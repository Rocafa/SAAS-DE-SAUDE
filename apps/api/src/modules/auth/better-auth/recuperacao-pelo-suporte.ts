/**
 * Recuperação do FATOR do admin único pelo suporte (B12). Desenho: docs/04-arquitetura/recuperacao-do-admin-unico.md;
 * parecer do Guardião de 16/11/2026 (R1 a R10). A recuperação COMPLETA (senha e fator) é VETADA e não existe aqui:
 * o token é do tipo `fator` e o uso exige a senha atual (nenhum token restaura os dois fatores).
 *
 * Recebe só os dois pools de banco (R4): a tarefa operacional não carrega `BETTER_AUTH_SECRET` nem outro segredo.
 * Mesma tabela e mesmo uso do #159 (`identidade.recuperacao`, `usarRecuperacao`), com `origem = 'suporte'`, o chamado,
 * ator sistema e validade de 24 h (0077). Só o SHA-256 do token fica no banco; o token sai só por `guardarToken`, que roda
 * DENTRO da transação que grava a linha (se guardar falhar, a linha não fica).
 *
 * Ordem das conferências (R4): clínica existe; a pessoa é admin ativo; a conta está ativa; nenhum OUTRO admin ativo tem
 * fator verificado (`ha_outro_admin`: o caminho é o desse admin, #159); teto (1 por clínica em 30 dias, 2 por pessoa em
 * 12 meses), sob trava consultiva por clínica e por pessoa.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { recuperacao, sessao, usuario } from '../../../db/identidade';
import { clinicMembers, tenants } from '../../../db/schema';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { recordAudit, SYSTEM_ACTOR_ID } from '../../audit/audit-log';
import type { MotivoDeRecuperacao } from '../credenciais';

/** Chamado do suporte. Só o número: nunca nome ou e-mail (vai para o CloudTrail, a trilha e o log). */
export const CHAMADO_SUPORTE = /^SUP-\d{1,7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Resposta 2 do parecer: 24 h (15 min é inviável com entrega por segunda pessoa; 72 h é demais). O CHECK da 0077 confere. */
export const VALIDADE_DA_RECUPERACAO_PELO_SUPORTE_HORAS = 24;
/** Resposta 3 do parecer: uma por clínica a cada 30 dias e duas por pessoa em 12 meses. Acima disso, revisão manual. */
export const TETO_DO_SUPORTE_POR_CLINICA_EM_30_DIAS = 1;
export const TETO_DO_SUPORTE_POR_PESSOA_EM_12_MESES = 2;

/** Motivos da lista fechada do #159 que cabem numa recuperação de FATOR (R5). Sem texto livre. */
export const MOTIVOS_DA_RECUPERACAO_PELO_SUPORTE = ['perdeu_o_aparelho', 'troca_de_aparelho', 'suspeita_de_invasao', 'conta_bloqueada'] as const satisfies readonly MotivoDeRecuperacao[];
export type MotivoDaRecuperacaoPeloSuporte = (typeof MOTIVOS_DA_RECUPERACAO_PELO_SUPORTE)[number];

export interface PedidoDeRecuperacaoPeloSuporte {
  readonly clinicaId: string;
  readonly usuarioId: string;
  /** `SUP-<número>`. Vai para a linha do token, a trilha da clínica e o evento. */
  readonly chamado: string;
  /** Id interno de quem executa. Só no evento de segurança, nunca na trilha da clínica (R6). */
  readonly operador: string;
  readonly motivo: MotivoDaRecuperacaoPeloSuporte;
  /** R5: derruba as sessões da pessoa já na emissão. Obrigatório com `suspeita_de_invasao`. */
  readonly derrubarSessoes: boolean;
}

/** Códigos fixos de recusa: a saída do comando nunca leva a mensagem do driver (R4). */
export type RecusaDaRecuperacaoPeloSuporte =
  | 'entrada_invalida'
  | 'chamado_invalido'
  | 'motivo_invalido'
  | 'derrubar_sessoes_obrigatorio'
  | 'clinica_nao_encontrada'
  | 'nao_e_admin'
  | 'conta_inativa'
  | 'ha_outro_admin'
  | 'teto';

export class RecuperacaoPeloSuporteRecusada extends Error {
  override readonly name = 'RecuperacaoPeloSuporteRecusada';
  constructor(readonly codigo: RecusaDaRecuperacaoPeloSuporte) {
    super(codigo);
  }
}

export interface ResultadoDaRecuperacaoPeloSuporte {
  readonly expiraEm: string;
  readonly sessoesDerrubadas: number;
}

export interface BancosDaRecuperacaoPeloSuporte {
  /** Papel `app_auth` (schema identidade). */
  readonly dbAuth: Database;
  /** Papel `app_user` (RLS por clínica), com o usuário de sistema na transação. */
  readonly dbClinica: Database;
}

export async function emitirRecuperacaoPeloSuporte(
  bancos: BancosDaRecuperacaoPeloSuporte,
  pedido: PedidoDeRecuperacaoPeloSuporte,
  guardarToken: (token: string) => Promise<void>,
): Promise<ResultadoDaRecuperacaoPeloSuporte> {
  const { clinicaId, usuarioId, chamado, operador, motivo, derrubarSessoes } = pedido;
  if (!UUID.test(clinicaId) || !UUID.test(usuarioId) || !UUID.test(operador) || usuarioId === SYSTEM_ACTOR_ID) throw new RecuperacaoPeloSuporteRecusada('entrada_invalida');
  if (!CHAMADO_SUPORTE.test(chamado)) throw new RecuperacaoPeloSuporteRecusada('chamado_invalido');
  if (!(MOTIVOS_DA_RECUPERACAO_PELO_SUPORTE as readonly string[]).includes(motivo)) throw new RecuperacaoPeloSuporteRecusada('motivo_invalido');
  // R5 e C1 do parecer de 17/11: aparelho perdido, conta bloqueada ou suspeita de invasão podem deixar sessão aberta
  // na mão de terceiro. Só a troca planejada de aparelho dispensa derrubar as sessões.
  if (motivo !== 'troca_de_aparelho' && !derrubarSessoes) throw new RecuperacaoPeloSuporteRecusada('derrubar_sessoes_obrigatorio');

  const tenantId = clinicaId as TenantId;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  let emitida: { expiraEm: Date; sessoes: number } | undefined;
  try {
    // Sem 4º argumento: usuário de sistema na transação, como os jobs e a anonimização.
    await withTenant(bancos.dbClinica, tenantId, async (tx) => {
      const [clinica] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, clinicaId));
      if (!clinica) throw new RecuperacaoPeloSuporteRecusada('clinica_nao_encontrada');
      const admins = (
        await tx
          .selectDistinct({ userId: clinicMembers.userId })
          .from(clinicMembers)
          .where(and(eq(clinicMembers.tenantId, clinicaId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)))
      ).map((l) => l.userId);
      if (!admins.includes(usuarioId)) throw new RecuperacaoPeloSuporteRecusada('nao_e_admin');
      const [pessoa] = await bancos.dbAuth.select({ ativo: usuario.ativo, inativaPor: usuario.inativaPor }).from(usuario).where(eq(usuario.id, usuarioId));
      if (!pessoa?.ativo || pessoa.inativaPor !== null) throw new RecuperacaoPeloSuporteRecusada('conta_inativa');
      const outros = admins.filter((id) => id !== usuarioId);
      if (outros.length > 0) {
        const comFator = await bancos.dbAuth
          .select({ id: usuario.id })
          .from(usuario)
          .where(and(inArray(usuario.id, outros), eq(usuario.ativo, true), isNull(usuario.inativaPor), eq(usuario.twoFactorEnabled, true)));
        if (comFator.length > 0) throw new RecuperacaoPeloSuporteRecusada('ha_outro_admin');
      }

      // R6: ator SISTEMA e metadata fechada; o operador nunca entra na trilha da clínica. A linha só confirma se o token
      // foi emitido (a emissão roda dentro desta transação; uma recusa desfaz a trilha).
      await recordAudit(tx, { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] }, {
        action: AuditAction.PermissionChange,
        scope: 'clinic_members',
        metadata: { op: 'credential_recovery_issued', user_id: usuarioId, kind: 'fator', reason: motivo, via: 'suporte', ticket: chamado },
      });

      emitida = await bancos.dbAuth.transaction(async (ta) => {
        // Sempre clínica e depois pessoa: a mesma ordem em toda rodada, sem ciclo de espera.
        await ta.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'recuperacao-suporte:' + clinicaId}, 0))`);
        await ta.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'recuperacao-suporte-pessoa:' + usuarioId}, 0))`);
        const [porClinica] = await ta
          .select({ n: sql<number>`count(*)::int` })
          .from(recuperacao)
          .where(and(eq(recuperacao.origem, 'suporte'), eq(recuperacao.clinicaId, clinicaId), gt(recuperacao.criadoEm, sql`now() - interval '30 days'`)));
        const [porPessoa] = await ta
          .select({ n: sql<number>`count(*)::int` })
          .from(recuperacao)
          .where(and(eq(recuperacao.origem, 'suporte'), eq(recuperacao.usuarioId, usuarioId), gt(recuperacao.criadoEm, sql`now() - interval '12 months'`)));
        if ((porClinica?.n ?? 0) >= TETO_DO_SUPORTE_POR_CLINICA_EM_30_DIAS || (porPessoa?.n ?? 0) >= TETO_DO_SUPORTE_POR_PESSOA_EM_12_MESES) {
          throw new RecuperacaoPeloSuporteRecusada('teto');
        }
        // R4: o token novo invalida os pendentes da pessoa (de qualquer clínica e origem).
        await ta.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, usuarioId), isNull(recuperacao.usadoEm)));
        const [r] = await ta
          .insert(recuperacao)
          .values({
            id: randomUUID(),
            usuarioId,
            tipo: 'fator',
            tokenHash,
            clinicaId,
            criadoPor: SYSTEM_ACTOR_ID,
            origem: 'suporte',
            chamado,
            expiraEm: sql`now() + make_interval(hours => ${VALIDADE_DA_RECUPERACAO_PELO_SUPORTE_HORAS})`,
          })
          .returning({ expiraEm: recuperacao.expiraEm });
        if (!r) throw new Error('falha ao emitir recuperação');
        const sessoes = derrubarSessoes ? (await ta.delete(sessao).where(eq(sessao.userId, usuarioId)).returning({ id: sessao.id })).length : 0;
        await guardarToken(token);
        return { expiraEm: r.expiraEm, sessoes };
      });
    });
  } catch (err) {
    // A trilha não confirmou depois da emissão: o token não vale (o comando apaga o parâmetro de entrega).
    if (emitida) {
      await bancos.dbAuth
        .update(recuperacao)
        .set({ usadoEm: new Date() })
        .where(and(eq(recuperacao.tokenHash, tokenHash), isNull(recuperacao.usadoEm)))
        // A2 do parecer de 17/11: se nem anular deu certo, o token vale sem trilha; o alarme é imediato.
        .catch(() => registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo: 'recuperacao_nao_anulada', tenantId: clinicaId, userId: usuarioId, chamado }));
    }
    if (err instanceof RecuperacaoPeloSuporteRecusada && err.codigo === 'teto') {
      // Acima do teto, revisão manual (DPO e os dois sócios): o alarme avisa na hora.
      registrarEventoDeSeguranca('RECUPERACAO_TETO', { motivo: 'teto_do_suporte', tenantId: clinicaId, userId: usuarioId, chamado, operador });
    }
    throw err;
  }
  if (!emitida) throw new Error('recuperação não emitida');
  // R6 e resposta 3(b): toda emissão alarma (imediato); o operador e o chamado ficam aqui e no CloudTrail.
  registrarEventoDeSeguranca('RECUPERACAO_PELO_SUPORTE', { motivo: 'recuperacao_pelo_suporte', tenantId: clinicaId, userId: usuarioId, chamado, operador });
  return { expiraEm: emitida.expiraEm.toISOString(), sessoesDerrubadas: emitida.sessoes };
}

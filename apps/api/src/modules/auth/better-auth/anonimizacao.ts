/**
 * Anonimização da conta da equipe a pedido do titular (LGPD art. 18 IV; R18 do desenho do PR 3; B10 do checklist).
 * Desenho: docs/04-arquitetura/anonimizacao-pelo-suporte.md; parecer do Guardião de 12/11/2026 (R1 a R5).
 *
 * Recebe só os dois pools de banco (R5): a tarefa operacional que a chama não carrega `BETTER_AUTH_SECRET` nem outro
 * segredo. O id da conta fica (o prontuário identifica o autor por 20 anos); e-mail e nome saem; senha, TOTP, sessões
 * e tokens de recuperação são apagados; a conta fica inativa.
 *
 * Idempotente (R3): rodar de novo não duplica a trilha nem o evento, e completa o que uma falha deixou para trás.
 */
import type { TenantId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { conta, conviteAceito, doisFatores, recuperacao, sessao, usuario, vinculo } from '../../../db/identidade';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca, registrarNoMaximoUmaVez } from '../../../security/log-de-seguranca';
import { recordAudit, SYSTEM_ACTOR_ID } from '../../audit/audit-log';
import { EMAIL_DESCARTADO } from '../convites-retencao';

/** Chamado operacional do atendimento ao titular. Só o número: nunca nome ou e-mail (vai para o CloudTrail). */
export const CHAMADO_LGPD = /^LGPD-\d{1,7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PedidoDeAnonimizacao {
  readonly usuarioId: string;
  /** `LGPD-<número>`. Vai para a trilha da clínica e para o evento. */
  readonly chamado: string;
  /** Id interno de quem executa. Só no evento de segurança, nunca na trilha da clínica (R2). */
  readonly operador: string;
}

/** Códigos fixos de recusa: a saída do comando nunca leva a mensagem do driver (R4). */
export type RecusaDaAnonimizacao = 'entrada_invalida' | 'conta_de_sistema' | 'nao_encontrada' | 'erro_parcial_rodar_de_novo';

export class AnonimizacaoRecusada extends Error {
  override readonly name = 'AnonimizacaoRecusada';
  constructor(readonly codigo: RecusaDaAnonimizacao) {
    super(codigo);
  }
}

export interface ResultadoDaAnonimizacao {
  /** A conta já estava anonimizada: nada de dado pessoal mudou, só a trilha que faltava foi completada. */
  readonly repetida: boolean;
  /** Clínicas tocadas (vínculo e espelho dos convites aceitos). */
  readonly clinicas: number;
}

export interface BancosDaAnonimizacao {
  /** Papel `app_auth` (schema identidade). */
  readonly dbAuth: Database;
  /** Papel `app_user` (RLS por clínica), com o usuário de sistema na transação. */
  readonly dbClinica: Database;
}

const MARCADOR_DO_NOME = 'Conta anonimizada';

export function emailAnonimizado(usuarioId: string): string {
  return `anonimizada-${usuarioId}@anonimizada.invalid`;
}

export async function anonimizarContaDoTitular(bancos: BancosDaAnonimizacao, pedido: PedidoDeAnonimizacao): Promise<ResultadoDaAnonimizacao> {
  const { usuarioId, chamado, operador } = pedido;
  if (!UUID.test(usuarioId) || !UUID.test(operador) || !CHAMADO_LGPD.test(chamado)) throw new AnonimizacaoRecusada('entrada_invalida');
  if (usuarioId === SYSTEM_ACTOR_ID) throw new AnonimizacaoRecusada('conta_de_sistema');

  // R3(a): a conta existe, ou nada acontece (nem evento).
  const [atual] = await bancos.dbAuth.select({ inativaPor: usuario.inativaPor }).from(usuario).where(eq(usuario.id, usuarioId));
  if (!atual) throw new AnonimizacaoRecusada('nao_encontrada');
  const repetida = atual.inativaPor === 'anonimizada';

  // Ordem (R4): primeiro as credenciais. O acesso cai antes de qualquer trilha; uma falha depois só deixa trilha a
  // completar, que a repetição completa.
  const vinculadas = (await bancos.dbAuth.selectDistinct({ clinica: vinculo.clinicaId }).from(vinculo).where(eq(vinculo.usuarioId, usuarioId))).map((l) => l.clinica);
  await bancos.dbAuth.transaction(async (tx) => {
    await tx
      .update(usuario)
      .set({ name: MARCADOR_DO_NOME, email: emailAnonimizado(usuarioId), ativo: false, inativaPor: 'anonimizada', image: null })
      .where(eq(usuario.id, usuarioId));
    await tx.update(conta).set({ password: null }).where(eq(conta.userId, usuarioId));
    await tx.delete(doisFatores).where(eq(doisFatores.userId, usuarioId));
    await tx.delete(sessao).where(eq(sessao.userId, usuarioId));
    await tx.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, usuarioId), isNull(recuperacao.usadoEm)));
  });
  // R3(d): o evento de "conta anonimizada" só na primeira vez; a repetição tem evento próprio. O operador fica aqui
  // (e no CloudTrail), nunca na trilha da clínica (R2).
  registrarEventoDeSeguranca(repetida ? 'ANONIMIZACAO_REPETIDA' : 'CONTA_ANONIMIZADA', { motivo: 'pedido_do_titular', userId: usuarioId, chamado, operador });

  // Clínicas do vínculo e as do espelho dos convites aceitos (0073; V3 do #177): mesmo tratamento, cada uma isolada
  // (R3(e)). Uma falha não para as outras; no fim, o erro pede para rodar de novo.
  const espelho = (await bancos.dbAuth.select({ clinica: conviteAceito.clinicaId }).from(conviteAceito).where(eq(conviteAceito.usuarioId, usuarioId))).map((l) => l.clinica);
  const clinicas = [...new Set([...vinculadas, ...espelho])];
  let falhas = 0;
  for (const clinica of clinicas) {
    const tenantId = clinica as TenantId;
    // Sem 4º argumento: usuário de sistema na transação, como os jobs (V1 do #177).
    await withTenant(bancos.dbClinica, tenantId, async (tx) => {
      // R3(b): só o que ainda tem pseudônimo.
      const zerados = await tx.execute<{ id: string }>(
        sql`update team_invites set email_hmac = ${EMAIL_DESCARTADO} where tenant_id = ${tenantId} and accepted_user_id = ${usuarioId} and email_hmac <> ${EMAIL_DESCARTADO} returning id`,
      );
      if (zerados.length > 0) {
        await recordAudit(tx, { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] }, {
          action: AuditAction.Update,
          scope: 'clinic_members',
          metadata: { op: 'invite_pseudonym_dropped', user_id: usuarioId, count: zerados.length },
        });
      }
      if (!vinculadas.includes(clinica)) return;
      // R3(c): a trilha é encadeada por hash e não se apaga; consulta-se antes. Vale também a linha antiga, gravada com
      // o próprio titular como ator e sem `user_id`.
      const [ja] = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_log where tenant_id = ${tenantId} and scope = 'session' and metadata->>'op' = 'account_anonymized'
            and (metadata->>'user_id' = ${usuarioId} or actor_id = ${usuarioId})`,
      );
      if ((ja?.n ?? 0) > 0) return;
      // R1: ator sistema. R2: na metadata, a conta afetada e o chamado; nunca quem executou.
      await recordAudit(tx, { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] }, {
        action: AuditAction.Update,
        scope: 'session',
        metadata: { op: 'account_anonymized', user_id: usuarioId, ticket: chamado, via: 'ops' },
      });
    }).catch(() => {
      falhas += 1;
      registrarNoMaximoUmaVez(`anonimizacao:${usuarioId}:${tenantId}`, 60_000, 'TRILHA_NAO_GRAVADA', { motivo: 'anonimizacao_incompleta', tenantId, userId: usuarioId });
    });
  }
  if (falhas > 0) {
    registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo: 'anonimizacao_incompleta', userId: usuarioId, contagem: falhas });
    throw new AnonimizacaoRecusada('erro_parcial_rodar_de_novo');
  }
  // V2 do #178: só as linhas lidas no início (o trigger já tira a linha quando o HMAC é zerado).
  if (espelho.length > 0) await bancos.dbAuth.delete(conviteAceito).where(and(eq(conviteAceito.usuarioId, usuarioId), inArray(conviteAceito.clinicaId, espelho)));
  return { repetida, clinicas: clinicas.length };
}

/** Conferência DEPOIS (R4): o estado no banco é o de uma conta anonimizada. Devolve o que não bate (só nomes de itens). */
export async function conferirAnonimizacao(bancos: Pick<BancosDaAnonimizacao, 'dbAuth'>, usuarioId: string): Promise<string[]> {
  const faltas: string[] = [];
  const [u] = await bancos.dbAuth.select({ inativaPor: usuario.inativaPor, email: usuario.email, nome: usuario.name, ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, usuarioId));
  if (!u) return ['conta'];
  if (u.inativaPor !== 'anonimizada' || u.ativo) faltas.push('estado');
  if (u.email !== emailAnonimizado(usuarioId) || u.nome !== MARCADOR_DO_NOME) faltas.push('identificacao');
  const contar = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  if ((await contar(bancos.dbAuth.select({ n: sql<number>`count(*)::int` }).from(sessao).where(eq(sessao.userId, usuarioId)))) > 0) faltas.push('sessoes');
  if ((await contar(bancos.dbAuth.select({ n: sql<number>`count(*)::int` }).from(doisFatores).where(eq(doisFatores.userId, usuarioId)))) > 0) faltas.push('totp');
  if ((await contar(bancos.dbAuth.select({ n: sql<number>`count(*)::int` }).from(conta).where(and(eq(conta.userId, usuarioId), sql`${conta.password} is not null`)))) > 0) faltas.push('senha');
  if ((await contar(bancos.dbAuth.select({ n: sql<number>`count(*)::int` }).from(conviteAceito).where(eq(conviteAceito.usuarioId, usuarioId)))) > 0) faltas.push('espelho');
  if (
    (await contar(bancos.dbAuth.select({ n: sql<number>`count(*)::int` }).from(recuperacao).where(and(eq(recuperacao.usuarioId, usuarioId), isNull(recuperacao.usadoEm))))) > 0
  ) {
    faltas.push('recuperacao');
  }
  return faltas;
}

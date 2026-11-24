/**
 * Troca do admin único que perdeu senha e fator (B13), lado da TAREFA avulsa: fases `pedir`, `emitir` e `cancelar`.
 * Desenho v2: docs/04-arquitetura/troca-do-admin-unico.md; parecer do Guardião de 24/11/2026 (R1 a R5; P3, P4, P7 a
 * P10). Runbook: docs/04-arquitetura/runbook-troca-do-admin-unico.md.
 *
 * A pessoa NÃO volta para a conta antiga (nenhum token restaura os dois fatores; RIPD §5a): recebe uma conta NOVA, com
 * outro e-mail, pelo token de ativação de uso único do provisionamento (origem `troca`, 24 h). O vínculo antigo só cai
 * quando a conta nova confirma o TOTP (R1), na API (`troca-do-admin-na-api.ts`).
 *
 * Recebe só a conexão do papel `app_provisionamento` (0080, ampliado pela 0082; P7): a mesma para a identidade e para
 * a clínica, numa transação só por fase (sessão de SISTEMA da clínica). O HMAC do e-mail e o hash do token passam por
 * funções SECURITY DEFINER pela chave; a tarefa não lê nenhum dos dois. Na trilha da clínica, o ator é SEMPRE o sistema;
 * o operador fica só na linha da troca (R4), no log de segurança e no CloudTrail.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ativacaoDoFundador, ESTADOS_FINAIS_DA_TROCA, trocaDoAdmin, type EstadoDaTroca } from '../../../db/identidade';
import { clinicMembers, tenants } from '../../../db/schema';
import { withTenant, type Database, type TenantTx } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { chaveDeHmac } from '../../../security/rate-limit-store';
import { recordAudit, SYSTEM_ACTOR_ID } from '../../audit/audit-log';
import { hmacDoEmail } from '../convites';
import { CONTRATO } from './provisionamento';
import { CHAMADO_SUPORTE } from './recuperacao-pelo-suporte';

/**
 * Tamanho da janela entre o pedido e a emissão. Padrão até decisão dos sócios (P1): 48 h CORRIDAS (a recomendação do
 * Guardião pede ainda pelo menos um dia útil inteiro; o calendário de dias úteis fica para depois da decisão). O CHECK
 * da 0082 recusa menos que 48 h.
 */
export const JANELA_DA_TROCA_HORAS = 48;

/**
 * Suspensão da conta antiga já no `pedir`. Padrão até decisão dos sócios (P2): só com a opção explícita
 * `--suspender-conta-antiga` E o motivo `suspeita_de_invasao` (o runbook exige a decisão do DPO registrada no chamado).
 */
export const MOTIVO_QUE_PERMITE_SUSPENDER = 'suspeita_de_invasao' as const;

/** P9 (decisão do Guardião): o token da troca vale 24 h. O CHECK da 0082 confere por origem. */
export const VALIDADE_DA_ATIVACAO_DA_TROCA_HORAS = 24;

/** R2: a confirmação de viva voz do `pedir` vale por até 24 h; relógio do operador com até 5 min de diferença. */
export const IDADE_MAXIMA_DA_VIVA_VOZ_HORAS = 24;
const TOLERANCIA_DO_RELOGIO_MS = 5 * 60_000;

/** Teto SOMADO com o B12 (resposta 3 e 4 do parecer de 16/11): 1 por clínica em 30 dias, 2 por pessoa em 12 meses. */
export const TETO_POR_CLINICA_EM_30_DIAS = 1;
export const TETO_POR_PESSOA_EM_12_MESES = 2;

/** Lista fechada (sem texto livre na trilha). */
export const MOTIVOS_DA_TROCA = ['perdeu_senha_e_fator', 'titular_indisponivel', 'suspeita_de_invasao'] as const;
export type MotivoDaTroca = (typeof MOTIVOS_DA_TROCA)[number];
export const QUEM_CANCELA = ['contrato', 'dpo'] as const;
export type QuemCancela = (typeof QUEM_CANCELA)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Hora UTC da ligação de retorno (ISO 8601 com `Z`); nunca o telefone. */
const HORA_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

export type RecusaDaTroca =
  | 'entrada_invalida'
  | 'chamado_invalido'
  | 'contrato_invalido'
  | 'motivo_invalido'
  | 'parametro_invalido'
  | 'viva_voz_ausente'
  | 'clinica_nao_encontrada'
  | 'nao_e_admin'
  | 'conta_inativa'
  | 'ha_outro_admin'
  | 'ha_pedido_pendente'
  | 'teto'
  | 'email_em_uso'
  | 'troca_nao_encontrada'
  | 'mesmo_operador'
  | 'janela_aberta'
  | 'token_vigente'
  | 'conclusao_pendente'
  | 'troca_suspensa'
  | 'troca_vencida'
  | 'troca_encerrada';

export class TrocaRecusada extends Error {
  override readonly name = 'TrocaRecusada';
  constructor(readonly codigo: RecusaDaTroca) {
    super(codigo);
  }
}

export interface OpcoesDaTroca {
  /** Chave do HMAC do e-mail; padrão `chaveDeHmac('ativacao-email')`, a mesma que a ativação usa para conferir. */
  readonly chaveDoEmail?: Uint8Array;
  readonly agora?: () => Date;
}

/** Confere a hora da ligação de viva voz (R2): formato, não no futuro e, se houver, dentro do intervalo. */
function vivaVozConfere(hora: string, agora: Date, desde: Date): boolean {
  if (!HORA_UTC.test(hora)) return false;
  const t = Date.parse(hora);
  return Number.isFinite(t) && t <= agora.getTime() + TOLERANCIA_DO_RELOGIO_MS && t >= desde.getTime();
}

function ehViolacaoDeUnicidade(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

const hashDoToken = (token: string): string => createHash('sha256').update(token).digest('hex');

async function travar(tx: TenantTx, clinicaId: string): Promise<void> {
  // Trava consultiva COMPARTILHADA com a recuperação do B12 (mesma chave): um pedido por vez na clínica.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'recuperacao-suporte:' + clinicaId}, 0))`);
}

async function adminsAtivos(tx: TenantTx, clinicaId: string): Promise<string[]> {
  const linhas = await tx
    .selectDistinct({ userId: clinicMembers.userId })
    .from(clinicMembers)
    .where(and(eq(clinicMembers.tenantId, clinicaId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)));
  return linhas.map((l) => l.userId);
}

async function quantosComFator(tx: TenantTx, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const lista = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [r] = await tx.execute<{ n: number }>(sql`select identidade.admins_com_fator(array[${lista}]::uuid[]) as n`);
  return Number(r?.n ?? 0);
}

async function contagem(tx: TenantTx, clinicaId: string, usuarioId: string): Promise<{ clinica30d: number; pessoa12m: number; pendentes: number }> {
  const [r] = await tx.execute<{ clinica_30d: number; pessoa_12m: number; pendentes: number }>(
    sql`select clinica_30d, pessoa_12m, pendentes from identidade.contagem_admin_unico(${clinicaId}::uuid, ${usuarioId}::uuid)`,
  );
  return { clinica30d: Number(r?.clinica_30d ?? 0), pessoa12m: Number(r?.pessoa_12m ?? 0), pendentes: Number(r?.pendentes ?? 0) };
}

const SISTEMA = (tenantId: string) => ({ tenantId: tenantId as TenantId, userId: SYSTEM_ACTOR_ID, roles: [] });

// ------------------------------------------------------------------------------------------------------------ pedir

export interface PedidoDeTroca {
  /** Uuid do pedido: nome do parâmetro SSM, trava da tarefa e id da troca. */
  readonly pedido: string;
  readonly clinicaId: string;
  /** A conta antiga (admin que perdeu senha e fator, ou o titular indisponível). */
  readonly usuarioAntigo: string;
  readonly chamado: string;
  readonly contrato: string;
  readonly motivo: MotivoDaTroca;
  /** Executor do pedido (R4): só na linha da troca, no log de segurança e no CloudTrail. */
  readonly operador: string;
  /** R2: hora UTC da ligação de retorno ao telefone do contrato. */
  readonly vivaVoz: string;
  /** P2 (padrão até decisão dos sócios): só com `suspeita_de_invasao`. */
  readonly suspenderContaAntiga: boolean;
  /** E-mail da conta NOVA, lido do parâmetro SSM. Só o HMAC sai desta função. */
  readonly email: string;
}

export interface ResultadoDoPedido {
  readonly liberaEm: string;
  readonly sessoesDerrubadas: number;
}

export async function pedirTrocaDoAdmin(db: Database, p: PedidoDeTroca, opcoes: OpcoesDaTroca = {}): Promise<ResultadoDoPedido> {
  const agora = (opcoes.agora ?? (() => new Date()))();
  if (![p.pedido, p.clinicaId, p.usuarioAntigo, p.operador].every((v) => UUID.test(v)) || p.usuarioAntigo === SYSTEM_ACTOR_ID) {
    throw new TrocaRecusada('entrada_invalida');
  }
  if (!CHAMADO_SUPORTE.test(p.chamado)) throw new TrocaRecusada('chamado_invalido');
  if (!CONTRATO.test(p.contrato)) throw new TrocaRecusada('contrato_invalido');
  if (!(MOTIVOS_DA_TROCA as readonly string[]).includes(p.motivo)) throw new TrocaRecusada('motivo_invalido');
  if (p.suspenderContaAntiga && p.motivo !== MOTIVO_QUE_PERMITE_SUSPENDER) throw new TrocaRecusada('motivo_invalido');
  if (!vivaVozConfere(p.vivaVoz, agora, new Date(agora.getTime() - IDADE_MAXIMA_DA_VIVA_VOZ_HORAS * 3_600_000))) throw new TrocaRecusada('viva_voz_ausente');
  const email = p.email.trim().toLowerCase();
  if (email.length > 320 || !EMAIL.test(email)) throw new TrocaRecusada('parametro_invalido');
  const emailHmac = hmacDoEmail(email, opcoes.chaveDoEmail ?? chaveDeHmac('ativacao-email'));
  const usuarioNovo = randomUUID();

  let resultado: ResultadoDoPedido;
  try {
    resultado = await withTenant(db, p.clinicaId as TenantId, async (tx) => {
      await travar(tx, p.clinicaId);
      const [clinica] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, p.clinicaId));
      if (!clinica) throw new TrocaRecusada('clinica_nao_encontrada');
      const admins = await adminsAtivos(tx, p.clinicaId);
      if (!admins.includes(p.usuarioAntigo)) throw new TrocaRecusada('nao_e_admin');
      const [apta] = await tx.execute<{ ok: boolean }>(sql`select identidade.conta_admin_apta(${p.usuarioAntigo}::uuid) as ok`);
      if (!apta?.ok) throw new TrocaRecusada('conta_inativa');
      // Outro admin ativo COM fator resolve pelo app (#159).
      if ((await quantosComFator(tx, admins.filter((id) => id !== p.usuarioAntigo))) > 0) throw new TrocaRecusada('ha_outro_admin');
      const c = await contagem(tx, p.clinicaId, p.usuarioAntigo);
      if (c.pendentes > 0) throw new TrocaRecusada('ha_pedido_pendente');
      if (c.clinica30d >= TETO_POR_CLINICA_EM_30_DIAS || c.pessoa12m >= TETO_POR_PESSOA_EM_12_MESES) throw new TrocaRecusada('teto');
      // P10: só conta NOVA. O e-mail novo não é o da conta antiga nem de conta nenhuma (o e-mail antigo nunca volta).
      const [antigo] = await tx.execute<{ ok: boolean }>(sql`select identidade.email_da_conta_confere(${p.usuarioAntigo}::uuid, ${email}) as ok`);
      if (antigo?.ok) throw new TrocaRecusada('email_em_uso');
      const contas = await tx.execute<{ id: string }>(sql`select id from identidade.conta_por_email(${email})`);
      if ([...contas].length > 0) throw new TrocaRecusada('email_em_uso');

      await tx.insert(trocaDoAdmin).values({
        id: p.pedido,
        clinicaId: p.clinicaId,
        usuarioAntigo: p.usuarioAntigo,
        usuarioNovo,
        operadorPedido: p.operador,
        emailHmac,
        motivo: p.motivo,
        chamado: p.chamado,
        contrato: p.contrato,
        // P1: o banco marca a hora do pedido e a janela conta dela.
        liberaEm: sql`now() + make_interval(hours => ${JANELA_DA_TROCA_HORAS})`,
        contaAntigaSuspensa: p.suspenderContaAntiga,
      });
      // Ator SISTEMA e metadata fechada; o operador nunca entra na trilha da clínica (R4).
      await recordAudit(tx, SISTEMA(p.clinicaId), {
        action: AuditAction.PermissionChange,
        scope: 'clinic_members',
        metadata: { op: 'admin_replacement_requested', user_id: p.usuarioAntigo, reason: p.motivo, via: 'suporte', ticket: p.chamado, window_hours: JANELA_DA_TROCA_HORAS },
      });
      let sessoes = 0;
      if (p.suspenderContaAntiga) {
        const [r] = await tx.execute<{ n: number }>(sql`select identidade.derrubar_sessoes_da_troca(${p.pedido}::uuid) as n`);
        sessoes = Number(r?.n ?? 0);
      }
      const [t] = await tx.select({ liberaEm: trocaDoAdmin.liberaEm }).from(trocaDoAdmin).where(eq(trocaDoAdmin.id, p.pedido));
      if (!t) throw new Error('troca não gravada');
      return { liberaEm: t.liberaEm.toISOString(), sessoesDerrubadas: sessoes };
    });
  } catch (err) {
    if (err instanceof TrocaRecusada && err.codigo === 'teto') {
      registrarEventoDeSeguranca('TROCA_DO_ADMIN_TETO', { motivo: 'teto_do_suporte', tenantId: p.clinicaId, userId: p.usuarioAntigo, chamado: p.chamado, operador: p.operador, pedido: p.pedido });
    }
    // Mesmo pedido de novo, ou outra troca aberta na clínica (índice parcial).
    if (ehViolacaoDeUnicidade(err)) throw new TrocaRecusada('ha_pedido_pendente');
    throw err;
  }
  registrarEventoDeSeguranca('TROCA_DO_ADMIN_PEDIDA', {
    motivo: p.motivo,
    tenantId: p.clinicaId,
    userId: p.usuarioAntigo,
    chamado: p.chamado,
    contrato: p.contrato,
    operador: p.operador,
    pedido: p.pedido,
    contagem: resultado.sessoesDerrubadas,
  });
  return resultado;
}

// ------------------------------------------------------------------------------------------------------- encerrar

interface TrocaLida {
  readonly id: string;
  readonly clinicaId: string;
  readonly usuarioAntigo: string;
  readonly usuarioNovo: string;
  readonly operadorPedido: string;
  readonly chamado: string;
  readonly liberaEm: Date;
  readonly estado: EstadoDaTroca;
  readonly reemissoes: number;
}

async function lerTroca(db: Database | TenantTx, pedido: string): Promise<TrocaLida | undefined> {
  // Sem o HMAC do e-mail (a 0082 não dá SELECT dessa coluna à tarefa).
  const [t] = await db
    .select({
      id: trocaDoAdmin.id,
      clinicaId: trocaDoAdmin.clinicaId,
      usuarioAntigo: trocaDoAdmin.usuarioAntigo,
      usuarioNovo: trocaDoAdmin.usuarioNovo,
      operadorPedido: trocaDoAdmin.operadorPedido,
      chamado: trocaDoAdmin.chamado,
      liberaEm: trocaDoAdmin.liberaEm,
      estado: trocaDoAdmin.estado,
      reemissoes: trocaDoAdmin.reemissoes,
    })
    .from(trocaDoAdmin)
    .where(eq(trocaDoAdmin.id, pedido));
  return t;
}

/** Revoga o vínculo INERTE (ou da conta nova sem fator) da troca encerrada, pelo sentinela, com a trilha (0082). */
async function revogarVinculoDaContaNova(tx: TenantTx, t: TrocaLida): Promise<number> {
  const ativos = await tx
    .select({ id: clinicMembers.id, role: clinicMembers.role })
    .from(clinicMembers)
    .where(and(eq(clinicMembers.tenantId, t.clinicaId), eq(clinicMembers.userId, t.usuarioNovo), isNull(clinicMembers.revokedAt)));
  for (const m of ativos) {
    await tx
      .update(clinicMembers)
      .set({ revokedBy: SYSTEM_ACTOR_ID, revokedAt: new Date() })
      .where(and(eq(clinicMembers.tenantId, t.clinicaId), eq(clinicMembers.id, m.id)));
    await recordAudit(tx, SISTEMA(t.clinicaId), {
      action: AuditAction.PermissionChange,
      scope: 'clinic_members',
      metadata: { op: 'member_revoke', member_id: m.id, user_id: t.usuarioNovo, role: m.role, via: 'troca_do_admin', ticket: t.chamado },
    });
  }
  return ativos.length;
}

/** Cancelada ou vencida: estado, tokens da conta nova, vínculo inerte, suspensão da conta antiga e trilha. */
async function encerrar(tx: TenantTx, t: TrocaLida, estado: 'cancelada' | 'vencida', por: QuemCancela | 'sistema'): Promise<void> {
  if (estado === 'vencida' && t.estado === 'emitida') {
    // O token venceu sem uso: passa por `liberada_sem_token` (o grafo da 0082).
    await tx.update(trocaDoAdmin).set({ estado: 'liberada_sem_token' }).where(eq(trocaDoAdmin.id, t.id));
  }
  await tx.update(trocaDoAdmin).set({ estado, encerradaPor: por }).where(eq(trocaDoAdmin.id, t.id));
  await tx.execute(sql`select identidade.encerrar_tokens_da_troca(${t.id}::uuid)`);
  await revogarVinculoDaContaNova(tx, t);
  await tx.execute(sql`select identidade.reativar_conta_da_troca(${t.id}::uuid)`);
  await recordAudit(tx, SISTEMA(t.clinicaId), {
    action: AuditAction.PermissionChange,
    scope: 'clinic_members',
    metadata: estado === 'cancelada' ? { op: 'admin_replacement_cancelled', ticket: t.chamado, by: por } : { op: 'admin_replacement_expired', ticket: t.chamado },
  });
}

// ----------------------------------------------------------------------------------------------------------- emitir

export interface EmissaoDaTroca {
  readonly pedido: string;
  readonly chamado: string;
  /** Executor da emissão: OUTRA pessoa (R4: `mesmo_operador`). */
  readonly operador: string;
  /** R2: segunda ligação de retorno, depois da janela. */
  readonly vivaVoz: string;
}

export interface ResultadoDaEmissao {
  /** `ativacao`: token de ativação (conta nova); `fator`: reemissão para a conta nova `ativada` sem TOTP. */
  readonly tipo: 'ativacao' | 'fator';
  readonly clinicaId: string;
  readonly expiraEm: string;
}

type DesfechoDaEmissao = { readonly ok: ResultadoDaEmissao } | { readonly recusa: RecusaDaTroca; readonly encerrou?: 'cancelada' | 'vencida' };

export async function emitirTrocaDoAdmin(
  db: Database,
  e: EmissaoDaTroca,
  guardarToken: (token: string) => Promise<void>,
  opcoes: OpcoesDaTroca = {},
): Promise<ResultadoDaEmissao> {
  const agora = (opcoes.agora ?? (() => new Date()))();
  if (!UUID.test(e.pedido) || !UUID.test(e.operador)) throw new TrocaRecusada('entrada_invalida');
  if (!CHAMADO_SUPORTE.test(e.chamado)) throw new TrocaRecusada('chamado_invalido');
  const lida = await lerTroca(db, e.pedido);
  if (!lida) throw new TrocaRecusada('troca_nao_encontrada');
  if (lida.chamado !== e.chamado) throw new TrocaRecusada('chamado_invalido');
  // R4: quem pediu não emite. A comparação é com a linha da troca (schema identidade), nunca com a trilha.
  if (lida.operadorPedido === e.operador) throw new TrocaRecusada('mesmo_operador');
  if (lida.estado === 'aguardando' && agora.getTime() < lida.liberaEm.getTime()) throw new TrocaRecusada('janela_aberta');
  // R2: a viva voz do `emitir` é posterior à janela.
  if (!vivaVozConfere(e.vivaVoz, agora, lida.liberaEm)) throw new TrocaRecusada('viva_voz_ausente');

  const token = randomBytes(32).toString('base64url');
  const desfecho = await withTenant(db, lida.clinicaId as TenantId, async (tx): Promise<DesfechoDaEmissao> => {
    await travar(tx, lida.clinicaId);
    const t = await lerTroca(tx, e.pedido);
    if (!t) return { recusa: 'troca_nao_encontrada' };
    const outrosComFator = async () =>
      quantosComFator(
        tx,
        (await adminsAtivos(tx, t.clinicaId)).filter((id) => id !== t.usuarioAntigo && id !== t.usuarioNovo),
      );

    if (t.estado === 'aguardando') {
      if (!(await adminsAtivos(tx, t.clinicaId)).includes(t.usuarioAntigo)) return { recusa: 'nao_e_admin' };
      // Outro admin ganhou fator na janela: ele resolve pelo app, e a troca é cancelada.
      if ((await outrosComFator()) > 0) {
        await encerrar(tx, t, 'cancelada', 'sistema');
        return { recusa: 'ha_outro_admin', encerrou: 'cancelada' };
      }
      // Só admin (P8), ao uuid reservado, na sessão de sistema; o clinic_members_guard confere a troca liberada.
      const [m] = await tx.insert(clinicMembers).values({ tenantId: t.clinicaId, userId: t.usuarioNovo, role: 'admin', grantedBy: SYSTEM_ACTOR_ID }).returning({ id: clinicMembers.id });
      if (!m) throw new Error('vínculo da conta nova não gravado');
      await recordAudit(tx, SISTEMA(t.clinicaId), {
        action: AuditAction.PermissionChange,
        scope: 'clinic_members',
        metadata: { op: 'member_grant', member_id: m.id, user_id: t.usuarioNovo, role: 'admin', via: 'troca_do_admin', ticket: t.chamado },
      });
      return { ok: await emitirAtivacao(tx, t, token, guardarToken) };
    }

    if (t.estado === 'emitida' || t.estado === 'liberada_sem_token') {
      if (t.estado === 'emitida') {
        const [vivo] = await tx
          .select({ id: ativacaoDoFundador.id })
          .from(ativacaoDoFundador)
          .where(and(eq(ativacaoDoFundador.trocaId, t.id), isNull(ativacaoDoFundador.usadoEm), sql`${ativacaoDoFundador.expiraEm} > now()`));
        if (vivo) return { recusa: 'token_vigente' };
        await tx.update(trocaDoAdmin).set({ estado: 'liberada_sem_token' }).where(eq(trocaDoAdmin.id, t.id));
      }
      const liberada: TrocaLida = { ...t, estado: 'liberada_sem_token' };
      if (t.reemissoes >= 1) {
        await encerrar(tx, liberada, 'vencida', 'sistema');
        return { recusa: 'troca_vencida', encerrou: 'vencida' };
      }
      // A única reemissão: mesma reserva e mesmo vínculo.
      return { ok: await emitirAtivacao(tx, liberada, token, guardarToken) };
    }

    if (t.estado === 'ativada') {
      // A conta nova já confirmou o TOTP: falta a conclusão (a API ou o job a fazem), não um token.
      if ((await quantosComFator(tx, [t.usuarioNovo])) > 0) return { recusa: 'conclusao_pendente' };
      if (t.reemissoes >= 1) {
        // Token de fator ainda vivo (a contagem soma o token do suporte vivo e a própria troca aberta).
        if ((await contagem(tx, t.clinicaId, t.usuarioAntigo)).pendentes > 1) return { recusa: 'token_vigente' };
        await encerrar(tx, t, 'vencida', 'sistema');
        return { recusa: 'troca_vencida', encerrou: 'vencida' };
      }
      if ((await outrosComFator()) > 0) {
        await encerrar(tx, t, 'cancelada', 'sistema');
        return { recusa: 'ha_outro_admin', encerrou: 'cancelada' };
      }
      const [r] = await tx.execute<{ expira: Date | string }>(
        sql`select identidade.emitir_fator_da_troca(${t.id}::uuid, ${randomUUID()}::uuid, ${hashDoToken(token)}) as expira`,
      );
      if (!r) throw new Error('fator da troca não emitido');
      await guardarToken(token);
      return { ok: { tipo: 'fator', clinicaId: t.clinicaId, expiraEm: new Date(r.expira).toISOString() } };
    }

    if (t.estado === 'suspensa') return { recusa: 'troca_suspensa' };
    return { recusa: 'troca_encerrada' };
  });

  const ids = { tenantId: lida.clinicaId, chamado: lida.chamado, operador: e.operador, pedido: lida.id };
  if ('recusa' in desfecho) {
    if (desfecho.encerrou === 'cancelada') registrarEventoDeSeguranca('TROCA_DO_ADMIN_CANCELADA', { motivo: 'sistema', userId: lida.usuarioAntigo, ...ids });
    if (desfecho.encerrou === 'vencida') registrarEventoDeSeguranca('TROCA_DO_ADMIN_VENCIDA', { motivo: 'troca_do_admin', userId: lida.usuarioAntigo, ...ids });
    throw new TrocaRecusada(desfecho.recusa);
  }
  if (desfecho.ok.tipo === 'ativacao') {
    registrarEventoDeSeguranca('ATIVACAO_EMITIDA', { motivo: 'troca_do_admin', userId: lida.usuarioNovo, ...ids });
  } else {
    registrarEventoDeSeguranca('RECUPERACAO_PELO_SUPORTE', { motivo: 'troca_do_admin', userId: lida.usuarioNovo, ...ids });
  }
  return desfecho.ok;
}

/** Token de ativação `origem = 'troca'` pela função da 0082 (o HMAC é copiado lá dentro) e entrega na transação. */
async function emitirAtivacao(tx: TenantTx, t: TrocaLida, token: string, guardarToken: (token: string) => Promise<void>): Promise<ResultadoDaEmissao> {
  const [r] = await tx.execute<{ expira: Date | string }>(
    sql`select identidade.emitir_ativacao_da_troca(${t.id}::uuid, ${randomUUID()}::uuid, ${hashDoToken(token)}) as expira`,
  );
  if (!r) throw new Error('ativação da troca não emitida');
  // Dentro da transação: se a entrega falhar, nada fica (nem vínculo, nem token).
  await guardarToken(token);
  return { tipo: 'ativacao', clinicaId: t.clinicaId, expiraEm: new Date(r.expira).toISOString() };
}

// --------------------------------------------------------------------------------------------------------- cancelar

export interface CancelamentoDaTroca {
  readonly pedido: string;
  readonly chamado: string;
  readonly operador: string;
  /** Quem pediu o cancelamento: o signatário pelo contrato (viva voz ou escrito) ou o DPO. */
  readonly por: QuemCancela;
}

export async function cancelarTrocaDoAdmin(db: Database, c: CancelamentoDaTroca): Promise<{ readonly clinicaId: string; readonly estadoAnterior: EstadoDaTroca }> {
  if (!UUID.test(c.pedido) || !UUID.test(c.operador)) throw new TrocaRecusada('entrada_invalida');
  if (!CHAMADO_SUPORTE.test(c.chamado)) throw new TrocaRecusada('chamado_invalido');
  if (!(QUEM_CANCELA as readonly string[]).includes(c.por)) throw new TrocaRecusada('motivo_invalido');
  const lida = await lerTroca(db, c.pedido);
  if (!lida) throw new TrocaRecusada('troca_nao_encontrada');
  if (lida.chamado !== c.chamado) throw new TrocaRecusada('chamado_invalido');
  const anterior = await withTenant(db, lida.clinicaId as TenantId, async (tx) => {
    await travar(tx, lida.clinicaId);
    const t = await lerTroca(tx, c.pedido);
    if (!t || ESTADOS_FINAIS_DA_TROCA.includes(t.estado)) throw new TrocaRecusada('troca_encerrada');
    await encerrar(tx, t, 'cancelada', c.por);
    return t.estado;
  });
  registrarEventoDeSeguranca('TROCA_DO_ADMIN_CANCELADA', {
    motivo: c.por,
    tenantId: lida.clinicaId,
    userId: lida.usuarioAntigo,
    chamado: lida.chamado,
    operador: c.operador,
    pedido: lida.id,
  });
  return { clinicaId: lida.clinicaId, estadoAnterior: anterior };
}

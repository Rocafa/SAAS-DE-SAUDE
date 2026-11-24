/**
 * Troca do admin único (B13), lado da API (`app_auth` para a identidade e `app_user`, sob o RLS, para a clínica).
 * Desenho v2: docs/04-arquitetura/troca-do-admin-unico.md, seções 4, 5 e 6; parecer do Guardião de 24/11/2026.
 *
 * - Conclusão (R1): SÓ quando a conta nova confirma o TOTP. Na clínica, a conta nova (admin, agora com fator) revoga
 *   todos os perfis da conta antiga nesta clínica e grava `admin_replaced`; na identidade, a troca vai a `concluida`
 *   (o trigger da 0082 confere o TOTP), as sessões e os tokens pendentes da conta antiga caem e, sem nenhum vínculo
 *   restante, ela vira `substituida` (R5). Se algo falhar, a troca fica `ativada` e o job `identidade-expurgo` refaz.
 * - Login completo (senha e TOTP) da conta antiga com a troca em andamento: a troca vai a `suspensa` (crítico; o DPO
 *   decide). Depois da conclusão: `CONTA_SUBSTITUIDA_ENTROU` (crítico) e a linha na trilha da clínica (R5).
 * - "Não fui eu" (contestação pela conta antiga, com MFA recente): a troca vai a `contestada`, os tokens da conta nova
 *   caem e a própria conta antiga (admin) revoga o vínculo da conta nova. É incidente.
 *
 * Ordem entre os dois bancos: a transação da identidade trava SÓ a linha da troca antes de abrir a da clínica (o
 * trigger de espelho da clínica mexe na conta e nas sessões; mexer nelas antes travaria as duas conexões).
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ativacaoDoFundador, ESTADOS_ABERTOS_DA_TROCA, recuperacao, sessao, trocaDoAdmin, usuario } from '../../../db/identidade';
import { clinicMembers } from '../../../db/schema';
import { withTenant, type Database, type TenantTx } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca, registrarNoMaximoUmaVez } from '../../../security/log-de-seguranca';
import { recordAudit, SYSTEM_ACTOR_ID } from '../../audit/audit-log';
import { EMAIL_DESCARTADO } from '../convites-retencao';

export interface BancosDaTrocaNaApi {
  /** Papel `app_auth` (schema identidade). */
  readonly dbAuth: Database;
  /** Papel `app_user` (RLS por clínica). */
  readonly dbClinica: Database;
}

/** A troca mudou entre a leitura e a trava: nada a fazer agora. */
class TrocaMudou extends Error {}

/** Estados em que o login completo da conta antiga para a troca (antes da conclusão). */
const EM_ANDAMENTO = ['aguardando', 'emitida', 'liberada_sem_token', 'ativada'] as const;

async function revogarPerfisDe(
  ct: TenantTx,
  ctx: RequestContext,
  alvo: string,
  chamado: string,
): Promise<number> {
  const ativos = await ct
    .select({ id: clinicMembers.id, role: clinicMembers.role })
    .from(clinicMembers)
    .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.userId, alvo), isNull(clinicMembers.revokedAt)));
  for (const m of ativos) {
    await ct
      .update(clinicMembers)
      .set({ revokedBy: ctx.userId, revokedAt: new Date() })
      .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.id, m.id)));
    await recordAudit(ct, ctx, {
      action: AuditAction.PermissionChange,
      scope: 'clinic_members',
      metadata: { op: 'member_revoke', member_id: m.id, user_id: alvo, role: m.role, via: 'troca_do_admin', ticket: chamado },
    });
  }
  return ativos.length;
}

/**
 * R1: conclui a troca `ativada` da conta nova que já confirmou o TOTP. Devolve se concluiu. Idempotente: o job refaz o
 * que faltou (a revogação já feita não se repete).
 */
export async function concluirTrocaDoAdmin(b: BancosDaTrocaNaApi, usuarioNovo: string): Promise<boolean> {
  const [t] = await b.dbAuth
    .select({ id: trocaDoAdmin.id, clinicaId: trocaDoAdmin.clinicaId, usuarioAntigo: trocaDoAdmin.usuarioAntigo, chamado: trocaDoAdmin.chamado })
    .from(trocaDoAdmin)
    .where(and(eq(trocaDoAdmin.usuarioNovo, usuarioNovo), eq(trocaDoAdmin.estado, 'ativada')));
  if (!t) return false;
  const [novo] = await b.dbAuth.select({ fator: usuario.twoFactorEnabled, ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, usuarioNovo));
  // Sem o TOTP confirmado, nada se conclui: a conta antiga segue admin (R1).
  if (!novo?.fator || !novo.ativo) return false;
  const tenantId = t.clinicaId as TenantId;
  try {
    await b.dbAuth.transaction(async (ta) => {
      const [travada] = await ta.select({ estado: trocaDoAdmin.estado }).from(trocaDoAdmin).where(eq(trocaDoAdmin.id, t.id)).for('update');
      if (travada?.estado !== 'ativada') throw new TrocaMudou();
      // Na clínica, a conta nova age na própria sessão: admin ativo e agora com fator (o guard de hoje aceita).
      await withTenant(
        b.dbClinica,
        tenantId,
        async (ct) => {
          const ctx = { tenantId, userId: usuarioNovo as UserId, roles: [] };
          await revogarPerfisDe(ct, ctx, t.usuarioAntigo, t.chamado);
          await recordAudit(ct, ctx, {
            action: AuditAction.PermissionChange,
            scope: 'clinic_members',
            metadata: { op: 'admin_replaced', user_id: usuarioNovo, replaces: t.usuarioAntigo, ticket: t.chamado },
          });
        },
        usuarioNovo,
      );
      // O trigger da 0082 confere o TOTP da conta nova (R1) e o login da API.
      await ta.update(trocaDoAdmin).set({ estado: 'concluida', encerradaPor: 'sistema' }).where(eq(trocaDoAdmin.id, t.id));
      // Conta antiga: todas as sessões (de qualquer clínica) e os tokens pendentes caem.
      await ta.delete(sessao).where(eq(sessao.userId, t.usuarioAntigo));
      await ta.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, t.usuarioAntigo), isNull(recuperacao.usadoEm)));
      await ta
        .update(ativacaoDoFundador)
        .set({ usadoEm: sql`now()`, emailHmac: EMAIL_DESCARTADO })
        .where(and(eq(ativacaoDoFundador.usuarioId, t.usuarioAntigo), isNull(ativacaoDoFundador.usadoEm)));
      // R5: sem nenhum vínculo restante, `substituida` (nunca reativada nem concedida; expurgo em 90 dias).
      await ta
        .update(usuario)
        .set({ ativo: false, inativaPor: 'substituida' })
        .where(
          and(
            eq(usuario.id, t.usuarioAntigo),
            sql`(${usuario.ativo} or ${usuario.inativaPor} in ('sem_vinculo', 'suspensa_na_troca'))`,
            sql`not exists (select 1 from identidade.vinculo v where v.usuario_id = ${usuario.id})`,
          ),
        );
    });
  } catch (err) {
    if (err instanceof TrocaMudou) return false;
    throw err;
  }
  registrarEventoDeSeguranca('ADMIN_SUBSTITUIDO', { motivo: 'conclusao_da_troca', tenantId: t.clinicaId, userId: usuarioNovo, chamado: t.chamado, pedido: t.id });
  return true;
}

/**
 * Login completo (senha e TOTP) de uma conta. Se ela é a conta ANTIGA de uma troca em andamento, a troca para
 * (`suspensa`, crítico): quem tem os dois fatores não é quem disse tê-los perdido. Se é a de uma troca concluída, o
 * alarme crítico ao DPO (R5), no log de segurança e na trilha da clínica da troca.
 */
export async function aoLoginCompletoDaConta(b: BancosDaTrocaNaApi, userId: string): Promise<void> {
  const trocas = await b.dbAuth
    .select({ id: trocaDoAdmin.id, clinicaId: trocaDoAdmin.clinicaId, chamado: trocaDoAdmin.chamado, estado: trocaDoAdmin.estado, usuarioNovo: trocaDoAdmin.usuarioNovo })
    .from(trocaDoAdmin)
    .where(and(eq(trocaDoAdmin.usuarioAntigo, userId), inArray(trocaDoAdmin.estado, [...EM_ANDAMENTO, 'concluida'])));
  for (const t of trocas) {
    const ids = { tenantId: t.clinicaId, userId, chamado: t.chamado, pedido: t.id };
    if (t.estado === 'concluida') {
      registrarEventoDeSeguranca('CONTA_SUBSTITUIDA_ENTROU', { motivo: 'login_da_conta_substituida', ...ids });
      await withTenant(b.dbClinica, t.clinicaId as TenantId, (tx) =>
        recordAudit(tx, { tenantId: t.clinicaId as TenantId, userId: SYSTEM_ACTOR_ID, roles: [] }, {
          action: AuditAction.AnomalyAlert,
          scope: 'clinic_members',
          metadata: { op: 'replaced_account_login', user_id: userId, ticket: t.chamado },
        }),
      ).catch(() => registrarNoMaximoUmaVez(`troca-login:${t.id}`, 60_000, 'TRILHA_NAO_GRAVADA', { motivo: 'login_da_conta_substituida', ...ids }));
      continue;
    }
    // Ressalva 1 do parecer do código (#239): a suspensão derruba, na MESMA transação, os tokens vivos da conta nova
    // (ativação da troca e fator da reemissão) e todas as sessões dela, inclusive a de cadastro pendente. Mesma regra
    // de `identidade.encerrar_tokens_da_troca` (que é do papel da tarefa), aqui pelo `app_auth`. O cadastro do fator
    // da conta nova fora de troca `ativada` também é recusado no banco (0082) e em `cadastroLiberado`.
    const suspensa = await b.dbAuth.transaction(async (ta) => {
      const mudou = await ta
        .update(trocaDoAdmin)
        .set({ estado: 'suspensa', encerradaPor: 'login_da_conta_antiga' })
        .where(and(eq(trocaDoAdmin.id, t.id), eq(trocaDoAdmin.estado, t.estado)))
        .returning({ id: trocaDoAdmin.id });
      if (mudou.length === 0) return false;
      await ta
        .update(ativacaoDoFundador)
        .set({ usadoEm: sql`now()`, emailHmac: EMAIL_DESCARTADO })
        .where(and(eq(ativacaoDoFundador.trocaId, t.id), isNull(ativacaoDoFundador.usadoEm)));
      await ta.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, t.usuarioNovo), isNull(recuperacao.usadoEm)));
      await ta.delete(sessao).where(eq(sessao.userId, t.usuarioNovo));
      return true;
    });
    if (suspensa) registrarEventoDeSeguranca('TROCA_DO_ADMIN_SUSPENSA', { motivo: 'login_da_conta_antiga', ...ids });
  }
}

/**
 * "Não fui eu" (seção 5): a conta antiga contesta a troca em andamento. Devolve se havia troca a contestar.
 * A rota exige MFA recente (é o titular legítimo, com os dois fatores).
 */
export async function contestarTrocaDoAdmin(b: BancosDaTrocaNaApi, userId: string): Promise<boolean> {
  const [t] = await b.dbAuth
    .select({ id: trocaDoAdmin.id, clinicaId: trocaDoAdmin.clinicaId, chamado: trocaDoAdmin.chamado, estado: trocaDoAdmin.estado, usuarioNovo: trocaDoAdmin.usuarioNovo })
    .from(trocaDoAdmin)
    .where(and(eq(trocaDoAdmin.usuarioAntigo, userId), inArray(trocaDoAdmin.estado, [...ESTADOS_ABERTOS_DA_TROCA])));
  if (!t) return false;
  const tenantId = t.clinicaId as TenantId;
  // Ressalva 3 do parecer do código (#239): a trilha da clínica confirma ANTES da identidade. Se a clínica gravou e a
  // identidade falhou depois, a trilha diz "contestada" e a troca não: alarme imediato (TRILHA_NAO_GRAVADA).
  let clinicaGravou = false;
  try {
    await b.dbAuth.transaction(async (ta) => {
      const mudou = await ta
        .update(trocaDoAdmin)
        .set({ estado: 'contestada', encerradaPor: 'titular' })
        .where(and(eq(trocaDoAdmin.id, t.id), eq(trocaDoAdmin.estado, t.estado)))
        .returning({ id: trocaDoAdmin.id });
      if (mudou.length === 0) throw new TrocaMudou();
      await ta
        .update(ativacaoDoFundador)
        .set({ usadoEm: sql`now()`, emailHmac: EMAIL_DESCARTADO })
        .where(and(eq(ativacaoDoFundador.trocaId, t.id), isNull(ativacaoDoFundador.usadoEm)));
      await ta.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, t.usuarioNovo), isNull(recuperacao.usadoEm)));
      // A conta antiga, admin ativo, revoga o vínculo da conta nova na sessão dela; a trilha diz quem contestou.
      await withTenant(
        b.dbClinica,
        tenantId,
        async (ct) => {
          const ctx = { tenantId, userId: userId as UserId, roles: [] };
          await revogarPerfisDe(ct, ctx, t.usuarioNovo, t.chamado);
          await recordAudit(ct, ctx, { action: AuditAction.PermissionChange, scope: 'clinic_members', metadata: { op: 'admin_replacement_contested', ticket: t.chamado } });
        },
        userId,
      );
      clinicaGravou = true;
    });
  } catch (err) {
    if (err instanceof TrocaMudou) return false;
    if (clinicaGravou) {
      registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo: 'contestacao_da_troca', tenantId: t.clinicaId, userId, chamado: t.chamado, pedido: t.id });
    }
    throw err;
  }
  registrarEventoDeSeguranca('TROCA_DO_ADMIN_CONTESTADA', { motivo: 'titular', tenantId: t.clinicaId, userId, chamado: t.chamado, pedido: t.id });
  return true;
}

/** O que o aviso fixo do app recebe (minimização): nada do e-mail novo, da conta nova, do chamado nem de quem pediu. */
export interface TrocaEmJanela {
  /** Fim da janela de 48 h (ISO 8601, UTC). */
  readonly liberaEm: string;
  /** A troca está parada (login completo da conta antiga ou suspeita), à espera da decisão do DPO. */
  readonly suspensa: boolean;
}

/**
 * Aviso fixo do app (seção 5, canal "App, pela conta antiga"): a troca em andamento em que a pessoa da sessão é a
 * conta ANTIGA, NA clínica da sessão (o tenant vem só da sessão no servidor). Mesmos estados que o "não fui eu"
 * aceita. Outra clínica, outro membro e a conta nova não veem nada. Defesa em profundidade: o vínculo ativo da pessoa
 * nessa clínica é conferido na própria clínica, sob o RLS (sem vínculo, sem aviso).
 */
export async function trocaEmJanelaDaSessao(b: BancosDaTrocaNaApi, userId: string, clinicaId: string): Promise<TrocaEmJanela | null> {
  const [t] = await b.dbAuth
    .select({ liberaEm: trocaDoAdmin.liberaEm, estado: trocaDoAdmin.estado })
    .from(trocaDoAdmin)
    .where(and(eq(trocaDoAdmin.usuarioAntigo, userId), eq(trocaDoAdmin.clinicaId, clinicaId), inArray(trocaDoAdmin.estado, [...ESTADOS_ABERTOS_DA_TROCA])))
    .limit(1);
  if (!t) return null;
  const vinculo = await withTenant(
    b.dbClinica,
    clinicaId as TenantId,
    (ct) =>
      ct
        .select({ id: clinicMembers.id })
        .from(clinicMembers)
        .where(and(eq(clinicMembers.tenantId, clinicaId), eq(clinicMembers.userId, userId), isNull(clinicMembers.revokedAt)))
        .limit(1),
    userId,
  );
  if (vinculo.length === 0) return null;
  return { liberaEm: t.liberaEm.toISOString(), suspensa: t.estado === 'suspensa' };
}

/** Job `identidade-expurgo`: refaz a conclusão das trocas `ativada` cuja conta nova já tem o TOTP (R1). */
export async function concluirTrocasPendentes(b: BancosDaTrocaNaApi): Promise<number> {
  const prontas = await b.dbAuth
    .select({ novo: trocaDoAdmin.usuarioNovo })
    .from(trocaDoAdmin)
    .innerJoin(usuario, eq(usuario.id, trocaDoAdmin.usuarioNovo))
    .where(and(eq(trocaDoAdmin.estado, 'ativada'), eq(usuario.twoFactorEnabled, true), eq(usuario.ativo, true)));
  let n = 0;
  for (const { novo } of prontas) {
    try {
      if (await concluirTrocaDoAdmin(b, novo)) n += 1;
    } catch {
      registrarNoMaximoUmaVez(`troca-conclusao:${novo}`, 60_000, 'TRILHA_NAO_GRAVADA', { motivo: 'conclusao_da_troca', userId: novo });
    }
  }
  return n;
}

/** Retenção (seção 12): a troca encerrada sai em 13 meses (o trigger da 0082 recusa qualquer outra). */
export async function expurgarTrocasAntigas(b: BancosDaTrocaNaApi): Promise<number> {
  const apagadas = await b.dbAuth
    .delete(trocaDoAdmin)
    .where(
      and(
        inArray(trocaDoAdmin.estado, ['concluida', 'contestada', 'cancelada', 'vencida']),
        sql`${trocaDoAdmin.pedidoEm} < now() - interval '13 months'`,
        sql`not exists (select 1 from identidade.ativacao_do_fundador a where a.troca_id = ${trocaDoAdmin.id})`,
      ),
    )
    .returning({ id: trocaDoAdmin.id });
  return apagadas.length;
}

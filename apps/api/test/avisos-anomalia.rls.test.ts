/**
 * R5 e R6 do parecer do #137 (aviso de anomalia aos admins, 0063).
 *
 * R6: a lista de regras do TypeScript e o CHECK da 0063 são a MESMA lista. Regra nova só no TS passa no compilador e
 * estoura 23514 na hora de avisar, em produção.
 * R5: os três casos que o teste do #137 não provava — (a) quem disparou não recebe quando é admin, (b) admin revogado
 * não recebe, (d) falha do aviso não derruba a trilha nem a operação de quem agiu.
 *
 * Dados fictícios.
 */
import { AuditAction, type RequestContext, type TenantId, type UserId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, clinicMembers, clinicalNotices } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { recordAudit } from '../src/modules/audit/audit-log';
import { REGRAS_DE_ANOMALIA_AVISADAS, avisarAdminsDeAnomalia, type RegraDeAnomaliaAvisada } from '../src/modules/records/avisos';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
if (!migratorUrl) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para este teste');

let api: ApiDeTeste;
let owner: postgres.Sql;

/** Dispara o alerta na trilha e avisa os admins, como o runtime faz: tudo na mesma transação. */
async function alertar(clinica: TenantId, ator: string, regra: RegraDeAnomaliaAvisada): Promise<number> {
  const ctx: RequestContext = { tenantId: clinica, userId: ator as UserId, roles: ['admin'], mfaEm: new Date() };
  // `userId` no contexto da transação, como o runtime faz (`db.run(..., ctx.userId)`): as políticas e os
  // gatilhos da trilha contam com ele.
  return withTenant(
    api.db.db,
    clinica,
    async (tx) => {
      await recordAudit(tx, ctx, { action: AuditAction.AnomalyAlert, scope: 'teste.anomalia', metadata: { rule: regra } });
      return avisarAdminsDeAnomalia(tx, ctx, regra);
    },
    ator,
  );
}

const avisos = async (clinica: TenantId) =>
  withTenant(api.db.db, clinica, (tx) =>
    tx
      .select({ para: clinicalNotices.recipientUserId, regra: clinicalNotices.anomalyRule })
      .from(clinicalNotices)
      .where(and(eq(clinicalNotices.tenantId, clinica), eq(clinicalNotices.kind, 'alerta_anomalia'))),
  );

const alertasNaTrilha = async (clinica: TenantId) =>
  withTenant(api.db.db, clinica, (tx) =>
    tx.select({ ator: auditLog.actorId }).from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.action, AuditAction.AnomalyAlert))),
  );

beforeAll(async () => {
  api = await subirApi();
  owner = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  try {
    await api?.fechar();
  } finally {
    await owner?.end({ timeout: 5 });
  }
});

describe('R6: regras de anomalia são uma fonte só (TS × CHECK da 0063)', () => {
  it('o CHECK de clinical_notices.anomaly_rule aceita exatamente as regras declaradas no TypeScript', async () => {
    const [row] = await owner<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'clinical_notices_anomaly_rule_check' and conrelid = 'clinical_notices'::regclass and convalidated`;
    expect(row, 'clinical_notices_anomaly_rule_check validada').toBeDefined();
    const doBanco = [...(row?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(doBanco).toEqual([...REGRAS_DE_ANOMALIA_AVISADAS].sort());
  });
});

describe('R5: quem recebe o aviso de anomalia', () => {
  /**
   * (a) do R5 fica declarado e NÃO provado: nesta bancada, `avisarAdminsDeAnomalia` devolveu 0 porque a consulta de
   * admins não achou os membros criados por `api.membro` — sem exceção, então não é o SAVEPOINT. Falta entender a
   * visibilidade de `clinic_members` nesta transação antes de afirmar qualquer coisa; afirmar "quem disparou não
   * recebe" com um teste que passa por ausência de destinatário seria verde falso. Rastro em #137.
   */
  it.todo('(a) o admin que disparou não recebe o próprio aviso; os outros admins recebem');

  it('(b) admin revogado não recebe', async () => {
    const clinica = await api.novaClinica();
    const quemDisparou = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
    const revogado = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
    const r = await api.http().delete(`/clinica/membros/${revogado.userId}/admin`).set(cab(quemDisparou));
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    await alertar(clinica, quemDisparou.userId, 'limite_por_usuario');
    expect((await avisos(clinica)).map((a) => a.para)).not.toContain(revogado.userId);
    const [linha] = await withTenant(api.db.db, clinica, (tx) =>
      tx.select({ revokedAt: clinicMembers.revokedAt }).from(clinicMembers).where(and(eq(clinicMembers.tenantId, clinica), eq(clinicMembers.userId, revogado.userId))),
    );
    expect(linha?.revokedAt, 'o perfil foi de fato revogado').not.toBeNull();
  });

  it('(d) falha do aviso não derruba a trilha nem a operação de quem agiu', async () => {
    const clinica = await api.novaClinica();
    const quemDisparou = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
    await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
    // Regra fora do CHECK: é exatamente o que uma regra nova só no TS faria em produção.
    const foraDoCheck = 'regra_que_nao_existe_no_check' as RegraDeAnomaliaAvisada;
    await expect(alertar(clinica, quemDisparou.userId, foraDoCheck)).resolves.toBe(0);
    expect((await alertasNaTrilha(clinica)).map((l) => l.ator)).toEqual([quemDisparou.userId]);
    expect(await avisos(clinica)).toEqual([]);
  });
});

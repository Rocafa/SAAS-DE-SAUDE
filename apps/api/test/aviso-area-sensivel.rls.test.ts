/**
 * E8 da revisão interna de 04/11 (0060): desmarcar a área sensível de um profissional avisa o próprio profissional e
 * os DEMAIS admins ativos, nunca quem desmarcou. Marcar não avisa. O aviso leva só o id do profissional. Fictício.
 */
import type { TenantId } from '@plataforma/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, clinicalNotices } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type S = { Authorization: string; userId: string };
let api: ApiDeTeste;
let clinica: TenantId;
let adminA: S;
let adminB: S;
let prof: S;
let profissionalId: string;

const avisos = async (s: S) => ((await api.http().get('/avisos').set(cab(s))).body as { tipo: string; profissionalId?: string; criadoPor?: string }[]).filter((a) => a.tipo === 'area_sensivel_desmarcada');
const marcar = (sensivel: boolean) => api.http().post(`/profissionais/${profissionalId}/area-sensivel`).set(cab(adminA)).send({ areaSensivel: sensivel });

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  adminA = await api.membro(clinica, api.sessao(clinica, 'admin', 'profissional'), 'admin', 'profissional');
  adminB = await api.membro(clinica, api.sessao(clinica, 'admin', 'profissional'), 'admin', 'profissional');
  prof = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional');
  const p = await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Prof Ficticio Area', especialidade: 'Fisioterapia', usuarioId: prof.userId });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  profissionalId = (p.body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('E8: aviso ao desmarcar a área sensível', () => {
  // Especialidade comum: o banco força a área sensível de especialidade sensível (Psicologia etc., 0033), e ali
  // desmarcar não muda nada (e não avisa). O risco do E8 é a área sensível marcada à mão.
  it('marcar não avisa ninguém', async () => {
    const r = await marcar(true);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await avisos(prof)).toEqual([]);
    expect(await avisos(adminB)).toEqual([]);
  });

  it('desmarcar avisa o profissional e o outro admin, com só o id do profissional; quem desmarcou não recebe', async () => {
    expect((await marcar(false)).status).toBe(201);
    for (const s of [prof, adminB]) {
      const [a, ...resto] = await avisos(s);
      expect(resto).toEqual([]);
      expect(a).toMatchObject({ tipo: 'area_sensivel_desmarcada', profissionalId, criadoPor: adminA.userId });
      expect(Object.keys(a ?? {}).sort()).toEqual(['criadoEm', 'criadoPor', 'id', 'lidoEm', 'profissionalId', 'tipo']);
    }
    expect(await avisos(adminA)).toEqual([]);
  });

  it('desmarcar de novo (já desmarcada) não repete o aviso; a trilha registra quantos foram avisados', async () => {
    expect((await marcar(false)).status).toBe(201);
    expect(await avisos(prof)).toHaveLength(1);
    const linhas = await withTenant(api.db.db, clinica, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, clinica), eq(auditLog.scope, 'professionals'), sql`${auditLog.metadata}->>'op' = 'sensitive_area'`))
        .orderBy(asc(auditLog.id)),
    );
    // O id da trilha é UUID (sem ordem): confere o conjunto. Marcar, desmarcar e desmarcar de novo: 0, 3 e 0 (o fundador,
    // o outro admin e o profissional são avisados uma vez só).
    expect(linhas.map((l) => (l.metadata as { notified?: number }).notified).sort()).toEqual([0, 0, 3]);
  });

  it('o banco recusa o tipo novo sem o id do profissional ou com campos de outro tipo', async () => {
    const tentar = (valores: Partial<typeof clinicalNotices.$inferInsert>) =>
      withTenant(
        api.db.db,
        clinica,
        (tx) => tx.insert(clinicalNotices).values({ tenantId: clinica, recipientUserId: prof.userId, kind: 'area_sensivel_desmarcada', createdBy: adminA.userId, ...valores }),
        adminA.userId,
      ).then(
        () => 'ok',
        (e: unknown) => String((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code),
      );
    // R2 do parecer do #133: a forma certa passa direto no banco (o ELSE antigo da shape_check barrava tudo).
    expect(await tentar({ professionalId: profissionalId })).toBe('ok');
    expect(await tentar({})).toBe('23514');
    expect(await tentar({ professionalId: profissionalId, patientId: profissionalId })).not.toBe('ok');
    expect(await tentar({ kind: 'perfil_alterado', professionalId: profissionalId, subjectUserId: prof.userId, subjectRole: 'admin', change: 'concedido' })).toBe('23514');
  });
});

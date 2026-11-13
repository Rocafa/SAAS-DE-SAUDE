/**
 * 0074: conselho e número de registro do profissional (Res. COFFITO 414/2012 e 415/2012, art. 1º §1º VIII). Gestão do
 * admin com MFA recente; a trilha leva o conselho, não o número; o banco recusa um sem o outro e formato fora da regra.
 * Dados fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, professionals } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let outra: TenantId;
let admin: { Authorization: string; userId: string };
let profissionalId: string;

const definir = (s: { Authorization: string }, id: string, corpo: object) => api.http().post(`/profissionais/${id}/conselho`).set(cab(s)).send(corpo);

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  outra = await api.novaClinica();
  admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  const p = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticia Conselho', especialidade: 'Fisioterapia' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  profissionalId = (p.body as { id: string }).id;
  expect(p.body).toMatchObject({ conselho: null, registro: null });
});

afterAll(async () => {
  await api?.fechar();
});

describe('conselho e número de registro do profissional (0074)', () => {
  it('o admin define; o DTO e a lista devolvem; a trilha leva o conselho, nunca o número', async () => {
    const r = await definir(admin, profissionalId, { conselho: 'CREFITO', registro: '3/123456-F' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ id: profissionalId, conselho: 'CREFITO', registro: '3/123456-F' });
    const lista = (await api.http().get('/profissionais').set(cab(admin))).body as { id: string; registro: string | null }[];
    expect(lista.find((x) => x.id === profissionalId)?.registro).toBe('3/123456-F');
    const trilha = await withTenant(api.db.db, clinica, (tx) =>
      tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.tenantId, clinica), sql`${auditLog.metadata}->>'op' = 'council_registration'`)),
    );
    expect(trilha.map((t) => t.metadata)).toEqual([{ op: 'council_registration', professional_id: profissionalId, council: 'CREFITO', had_registration: false }]);
    expect(JSON.stringify(trilha)).not.toContain('123456');
  });

  it('conselho fora da lista, número fora do formato ou campo a mais: 400', async () => {
    for (const corpo of [
      { conselho: 'XYZ', registro: '123' },
      { conselho: 'CREFITO', registro: 'Fulano de Tal' },
      { conselho: 'CREFITO', registro: '' },
      { conselho: 'CREFITO' },
      { conselho: 'CREFITO', registro: '123', nome: 'x' },
    ]) {
      expect((await definir(admin, profissionalId, corpo)).status, JSON.stringify(corpo)).toBe(400);
    }
  });

  it('só quem gere cadastros, com MFA recente; de outra clínica: 404', async () => {
    const recepcao = api.sessao(clinica, 'recepcao');
    expect((await definir(recepcao, profissionalId, { conselho: 'CREFITO', registro: '1' })).status).toBe(403);
    const semMfa = { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId: admin.userId, perfis: ['admin'], mfaEm: null })}` };
    expect((await definir(semMfa, profissionalId, { conselho: 'CREFITO', registro: '1' })).status).toBe(403);
    const adminOutra = await api.membro(outra, api.sessao(outra, 'admin'), 'admin');
    expect((await definir(adminOutra, profissionalId, { conselho: 'CREFITO', registro: '1' })).status).toBe(404);
  });

  it('o banco recusa conselho sem número (e vice-versa) e número fora do formato, mesmo por SQL direto', async () => {
    const tentar = (set: Record<string, unknown>) =>
      withTenant(api.db.db, clinica, (tx) => tx.update(professionals).set(set).where(eq(professionals.id, profissionalId)), admin.userId).then(
        () => 'ok',
        (e: unknown) => {
          for (let x: unknown = e; x instanceof Error; x = x.cause) {
            const code = (x as { code?: unknown }).code;
            if (typeof code === 'string') return code;
          }
          return 'erro';
        },
      );
    expect(await tentar({ councilRegistration: null })).toBe('23514');
    expect(await tentar({ council: null })).toBe('23514');
    expect(await tentar({ councilRegistration: 'nome@exemplo' })).toBe('23514');
  });
});

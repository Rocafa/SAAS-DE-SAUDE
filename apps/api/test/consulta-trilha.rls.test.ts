/**
 * E10 da revisão interna de 04/11: a clínica consulta a própria trilha (`GET /clinica/auditoria`). Só admin, com MFA
 * recente; filtra por paciente, usuário e ação; pagina; nunca mostra outra clínica; a consulta vai para a trilha.
 * Dados fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type S = { Authorization: string; userId: string };
type Pagina = { itens: { id: string; acao: string; escopo: string; atorId: string; metadata: Record<string, unknown> }[]; proximo: string | null };
let api: ApiDeTeste;
let clinica: TenantId;
let outra: TenantId;
let admin: S;
let recep: S;
let paciente: string;

const consultar = (s: { Authorization: string }, q = '') => api.http().get(`/clinica/auditoria${q}`).set(cab(s));

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  outra = await api.novaClinica();
  admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  recep = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
  const r = await api.http().post('/pacientes').set(cab(recep)).send({ nome: 'Paciente Ficticio Trilha', telefone: '11900000071' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  paciente = (r.body as { id: string }).id;
  await api.http().get(`/pacientes/${paciente}`).set(cab(recep)).expect(200);
  // Algo na outra clínica, para provar o isolamento.
  const adminOutra = await api.membro(outra, api.sessao(outra, 'admin'), 'admin');
  await api.http().post('/pacientes').set(cab(adminOutra)).send({ nome: 'Paciente Ficticio Outra', telefone: '11900000072' }).expect(201);
});

afterAll(async () => {
  await api?.fechar();
});

describe('E10: consulta da trilha pela clínica', () => {
  it('recepção não consulta (403); admin com MFA antigo também não (mfa_recente_obrigatorio)', async () => {
    expect((await consultar(recep)).status).toBe(403);
    const velho = { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId: admin.userId, perfis: ['admin'], mfaEm: new Date(Date.now() - MFA_RECENTE_MS - 60_000) })}` };
    const r = await consultar(velho);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
  });

  it('filtro por paciente: só as linhas com aquele patient_id, de quem agiu, sem nada da outra clínica', async () => {
    const r = await consultar(admin, `?pacienteId=${paciente}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { itens } = r.body as Pagina;
    expect(itens.length).toBeGreaterThanOrEqual(2);
    for (const i of itens) expect(i.metadata['patient_id']).toBe(paciente);
    expect(itens.some((i) => i.atorId === recep.userId && i.acao === 'read')).toBe(true);
    expect(JSON.stringify(itens)).not.toContain('Paciente Ficticio');
  });

  it('filtro por usuário e por ação', async () => {
    const r = await consultar(admin, `?usuarioId=${recep.userId}&acao=create`);
    const { itens } = r.body as Pagina;
    expect(itens.length).toBeGreaterThanOrEqual(1);
    for (const i of itens) expect([i.atorId, i.acao]).toEqual([recep.userId, 'create']);
  });

  it('paginação por cursor: páginas sem repetição até acabar', async () => {
    const vistos = new Set<string>();
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const q: string = cursor ? `?limite=2&cursor=${cursor}` : '?limite=2';
      const r = await consultar(admin, q);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const p = r.body as Pagina;
      expect(p.itens.length).toBeLessThanOrEqual(2);
      for (const i of p.itens) {
        expect(vistos.has(i.id)).toBe(false);
        vistos.add(i.id);
      }
      cursor = p.proximo;
      paginas++;
    } while (cursor && paginas < 50);
    expect(paginas).toBeGreaterThan(1);
  });

  it('a consulta vai para a trilha (read audit_trail) com os filtros, só ids', async () => {
    await consultar(admin, `?pacienteId=${paciente}`).expect(200);
    const linhas = await withTenant(api.db.db, clinica, (tx) =>
      tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.actorId, admin.userId), eq(auditLog.scope, 'audit_trail'))),
    );
    expect(linhas.some((l) => (l.metadata as Record<string, unknown>)['patient_id'] === paciente)).toBe(true);
  });

  it('filtro inválido: 400', async () => {
    expect((await consultar(admin, '?acao=drop_table')).status).toBe(400);
    expect((await consultar(admin, '?nome=Maria')).status).toBe(400);
  });
});

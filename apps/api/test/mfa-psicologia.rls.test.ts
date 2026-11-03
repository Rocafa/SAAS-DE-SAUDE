/**
 * R3 do parecer do #123: no prontuário, MFA recente só no compartimento de psicologia. Ver ou mexer num atendimento
 * de psicologia sem MFA recente é 403 auditado; no histórico, o conteúdo de psicologia vem oculto e o resto aparece.
 * Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { SCOPE_ACESSO_NEGADO } from '../src/modules/records/acesso-clinico';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let psiUserId: string;
let pacienteId: string;
let atPsi: string;

const sessaoPsi = (mfaEm: Date | null) => ({ Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId: psiUserId, perfis: ['profissional'], mfaEm })}` });
const antigo = () => new Date(Date.now() - MFA_RECENTE_MS - 60_000);

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  const psi = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'psicologo');
  psiUserId = psi.userId;
  const prof = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Psi Ficticia MFA', especialidade: 'Psicologia', usuarioId: psiUserId });
  expect(prof.status, JSON.stringify(prof.body)).toBe(201);
  const tipo = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao', minutos: 50 });
  const pac = await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticia Psi MFA', telefone: '11900000041' });
  pacienteId = (pac.body as { id: string }).id;
  const ag = randomUUID();
  const recepcao = randomUUID();
  await withTenant(
    api.db.db,
    clinica,
    (tx) =>
      tx.insert(appointments).values({
        createdBy: recepcao,
        id: ag,
        tenantId: clinica,
        patientId: pacienteId,
        professionalId: (prof.body as { id: string }).id,
        appointmentTypeId: (tipo.body as { id: string }).id,
        startsAt: new Date(Date.now() - 10 * 60_000),
        endsAt: new Date(Date.now() + 40 * 60_000),
        status: 'checked_in',
      }),
    recepcao,
  );
  const at = await api.http().post('/atendimentos').set(cab(sessaoPsi(new Date()))).send({ agendamentoId: ag });
  expect(at.status, JSON.stringify(at.body)).toBe(200);
  atPsi = (at.body as { id: string; restrito: boolean }).id;
  expect((at.body as { restrito: boolean }).restrito).toBe(true);
  await api.http().put(`/atendimentos/${atPsi}/registro`).set(cab(sessaoPsi(new Date()))).send({ versaoBase: 0, conteudo: { queixa: 'Queixa ficticia psi' } }).expect(200);
});

afterAll(async () => {
  await api?.fechar();
});

describe('R3 do #123: MFA recente só na psicologia', () => {
  it('ver, salvar e ver versões de atendimento de psicologia sem MFA recente: 403 mfa_recente_obrigatorio, auditado', async () => {
    const velho = sessaoPsi(antigo());
    for (const [metodo, url, corpo] of [
      ['get', `/atendimentos/${atPsi}`, undefined],
      ['get', `/atendimentos/${atPsi}/versoes`, undefined],
      ['put', `/atendimentos/${atPsi}/registro`, { versaoBase: 1, conteudo: { queixa: 'Tentativa ficticia' } }],
    ] as const) {
      const req = metodo === 'get' ? api.http().get(url) : api.http().put(url).send(corpo);
      const r = await req.set(cab(velho));
      expect(r.status, url).toBe(403);
      expect(r.body, url).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
    }
    const negadas = await withTenant(api.db.db, clinica, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.actorId, psiUserId), eq(auditLog.scope, SCOPE_ACESSO_NEGADO))),
    );
    expect(negadas.filter((l) => (l.metadata as { reason?: string }).reason === 'mfa_recente_obrigatorio').length).toBeGreaterThanOrEqual(3);
  });

  it('com MFA recente, o autor vê o atendimento de psicologia', async () => {
    const r = await api.http().get(`/atendimentos/${atPsi}`).set(cab(sessaoPsi(new Date())));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ conteudoOculto: false, conteudo: { queixa: 'Queixa ficticia psi' } });
  });

  it('histórico sem MFA recente: o atendimento de psicologia aparece com o conteúdo oculto, sem 403', async () => {
    const velho = await api.http().get(`/pacientes/${pacienteId}/prontuario`).set(cab(sessaoPsi(antigo())));
    expect(velho.status, JSON.stringify(velho.body)).toBe(200);
    const item = (velho.body as { itens: { id: string; conteudoOculto: boolean; conteudo: unknown }[] }).itens.find((i) => i.id === atPsi);
    expect(item).toMatchObject({ conteudoOculto: true, conteudo: null, motivoOculto: 'mfa_recente_obrigatorio' });
    const novo = await api.http().get(`/pacientes/${pacienteId}/prontuario`).set(cab(sessaoPsi(new Date())));
    expect((novo.body as { itens: { id: string; conteudoOculto: boolean }[] }).itens.find((i) => i.id === atPsi)?.conteudoOculto).toBe(false);
  });
});

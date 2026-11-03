/**
 * Política de MFA na API real (issue #106, S3): obrigatório por perfil e recente nas rotas de conteúdo clínico mais
 * sensível. A sessão é fictícia (DevSessionProvider); o provedor real (D4) só vai informar `mfaEm`. Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let pacienteId: string;

function sessao(perfis: string[], mfaEm: Date | null, userId: string = randomUUID()) {
  return { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId, perfis, mfaEm })}`, userId };
}

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const r = await api.http().post('/pacientes').set(cab(api.sessao(clinica, 'recepcao'))).send({ nome: 'Paciente Ficticia MFA', telefone: '11900000031' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  pacienteId = (r.body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('issue #106: MFA obrigatório por perfil e recente nas rotas sensíveis', () => {
  it('admin, profissional e financeiro sem MFA: 403 mfa_obrigatorio; recepção sem MFA passa', async () => {
    for (const perfil of ['admin', 'profissional', 'financeiro']) {
      const r = await api.http().get('/pacientes').set(cab(sessao([perfil], null)));
      expect(r.status, perfil).toBe(403);
      expect(r.body, perfil).toMatchObject({ codigo: 'mfa_obrigatorio' });
    }
    expect((await api.http().get('/pacientes').set(cab(sessao(['recepcao'], null)))).status).toBe(200);
    // MFA feito há horas basta para rota comum.
    expect((await api.http().get('/pacientes').set(cab(sessao(['admin'], new Date(Date.now() - 8 * 3_600_000))))).status).toBe(200);
  });

  it('notas privadas exigem MFA dos últimos 15 minutos', async () => {
    const userId = randomUUID();
    const antigo = sessao(['profissional'], new Date(Date.now() - MFA_RECENTE_MS - 60_000), userId);
    const r = await api.http().get(`/pacientes/${pacienteId}/notas-privadas`).set(cab(antigo));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
    expect((await api.http().get(`/notas-privadas/${randomUUID()}`).set(cab(antigo))).body).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
    // Com MFA recente o guard deixa passar (o que vem depois é regra do serviço, não do MFA).
    const recente = await api.http().get(`/pacientes/${pacienteId}/notas-privadas`).set(cab(sessao(['profissional'], new Date(), userId)));
    expect((recente.body as { codigo?: string }).codigo ?? '').not.toMatch(/^mfa_/);
  });

  it('GET /sessao informa quando foi o MFA (o cliente sabe se pede o código antes)', async () => {
    const quando = new Date(Date.now() - 60_000);
    const r = await api.http().get('/sessao').set(cab(sessao(['recepcao'], quando)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mfaEm: quando.toISOString() });
    expect((await api.http().get('/sessao').set(cab(sessao(['recepcao'], null)))).body).toMatchObject({ mfaEm: null });
  });
});

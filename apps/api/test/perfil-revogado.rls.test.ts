/**
 * E2 da revisão interna de 04/11 (lado da equipe): revogar um perfil corta a sessão ABERTA na próxima requisição,
 * e desligar alguém (todas as linhas revogadas) tira todo acesso, mesmo o que a sessão diz ter. Dados fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let admin: { Authorization: string; userId: string };

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
});

afterAll(async () => {
  await api?.fechar();
});

const listar = (s: { Authorization: string }) => api.http().get('/pacientes').set(cab(s));

describe('E2: perfil revogado no banco sai da sessão aberta', () => {
  it('recepção revogada: a mesma sessão passa de 200 a 403; concedida de novo, volta a 200', async () => {
    const recep = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
    expect((await listar(recep)).status).toBe(200);
    await api.http().delete(`/clinica/membros/${recep.userId}/recepcao`).set(cab(admin)).expect(204);
    expect((await listar(recep)).status).toBe(403);
    await api.http().post('/clinica/membros').set(cab(admin)).send({ usuarioId: recep.userId, perfil: 'recepcao' }).expect(201);
    expect((await listar(recep)).status).toBe(200);
  });

  it('desligado (nenhuma linha ativa): perde tudo, inclusive o perfil que a sessão diz ter e nunca foi para o banco', async () => {
    const ex = await api.membro(clinica, api.sessao(clinica, 'admin', 'financeiro'), 'recepcao');
    expect((await listar(ex)).status).toBe(200);
    await api.http().delete(`/clinica/membros/${ex.userId}/recepcao`).set(cab(admin)).expect(204);
    expect((await listar(ex)).status).toBe(403);
    expect((await api.http().get('/clinica/membros').set(cab(ex))).status).toBe(403);
  });

  it('sem linha no banco: a sessão vale como o provedor disse (transição até a D4)', async () => {
    expect((await listar(api.sessao(clinica, 'recepcao'))).status).toBe(200);
  });

  it('o perfil revogado de uma clínica não afeta o mesmo usuário em outra', async () => {
    const outra = await api.novaClinica();
    const recep = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
    const naOutra = { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: outra, userId: recep.userId, perfis: ['recepcao'] })}` };
    await api.http().delete(`/clinica/membros/${recep.userId}/recepcao`).set(cab(admin)).expect(204);
    expect((await listar(recep)).status).toBe(403);
    expect((await listar(naOutra)).status).toBe(200);
  });
});

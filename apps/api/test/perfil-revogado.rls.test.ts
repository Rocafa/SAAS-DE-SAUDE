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

  it('R1 do parecer do #130: com linha no banco, perfil que só a sessão diz ter não vale (admin pela palavra do provedor)', async () => {
    const s = await api.membro(clinica, api.sessao(clinica, 'admin', 'recepcao'), 'recepcao');
    expect((await listar(s)).status).toBe(200);
    expect((await api.http().get('/clinica/membros').set(cab(s))).status).toBe(403);
  });

  it('desligado (nenhum perfil de sessão ativo): perde tudo', async () => {
    const ex = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
    expect((await listar(ex)).status).toBe(200);
    await api.http().delete(`/clinica/membros/${ex.userId}/recepcao`).set(cab(admin)).expect(204);
    expect((await listar(ex)).status).toBe(403);
  });

  it('R2 do parecer do #130: a qualificação psicologo ativa não segura quem teve o perfil revogado', async () => {
    const psi = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional', 'psicologo');
    expect((await listar(psi)).status).toBe(200);
    await api.http().delete(`/clinica/membros/${psi.userId}/profissional`).set(cab(admin)).expect(204);
    expect((await listar(psi)).status).toBe(403);
  });

  it('sem linha no banco: a sessão vale como o provedor disse (transição até a D4)', async () => {
    expect((await listar(api.sessao(clinica, 'recepcao'))).status).toBe(200);
  });

  it('o perfil revogado de uma clínica não afeta o mesmo usuário em outra', async () => {
    const outra = await api.novaClinica();
    const recep = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
    // Registrado também na outra clínica: lá a decisão passa pela leitura do banco, não pela regra de transição.
    const naOutra = await api.membro(outra, { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: outra, userId: recep.userId, perfis: ['recepcao'] })}`, userId: recep.userId }, 'recepcao');
    await api.http().delete(`/clinica/membros/${recep.userId}/recepcao`).set(cab(admin)).expect(204);
    expect((await listar(recep)).status).toBe(403);
    expect((await listar(naOutra)).status).toBe(200);
  });
});

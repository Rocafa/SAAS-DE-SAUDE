import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DevSessionProvider } from '../auth/dev-session.provider';
import { createPortalAuthProvider, DevPortalSessionProvider } from './portal-auth';

describe('sessão do portal do paciente (separada da clínica)', () => {
  it('só sobe em development/test (lista fechada); produção, staging e vazio recusam', () => {
    for (const nodeEnv of ['production', 'staging', 'homolog', 'Production', '', undefined]) {
      expect(() => createPortalAuthProvider({ NODE_ENV: nodeEnv })).toThrow(/produção|staging/);
      expect(() => new DevPortalSessionProvider(nodeEnv ?? '')).toThrow();
    }
    expect(createPortalAuthProvider({ NODE_ENV: 'test' }).tipo).toBe('dev');
    expect(() => createPortalAuthProvider({ NODE_ENV: 'test', PORTAL_AUTH_PROVIDER: 'outro' })).toThrow(/desconhecido/);
  });

  it('a identidade é só a conta; o vínculo escolhido fica no servidor', async () => {
    const p = new DevPortalSessionProvider('test');
    const conta = randomUUID();
    const token = p.criarSessao({ contaId: conta });
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(await p.resolver(req)).toEqual({ contaId: conta, vinculoId: null });
    const vinculo = randomUUID();
    await p.escolherVinculo(req, vinculo);
    expect(await p.resolver(req)).toEqual({ contaId: conta, vinculoId: vinculo });
    p.encerrarSessao(token);
    expect(await p.resolver(req)).toBeNull();
  });

  it('token da clínica não abre o portal e token do portal não abre a clínica', async () => {
    const portal = new DevPortalSessionProvider('test');
    const clinica = new DevSessionProvider('test');
    const tokenClinica = clinica.criarSessao({ tenantId: randomUUID(), userId: randomUUID(), perfis: ['admin'] });
    const tokenPortal = portal.criarSessao({ contaId: randomUUID() });
    expect(await portal.resolver({ headers: { authorization: `Bearer ${tokenClinica}` } })).toBeNull();
    expect(await portal.resolver({ headers: { authorization: `Bearer ptl_${tokenClinica}` } })).toBeNull();
    expect(await clinica.resolver({ headers: { authorization: `Bearer ${tokenPortal}` } })).toBeNull();
    expect(await clinica.resolver({ headers: { authorization: `Bearer ${tokenPortal.slice(4)}` } })).toBeNull();
  });

  it('cabeçalhos de paciente/clínica não entram na sessão', async () => {
    const p = new DevPortalSessionProvider('test');
    const conta = randomUUID();
    const token = p.criarSessao({ contaId: conta });
    const s = await p.resolver({
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': randomUUID(), 'x-paciente-id': randomUUID(), 'x-vinculo-id': randomUUID() },
    });
    expect(s).toEqual({ contaId: conta, vinculoId: null });
  });
});

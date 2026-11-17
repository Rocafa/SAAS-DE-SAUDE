/**
 * Contrato de todo provedor de sessão (R6 do parecer do #123; #128). A suíte está em `test/apoio-contrato-provedor.ts`.
 * Aqui roda a sessão fictícia (`dev`); o provedor real (`better-auth`) roda a mesma suíte com banco em
 * `test/contrato-provedor-better-auth.rls.test.ts`. Tipo novo na fábrica sem bancada declarada aqui não compila.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { executarContrato, type BancadaDoProvedor } from '../../../test/apoio-contrato-provedor';
import { TIPOS_DE_PROVEDOR, type TipoDeProvedor } from './auth-provider.factory';
import { DevSessionProvider } from './dev-session.provider';

function bancadaDev(): Promise<BancadaDoProvedor> {
  const provider = new DevSessionProvider('test');
  return Promise.resolve({
    provider,
    sessao: (d) => {
      const tenantId = randomUUID();
      const userId = randomUUID();
      const token = provider.criarSessao({ tenantId, userId, perfis: d.perfis, mfaEm: d.comFator ? new Date() : null });
      return Promise.resolve({ cabecalhos: { authorization: `Bearer ${token}` }, tenantId, userId });
    },
    encerrar: (c) => {
      provider.encerrarSessao(String(c.authorization).replace(/^Bearer /, ''));
      return Promise.resolve();
    },
  });
}

/** Onde roda a bancada de cada tipo da fábrica. Tipo novo sem entrada aqui não compila. */
const BANCADAS: Record<TipoDeProvedor, string> = {
  dev: 'aqui',
  'better-auth': 'test/contrato-provedor-better-auth.rls.test.ts',
};

it('todo tipo aceito pela fábrica tem bancada declarada, e a bancada externa roda a suíte do contrato', () => {
  expect(Object.keys(BANCADAS).sort()).toEqual([...TIPOS_DE_PROVEDOR].sort());
  for (const [tipo, onde] of Object.entries(BANCADAS)) {
    if (onde === 'aqui') continue;
    const arquivo = join(__dirname, '..', '..', '..', onde);
    expect(existsSync(arquivo), onde).toBe(true);
    expect(readFileSync(arquivo, 'utf8')).toContain(`executarContrato('${tipo}'`);
  }
});

executarContrato('dev', bancadaDev);

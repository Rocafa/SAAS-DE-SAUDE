/**
 * Segredos versionados (R9 do parecer do código do #152): leitura de BETTER_AUTH_SECRETS e a configuração que
 * decifra o TOTP cifrado com uma versão antiga.
 */
import { randomBytes } from 'node:crypto';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import { configuracaoDoSegredo, lerSegredosVersionados } from './segredos';

const S1 = randomBytes(32).toString('base64');
const S2 = randomBytes(32).toString('base64');
const LEGADO = randomBytes(32).toString('base64');

describe('segredos versionados do Better Auth', () => {
  it('lê "2:novo,1:antigo" na ordem (a primeira cifra) e recusa formato errado, versão repetida ou segredo curto', () => {
    expect(lerSegredosVersionados(`2:${S2},1:${S1}`)).toEqual([
      { version: 2, value: S2 },
      { version: 1, value: S1 },
    ]);
    expect(lerSegredosVersionados(undefined)).toBeUndefined();
    expect(lerSegredosVersionados('  ')).toBeUndefined();
    expect(() => lerSegredosVersionados(S1)).toThrow();
    expect(() => lerSegredosVersionados(`1:${S1},1:${S2}`)).toThrow(/repetida/);
    expect(() => lerSegredosVersionados('1:curto')).toThrow(/bytes/);
    expect(() => lerSegredosVersionados(`0:${S1}`)).toThrow();
  });

  it('rotação: o que foi cifrado na versão 1 decifra depois que a 2 entra na frente; o legado (sem versão) também', async () => {
    const naV1 = await symmetricEncrypt({ key: configuracaoDoSegredo(LEGADO, [{ version: 1, value: S1 }]), data: 'segredo-do-totp' });
    const legado = await symmetricEncrypt({ key: LEGADO, data: 'totp-antigo' });
    const depois = configuracaoDoSegredo(LEGADO, [
      { version: 2, value: S2 },
      { version: 1, value: S1 },
    ]);
    expect(await symmetricDecrypt({ key: depois, data: naV1 })).toBe('segredo-do-totp');
    expect(await symmetricDecrypt({ key: depois, data: legado })).toBe('totp-antigo');
    // Retirar a versão 1 antes da hora quebra (por isso o runbook manda esperar).
    await expect(symmetricDecrypt({ key: configuracaoDoSegredo(LEGADO, [{ version: 2, value: S2 }]), data: naV1 })).rejects.toThrow();
  });

  it('sem versões, a configuração é o segredo legado (comportamento de antes)', () => {
    expect(configuracaoDoSegredo(LEGADO, undefined)).toBe(LEGADO);
  });
});

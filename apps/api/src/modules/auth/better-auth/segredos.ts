/**
 * Segredos versionados do Better Auth (R9 do parecer do código do #152; 3c da D4). Sem eles, trocar o
 * BETTER_AUTH_SECRET torna ilegível o segredo do TOTP de todo mundo.
 *
 * `BETTER_AUTH_SECRETS=2:<novo>,1:<antigo>`: a PRIMEIRA entrada cifra o que é novo; as demais só decifram. O
 * `BETTER_AUTH_SECRET` continua como legado, para o que foi cifrado antes do formato com versão. Rotação (runbook):
 * acrescentar a versão nova NA FRENTE, publicar, e só retirar a antiga depois que nada mais depende dela.
 */
import type { SecretConfig } from 'better-auth/crypto';
import { TAMANHO_MINIMO_DO_SEGREDO } from './instancia';

export interface SegredoVersionado {
  readonly version: number;
  readonly value: string;
}

/** Lê `BETTER_AUTH_SECRETS`; vazio = sem versões (só o segredo legado). Formato errado derruba o boot. */
export function lerSegredosVersionados(texto: string | undefined): SegredoVersionado[] | undefined {
  const bruto = texto?.trim();
  if (!bruto) return undefined;
  const vistos = new Set<number>();
  const saida = bruto.split(',').map((entrada) => {
    const i = entrada.indexOf(':');
    const version = Number(entrada.slice(0, i));
    const value = entrada.slice(i + 1).trim();
    if (i < 1 || !Number.isInteger(version) || version < 1) throw new Error('BETTER_AUTH_SECRETS: cada entrada é <versão inteira >= 1>:<segredo>');
    if (vistos.has(version)) throw new Error('BETTER_AUTH_SECRETS: versão repetida');
    if (Buffer.byteLength(value, 'utf8') < TAMANHO_MINIMO_DO_SEGREDO) {
      throw new Error(`BETTER_AUTH_SECRETS: a versão ${version} precisa de ao menos ${TAMANHO_MINIMO_DO_SEGREDO} bytes`);
    }
    vistos.add(version);
    return { version, value };
  });
  return saida;
}

/** A mesma configuração que a biblioteca monta, para decifrar o TOTP fora do login (recuperação de senha). */
export function configuracaoDoSegredo(legado: string, versionados: readonly SegredoVersionado[] | undefined): string | SecretConfig {
  if (!versionados?.length) return legado;
  const primeiro = versionados[0];
  if (!primeiro) return legado;
  return {
    keys: new Map(versionados.map((s) => [s.version, s.value])),
    currentVersion: primeiro.version,
    legacySecret: legado,
  };
}

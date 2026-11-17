/**
 * Conferência do código TOTP fora do fluxo de login da biblioteca (recuperação de senha, PR 3b-2): a pessoa não tem a
 * senha, mas tem o aplicativo. Mesmos parâmetros do plugin (RFC 6238, SHA-1, 6 dígitos, 30 s, janela de ±1) e
 * comparação em tempo constante. O segredo vem decifrado pela própria biblioteca (`better-auth/crypto`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function hotp(segredo: Buffer, contador: number): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', segredo).update(c).digest();
  const o = (h[h.length - 1] ?? 0) & 0x0f;
  const n = (((h[o] ?? 0) & 0x7f) << 24) | ((h[o + 1] ?? 0) << 16) | ((h[o + 2] ?? 0) << 8) | (h[o + 3] ?? 0);
  return String(n % 1_000_000).padStart(6, '0');
}

export function totpConfere(segredoDecifrado: string, codigo: string, agoraMs: number = Date.now()): boolean {
  if (!/^[0-9]{6}$/.test(codigo)) return false;
  const segredo = Buffer.from(segredoDecifrado, 'utf8');
  const contador = Math.floor(agoraMs / 30_000);
  let confere = false;
  for (const d of [-1, 0, 1]) confere = timingSafeEqual(Buffer.from(hotp(segredo, contador + d)), Buffer.from(codigo)) || confere;
  return confere;
}

/**
 * Gerador de TOTP para a bancada (RFC 6238, SHA-1, 6 dígitos, 30 s), sem depender do pacote interno da biblioteca:
 * o teste confere que o código do aplicativo autenticador é aceito, como um celular faria a partir do URI.
 */
import { createHmac } from 'node:crypto';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(texto: string): Buffer {
  let bits = 0;
  let valor = 0;
  const saida: number[] = [];
  for (const ch of texto.replace(/=+$/, '').toUpperCase()) {
    const i = ALFABETO.indexOf(ch);
    if (i < 0) throw new Error('base32 inválido');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      saida.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(saida);
}

/** Segredo (bytes) a partir do `otpauth://totp/...?secret=...` devolvido pelo cadastro. */
export function segredoDoUri(uri: string): Buffer {
  const s = new URL(uri).searchParams.get('secret');
  if (!s) throw new Error('URI do TOTP sem segredo');
  return base32(s);
}

/** Código do período atual + `deslocamento` (a biblioteca aceita -1, 0 e +1). */
export function codigoTotp(segredo: Buffer, deslocamento = 0, agora = Date.now()): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(agora / 30_000) + deslocamento));
  const h = createHmac('sha1', segredo).update(contador).digest();
  const o = (h[h.length - 1] ?? 0) & 0x0f;
  const n = (((h[o] ?? 0) & 0x7f) << 24) | ((h[o + 1] ?? 0) << 16) | ((h[o + 2] ?? 0) << 8) | (h[o + 3] ?? 0);
  return String(n % 1_000_000).padStart(6, '0');
}

/** O n-ésimo código de 6 dígitos que NÃO vale na janela atual (códigos errados distintos entre si). */
export function codigoErrado(segredo: Buffer, n = 0): string {
  const validos = new Set([-1, 0, 1].map((d) => codigoTotp(segredo, d)));
  let achados = 0;
  for (let i = 0; ; i++) {
    const c = String((123_456 + i * 7_919) % 1_000_000).padStart(6, '0');
    if (validos.has(c)) continue;
    if (achados++ === n) return c;
  }
}

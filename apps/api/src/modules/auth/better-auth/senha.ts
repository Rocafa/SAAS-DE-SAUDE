/**
 * Hash de senha da autenticação real (R9 do parecer do desenho Better Auth): scrypt nativo do Node com N=2^16, r=8,
 * p=2 (64 MiB por hash), um dos mínimos da OWASP. O padrão da biblioteca (N=2^14, r=16, p=1) fica cerca de 4×
 * abaixo do mínimo, por isso a biblioteca recebe estas funções (`emailAndPassword.password.hash/verify`).
 *
 * Formato guardado: `scrypt$<N>$<r>$<p>$<sal base64>$<hash base64>`. Os parâmetros vão junto para permitir subir o
 * custo depois (rehash no login) sem invalidar as senhas antigas.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const PARAMETROS_SCRYPT = { N: 2 ** 16, r: 8, p: 2 } as const;
const TAMANHO_HASH = 64;
const TAMANHO_SAL = 16;
/** Memória máxima permitida ao scrypt: 128·N·r·p com folga (o padrão de 32 MiB do Node recusaria N=2^16). */
const MEMORIA_MAXIMA = 256 * 1024 * 1024;

function scrypt(senha: string, sal: Buffer, opcoes: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(senha.normalize('NFKC'), sal, TAMANHO_HASH, { ...opcoes, maxmem: MEMORIA_MAXIMA }, (erro, chave) => (erro ? reject(erro) : resolve(chave)));
  });
}

export async function gerarHashDeSenha(senha: string): Promise<string> {
  const sal = randomBytes(TAMANHO_SAL);
  const { N, r, p } = PARAMETROS_SCRYPT;
  const hash = await scrypt(senha, sal, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

const FORMATO = /^scrypt\$(\d{4,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/=]{16,64})\$([A-Za-z0-9+/=]{80,100})$/;

/** Confere a senha em tempo constante. Hash em formato desconhecido (ou parâmetros absurdos) é recusado. */
export async function conferirSenha(dados: { hash: string; password: string }): Promise<boolean> {
  const m = FORMATO.exec(dados.hash);
  if (!m) return false;
  const [, n, r, p, salB64, hashB64] = m;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // Parâmetros dentro de uma faixa sã: um hash adulterado não força custo enorme (DoS) nem custo baixo.
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || R < 8 || R > 32 || P < 1 || P > 16) return false;
  const esperado = Buffer.from(hashB64 as string, 'base64');
  if (esperado.length !== TAMANHO_HASH) return false;
  const obtido = await scrypt(dados.password, Buffer.from(salB64 as string, 'base64'), { N, r: R, p: P });
  return timingSafeEqual(obtido, esperado);
}

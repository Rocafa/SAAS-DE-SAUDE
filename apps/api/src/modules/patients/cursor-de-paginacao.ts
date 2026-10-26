/**
 * Cursor de paginação opaco, cifrado e assinado da lista de pacientes (R5 do parecer PR #76; R7–R9 da
 * conferência de 25/10).
 *
 * Problema: a página seguinte era pedida por número (`pagina=N`) e respondida com a clínica do cookie
 * daquele momento. Se a sessão trocasse A→B→A no meio da paginação, páginas de B se misturavam à lista
 * de A no cliente. Agora a página 2 em diante só sai com o `proximoCursor` da página anterior, e o
 * cursor vale só para a MESMA sessão (clínica + usuário), o MESMO filtro e por `VALIDADE_MS`.
 *
 * Formato v2: `v2.<iv base64url>.<AES-256-GCM(payload) + tag base64url>.<HMAC-SHA256 base64url>`.
 * - R7: o cursor vai na query string do `GET /pacientes`, e a query aparece no log de acesso do ALB e de
 *   proxies. Por isso o payload é CIFRADO (AES-256-GCM): o log só vê bytes opacos, nenhum UUID legível.
 *   O transporte não mudou (mesmo campo `cursor`, mesmo `proximoCursor`): o front não precisa de ajuste.
 * - O payload leva só ids técnicos (clínica, usuário, último paciente), a página, a validade e uma marca
 *   da posição da âncora (HMAC truncado do nome de busca, nunca o nome). Nunca nome, termo, CPF.
 * - O filtro (situação, limite e termo normalizado) e o escopo entram no AAD do GCM e no HMAC, não no
 *   payload: cursor de outro filtro falha sem expor o termo.
 * - Chaves de cifra e de assinatura são DISTINTAS, derivadas por HKDF-SHA256 do segredo
 *   `PAGINATION_CURSOR_KEY`. O HMAC é conferido antes de decifrar.
 *
 * Qualquer falha (formato, assinatura, versão, outra clínica, outro usuário, vencido, âncora sumida ou
 * movida) vira a MESMA resposta 409 `cursor_invalido`, sem dados e sem dizer o motivo. O motivo vai só
 * para o log, com marcador fixo (CURSOR_INVALIDO motivo=...), sem id.
 */
import { Logger } from '@nestjs/common';
import type { RequestContext } from '@plataforma/shared';
import { CURSOR_INVALIDO } from '@plataforma/shared';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConflitoError } from '../../common/erros-dominio';

/** Validade de cada cursor (renovada a cada página). */
export const VALIDADE_DO_CURSOR_MS = 10 * 60_000;
export const PAGINATION_CURSOR_KEY_MIN_BYTES = 32;
const VERSAO = 'v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bytes da marca da âncora (HMAC truncado do nome de busca). */
const MARCA_BYTES = 16;

export class CursorInvalidoError extends ConflitoError {
  constructor() {
    super(CURSOR_INVALIDO);
  }
}

/** Filtro que o cursor amarra (vai só no AAD/HMAC). */
export interface FiltroDoCursor {
  readonly situacao: string;
  readonly limite: number;
  readonly busca?: string;
}

/** Posição de onde a próxima página continua (o que o service passa ao emitir). */
export interface PosicaoDoCursor {
  /** Número da página que o cursor abre (2 em diante). */
  readonly pagina: number;
  /** Último paciente da página anterior (âncora do keyset). */
  readonly depoisDe: string;
  /** Nome de busca (`search_name`) da âncora na emissão. Só vira marca (HMAC truncado); nunca vai no cursor. */
  readonly nomeDaAncora: string;
}

/** Posição lida do cursor: o nome da âncora não volta, só a marca para conferir. */
export interface PosicaoLida {
  readonly pagina: number;
  readonly depoisDe: string;
  readonly marcaDaAncora: string;
}

interface Payload {
  readonly c: string;
  readonly u: string;
  readonly e: number;
  readonly p: number;
  readonly k: string;
  readonly h: string;
}

type Motivo = 'formato' | 'assinatura' | 'outra_clinica' | 'outro_usuario' | 'vencido' | 'ancora_sumiu' | 'ancora_mudou';

let segredoDoProcesso: Buffer | undefined;

/** Fragmentos de valor de exemplo/placeholder recusados em produção (R8). */
const SINAIS_DE_EXEMPLO = ['exemplo', 'example', 'changeme', 'troque', 'trocar', 'placeholder', 'password', 'segredo', 'secret'];
/** Mínimo de bytes distintos no segredo decodificado: 32 bytes aleatórios têm ~30; frase ou repetição, bem menos. */
const MIN_BYTES_DISTINTOS = 20;

/** Decodifica hex ou base64/base64url canônico; `undefined` se não for nenhum dos dois. */
function decodificarSegredo(raw: string): Buffer | undefined {
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64');
  const semPad = raw.replace(/=+$/, '');
  if (bytes.toString('base64').replace(/=+$/, '') !== semPad && bytes.toString('base64url') !== semPad) return undefined;
  return bytes;
}

/**
 * Segredo do cursor (as chaves de cifra e de HMAC derivam dele). Em produção é obrigatório
 * (PAGINATION_CURSOR_KEY, do Secrets Manager) e igual em todas as instâncias (a página 2 pode cair em
 * outra instância).
 *
 * R8, em produção: tem de ser bytes aleatórios codificados em base64/base64url ou hex (ex.:
 * `openssl rand -base64 32` ou o `random_password` do Terraform), com ≥ 32 bytes DECODIFICADOS, ≥ 20
 * bytes distintos, sem cara de valor de exemplo e diferente de RATE_LIMIT_HASH_KEY. Frase, valor de
 * exemplo ou repetição: a API não sobe. Fora de produção, aceita texto com ≥ 32 bytes UTF-8 e, sem a
 * variável, usa um segredo aleatório do processo.
 */
export function loadPaginationCursorKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.PAGINATION_CURSOR_KEY?.trim();
  const producao = env.NODE_ENV === 'production';
  if (raw) {
    const decodificado = decodificarSegredo(raw);
    if (producao) {
      if (!decodificado) {
        throw new Error('PAGINATION_CURSOR_KEY precisa ser bytes aleatórios em base64 ou hex (ex.: openssl rand -base64 32)');
      }
      if (decodificado.length < PAGINATION_CURSOR_KEY_MIN_BYTES) {
        throw new Error(`PAGINATION_CURSOR_KEY precisa de ao menos ${PAGINATION_CURSOR_KEY_MIN_BYTES} bytes decodificados`);
      }
      const minusculo = raw.toLowerCase();
      if (SINAIS_DE_EXEMPLO.some((s) => minusculo.includes(s)) || new Set(decodificado).size < MIN_BYTES_DISTINTOS) {
        throw new Error('PAGINATION_CURSOR_KEY fraca ou de exemplo: gere bytes aleatórios (openssl rand -base64 32)');
      }
      if (env.RATE_LIMIT_HASH_KEY?.trim() === raw) {
        throw new Error('PAGINATION_CURSOR_KEY não pode ser igual a RATE_LIMIT_HASH_KEY');
      }
      return decodificado;
    }
    const chave = decodificado && decodificado.length >= PAGINATION_CURSOR_KEY_MIN_BYTES ? decodificado : Buffer.from(raw, 'utf8');
    if (chave.length < PAGINATION_CURSOR_KEY_MIN_BYTES) {
      throw new Error(`PAGINATION_CURSOR_KEY precisa de ao menos ${PAGINATION_CURSOR_KEY_MIN_BYTES} bytes`);
    }
    return chave;
  }
  if (producao) {
    throw new Error('PAGINATION_CURSOR_KEY é obrigatória em produção (segredo do cursor de paginação)');
  }
  segredoDoProcesso ??= randomBytes(PAGINATION_CURSOR_KEY_MIN_BYTES);
  return segredoDoProcesso;
}

export const CURSOR_DE_PAGINACAO = Symbol('CURSOR_DE_PAGINACAO');

function derivar(segredo: Uint8Array, uso: string): Buffer {
  return Buffer.from(hkdfSync('sha256', segredo, 'plataforma-saude/cursor-de-paginacao', uso, 32));
}

function amarraDoFiltro(filtro: FiltroDoCursor): string[] {
  return [filtro.situacao, String(filtro.limite), filtro.busca === undefined ? '-' : `b:${filtro.busca}`];
}

export class CursorDePaginacao {
  private readonly logger = new Logger('cursor');
  private readonly chaveCifra: Buffer;
  private readonly chaveMac: Buffer;

  constructor(
    segredo: Uint8Array,
    /** Escopo da lista (cursor de uma lista não serve em outra). */
    private readonly escopo: string,
    private readonly agora: () => number = Date.now,
    private readonly validadeMs: number = VALIDADE_DO_CURSOR_MS,
    private readonly paginaMaxima: number = 1000,
  ) {
    if (segredo.length < PAGINATION_CURSOR_KEY_MIN_BYTES) throw new Error('chave do cursor curta demais');
    this.chaveCifra = derivar(segredo, 'cifra-v2');
    this.chaveMac = derivar(segredo, 'assinatura-v2');
  }

  /** Emite o cursor da página `pagina` (a próxima), ancorado no último paciente da página atual. */
  assinar(ctx: RequestContext, filtro: FiltroDoCursor, posicao: PosicaoDoCursor): string {
    const payload: Payload = {
      c: ctx.tenantId,
      u: ctx.userId,
      e: Math.floor((this.agora() + this.validadeMs) / 1000),
      p: posicao.pagina,
      k: posicao.depoisDe,
      h: this.marca(posicao.nomeDaAncora),
    };
    const iv = randomBytes(IV_BYTES);
    const cifra = createCipheriv('aes-256-gcm', this.chaveCifra, iv);
    cifra.setAAD(this.aad(filtro));
    const ct = Buffer.concat([cifra.update(JSON.stringify(payload), 'utf8'), cifra.final(), cifra.getAuthTag()]);
    const ivB = iv.toString('base64url');
    const ctB = ct.toString('base64url');
    return `${VERSAO}.${ivB}.${ctB}.${this.mac(ivB, ctB, filtro)}`;
  }

  /** Confere, decifra e abre o cursor. Lança `CursorInvalidoError` (409) em qualquer falha. */
  ler(ctx: RequestContext, filtro: FiltroDoCursor, token: string): PosicaoLida {
    const partes = token.split('.');
    if (partes.length !== 4 || partes[0] !== VERSAO || !partes.slice(1).every((x) => BASE64URL.test(x))) {
      return this.recusar('formato');
    }
    const [, ivB, ctB, assinatura] = partes as [string, string, string, string];
    const esperada = Buffer.from(this.mac(ivB, ctB, filtro), 'base64url');
    const recebida = Buffer.from(assinatura, 'base64url');
    if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return this.recusar('assinatura');
    const iv = Buffer.from(ivB, 'base64url');
    const ct = Buffer.from(ctB, 'base64url');
    if (iv.length !== IV_BYTES || ct.length <= TAG_BYTES) return this.recusar('formato');
    let p: Partial<Payload>;
    try {
      const decifra = createDecipheriv('aes-256-gcm', this.chaveCifra, iv);
      decifra.setAAD(this.aad(filtro));
      decifra.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
      const claro = Buffer.concat([decifra.update(ct.subarray(0, ct.length - TAG_BYTES)), decifra.final()]);
      p = JSON.parse(claro.toString('utf8')) as Partial<Payload>;
    } catch {
      return this.recusar('formato');
    }
    if (
      typeof p !== 'object' ||
      p === null ||
      typeof p.c !== 'string' ||
      typeof p.u !== 'string' ||
      typeof p.k !== 'string' ||
      typeof p.h !== 'string' ||
      !UUID.test(p.k) ||
      !Number.isInteger(p.e) ||
      !Number.isInteger(p.p) ||
      (p.p as number) < 2 ||
      (p.p as number) > this.paginaMaxima
    ) {
      return this.recusar('formato');
    }
    if (p.c !== ctx.tenantId) return this.recusar('outra_clinica');
    if (p.u !== ctx.userId) return this.recusar('outro_usuario');
    if ((p.e as number) * 1000 <= this.agora()) return this.recusar('vencido');
    return { pagina: p.p as number, depoisDe: p.k, marcaDaAncora: p.h };
  }

  /**
   * R9: a âncora (último paciente da página anterior) é relida na transação da clínica. Sumiu = 409;
   * mudou de nome de busca (a posição dela na ordem mudou, e a próxima página pularia ou repetiria) =
   * 409. Mudou só de situação (ativo/inativo) = segue: a posição na ordem é a mesma.
   */
  conferirAncora(posicao: PosicaoLida, nomeAtual: string | undefined): void {
    if (nomeAtual === undefined) return this.recusar('ancora_sumiu');
    const atual = Buffer.from(this.marca(nomeAtual), 'base64url');
    const emitida = Buffer.from(posicao.marcaDaAncora, 'base64url');
    if (atual.length !== emitida.length || !timingSafeEqual(atual, emitida)) return this.recusar('ancora_mudou');
  }

  private marca(nome: string): string {
    return createHmac('sha256', this.chaveMac)
      .update(['ancora', this.escopo, nome].join('\u001f'))
      .digest()
      .subarray(0, MARCA_BYTES)
      .toString('base64url');
  }

  private aad(filtro: FiltroDoCursor): Buffer {
    // Separador 0x1f: não aparece em base64url, enum, número nem no termo (o validador recusa controle).
    return Buffer.from([VERSAO, this.escopo, ...amarraDoFiltro(filtro)].join('\u001f'), 'utf8');
  }

  private mac(iv: string, ct: string, filtro: FiltroDoCursor): string {
    return createHmac('sha256', this.chaveMac)
      .update([VERSAO, this.escopo, iv, ct, ...amarraDoFiltro(filtro)].join('\u001f'))
      .digest('base64url');
  }

  private recusar(motivo: Motivo): never {
    this.logger.warn(`CURSOR_INVALIDO motivo=${motivo}`);
    throw new CursorInvalidoError();
  }
}

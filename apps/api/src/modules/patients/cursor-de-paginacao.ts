/**
 * Cursor de paginação opaco e assinado da lista de pacientes (R5 do parecer PR #76).
 *
 * Problema: a página seguinte era pedida por número (`pagina=N`) e respondida com a clínica do cookie
 * daquele momento. Se a sessão trocasse A→B→A no meio da paginação, páginas de B se misturavam à lista
 * de A no cliente. Agora a página 2 em diante só sai com o `proximoCursor` da página anterior, e o
 * cursor vale só para a MESMA sessão (clínica + usuário), o MESMO filtro e por `VALIDADE_MS`.
 *
 * Formato: `v1.<payload base64url>.<HMAC-SHA256 base64url>`. O payload leva só ids técnicos (UUID da
 * clínica, do usuário e do último paciente da página), o número da página e a validade. Nunca nome,
 * termo de busca, CPF ou qualquer dado pessoal. O filtro (situação, limite e termo de busca normalizado)
 * entra só no HMAC, não no payload: cursor de outro filtro falha na assinatura sem expor o termo.
 *
 * Qualquer falha (formato, assinatura, versão, outra clínica, outro usuário, vencido) vira a MESMA
 * resposta 409 `cursor_invalido`, sem dados e sem dizer o motivo. O motivo vai só para o log, com
 * marcador fixo (CURSOR_INVALIDO motivo=...), sem id.
 */
import { Logger } from '@nestjs/common';
import type { RequestContext } from '@plataforma/shared';
import { CURSOR_INVALIDO } from '@plataforma/shared';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConflitoError } from '../../common/erros-dominio';

/** Validade de cada cursor (renovada a cada página). */
export const VALIDADE_DO_CURSOR_MS = 10 * 60_000;
export const PAGINATION_CURSOR_KEY_MIN_BYTES = 32;
const VERSAO = 'v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class CursorInvalidoError extends ConflitoError {
  constructor() {
    super(CURSOR_INVALIDO);
  }
}

/** Filtro que o cursor amarra (vai só no HMAC). */
export interface FiltroDoCursor {
  readonly situacao: string;
  readonly limite: number;
  readonly busca?: string;
}

/** Posição de onde a próxima página continua. */
export interface PosicaoDoCursor {
  /** Número da página que o cursor abre (2 em diante). */
  readonly pagina: number;
  /** Último paciente da página anterior (âncora do keyset). */
  readonly depoisDe: string;
}

interface Payload {
  readonly c: string;
  readonly u: string;
  readonly e: number;
  readonly p: number;
  readonly k: string;
}

let segredoDoProcesso: Buffer | undefined;

/**
 * Segredo do HMAC do cursor. Em produção é obrigatório (PAGINATION_CURSOR_KEY, ≥ 32 bytes, do Secrets
 * Manager) e igual em todas as instâncias (a página 2 pode cair em outra instância). Fora de produção,
 * sem a variável, usa um segredo aleatório do processo.
 */
export function loadPaginationCursorKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.PAGINATION_CURSOR_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, 'utf8');
    if (key.length < PAGINATION_CURSOR_KEY_MIN_BYTES) {
      throw new Error(`PAGINATION_CURSOR_KEY precisa de ao menos ${PAGINATION_CURSOR_KEY_MIN_BYTES} bytes`);
    }
    return key;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('PAGINATION_CURSOR_KEY é obrigatória em produção (segredo do cursor de paginação)');
  }
  segredoDoProcesso ??= randomBytes(PAGINATION_CURSOR_KEY_MIN_BYTES);
  return segredoDoProcesso;
}

export const CURSOR_DE_PAGINACAO = Symbol('CURSOR_DE_PAGINACAO');

export class CursorDePaginacao {
  private readonly logger = new Logger('cursor');

  constructor(
    private readonly chave: Uint8Array,
    /** Escopo da lista (cursor de uma lista não serve em outra). */
    private readonly escopo: string,
    private readonly agora: () => number = Date.now,
    private readonly validadeMs: number = VALIDADE_DO_CURSOR_MS,
    private readonly paginaMaxima: number = 1000,
  ) {
    if (chave.length < PAGINATION_CURSOR_KEY_MIN_BYTES) throw new Error('chave do cursor curta demais');
  }

  /** Emite o cursor da página `pagina` (a próxima), ancorado no último id da página atual. */
  assinar(ctx: RequestContext, filtro: FiltroDoCursor, posicao: PosicaoDoCursor): string {
    const payload: Payload = {
      c: ctx.tenantId,
      u: ctx.userId,
      e: Math.floor((this.agora() + this.validadeMs) / 1000),
      p: posicao.pagina,
      k: posicao.depoisDe,
    };
    const corpo = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${VERSAO}.${corpo}.${this.mac(corpo, filtro)}`;
  }

  /** Confere e abre o cursor. Lança `CursorInvalidoError` (409) em qualquer falha. */
  ler(ctx: RequestContext, filtro: FiltroDoCursor, token: string): PosicaoDoCursor {
    const partes = token.split('.');
    if (partes.length !== 3 || partes[0] !== VERSAO || !BASE64URL.test(partes[1]!) || !BASE64URL.test(partes[2]!)) {
      return this.recusar('formato');
    }
    const [, corpo, assinatura] = partes as [string, string, string];
    const esperada = Buffer.from(this.mac(corpo, filtro), 'base64url');
    const recebida = Buffer.from(assinatura, 'base64url');
    if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return this.recusar('assinatura');
    let p: Partial<Payload>;
    try {
      p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Partial<Payload>;
    } catch {
      return this.recusar('formato');
    }
    if (
      typeof p !== 'object' ||
      p === null ||
      typeof p.c !== 'string' ||
      typeof p.u !== 'string' ||
      typeof p.k !== 'string' ||
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
    return { pagina: p.p as number, depoisDe: p.k };
  }

  private mac(corpo: string, filtro: FiltroDoCursor): string {
    // Separador 0x1f: não aparece em base64url, enum, número nem no termo (o validador recusa controle).
    const entrada = [VERSAO, this.escopo, corpo, filtro.situacao, String(filtro.limite), filtro.busca === undefined ? '-' : `b:${filtro.busca}`].join('\u001f');
    return createHmac('sha256', this.chave).update(entrada).digest('base64url');
  }

  private recusar(motivo: 'formato' | 'assinatura' | 'outra_clinica' | 'outro_usuario' | 'vencido'): never {
    this.logger.warn(`CURSOR_INVALIDO motivo=${motivo}`);
    throw new CursorInvalidoError();
  }
}

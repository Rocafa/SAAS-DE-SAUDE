import { BadRequestException, HttpException, HttpStatus, PayloadTooLargeException } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { ConflitoError } from '../../common/erros-dominio';
import { EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';
import { IMPORT_KINDS, type ImportKind } from '../../db/schema';
import type { Mapeamento } from './importacao-regras';
import { IMPORT_MAX_BYTES, IMPORT_MAX_COLUNAS, pareceZip, PlanilhaInvalidaError } from './planilha-csv';

/**
 * Entrada do importador. Na URL só enums e a VERSÃO do termo (nunca dado pessoal: o conteúdo vai no corpo,
 * que não passa por log de acesso). O arquivo é o corpo cru `text/csv`, lido aqui com teto de tamanho.
 */

/** 415 com código estável: o front orienta "salve como CSV UTF-8". */
export class FormatoNaoSuportadoError extends HttpException {
  constructor() {
    super({ statusCode: 415, message: 'Formato não suportado', codigo: 'formato_nao_suportado' }, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  }
}

/** Arquivo recusado por inteiro: só o código (o conteúdo não volta). */
export class ArquivoInvalidoError extends BadRequestException {
  constructor(codigo: string) {
    super({ statusCode: 400, message: 'Dados inválidos', campos: ['arquivo'], codigo });
  }
}

export function traduzirPlanilha<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PlanilhaInvalidaError) throw new ArquivoInvalidoError(e.codigo);
    throw e;
  }
}

export async function traduzirPlanilhaAsync<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlanilhaInvalidaError) throw new ArquivoInvalidoError(e.codigo);
    throw e;
  }
}

export function validarEnvio(query: unknown): { tipo: ImportKind; termo: string } {
  const entrada = exigirObjeto(query ?? {}, ['tipo', 'termo']);
  const v = new Validador(entrada);
  const tipo = v.umDe('tipo', IMPORT_KINDS, true);
  v.concluir();
  // Sem aceite do termo de migração (MIG-02.4), nada é recebido.
  if (!v.tem('termo')) throw new ConflitoError('termo_de_migracao_obrigatorio');
  const termo = entrada.termo;
  if (typeof termo !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,31}$/.test(termo)) throw new EntradaInvalidaError(['termo']);
  return { tipo: tipo as ImportKind, termo };
}

const TIPOS_PLANILHA_BINARIA = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/zip',
];

/**
 * Lê o corpo cru com teto (413 ao passar de 5 MiB, sem bufferizar o excesso). Só `text/csv` com charset
 * ausente ou UTF-8; planilha binária (XLSX/ODS/ZIP) dá 415, pelo tipo declarado ou pela assinatura.
 */
export async function lerArquivoCsv(req: IncomingMessage): Promise<Uint8Array> {
  const tipo = (req.headers['content-type'] ?? '').toLowerCase();
  const [mime, ...params] = tipo.split(';').map((s) => s.trim());
  if (TIPOS_PLANILHA_BINARIA.includes(mime ?? '')) throw new FormatoNaoSuportadoError();
  const charset = params.find((p) => p.startsWith('charset='))?.slice(8).replace(/"/g, '');
  if (mime !== 'text/csv' || (charset !== undefined && charset !== 'utf-8' && charset !== 'utf8')) throw new FormatoNaoSuportadoError();
  const declarado = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declarado) && declarado > IMPORT_MAX_BYTES) throw new PayloadTooLargeException({ statusCode: 413, message: 'Arquivo grande demais' });
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of req as AsyncIterable<Buffer>) {
    total += parte.length;
    if (total > IMPORT_MAX_BYTES) {
      req.destroy();
      throw new PayloadTooLargeException({ statusCode: 413, message: 'Arquivo grande demais' });
    }
    partes.push(parte);
  }
  const bytes = Buffer.concat(partes);
  if (bytes.length === 0) throw new ArquivoInvalidoError('arquivo_vazio');
  if (pareceZip(bytes)) throw new FormatoNaoSuportadoError();
  return bytes;
}

/** `{mapeamento: {campo: índice}}` — os campos são conferidos contra o tipo do lote no serviço. */
export function validarMapeamento(corpo: unknown): Mapeamento {
  const entrada = exigirObjeto(corpo, ['mapeamento']);
  const m = entrada.mapeamento;
  if (typeof m !== 'object' || m === null || Array.isArray(m) || Object.getPrototypeOf(m) !== Object.prototype) {
    throw new EntradaInvalidaError(['mapeamento']);
  }
  const out: Record<string, number> = {};
  const erros: string[] = [];
  for (const [campo, idx] of Object.entries(m as Record<string, unknown>)) {
    if (!/^[a-z][a-zA-Z]{0,31}$/.test(campo) || typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= IMPORT_MAX_COLUNAS) {
      erros.push(/^[a-z][a-zA-Z]{0,31}$/.test(campo) ? `mapeamento.${campo}` : 'mapeamento');
      continue;
    }
    out[campo] = idx;
  }
  if (erros.length > 0 || Object.keys(out).length === 0) throw new EntradaInvalidaError(erros.length > 0 ? erros : ['mapeamento']);
  return out;
}

export function validarAplicacao(corpo: unknown): { resumoHash: string } {
  const v = new Validador(exigirObjeto(corpo, ['resumoHash']));
  const h = v.texto('resumoHash', { min: 64, max: 64, obrigatorio: true });
  v.concluir();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new EntradaInvalidaError(['resumoHash']);
  return { resumoHash: h };
}

export function validarCorpoVazio(corpo: unknown): void {
  exigirObjeto(corpo ?? {}, []);
}

export function validarQuery(query: unknown, permitidas: readonly string[] = []): Record<string, unknown> {
  return { ...exigirObjeto(query ?? {}, permitidas) };
}

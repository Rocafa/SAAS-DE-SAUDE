import { exigirObjeto, Validador } from '../../common/validacao';

export interface NovaUnidade {
  readonly nome: string;
}

export interface AlteracaoUnidade {
  readonly nome?: string;
  readonly ativa?: boolean;
}

export interface NovaSala {
  readonly unidadeId: string;
  readonly nome: string;
  readonly capacidade: number;
}

export interface AlteracaoSala {
  readonly nome?: string;
  readonly capacidade?: number;
  readonly ativa?: boolean;
}

export interface FiltroSalas {
  readonly unidadeId?: string;
}

/** Capacidade da sala: o mesmo teto do CHECK da 0101 (rooms_capacity_check). */
export const CAPACIDADE_MAXIMA_SALA = 20;

/** O Validador já normaliza (NFC, sem espaço nas pontas) e recusa vazio e caractere de controle. */
function nomeLimpo(v: Validador, obrigatorio: boolean): string | undefined {
  return obrigatorio ? v.texto('nome', { max: 100, obrigatorio: true }) : v.texto('nome', { max: 100 });
}

/** PATCH vazio é erro de entrada (nada a mudar não vira auditoria vazia). */
function exigirAlgumCampo(v: Validador, campos: readonly string[]): void {
  if (!campos.some((c) => v.tem(c))) v.falhar('corpo');
}

export function validarNovaUnidade(corpo: unknown): NovaUnidade {
  const v = new Validador(exigirObjeto(corpo, ['nome']));
  const nome = nomeLimpo(v, true);
  v.concluir();
  return { nome: nome as string };
}

export function validarAlteracaoUnidade(corpo: unknown): AlteracaoUnidade {
  const v = new Validador(exigirObjeto(corpo, ['nome', 'ativa']));
  const nome = nomeLimpo(v, false);
  const ativa = v.booleano('ativa');
  exigirAlgumCampo(v, ['nome', 'ativa']);
  v.concluir();
  return { ...(nome !== undefined ? { nome } : {}), ...(ativa !== undefined ? { ativa } : {}) };
}

export function validarNovaSala(corpo: unknown): NovaSala {
  const v = new Validador(exigirObjeto(corpo, ['unidadeId', 'nome', 'capacidade']));
  const unidadeId = v.uuid('unidadeId', true);
  const nome = nomeLimpo(v, true);
  const capacidade = v.inteiro('capacidade', { min: 1, max: CAPACIDADE_MAXIMA_SALA }) ?? 1;
  v.concluir();
  return { unidadeId: unidadeId as string, nome: nome as string, capacidade };
}

export function validarAlteracaoSala(corpo: unknown): AlteracaoSala {
  const v = new Validador(exigirObjeto(corpo, ['nome', 'capacidade', 'ativa']));
  const nome = nomeLimpo(v, false);
  const capacidade = v.inteiro('capacidade', { min: 1, max: CAPACIDADE_MAXIMA_SALA });
  const ativa = v.booleano('ativa');
  exigirAlgumCampo(v, ['nome', 'capacidade', 'ativa']);
  v.concluir();
  return {
    ...(nome !== undefined ? { nome } : {}),
    ...(capacidade !== undefined ? { capacidade } : {}),
    ...(ativa !== undefined ? { ativa } : {}),
  };
}

export function validarFiltroSalas(query: unknown): FiltroSalas {
  const v = new Validador(exigirObjeto(query ?? {}, ['unidadeId']));
  const unidadeId = v.uuid('unidadeId', false);
  v.concluir();
  return unidadeId ? { unidadeId } : {};
}

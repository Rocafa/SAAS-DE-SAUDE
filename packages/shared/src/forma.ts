/**
 * Mini-descritor de formato JSON (sem dependências): o MESMO objeto gera o tipo TypeScript (`Infer`) e
 * confere uma resposta real em tempo de execução (`conferirForma`). É a base dos contratos de API
 * compartilhados entre o backend e o front (ex.: `ApiPortal`).
 *
 * A conferência é ESTRITA: campo a mais em objeto é erro. Assim, um campo novo que o backend passe a
 * devolver (por exemplo, algo clínico no portal) quebra o teste de contrato antes de chegar ao front.
 */

export type Forma =
  | { readonly t: 'texto' }
  /** Data de calendário `AAAA-MM-DD` (sem hora e sem fuso); a conferência exige que a data exista. */
  | { readonly t: 'data' }
  | { readonly t: 'inteiro' }
  | { readonly t: 'bool' }
  | { readonly t: 'nulo' }
  | { readonly t: 'enum'; readonly v: readonly string[] }
  | { readonly t: 'literal'; readonly v: string | number | boolean }
  | { readonly t: 'lista'; readonly de: Forma }
  | { readonly t: 'vazia' }
  | { readonly t: 'obj'; readonly campos: { readonly [k: string]: Forma | FormaOpcional } }
  | { readonly t: 'ou'; readonly de: readonly Forma[] };

export interface FormaOpcional {
  readonly t: 'opcional';
  readonly de: Forma;
}

type Simplificar<T> = { [K in keyof T]: T[K] } & {};

type ChavesOpcionais<C> = { [K in keyof C]: C[K] extends FormaOpcional ? K : never }[keyof C];
type ChavesObrigatorias<C> = Exclude<keyof C, ChavesOpcionais<C>>;

type InferObj<C> = Simplificar<
  { readonly [K in ChavesObrigatorias<C>]: Infer<C[K]> } & {
    readonly [K in ChavesOpcionais<C>]?: C[K] extends FormaOpcional ? Infer<C[K]['de']> : never;
  }
>;

/** Tipo TypeScript descrito por uma `Forma`. */
export type Infer<F> = F extends { t: 'texto' | 'data' }
  ? string
  : F extends { t: 'inteiro' }
    ? number
    : F extends { t: 'bool' }
      ? boolean
      : F extends { t: 'nulo' }
        ? null
        : F extends { t: 'enum'; v: readonly (infer V)[] }
          ? V
          : F extends { t: 'literal'; v: infer V }
            ? V
            : F extends { t: 'lista'; de: infer D }
              ? readonly Infer<D>[]
              : F extends { t: 'vazia' }
                ? readonly never[]
                : F extends { t: 'obj'; campos: infer C }
                  ? InferObj<C>
                  : F extends { t: 'ou'; de: readonly (infer D)[] }
                    ? D extends unknown
                      ? Infer<D>
                      : never
                    : never;

export const f = {
  texto: { t: 'texto' } as const,
  /** Data `AAAA-MM-DD` (tipo `string`; formato e existência conferidos em tempo de execução). */
  data: { t: 'data' } as const,
  inteiro: { t: 'inteiro' } as const,
  bool: { t: 'bool' } as const,
  nulo: { t: 'nulo' } as const,
  /** Lista que é SEMPRE vazia (ex.: documentos ainda indisponíveis). */
  vazia: { t: 'vazia' } as const,
  enumDe: <const V extends readonly string[]>(v: V) => ({ t: 'enum', v }) as const,
  literal: <const V extends string | number | boolean>(v: V) => ({ t: 'literal', v }) as const,
  lista: <const D extends Forma>(de: D) => ({ t: 'lista', de }) as const,
  obj: <const C extends { readonly [k: string]: Forma | FormaOpcional }>(campos: C) => ({ t: 'obj', campos }) as const,
  ou: <const D extends readonly Forma[]>(...de: D) => ({ t: 'ou', de }) as const,
  ouNulo: <const D extends Forma>(de: D) => ({ t: 'ou', de: [de, { t: 'nulo' }] as const }) as const,
  opcional: <const D extends Forma>(de: D) => ({ t: 'opcional', de }) as const,
};

/**
 * Confere `valor` contra `forma`. Devolve a lista de divergências (vazia = confere). As mensagens
 * citam só o CAMINHO e o tipo esperado, nunca o valor (o valor pode ser dado pessoal).
 */
export function conferirForma(forma: Forma, valor: unknown, caminho = '$'): string[] {
  switch (forma.t) {
    case 'texto':
      return typeof valor === 'string' ? [] : [`${caminho}: esperado texto`];
    case 'data':
      return ehDataAAAAMMDD(valor) ? [] : [`${caminho}: esperada data AAAA-MM-DD`];
    case 'inteiro':
      return typeof valor === 'number' && Number.isInteger(valor) ? [] : [`${caminho}: esperado inteiro`];
    case 'bool':
      return typeof valor === 'boolean' ? [] : [`${caminho}: esperado booleano`];
    case 'nulo':
      return valor === null ? [] : [`${caminho}: esperado null`];
    case 'enum':
      return typeof valor === 'string' && forma.v.includes(valor) ? [] : [`${caminho}: fora de [${forma.v.join(', ')}]`];
    case 'literal':
      return valor === forma.v ? [] : [`${caminho}: esperado ${JSON.stringify(forma.v)}`];
    case 'vazia':
      return Array.isArray(valor) && valor.length === 0 ? [] : [`${caminho}: esperada lista vazia`];
    case 'lista':
      if (!Array.isArray(valor)) return [`${caminho}: esperada lista`];
      return valor.flatMap((item, i) => conferirForma(forma.de, item, `${caminho}[${i}]`));
    case 'ou': {
      const tentativas = forma.de.map((d) => conferirForma(d, valor, caminho));
      return tentativas.some((e) => e.length === 0) ? [] : (tentativas.sort((a, b) => a.length - b.length)[0] ?? [`${caminho}: nenhuma alternativa`]);
    }
    case 'obj': {
      if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return [`${caminho}: esperado objeto`];
      const v = valor as Record<string, unknown>;
      const erros: string[] = [];
      for (const k of Object.keys(v)) {
        if (!Object.prototype.hasOwnProperty.call(forma.campos, k)) erros.push(`${caminho}.${k}: campo fora do contrato`);
      }
      for (const [k, cf] of Object.entries(forma.campos)) {
        const presente = Object.prototype.hasOwnProperty.call(v, k);
        if (cf.t === 'opcional') {
          if (presente) erros.push(...conferirForma(cf.de, v[k], `${caminho}.${k}`));
        } else if (!presente) {
          erros.push(`${caminho}.${k}: campo obrigatório ausente`);
        } else {
          erros.push(...conferirForma(cf, v[k], `${caminho}.${k}`));
        }
      }
      return erros;
    }
  }
}

/** Data de calendário `AAAA-MM-DD` que existe (ex.: `2027-02-30` não passa). */
export function ehDataAAAAMMDD(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

/** Todas as chaves de objeto que a forma pode produzir (em qualquer profundidade). */
export function chavesDaForma(forma: Forma | FormaOpcional): string[] {
  switch (forma.t) {
    case 'opcional':
    case 'lista':
      return chavesDaForma(forma.de);
    case 'ou':
      return forma.de.flatMap(chavesDaForma);
    case 'obj':
      return Object.entries(forma.campos).flatMap(([k, cf]) => [k, ...chavesDaForma(cf)]);
    default:
      return [];
  }
}

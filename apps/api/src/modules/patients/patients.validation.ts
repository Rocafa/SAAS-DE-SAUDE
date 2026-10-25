import { ehDataValida, EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';

/** Paginação: a lista nunca devolve a base inteira (ressalva do Guardião). */
export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 100;
export const PAGINA_MAXIMA = 1000;
/** Tamanho máximo do cursor opaco (R5 do parecer #76); o real fica perto de 250 caracteres. */
export const CURSOR_MAX = 512;

export interface NovoPaciente {
  readonly nome: string;
  readonly nomeSocial?: string;
  readonly cpf?: string;
  readonly telefone: string;
  readonly nascimento?: string;
}

export interface AlteracaoPaciente {
  readonly nome?: string;
  readonly nomeSocial?: string | null;
  readonly cpf?: string | null;
  readonly telefone?: string;
  readonly nascimento?: string | null;
  /**
   * C1-b′ (conferência de 24/10): a clínica conferiu o documento da data nova. Exigido quando a mudança
   * reduz a idade de paciente com 12 anos ou mais (`correcaoDeNascimentoExigeDocumento`). Só com `nascimento`.
   */
  readonly documentoConferido?: boolean;
}

export interface FiltroPacientes {
  readonly busca?: string;
  readonly situacao: 'ativos' | 'inativos' | 'todos';
  readonly limite: number;
  /** Cursor opaco da página anterior (`proximoCursor`); ausente = primeira página. */
  readonly cursor?: string;
}

/**
 * Página 2 em diante só por cursor (R5 do parecer #76): `pagina` aceita só 1 (compatibilidade da
 * primeira página) e não vem junto com `cursor`.
 */
function paginacao(v: Validador, pagina: number | undefined, cursor: string | undefined): { cursor?: string } {
  if (pagina !== undefined && (pagina !== 1 || cursor !== undefined)) v.falhar('pagina');
  return cursor !== undefined ? { cursor } : {};
}

/** Só dígitos; CPF com dígitos verificadores corretos e sem sequência repetida. */
export function normalizarCpf(valor: string): string | undefined {
  const d = valor.replace(/[.\-\s]/g, '');
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return undefined;
  const dv = (base: string, pesoInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  if (dv(d.slice(0, 9), 10) !== Number(d[9]) || dv(d.slice(0, 10), 11) !== Number(d[10])) return undefined;
  return d;
}

/** Telefone brasileiro: DDD + 8 ou 9 dígitos (aceita +55, espaços, parênteses e hífen). */
export function normalizarTelefone(valor: string): string | undefined {
  let d = valor.replace(/[\s()+\-.]/g, '');
  if (!/^\d+$/.test(d)) return undefined;
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (!/^[1-9]\d(9\d{8}|[2-8]\d{7})$/.test(d)) return undefined;
  return d;
}

/** Nascimento: data válida, entre 1900-01-01 e hoje. */
export function nascimentoValido(valor: string, hoje: Date = new Date()): boolean {
  return ehDataValida(valor) && valor >= '1900-01-01' && valor <= hoje.toISOString().slice(0, 10);
}

/** Nome para busca: minúsculas, sem acento, espaços simples. */
export function normalizarBusca(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const CAMPOS = ['nome', 'nomeSocial', 'cpf', 'telefone', 'nascimento'] as const;

function documentos(v: Validador, campo: 'cpf' | 'telefone' | 'nascimento', bruto: string | null | undefined) {
  if (bruto === undefined || bruto === null) return bruto;
  const normal =
    campo === 'cpf' ? normalizarCpf(bruto) : campo === 'telefone' ? normalizarTelefone(bruto) : nascimentoValido(bruto) ? bruto : undefined;
  if (normal === undefined) v.falhar(campo);
  return normal;
}

export function validarNovoPaciente(corpo: unknown): NovoPaciente {
  const v = new Validador(exigirObjeto(corpo, CAMPOS));
  const nome = v.texto('nome', { max: 200, obrigatorio: true });
  const nomeSocial = v.texto('nomeSocial', { max: 200 });
  const cpf = documentos(v, 'cpf', v.texto('cpf', { max: 20 }));
  const telefone = documentos(v, 'telefone', v.texto('telefone', { max: 25, obrigatorio: true }));
  const nascimento = documentos(v, 'nascimento', v.texto('nascimento', { max: 10 }));
  v.concluir();
  return {
    nome: nome,
    telefone: telefone as string,
    ...(nomeSocial ? { nomeSocial } : {}),
    ...(cpf ? { cpf } : {}),
    ...(nascimento ? { nascimento } : {}),
  };
}

export function validarAlteracaoPaciente(corpo: unknown): AlteracaoPaciente {
  const entrada = exigirObjeto(corpo, [...CAMPOS, 'documentoConferido']);
  const v = new Validador(entrada);
  const nome = v.texto('nome', { max: 200 });
  const nomeSocial = v.textoOuNulo('nomeSocial', { max: 200 });
  const cpf = documentos(v, 'cpf', v.textoOuNulo('cpf', { max: 20 }));
  const telefone = documentos(v, 'telefone', v.texto('telefone', { max: 25 }));
  const nascimento = documentos(v, 'nascimento', v.textoOuNulo('nascimento', { max: 10 }));
  const documentoConferido = v.booleano('documentoConferido');
  // A conferência de documento só acompanha a data de nascimento.
  if (documentoConferido !== undefined && !v.tem('nascimento')) v.falhar('documentoConferido');
  v.concluir();
  if (!CAMPOS.some((c) => v.tem(c))) throw new EntradaInvalidaError(['corpo']);
  const out: { -readonly [K in keyof AlteracaoPaciente]: AlteracaoPaciente[K] } = {};
  if (nome !== undefined) out.nome = nome;
  if (nomeSocial !== undefined) out.nomeSocial = nomeSocial;
  if (cpf !== undefined) out.cpf = cpf;
  if (telefone) out.telefone = telefone;
  if (nascimento !== undefined) out.nascimento = nascimento;
  if (documentoConferido !== undefined) out.documentoConferido = documentoConferido;
  return out;
}

/**
 * Chaves de texto livre que NUNCA podem vir na URL (V1 do parecer PR #57): a query string vai para os
 * logs de acesso do ALB, do WAF, de proxies e de APM, fora do nosso controle de retenção. A busca por
 * nome é `POST /pacientes/busca`, com o termo no corpo.
 */
export const TEXTO_LIVRE_NA_URL = ['busca', 'q', 'termo', 'nome', 'nomeSocial', 'cpf', 'telefone', 'nascimento'] as const;

/** `GET /pacientes`: só situação e paginação (limite, cursor) na query; termo de busca na URL é recusado (400). */
export function validarFiltroPacientes(query: unknown): FiltroPacientes {
  if (
    typeof query === 'object' &&
    query !== null &&
    TEXTO_LIVRE_NA_URL.some((k) => Object.prototype.hasOwnProperty.call(query, k))
  ) {
    throw new EntradaInvalidaError(['busca_na_url']);
  }
  const v = new Validador(exigirObjeto(query ?? {}, ['situacao', 'pagina', 'limite', 'cursor']));
  const situacao = v.umDe('situacao', ['ativos', 'inativos', 'todos'] as const, false) ?? 'ativos';
  const pagina = v.tem('pagina') ? v.inteiroDeTexto('pagina', { min: 1, max: PAGINA_MAXIMA, padrao: 1 }) : undefined;
  const limite = v.inteiroDeTexto('limite', { min: 1, max: LIMITE_MAXIMO, padrao: LIMITE_PADRAO });
  const cursor = v.texto('cursor', { max: CURSOR_MAX });
  const extra = paginacao(v, pagina, cursor);
  v.concluir();
  return { situacao, limite, ...extra };
}

/** `POST /pacientes/busca`: termo (2 a 80 caracteres) obrigatório no corpo; paginação como no GET. */
export function validarBuscaPacientes(corpo: unknown): FiltroPacientes & { readonly busca: string } {
  const v = new Validador(exigirObjeto(corpo, ['busca', 'situacao', 'pagina', 'limite', 'cursor']));
  const busca = v.texto('busca', { min: 2, max: 80, obrigatorio: true });
  const situacao = v.umDe('situacao', ['ativos', 'inativos', 'todos'] as const, false) ?? 'ativos';
  const pagina = v.inteiro('pagina', { min: 1, max: PAGINA_MAXIMA });
  const limite = v.inteiro('limite', { min: 1, max: LIMITE_MAXIMO }) ?? LIMITE_PADRAO;
  const cursor = v.texto('cursor', { max: CURSOR_MAX });
  const extra = paginacao(v, pagina, cursor);
  v.concluir();
  const normal = normalizarBusca(busca);
  // Termo só de acentos/espaços fica vazio depois de normalizar: seria "listar tudo" disfarçado.
  if (normal.length < 2) throw new EntradaInvalidaError(['busca']);
  return { busca: normal, situacao, limite, ...extra };
}

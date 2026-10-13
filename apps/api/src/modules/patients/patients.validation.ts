import { ehDataValida, EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';

/** Paginação: a lista nunca devolve a base inteira (ressalva do Guardião). */
export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 100;
export const PAGINA_MAXIMA = 1000;

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
}

export interface FiltroPacientes {
  readonly busca?: string;
  readonly situacao: 'ativos' | 'inativos' | 'todos';
  readonly pagina: number;
  readonly limite: number;
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
  const entrada = exigirObjeto(corpo, CAMPOS);
  const v = new Validador(entrada);
  const nome = v.texto('nome', { max: 200 });
  const nomeSocial = v.textoOuNulo('nomeSocial', { max: 200 });
  const cpf = documentos(v, 'cpf', v.textoOuNulo('cpf', { max: 20 }));
  const telefone = documentos(v, 'telefone', v.texto('telefone', { max: 25 }));
  const nascimento = documentos(v, 'nascimento', v.textoOuNulo('nascimento', { max: 10 }));
  v.concluir();
  if (!CAMPOS.some((c) => v.tem(c))) throw new EntradaInvalidaError(['corpo']);
  const out: { -readonly [K in keyof AlteracaoPaciente]: AlteracaoPaciente[K] } = {};
  if (nome !== undefined) out.nome = nome;
  if (nomeSocial !== undefined) out.nomeSocial = nomeSocial;
  if (cpf !== undefined) out.cpf = cpf;
  if (telefone) out.telefone = telefone;
  if (nascimento !== undefined) out.nascimento = nascimento;
  return out;
}

export function validarFiltroPacientes(query: unknown): FiltroPacientes {
  const v = new Validador(exigirObjeto(query ?? {}, ['busca', 'situacao', 'pagina', 'limite']));
  const busca = v.texto('busca', { min: 2, max: 80 });
  const situacao = v.umDe('situacao', ['ativos', 'inativos', 'todos'] as const, false) ?? 'ativos';
  const pagina = v.inteiroDeTexto('pagina', { min: 1, max: PAGINA_MAXIMA, padrao: 1 });
  const limite = v.inteiroDeTexto('limite', { min: 1, max: LIMITE_MAXIMO, padrao: LIMITE_PADRAO });
  v.concluir();
  return { situacao, pagina, limite, ...(busca ? { busca: normalizarBusca(busca) } : {}) };
}

import { ehDataValida, EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';
import {
  ESCOPOS_INFORMACAO_CLINICA,
  GUARDIAN_END_REASONS,
  GUARDIAN_KINDS,
  type EscopoInformacaoClinica,
  type GuardianEndReason,
  type GuardianKind,
} from '../../db/schema';
import { normalizarCpf, normalizarTelefone } from './patients.validation';

/** Dados da PESSOA responsável. Nome obrigatório; CPF e telefone opcionais (CPF é exigido no recibo, não aqui). */
export interface PessoaResponsavel {
  readonly nome: string;
  readonly cpf?: string;
  readonly telefone?: string;
}

export interface NovoVinculo {
  /** Pessoa já cadastrada (irmãos): ou isto, ou os dados de `pessoa`. */
  readonly responsavelId?: string;
  readonly pessoa?: PessoaResponsavel;
  readonly tipo: GuardianKind;
  readonly pagador: boolean;
  readonly recebeInformacaoClinica: boolean;
  /** Obrigatória ao ligar a informação clínica: a avaliação do profissional (cifrada; nunca na trilha). */
  readonly justificativa?: string;
  /** Apoiador (0055, B1): o profissional atesta a autorização expressa do paciente (como e em que limites, na justificativa). */
  readonly autorizacaoDoPaciente?: boolean;
  /** 0056 (A1 b): escopo da informação ao ligar a marca; padrão `essencial`. */
  readonly escopoInformacao?: EscopoInformacaoClinica;
  /** 0056 (A1 c): a decisão supera o pedido de sigilo do adolescente por risco (motivo na justificativa). */
  readonly superaSigiloPorRisco?: boolean;
  /** Início da vigência (AAAA-MM-DD, não futuro). Padrão: hoje no fuso da clínica. */
  readonly desde?: string;
  /**
   * Decisão judicial, cifrada (A3 do #67): curatela (tipo curador, campos `curatelaReferencia`/`curatelaEscopo`) ou
   * termo de decisão apoiada (tipo apoiador, 0055, campos `apoioReferencia`/`apoioEscopo`). Mesmas colunas no banco.
   */
  readonly curatela?: { readonly referencia: string; readonly escopo: string };
  /** Paciente adulto ciente de que um terceiro é o pagador (A7 do #67). */
  readonly cienciaDoPaciente: boolean;
  /** Pai/mãe ou tutor de paciente MAIOR (ou emancipado): a recepção confirma ciência de que ele não representa mais (A3 do #67). */
  readonly confirmaPacienteMaior: boolean;
}

export interface AlteracaoVinculo {
  readonly nome?: string;
  readonly cpf?: string | null;
  readonly telefone?: string | null;
  readonly recebeInformacaoClinica?: boolean;
  readonly justificativa?: string;
  /** Apoiador (0055, B1): autorização expressa do paciente ao ligar a marca. */
  readonly autorizacaoDoPaciente?: boolean;
  /** 0056 (A1 b): escopo ao ligar (ou renovar) a marca; padrão `essencial`. */
  readonly escopoInformacao?: EscopoInformacaoClinica;
  /** 0056 (A1 c): a decisão supera o pedido de sigilo do adolescente por risco. */
  readonly superaSigiloPorRisco?: boolean;
}

/** Pedido de sigilo do adolescente (0056): para todos os responsáveis ou para um vínculo. */
export interface NovoPedidoDeSigilo {
  readonly vinculoId?: string;
}

export interface Encerramento {
  readonly motivo: GuardianEndReason;
  /** Fim EXCLUSIVO da vigência (AAAA-MM-DD, não futuro). Padrão: hoje no fuso da clínica. */
  readonly ate?: string;
}

const CAMPOS_NOVO = [
  'responsavelId',
  'nome',
  'cpf',
  'telefone',
  'tipo',
  'pagador',
  'recebeInformacaoClinica',
  'justificativa',
  'desde',
  'curatelaReferencia',
  'curatelaEscopo',
  'cienciaDoPaciente',
  'apoioReferencia',
  'apoioEscopo',
  'confirmaPacienteMaior',
  'autorizacaoDoPaciente',
  'escopoInformacao',
  'superaSigiloPorRisco',
] as const;
const CAMPOS_ALTERACAO = [
  'nome',
  'cpf',
  'telefone',
  'recebeInformacaoClinica',
  'justificativa',
  'autorizacaoDoPaciente',
  'escopoInformacao',
  'superaSigiloPorRisco',
] as const;

function cpfOuFalha(v: Validador, bruto: string | null | undefined): string | null | undefined {
  if (bruto === undefined || bruto === null) return bruto;
  const n = normalizarCpf(bruto);
  if (n === undefined) v.falhar('cpf');
  return n;
}

function telefoneOuFalha(v: Validador, bruto: string | null | undefined): string | null | undefined {
  if (bruto === undefined || bruto === null) return bruto;
  const n = normalizarTelefone(bruto);
  if (n === undefined) v.falhar('telefone');
  return n;
}

/** Justificativa só junto com a marca LIGADA, e obrigatória nesse caso (decisão do profissional, A1 do #67). */
function justificativaDaDecisao(v: Validador, liga: boolean | undefined): string | undefined {
  const j = v.texto('justificativa', { min: 10, max: 1000 });
  if (liga === true && j === undefined) v.falhar('justificativa');
  if (liga !== true && v.tem('justificativa')) v.falhar('justificativa');
  return j;
}

/** Autorização do paciente (apoiador, 0055): só `true`, e só junto com a marca LIGADA. O tipo é conferido no serviço. */
function autorizacaoDaDecisao(v: Validador, liga: boolean | undefined): boolean {
  const a = v.booleano('autorizacaoDoPaciente');
  if (a === false || (a === true && liga !== true)) v.falhar('autorizacaoDoPaciente');
  return a === true;
}

/**
 * Escopo e exceção por risco (0056): só junto com a marca LIGADA. Ligada sem escopo = `essencial` (padrão
 * protetor). A exceção por risco só aceita `true` (omitir = sem exceção).
 */
function extrasDaDecisao(v: Validador, liga: boolean | undefined): { escopoInformacao?: EscopoInformacaoClinica; superaSigiloPorRisco?: true } {
  const escopo = v.umDe<EscopoInformacaoClinica>('escopoInformacao', ESCOPOS_INFORMACAO_CLINICA, false);
  const risco = v.booleano('superaSigiloPorRisco');
  if (escopo !== undefined && liga !== true) v.falhar('escopoInformacao');
  if (risco === false || (risco === true && liga !== true)) v.falhar('superaSigiloPorRisco');
  if (liga !== true) return {};
  return { escopoInformacao: escopo ?? 'essencial', ...(risco === true ? { superaSigiloPorRisco: true as const } : {}) };
}

/** Corpo do pedido de sigilo: `{}` (todos os responsáveis) ou `{ vinculoId }`. */
export function validarPedidoDeSigilo(corpo: unknown): NovoPedidoDeSigilo {
  const v = new Validador(exigirObjeto(corpo ?? {}, ['vinculoId']));
  const vinculoId = v.uuid('vinculoId', false);
  v.concluir();
  return vinculoId ? { vinculoId } : {};
}

function dataNaoFutura(v: Validador, campo: string, hoje: string): string | undefined {
  const d = v.texto(campo, { max: 10 });
  if (d === undefined) return undefined;
  if (!ehDataValida(d) || d > hoje || d < '1900-01-01') {
    v.falhar(campo);
    return undefined;
  }
  return d;
}

export function validarNovoVinculo(corpo: unknown, hoje: string): NovoVinculo {
  const v = new Validador(exigirObjeto(corpo, CAMPOS_NOVO));
  const responsavelId = v.uuid('responsavelId', false);
  const nome = v.texto('nome', { min: 2, max: 200 });
  const cpf = cpfOuFalha(v, v.texto('cpf', { max: 20 }));
  const telefone = telefoneOuFalha(v, v.texto('telefone', { max: 25 }));
  const tipo = v.umDe('tipo', GUARDIAN_KINDS, true);
  const pagador = v.booleano('pagador') ?? false;
  const recebeInformacaoClinica = v.booleano('recebeInformacaoClinica') ?? false;
  const justificativa = justificativaDaDecisao(v, recebeInformacaoClinica);
  const autorizacaoDoPaciente = autorizacaoDaDecisao(v, recebeInformacaoClinica);
  const extras = extrasDaDecisao(v, recebeInformacaoClinica);
  const desde = dataNaoFutura(v, 'desde', hoje);
  const curatelaReferencia = v.texto('curatelaReferencia', { min: 3, max: 300 });
  const curatelaEscopo = v.texto('curatelaEscopo', { min: 3, max: 1000 });
  // Curador exige a decisão judicial e o escopo; os outros tipos não levam estes campos.
  if (tipo === 'curador' && (curatelaReferencia === undefined || curatelaEscopo === undefined)) v.falhar(curatelaReferencia === undefined ? 'curatelaReferencia' : 'curatelaEscopo');
  if (tipo !== 'curador' && (v.tem('curatelaReferencia') || v.tem('curatelaEscopo'))) v.falhar('curatelaReferencia');
  // Apoiador (0055) exige o termo homologado e os limites do apoio (CC art. 1.783-A); só ele leva estes campos.
  const apoioReferencia = v.texto('apoioReferencia', { min: 3, max: 300 });
  const apoioEscopo = v.texto('apoioEscopo', { min: 3, max: 1000 });
  if (tipo === 'apoiador' && (apoioReferencia === undefined || apoioEscopo === undefined)) v.falhar(apoioReferencia === undefined ? 'apoioReferencia' : 'apoioEscopo');
  if (tipo !== 'apoiador' && (v.tem('apoioReferencia') || v.tem('apoioEscopo'))) v.falhar('apoioReferencia');
  const cienciaDoPaciente = v.booleano('cienciaDoPaciente') ?? false;
  const confirmaPacienteMaior = v.booleano('confirmaPacienteMaior') ?? false;
  if (confirmaPacienteMaior && tipo !== 'pai_mae' && tipo !== 'tutor') v.falhar('confirmaPacienteMaior');
  if (autorizacaoDoPaciente && tipo !== 'apoiador') v.falhar('autorizacaoDoPaciente');
  // Ou a pessoa existente, ou os dados de uma nova (nunca os dois, nunca nenhum).
  const temPessoa = v.tem('nome') || v.tem('cpf') || v.tem('telefone');
  if (v.tem('responsavelId') === temPessoa) v.falhar(v.tem('responsavelId') ? 'responsavelId' : 'nome');
  v.concluir();
  return {
    ...(responsavelId ? { responsavelId } : {}),
    ...(nome ? { pessoa: { nome, ...(cpf ? { cpf } : {}), ...(telefone ? { telefone } : {}) } } : {}),
    tipo: tipo as GuardianKind,
    pagador,
    recebeInformacaoClinica,
    ...(justificativa ? { justificativa } : {}),
    ...(autorizacaoDoPaciente ? { autorizacaoDoPaciente } : {}),
    ...extras,
    ...(desde ? { desde } : {}),
    ...(curatelaReferencia && curatelaEscopo ? { curatela: { referencia: curatelaReferencia, escopo: curatelaEscopo } } : {}),
    ...(apoioReferencia && apoioEscopo ? { curatela: { referencia: apoioReferencia, escopo: apoioEscopo } } : {}),
    cienciaDoPaciente,
    confirmaPacienteMaior,
  };
}

export function validarAlteracaoVinculo(corpo: unknown): AlteracaoVinculo {
  const v = new Validador(exigirObjeto(corpo, CAMPOS_ALTERACAO));
  const nome = v.texto('nome', { min: 2, max: 200 });
  const cpf = cpfOuFalha(v, v.textoOuNulo('cpf', { max: 20 }));
  const telefone = telefoneOuFalha(v, v.textoOuNulo('telefone', { max: 25 }));
  const recebeInformacaoClinica = v.booleano('recebeInformacaoClinica');
  const justificativa = justificativaDaDecisao(v, recebeInformacaoClinica);
  const autorizacaoDoPaciente = autorizacaoDaDecisao(v, recebeInformacaoClinica);
  const extras = extrasDaDecisao(v, recebeInformacaoClinica);
  v.concluir();
  if (!CAMPOS_ALTERACAO.some((c) => v.tem(c))) throw new EntradaInvalidaError(['corpo']);
  const out: { -readonly [K in keyof AlteracaoVinculo]: AlteracaoVinculo[K] } = {};
  if (nome !== undefined) out.nome = nome;
  if (cpf !== undefined) out.cpf = cpf;
  if (telefone !== undefined) out.telefone = telefone;
  if (recebeInformacaoClinica !== undefined) out.recebeInformacaoClinica = recebeInformacaoClinica;
  if (justificativa !== undefined) out.justificativa = justificativa;
  if (autorizacaoDoPaciente) out.autorizacaoDoPaciente = true;
  if (extras.escopoInformacao) out.escopoInformacao = extras.escopoInformacao;
  if (extras.superaSigiloPorRisco) out.superaSigiloPorRisco = true;
  return out;
}

export function validarPagador(corpo: unknown): { readonly pagador: boolean; readonly cienciaDoPaciente: boolean } {
  const v = new Validador(exigirObjeto(corpo, ['pagador', 'cienciaDoPaciente']));
  const pagador = v.booleano('pagador');
  if (pagador === undefined) v.falhar('pagador');
  const cienciaDoPaciente = v.booleano('cienciaDoPaciente') ?? false;
  v.concluir();
  return { pagador: pagador as boolean, cienciaDoPaciente };
}

/** Anulação de cadastro errado (A4 do #67): motivo obrigatório, cifrado; nunca na trilha. */
export function validarAnulacao(corpo: unknown): { readonly motivo: string } {
  const v = new Validador(exigirObjeto(corpo, ['motivo']));
  const motivo = v.texto('motivo', { min: 10, max: 500, obrigatorio: true });
  v.concluir();
  return { motivo };
}

/** Emancipação (A3 do #67): data (não futura) e referência do documento (cifrada). */
export function validarEmancipacao(corpo: unknown, hoje: string): { readonly data: string; readonly documento: string } {
  const v = new Validador(exigirObjeto(corpo, ['data', 'documento']));
  const data = dataNaoFutura(v, 'data', hoje);
  if (!v.tem('data')) v.falhar('data');
  const documento = v.texto('documento', { min: 3, max: 300, obrigatorio: true });
  v.concluir();
  return { data: data as string, documento };
}

export function validarEncerramento(corpo: unknown, hoje: string): Encerramento {
  const v = new Validador(exigirObjeto(corpo, ['motivo', 'ate']));
  const motivo = v.umDe('motivo', GUARDIAN_END_REASONS, true);
  // Cadastro errado vai pela anulação (motivo e prazo de descarte); emancipação, pelo registro no paciente.
  if (motivo === 'cadastro_errado' || motivo === 'emancipacao') v.falhar('motivo');
  const ate = dataNaoFutura(v, 'ate', hoje);
  v.concluir();
  return { motivo: motivo as GuardianEndReason, ...(ate ? { ate } : {}) };
}

export function validarFiltroResponsaveis(query: unknown): { readonly situacao: 'vigentes' | 'todos' } {
  const v = new Validador(exigirObjeto(query ?? {}, ['situacao']));
  const situacao = v.umDe('situacao', ['vigentes', 'todos'] as const, false) ?? 'vigentes';
  v.concluir();
  return { situacao };
}

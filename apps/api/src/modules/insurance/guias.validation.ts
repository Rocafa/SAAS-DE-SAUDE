import { ehDataValida, EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';
import {
  GUIDE_OVERRIDE_REASONS,
  GUIDE_REVERSAL_REASONS,
  PACKAGE_PROFESSIONAL_CHANGE_REASONS,
  PACKAGE_REVERSAL_REASONS,
  SIGNATURE_METHODS,
  type GuideOverrideReason,
  type GuideReversalReason,
  type PackageProfessionalChangeReason,
  type PackageReversalReason,
  type SignatureMethod,
} from '../../db/schema';
import { diasEntre, type Limiares } from './guias-regras';

/**
 * Validação ESTRITA de convênios, guias e pacotes (mesmas regras de common/validacao.ts: chave
 * desconhecida é erro, a resposta diz o campo e nunca o valor). Número da guia, senha e carteirinha
 * só no CORPO: na URL (query) dão 400 `dado_na_url` (V1 do parecer PR #57).
 */

export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 100;
export const PAGINA_MAXIMA = 10_000;
/** Relatório por convênio: janela de no máximo 31 dias (como a agenda). */
export const JANELA_RELATORIO_DIAS = 31;
/** Teto de linhas do relatório, mesmo dentro da janela (`truncado: true`). */
export const MAXIMO_LINHAS_RELATORIO = 5000;

/** Identificadores do paciente na operadora: nunca na URL. */
const DADO_NA_URL = ['numero', 'senha', 'carteirinha', 'busca', 'q', 'termo', 'nome', 'cpf'] as const;

// Número da guia/carteirinha/senha: letras, dígitos e separadores comuns (sem controle, sem espaço duplo).
const IDENTIFICADOR_RE = /^[0-9A-Za-z][0-9A-Za-z ./-]{0,39}$/;
const DISPOSITIVO_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

export interface NovoConvenio {
  readonly nome: string;
  readonly registroAns?: string;
  readonly valorSessaoCentavos?: number;
  readonly exigeSenha: boolean;
  readonly exigeAssinatura: boolean;
  readonly validadePadraoDias?: number;
}

export interface AlteracaoConvenio {
  readonly nome?: string;
  readonly registroAns?: string | null;
  readonly valorSessaoCentavos?: number | null;
  readonly exigeSenha?: boolean;
  readonly exigeAssinatura?: boolean;
  readonly validadePadraoDias?: number | null;
}

export interface NovaGuia {
  readonly pacienteId: string;
  readonly convenioId: string;
  readonly numero: string;
  readonly senha?: string;
  readonly carteirinha?: string;
  readonly sessoesAutorizadas: number;
  readonly emissao?: string;
  /** Opcional se o convênio tiver validade padrão (conta a partir da emissão ou de hoje). */
  readonly validade?: string;
}

export interface AlteracaoGuia {
  readonly sessoesAutorizadas?: number;
  readonly validade?: string;
  readonly senha?: string | null;
  readonly carteirinha?: string | null;
}

export interface FiltroGuias {
  readonly pacienteId?: string;
  readonly convenioId?: string;
  readonly situacao: 'ativas' | 'todas';
  readonly pagina: number;
  readonly limite: number;
}

export interface FiltroRelatorio {
  readonly de: string;
  readonly ate: string;
}

export interface NovoPacote {
  readonly pacienteId: string;
  readonly nome: string;
  readonly total: number;
  readonly tipoId?: string;
  readonly validade?: string;
  /** R13 do #65: profissional fixado na venda (consumo e cobrança seguem ele). */
  readonly profissionalId?: string;
}

export interface FiltroPacotes {
  readonly pacienteId?: string;
  readonly situacao: 'ativos' | 'todos';
}

function recusarDadoNaUrl(query: unknown): void {
  if (typeof query === 'object' && query !== null && DADO_NA_URL.some((k) => Object.prototype.hasOwnProperty.call(query, k))) {
    throw new EntradaInvalidaError(['dado_na_url']);
  }
}

function identificador(v: Validador, campo: string, obrigatorio: boolean): string | undefined {
  const t = obrigatorio ? v.texto(campo, { max: 40, obrigatorio: true }) : v.texto(campo, { max: 40 });
  if (t !== undefined && !IDENTIFICADOR_RE.test(t)) {
    v.falhar(campo);
    return undefined;
  }
  return t;
}

function identificadorOuNulo(v: Validador, entrada: Record<string, unknown>, campo: string): string | null | undefined {
  if (v.tem(campo) && entrada[campo] === null) return null;
  return identificador(v, campo, false);
}

function data(v: Validador, campo: string, obrigatorio = false): string | undefined {
  const t = obrigatorio ? v.texto(campo, { max: 10, obrigatorio: true }) : v.texto(campo, { max: 10 });
  if (t !== undefined && !ehDataValida(t)) {
    v.falhar(campo);
    return undefined;
  }
  return t;
}

function inteiroOuNulo(v: Validador, entrada: Record<string, unknown>, campo: string, faixa: { min: number; max: number }) {
  if (v.tem(campo) && entrada[campo] === null) return null;
  return v.inteiro(campo, faixa);
}

function ansOuNulo(v: Validador, entrada: Record<string, unknown>): string | null | undefined {
  if (v.tem('registroAns') && entrada.registroAns === null) return null;
  const t = v.texto('registroAns', { max: 6 });
  if (t !== undefined && !/^\d{6}$/.test(t)) {
    v.falhar('registroAns');
    return undefined;
  }
  return t;
}

const CAMPOS_CONVENIO = ['nome', 'registroAns', 'valorSessaoCentavos', 'exigeSenha', 'exigeAssinatura', 'validadePadraoDias'] as const;
const FAIXA_VALOR = { min: 0, max: 10_000_000 };
const FAIXA_VALIDADE = { min: 1, max: 365 };

export function validarNovoConvenio(corpo: unknown): NovoConvenio {
  const entrada = exigirObjeto(corpo, CAMPOS_CONVENIO);
  const v = new Validador(entrada);
  const nome = v.texto('nome', { max: 120, obrigatorio: true });
  const registroAns = ansOuNulo(v, entrada);
  const valor = v.inteiro('valorSessaoCentavos', FAIXA_VALOR);
  const exigeSenha = v.booleano('exigeSenha') ?? false;
  const exigeAssinatura = v.booleano('exigeAssinatura') ?? false;
  const validade = v.inteiro('validadePadraoDias', FAIXA_VALIDADE);
  if (registroAns === null) v.falhar('registroAns');
  v.concluir();
  return {
    nome: nome,
    exigeSenha,
    exigeAssinatura,
    ...(registroAns ? { registroAns } : {}),
    ...(valor !== undefined ? { valorSessaoCentavos: valor } : {}),
    ...(validade !== undefined ? { validadePadraoDias: validade } : {}),
  };
}

export function validarAlteracaoConvenio(corpo: unknown): AlteracaoConvenio {
  const entrada = exigirObjeto(corpo, CAMPOS_CONVENIO);
  const v = new Validador(entrada);
  const out: { -readonly [K in keyof AlteracaoConvenio]: AlteracaoConvenio[K] } = {};
  const nome = v.texto('nome', { max: 120 });
  const registroAns = ansOuNulo(v, entrada);
  const valor = inteiroOuNulo(v, entrada, 'valorSessaoCentavos', FAIXA_VALOR);
  const exigeSenha = v.booleano('exigeSenha');
  const exigeAssinatura = v.booleano('exigeAssinatura');
  const validade = inteiroOuNulo(v, entrada, 'validadePadraoDias', FAIXA_VALIDADE);
  v.concluir();
  if (!CAMPOS_CONVENIO.some((c) => v.tem(c))) throw new EntradaInvalidaError(['corpo']);
  if (nome !== undefined) out.nome = nome;
  if (registroAns !== undefined) out.registroAns = registroAns;
  if (valor !== undefined) out.valorSessaoCentavos = valor;
  if (exigeSenha !== undefined) out.exigeSenha = exigeSenha;
  if (exigeAssinatura !== undefined) out.exigeAssinatura = exigeAssinatura;
  if (validade !== undefined) out.validadePadraoDias = validade;
  return out;
}

export function validarNovaGuia(corpo: unknown): NovaGuia {
  const v = new Validador(
    exigirObjeto(corpo, ['pacienteId', 'convenioId', 'numero', 'senha', 'carteirinha', 'sessoesAutorizadas', 'emissao', 'validade']),
  );
  const pacienteId = v.uuid('pacienteId', true);
  const convenioId = v.uuid('convenioId', true);
  const numero = identificador(v, 'numero', true);
  const senha = identificador(v, 'senha', false);
  const carteirinha = identificador(v, 'carteirinha', false);
  const sessoes = v.inteiro('sessoesAutorizadas', { min: 1, max: 200, obrigatorio: true });
  const emissao = data(v, 'emissao');
  const validade = data(v, 'validade');
  if (emissao && validade && diasEntre(emissao, validade) < 0) v.falhar('validade');
  v.concluir();
  return {
    pacienteId: pacienteId as string,
    convenioId: convenioId as string,
    numero: numero as string,
    sessoesAutorizadas: sessoes as number,
    ...(senha ? { senha } : {}),
    ...(carteirinha ? { carteirinha } : {}),
    ...(emissao ? { emissao } : {}),
    ...(validade ? { validade } : {}),
  };
}

export function validarAlteracaoGuia(corpo: unknown): AlteracaoGuia {
  const campos = ['sessoesAutorizadas', 'validade', 'senha', 'carteirinha'] as const;
  const entrada = exigirObjeto(corpo, campos);
  const v = new Validador(entrada);
  const sessoes = v.inteiro('sessoesAutorizadas', { min: 1, max: 200 });
  const validade = data(v, 'validade');
  const senha = identificadorOuNulo(v, entrada, 'senha');
  const carteirinha = identificadorOuNulo(v, entrada, 'carteirinha');
  v.concluir();
  if (!campos.some((c) => v.tem(c))) throw new EntradaInvalidaError(['corpo']);
  const out: { -readonly [K in keyof AlteracaoGuia]: AlteracaoGuia[K] } = {};
  if (sessoes !== undefined) out.sessoesAutorizadas = sessoes;
  if (validade !== undefined) out.validade = validade;
  if (senha !== undefined) out.senha = senha;
  if (carteirinha !== undefined) out.carteirinha = carteirinha;
  return out;
}

export function validarFiltroGuias(query: unknown): FiltroGuias {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['pacienteId', 'convenioId', 'situacao', 'pagina', 'limite']));
  const pacienteId = v.uuid('pacienteId', false);
  const convenioId = v.uuid('convenioId', false);
  const situacao = v.umDe('situacao', ['ativas', 'todas'] as const, false) ?? 'ativas';
  const pagina = v.inteiroDeTexto('pagina', { min: 1, max: PAGINA_MAXIMA, padrao: 1 });
  const limite = v.inteiroDeTexto('limite', { min: 1, max: LIMITE_MAXIMO, padrao: LIMITE_PADRAO });
  v.concluir();
  return { situacao, pagina, limite, ...(pacienteId ? { pacienteId } : {}), ...(convenioId ? { convenioId } : {}) };
}

export function validarLimiares(query: unknown, padrao: Limiares): Limiares {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['diasVencimento', 'sessoesRestantes']));
  const diasVencimento = v.inteiroDeTexto('diasVencimento', { min: 0, max: 90, padrao: padrao.diasVencimento });
  const sessoesRestantes = v.inteiroDeTexto('sessoesRestantes', { min: 1, max: 20, padrao: padrao.sessoesRestantes });
  v.concluir();
  return { diasVencimento, sessoesRestantes };
}

export function validarFiltroRelatorio(query: unknown): FiltroRelatorio {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate']));
  const de = data(v, 'de', true);
  const ate = data(v, 'ate', true);
  if (de && ate) {
    const dias = diasEntre(de, ate);
    if (dias < 0 || dias >= JANELA_RELATORIO_DIAS) v.falhar('ate');
  }
  v.concluir();
  return { de: de as string, ate: ate as string };
}

export function validarConsumoGuia(corpo: unknown): { agendamentoId: string; override?: GuideOverrideReason } {
  const v = new Validador(exigirObjeto(corpo, ['agendamentoId', 'overrideMotivo']));
  const agendamentoId = v.uuid('agendamentoId', true);
  const override = v.umDe('overrideMotivo', GUIDE_OVERRIDE_REASONS, false);
  v.concluir();
  return { agendamentoId: agendamentoId as string, ...(override ? { override } : {}) };
}

export function validarEstornoGuia(corpo: unknown): GuideReversalReason {
  const v = new Validador(exigirObjeto(corpo, ['motivo']));
  const motivo = v.umDe('motivo', GUIDE_REVERSAL_REASONS, true);
  v.concluir();
  return motivo as GuideReversalReason;
}

export function validarAssinatura(corpo: unknown): { meio: SignatureMethod; dispositivo: string | null } {
  const v = new Validador(exigirObjeto(corpo, ['meio', 'dispositivo']));
  const meio = v.umDe('meio', SIGNATURE_METHODS, true);
  const dispositivo = v.texto('dispositivo', { max: 60 });
  if (dispositivo !== undefined && !DISPOSITIVO_RE.test(dispositivo)) v.falhar('dispositivo');
  v.concluir();
  return { meio: meio as SignatureMethod, dispositivo: dispositivo ?? null };
}

export function validarNovoPacote(corpo: unknown): NovoPacote {
  const v = new Validador(exigirObjeto(corpo, ['pacienteId', 'nome', 'total', 'tipoId', 'validade', 'profissionalId']));
  const pacienteId = v.uuid('pacienteId', true);
  const nome = v.texto('nome', { max: 100, obrigatorio: true });
  const total = v.inteiro('total', { min: 1, max: 200, obrigatorio: true });
  const tipoId = v.uuid('tipoId', false);
  const validade = data(v, 'validade');
  const profissionalId = v.uuid('profissionalId', false);
  v.concluir();
  return {
    ...(profissionalId ? { profissionalId } : {}),
    pacienteId: pacienteId as string,
    nome: nome,
    total: total as number,
    ...(tipoId ? { tipoId } : {}),
    ...(validade ? { validade } : {}),
  };
}

export function validarFiltroPacotes(query: unknown): FiltroPacotes {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['pacienteId', 'situacao']));
  const pacienteId = v.uuid('pacienteId', false);
  const situacao = v.umDe('situacao', ['ativos', 'todos'] as const, false) ?? 'ativos';
  v.concluir();
  return { situacao, ...(pacienteId ? { pacienteId } : {}) };
}

export function validarConsumoPacote(corpo: unknown): { agendamentoId: string } {
  const v = new Validador(exigirObjeto(corpo, ['agendamentoId']));
  const agendamentoId = v.uuid('agendamentoId', true);
  v.concluir();
  return { agendamentoId: agendamentoId as string };
}

export function validarEstornoPacote(corpo: unknown): PackageReversalReason {
  const v = new Validador(exigirObjeto(corpo, ['motivo']));
  const motivo = v.umDe('motivo', PACKAGE_REVERSAL_REASONS, true);
  v.concluir();
  return motivo as PackageReversalReason;
}

/** Troca do profissional do pacote (R13 do #65): novo profissional e motivo (enum, nunca texto livre). */
export function validarTrocaProfissionalPacote(corpo: unknown): { profissionalId: string; motivo: PackageProfessionalChangeReason } {
  const v = new Validador(exigirObjeto(corpo, ['profissionalId', 'motivo']));
  const profissionalId = v.uuid('profissionalId', true);
  const motivo = v.umDe('motivo', PACKAGE_PROFESSIONAL_CHANGE_REASONS, true);
  v.concluir();
  return { profissionalId: profissionalId as string, motivo: motivo as PackageProfessionalChangeReason };
}

/** GET sem parâmetros: qualquer query é recusada (e dado pessoal na URL tem código próprio). */
export function validarQueryVazia(query: unknown): void {
  recusarDadoNaUrl(query);
  exigirObjeto(query ?? {}, []);
}

/** Corpo vazio (ou ausente) em ações sem parâmetros (cancelar, inativar). */
export function validarCorpoVazio(corpo: unknown): void {
  exigirObjeto(corpo ?? {}, []);
}

import { ehDataValida, EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';
import {
  ATTENDANCE_KINDS,
  CASH_SHIFTS,
  CHARGE_CANCEL_REASONS,
  PAYMENT_METHODS,
  PAYMENT_REVERSAL_REASONS,
  RECEIPT_CANCEL_REASONS,
  type AttendanceKind,
  type CashShift,
  type ChargeCancelReason,
  type PaymentMethod,
  type PaymentReversalReason,
  type ReceiptCancelReason,
} from '../../db/schema';
import { diasEntre } from '../insurance/guias-regras';
import { normalizarCpf } from '../patients/patients.validation';
import { descricaoEhNeutraOuAceita } from './financeiro-regras';

/**
 * Validação ESTRITA do financeiro (common/validacao.ts: chave desconhecida é erro; a resposta diz o
 * campo, nunca o valor). Nome e CPF (pagador, profissional) só no CORPO: na URL dão 400 `dado_na_url`
 * (V1 do parecer PR #57). Na URL só ids, datas e enums.
 */

/** Janela das consultas por período (contas a receber, recibos, Receita Saúde): até 31 dias. */
export const JANELA_FINANCEIRO_DIAS = 31;
/** Teto de linhas por consulta (`truncado: true` acima dele). */
export const MAXIMO_LINHAS_FINANCEIRO = 2000;
/** Até R$ 1.000.000,00 por cobrança/recebimento. */
const FAIXA_VALOR = { min: 1, max: 100_000_000 };

const DADO_NA_URL = ['nome', 'cpf', 'pagador', 'busca', 'q', 'termo', 'telefone', 'descricao'] as const;
const CNPJ_RE = /^[0-9]{14}$/;
const CONSELHO_RE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{1,39}$/;

function recusarDadoNaUrl(query: unknown): void {
  if (typeof query === 'object' && query !== null && DADO_NA_URL.some((k) => Object.prototype.hasOwnProperty.call(query, k))) {
    throw new EntradaInvalidaError(['dado_na_url']);
  }
}

function data(v: Validador, campo: string, obrigatorio = false): string | undefined {
  const t = obrigatorio ? v.texto(campo, { max: 10, obrigatorio: true }) : v.texto(campo, { max: 10 });
  if (t !== undefined && !ehDataValida(t)) {
    v.falhar(campo);
    return undefined;
  }
  return t;
}

function periodo(v: Validador): { de: string; ate: string } {
  const de = data(v, 'de', true);
  const ate = data(v, 'ate', true);
  if (de && ate) {
    const dias = diasEntre(de, ate);
    if (dias < 0 || dias >= JANELA_FINANCEIRO_DIAS) v.falhar('ate');
  }
  return { de: de as string, ate: ate as string };
}

function cpf(v: Validador, campo: string, valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;
  const n = normalizarCpf(valor);
  if (!n) v.falhar(campo);
  return n;
}

// ---------------------------------------------------------------- configuração e perfil fiscal

export interface ConfiguracaoFinanceiro {
  readonly descricaoRecibo?: string;
  readonly atendimentoPadrao?: AttendanceKind;
  readonly emitenteNome?: string | null;
  readonly emitenteCnpj?: string | null;
  readonly mostrarRegistroConselho?: boolean;
}

export function validarConfiguracao(corpo: unknown): ConfiguracaoFinanceiro {
  const campos = ['descricaoRecibo', 'atendimentoPadrao', 'emitenteNome', 'emitenteCnpj', 'mostrarRegistroConselho'] as const;
  const entrada = exigirObjeto(corpo, campos);
  const v = new Validador(entrada);
  const descricao = v.texto('descricaoRecibo', { min: 3, max: 60 });
  // Texto que revela diagnóstico/condição é recusado (o campo volta, nunca o valor).
  if (descricao !== undefined && !descricaoEhNeutraOuAceita(descricao)) v.falhar('descricaoRecibo');
  const atendimentoPadrao = v.umDe('atendimentoPadrao', ATTENDANCE_KINDS, false);
  const emitenteNome = v.textoOuNulo('emitenteNome', { min: 2, max: 120 });
  let emitenteCnpj: string | null | undefined;
  if (v.tem('emitenteCnpj') && entrada.emitenteCnpj === null) emitenteCnpj = null;
  else {
    const t = v.texto('emitenteCnpj', { max: 18 });
    const digitos = t?.replace(/[./-]/g, '');
    if (t !== undefined && (!digitos || !CNPJ_RE.test(digitos))) v.falhar('emitenteCnpj');
    else emitenteCnpj = digitos;
  }
  const mostrar = v.booleano('mostrarRegistroConselho');
  v.concluir();
  if (!campos.some((c) => v.tem(c))) throw new EntradaInvalidaError(['corpo']);
  return {
    ...(descricao !== undefined ? { descricaoRecibo: descricao } : {}),
    ...(atendimentoPadrao !== undefined ? { atendimentoPadrao } : {}),
    ...(emitenteNome !== undefined ? { emitenteNome } : {}),
    ...(emitenteCnpj !== undefined ? { emitenteCnpj } : {}),
    ...(mostrar !== undefined ? { mostrarRegistroConselho: mostrar } : {}),
  };
}

export interface PerfilFiscal {
  readonly cpf?: string | null;
  readonly registroConselho?: string | null;
}

export function validarPerfilFiscal(corpo: unknown): PerfilFiscal {
  const entrada = exigirObjeto(corpo, ['cpf', 'registroConselho']);
  const v = new Validador(entrada);
  let c: string | null | undefined;
  if (v.tem('cpf') && entrada.cpf === null) c = null;
  else c = cpf(v, 'cpf', v.texto('cpf', { max: 20 }));
  const registro = v.textoOuNulo('registroConselho', { min: 2, max: 40 });
  if (typeof registro === 'string' && !CONSELHO_RE.test(registro)) v.falhar('registroConselho');
  v.concluir();
  if (!v.tem('cpf') && !v.tem('registroConselho')) throw new EntradaInvalidaError(['corpo']);
  return { ...(c !== undefined ? { cpf: c } : {}), ...(registro !== undefined ? { registroConselho: registro } : {}) };
}

// ---------------------------------------------------------------- cobranças

export interface NovaCobranca {
  readonly agendamentoId?: string;
  readonly pacoteId?: string;
  readonly profissionalId?: string;
  readonly valorCentavos: number;
  readonly vencimento?: string;
  readonly atendimentoPor?: AttendanceKind;
  readonly pagador?: { readonly nome: string; readonly cpf?: string };
}

export function validarNovaCobranca(corpo: unknown): NovaCobranca {
  const entrada = exigirObjeto(corpo, [
    'agendamentoId',
    'pacoteId',
    'profissionalId',
    'valorCentavos',
    'vencimento',
    'atendimentoPor',
    'pagador',
  ]);
  const v = new Validador(entrada);
  const agendamentoId = v.uuid('agendamentoId', false);
  const pacoteId = v.uuid('pacoteId', false);
  if (v.tem('agendamentoId') === v.tem('pacoteId')) v.falhar('alvo');
  const profissionalId = v.uuid('profissionalId', false);
  const valor = v.inteiro('valorCentavos', { ...FAIXA_VALOR, obrigatorio: true });
  const vencimento = data(v, 'vencimento');
  const atendimentoPor = v.umDe('atendimentoPor', ATTENDANCE_KINDS, false);
  let pagador: NovaCobranca['pagador'];
  if (v.tem('pagador')) {
    try {
      const p = new Validador(exigirObjeto(entrada.pagador, ['nome', 'cpf']));
      const nome = p.texto('nome', { min: 2, max: 120, obrigatorio: true });
      const c = cpf(p, 'cpf', p.texto('cpf', { max: 20 }));
      p.concluir();
      pagador = { nome, ...(c ? { cpf: c } : {}) };
    } catch {
      v.falhar('pagador');
    }
  }
  v.concluir();
  return {
    valorCentavos: valor as number,
    ...(agendamentoId ? { agendamentoId } : {}),
    ...(pacoteId ? { pacoteId } : {}),
    ...(profissionalId ? { profissionalId } : {}),
    ...(vencimento ? { vencimento } : {}),
    ...(atendimentoPor ? { atendimentoPor } : {}),
    ...(pagador ? { pagador } : {}),
  };
}

export function validarCancelamentoCobranca(corpo: unknown): ChargeCancelReason {
  const v = new Validador(exigirObjeto(corpo, ['motivo']));
  const motivo = v.umDe('motivo', CHARGE_CANCEL_REASONS, true);
  v.concluir();
  return motivo as ChargeCancelReason;
}

export const SITUACOES_FILTRO = ['em_aberto', 'pagas', 'canceladas', 'todas'] as const;
export type SituacaoFiltro = (typeof SITUACOES_FILTRO)[number];

export interface FiltroContasAReceber {
  readonly de: string;
  readonly ate: string;
  readonly situacao: SituacaoFiltro;
  readonly pacienteId?: string;
  readonly profissionalId?: string;
}

/** Contas a receber por VENCIMENTO, `de`/`ate` obrigatórios, janela de até 31 dias. */
export function validarFiltroContasAReceber(query: unknown): FiltroContasAReceber {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate', 'situacao', 'pacienteId', 'profissionalId']));
  const p = periodo(v);
  const situacao = v.umDe('situacao', SITUACOES_FILTRO, false) ?? 'em_aberto';
  const pacienteId = v.uuid('pacienteId', false);
  const profissionalId = v.uuid('profissionalId', false);
  v.concluir();
  return { ...p, situacao, ...(pacienteId ? { pacienteId } : {}), ...(profissionalId ? { profissionalId } : {}) };
}

// ---------------------------------------------------------------- recebimento e estorno

export interface NovoRecebimento {
  readonly valorCentavos?: number;
  readonly forma: PaymentMethod;
  readonly caixaId?: string;
}

/** `forma` aceita também o vocabulário do front (`cartao` = cartão de crédito, `pix` = Pix manual). */
export function validarRecebimento(corpo: unknown): NovoRecebimento {
  const v = new Validador(exigirObjeto(corpo, ['valorCentavos', 'forma', 'caixaId']));
  const valor = v.inteiro('valorCentavos', FAIXA_VALOR);
  const bruto = v.umDe('forma', [...PAYMENT_METHODS, 'cartao', 'pix'] as const, true);
  const caixaId = v.uuid('caixaId', false);
  v.concluir();
  const forma: PaymentMethod = bruto === 'cartao' ? 'cartao_credito' : bruto === 'pix' ? 'pix_manual' : (bruto as PaymentMethod);
  return { forma, ...(valor !== undefined ? { valorCentavos: valor } : {}), ...(caixaId ? { caixaId } : {}) };
}

export function validarEstorno(corpo: unknown): { motivo: PaymentReversalReason; caixaId?: string } {
  const v = new Validador(exigirObjeto(corpo, ['motivo', 'caixaId']));
  const motivo = v.umDe('motivo', PAYMENT_REVERSAL_REASONS, true);
  const caixaId = v.uuid('caixaId', false);
  v.concluir();
  return { motivo: motivo as PaymentReversalReason, ...(caixaId ? { caixaId } : {}) };
}

// ---------------------------------------------------------------- caixa

/** O caixa abre sempre no dia de HOJE (fuso da clínica): não há caixa retroativo. */
export function validarAberturaCaixa(corpo: unknown): { turno: CashShift; trocoInicialCentavos: number } {
  const v = new Validador(exigirObjeto(corpo, ['turno', 'trocoInicialCentavos']));
  const turno = v.umDe('turno', CASH_SHIFTS, true);
  const troco = v.inteiro('trocoInicialCentavos', { min: 0, max: 10_000_000 }) ?? 0;
  v.concluir();
  return { turno: turno as CashShift, trocoInicialCentavos: troco };
}

export function validarFechamentoCaixa(corpo: unknown): { dinheiroContadoCentavos: number } {
  const v = new Validador(exigirObjeto(corpo, ['dinheiroContadoCentavos']));
  const contado = v.inteiro('dinheiroContadoCentavos', { min: 0, max: 1_000_000_000, obrigatorio: true });
  v.concluir();
  return { dinheiroContadoCentavos: contado as number };
}

export function validarFiltroCaixa(query: unknown): { data?: string } {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['data']));
  const d = data(v, 'data');
  v.concluir();
  return d ? { data: d } : {};
}

// ---------------------------------------------------------------- recibos e Receita Saúde

export function validarCancelamentoRecibo(corpo: unknown): ReceiptCancelReason {
  const v = new Validador(exigirObjeto(corpo, ['motivo']));
  const motivo = v.umDe('motivo', RECEIPT_CANCEL_REASONS, true);
  v.concluir();
  return motivo as ReceiptCancelReason;
}

export function validarFiltroRecibos(query: unknown): { de: string; ate: string; pacienteId?: string } {
  recusarDadoNaUrl(query);
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate', 'pacienteId']));
  const p = periodo(v);
  const pacienteId = v.uuid('pacienteId', false);
  v.concluir();
  return { ...p, ...(pacienteId ? { pacienteId } : {}) };
}

export function validarLoteReceitaSaude(corpo: unknown): { profissionalId: string; de: string; ate: string } {
  const v = new Validador(exigirObjeto(corpo, ['profissionalId', 'de', 'ate']));
  const profissionalId = v.uuid('profissionalId', true);
  const p = periodo(v);
  v.concluir();
  return { profissionalId: profissionalId as string, ...p };
}

/** GET sem parâmetros: qualquer query é recusada (e dado pessoal na URL tem código próprio). */
export function validarQueryVazia(query: unknown): void {
  recusarDadoNaUrl(query);
  exigirObjeto(query ?? {}, []);
}

/** Corpo vazio (ou ausente) em ações sem parâmetros. */
export function validarCorpoVazio(corpo: unknown): void {
  exigirObjeto(corpo ?? {}, []);
}

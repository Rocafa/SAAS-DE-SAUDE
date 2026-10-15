import type { AttendanceKind, PaymentMethod } from '../../db/schema';

/**
 * Regras puras do financeiro (sem banco): texto neutro, situação da cobrança, totais do caixa, retrato
 * do recibo e insumo do Receita Saúde. Valores SEMPRE em centavos inteiros (nunca ponto flutuante).
 */

/** Texto padrão do recibo e da cobrança: neutro, não revela especialidade, condição nem procedimento. */
export const DESCRICAO_NEUTRA_PADRAO = 'Atendimento';

/**
 * Termos que a clínica NÃO pode pôr no texto do recibo/cobrança: código CID e palavras que revelam
 * diagnóstico ou condição. O texto é da clínica (controladora), mas o recibo vai para o empregador, o
 * plano e a Receita (bases-legais l.32; parecer front-r8 G2). A lista é barreira mínima, não análise
 * semântica: especialidade continua permitida se a clínica quiser (ex.: "Sessão de fisioterapia"),
 * mas o padrão é o texto neutro.
 */
const PADROES_PROIBIDOS: readonly RegExp[] = [
  /\b[A-TV-Z][0-9]{2}(\.[0-9]{1,2})?\b/i, // CID-10 (ex.: F32, F84.0)
  /\bcid\b/i,
  /diagn[oó]stic/i,
  /transtorno/i,
  /s[ií]ndrome/i,
  /dep?ress[aã]o/i,
  /ansiedade/i,
  /autismo|\btea\b/i,
  /\bhiv\b|\baids\b/i,
  /c[aâ]ncer|oncol/i,
  /depend[eê]ncia qu[ií]mica|alcoolismo/i,
];

export function descricaoEhNeutraOuAceita(texto: string): boolean {
  return !PADROES_PROIBIDOS.some((re) => re.test(texto));
}

export type SituacaoCobranca = 'aberta' | 'parcial' | 'paga' | 'cancelada';

export function situacaoDaCobranca(c: { status: 'open' | 'cancelled'; amountCents: number; paidCents: number }): SituacaoCobranca {
  if (c.status === 'cancelled') return 'cancelada';
  if (c.paidCents >= c.amountCents) return 'paga';
  return c.paidCents > 0 ? 'parcial' : 'aberta';
}

/** Formas do front (`Recibo['forma']`: dinheiro | cartao | pix) -> forma da API. */
export const FORMA_DO_FRONT: Readonly<Record<'dinheiro' | 'cartao' | 'pix', PaymentMethod>> = {
  dinheiro: 'dinheiro',
  cartao: 'cartao_credito',
  pix: 'pix_manual',
};

/** Recebimento pago pela operadora não é pago pelo paciente: sem recibo ao paciente e fora do Receita Saúde. */
export function formaGeraRecibo(forma: PaymentMethod): boolean {
  return forma !== 'convenio';
}

export type TotaisPorForma = Record<PaymentMethod, number>;

export function totaisZerados(): TotaisPorForma {
  return { dinheiro: 0, cartao_credito: 0, cartao_debito: 0, pix_manual: 0, transferencia: 0, convenio: 0 };
}

/**
 * Conferência do caixa: dinheiro esperado na gaveta = troco inicial + recebimentos em dinheiro do caixa
 * − estornos em dinheiro registrados NESTE caixa. As demais formas são conferidas pelo extrato.
 */
export function dinheiroEsperado(trocoInicial: number, recebidos: TotaisPorForma, estornados: TotaisPorForma): number {
  return trocoInicial + recebidos.dinheiro - estornados.dinheiro;
}

/** Emitente do recibo: a clínica (pj) ou o profissional pessoa física (pf). */
export interface EmitenteDoRecibo {
  readonly tipo: AttendanceKind;
  readonly nome: string;
  /** CNPJ (pj) ou CPF (pf); null se a clínica ainda não cadastrou (vira pendência). */
  readonly documento: string | null;
  /** Só com `show_council_on_receipt` (padrão: não, porque o conselho revela a profissão). */
  readonly registroConselho: string | null;
  readonly profissionalId: string | null;
}

export interface PessoaDoRecibo {
  readonly nome: string;
  readonly cpf: string | null;
}

/** Retrato do recibo no momento da emissão. Cifrado no banco; nada de clínico aqui. */
export interface ConteudoDoRecibo {
  readonly versao: 1;
  readonly emitente: EmitenteDoRecibo;
  readonly pagador: PessoaDoRecibo;
  readonly beneficiario: PessoaDoRecibo;
  readonly valorCentavos: number;
  readonly forma: PaymentMethod;
  /** Data do pagamento (AAAA-MM-DD, fuso da clínica). */
  readonly dataPagamento: string;
  /** Texto neutro configurado pela clínica (nunca diagnóstico/especialidade por padrão). */
  readonly descricao: string;
  /** Campos que faltam para o recibo servir ao IR/reembolso (ex.: CPF do emitente). */
  readonly pendencias: readonly string[];
}

export function pendenciasDoRecibo(c: Omit<ConteudoDoRecibo, 'pendencias' | 'versao'>): string[] {
  const p: string[] = [];
  if (!c.emitente.documento) p.push(c.emitente.tipo === 'pf' ? 'cpf_do_profissional' : 'cnpj_da_clinica');
  if (!c.pagador.cpf) p.push('cpf_do_pagador');
  if (!c.beneficiario.cpf) p.push('cpf_do_beneficiario');
  return p;
}

/**
 * Insumo do Receita Saúde (D14 pendente). O layout OFICIAL do arquivo de integração está no Manual do
 * Receita Saúde v2.1 (perguntas 24 e 25), que NÃO está no repositório: aqui sai um insumo ESTRUTURADO
 * com os dados que o recibo eletrônico pede (emitente PF, pagador, beneficiário, valor, data do
 * pagamento), para um conversor ao layout oficial depois de validado com um contador. Não é o arquivo
 * oficial e não deve ser vendido como tal.
 */
export const INSUMO_RECEITA_SAUDE = {
  formato: 'plataforma-saude/receita-saude-insumo',
  versao: '0.1.0',
  oficial: false,
  dependeDe: ['D14', 'manual_receita_saude_v2.1_perguntas_24_25'],
  lacuna: 'layout oficial do arquivo de integração não está no repositório; converter depois de validar com contador',
} as const;

export interface ItemReceitaSaude {
  readonly recebimentoId: string;
  readonly cobrancaId: string;
  readonly reciboNumero: number | null;
  readonly dataPagamento: string;
  readonly valorCentavos: number;
  readonly pagador: PessoaDoRecibo;
  readonly beneficiario: PessoaDoRecibo;
  readonly descricao: string;
  readonly pendencias: readonly string[];
}

export function pendenciasDoItem(i: Pick<ItemReceitaSaude, 'pagador' | 'beneficiario'>): string[] {
  const p: string[] = [];
  if (!i.pagador.cpf) p.push('cpf_do_pagador');
  if (!i.beneficiario.cpf) p.push('cpf_do_beneficiario');
  return p;
}

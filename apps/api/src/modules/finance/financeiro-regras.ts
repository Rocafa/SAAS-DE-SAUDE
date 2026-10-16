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
  // R4 do #65: lista mínima ampliada (contornos comuns). Continua barreira mínima, não análise semântica.
  /\b[A-TV-Z][\s.-][0-9]{2}(\.[0-9]{1,2})?\b/, // CID com separador (ex.: "F 32", "F-32"); só maiúscula
  /\btdah?\b|d[eé]ficit de aten[cç][aã]o|hiperatividade/i,
  /bipolar|esquizofren|psicose|psic[oó]tic|borderline|\btoc\b|obsessivo|compulsiv|\btept\b|p[aâ]nico|fobia/i,
  /anorexia|bulimia|transtorno alimentar|compuls[aã]o alimentar/i,
  /gestante|gravidez|gr[aá]vida|pr[eé]-natal|aborto|\bist\b|\bdst\b|sorolog/i,
  /alzheimer|dem[eê]ncia|parkinson|epilep|\bavc\b|paralisia cerebral|s[ií]ndrome de down/i,
  /suic[ií]d|automutila|depend[eê]ncia|drogadi|[aá]lcool/i,
];

/**
 * R4 do #65: aviso para a TELA de configuração do texto do recibo (devolvido junto da configuração). A
 * lista acima é só uma barreira mínima; quem escreve o texto é a clínica (controladora).
 */
export const AVISO_DESCRICAO_RECIBO =
  'Este texto sai no recibo que o paciente entrega ao empregador, ao plano de saúde e à Receita Federal. Não descreva diagnóstico, condição, especialidade sensível nem procedimento. Recomendado: "' +
  'Atendimento" (padrão).';

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

/** Maioridade civil (CC art. 5º). Abaixo dela, o paciente não é presumido pagador (R3 do #65). */
export const IDADE_MAIORIDADE = 18;

/** O beneficiário era menor de idade na data do pagamento? Sem data de nascimento: não se sabe (false). */
export function menorDeIdadeEm(nascimento: string | null, data: string): boolean {
  if (!nascimento || !/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return false;
  const [an, mn, dn] = nascimento.split('-').map(Number) as [number, number, number];
  const [ad, md, dd] = data.split('-').map(Number) as [number, number, number];
  const idade = ad - an - (md < mn || (md === mn && dd < dn) ? 1 : 0);
  return idade < IDADE_MAIORIDADE;
}

/**
 * Pendências do recibo. `pagadorResponsavel`: o paciente é menor e nenhum pagador foi informado — o
 * recibo sai com o paciente como pagador PRESUMIDO e a pendência `pagador_responsavel` (R3 do #65): o
 * IR do responsável exige o nome e o CPF de quem pagou (Lei 9.250/1995, art. 8º, §2º, III).
 */
export function pendenciasDoRecibo(c: Omit<ConteudoDoRecibo, 'pendencias' | 'versao'>, pagadorResponsavel = false): string[] {
  const p: string[] = [];
  if (pagadorResponsavel) p.push('pagador_responsavel');
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
 * oficial e não deve ser vendido como tal. Fica DENTRO da plataforma (nada é enviado a terceiros).
 * R5 do #65: minimizado ao que o recibo eletrônico pede; o número do recibo serve de referência.
 */
export const INSUMO_RECEITA_SAUDE = {
  formato: 'plataforma-saude/receita-saude-insumo',
  // 0.2.0 (R5 do #65): só o necessário — sem descrição livre, ids internos nem registro no conselho.
  versao: '0.2.0',
  oficial: false,
  dependeDe: ['D14', 'manual_receita_saude_v2.1_perguntas_24_25'],
  lacuna: 'layout oficial do arquivo de integração não está no repositório; converter depois de validar com contador',
} as const;

export interface ItemReceitaSaude {
  readonly reciboNumero: number | null;
  readonly dataPagamento: string;
  readonly valorCentavos: number;
  readonly pagador: PessoaDoRecibo;
  readonly beneficiario: PessoaDoRecibo;
  readonly pendencias: readonly string[];
}

export function pendenciasDoItem(i: Pick<ItemReceitaSaude, 'pagador' | 'beneficiario'>, pagadorResponsavel = false): string[] {
  const p: string[] = [];
  if (pagadorResponsavel) p.push('pagador_responsavel');
  if (!i.pagador.cpf) p.push('cpf_do_pagador');
  if (!i.beneficiario.cpf) p.push('cpf_do_beneficiario');
  return p;
}

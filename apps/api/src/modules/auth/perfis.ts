/**
 * Perfis e permissões (RBAC por clínica). A clínica é sempre a da sessão; aqui só se decide O QUE
 * cada perfil pode fazer dentro dela.
 *
 * - `admin`: dono/administrador da clínica. Gestão e cadastro, mas NÃO é perfil clínico
 *   (front-r8 B1): não lê conteúdo clínico, salvo se também tiver o perfil `profissional`.
 * - `profissional`: profissional de saúde. Único perfil clínico.
 * - `recepcao`: cadastra pacientes e agenda; nunca vê conteúdo clínico.
 * - `financeiro`: lê cadastro e agenda (para cobrar); não altera agenda nem vê conteúdo clínico.
 */
export const PERFIS = ['admin', 'profissional', 'recepcao', 'financeiro'] as const;
export type Perfil = (typeof PERFIS)[number];

export function ehPerfil(valor: unknown): valor is Perfil {
  return typeof valor === 'string' && (PERFIS as readonly string[]).includes(valor);
}

export const PERMISSOES = {
  'sessao:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'pacientes:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'pacientes:escrever': ['admin', 'profissional', 'recepcao'],
  'pacientes:inativar': ['admin', 'recepcao'],
  /**
   * Responsáveis do paciente (PAC-01.2, migração 0028). Ler: todos (o financeiro precisa do pagador).
   * Cadastrar, alterar, marcar pagador e encerrar vigência: quem escreve o cadastro (a recepção também).
   * LIGAR a informação clínica para o responsável é DECISÃO CLÍNICA: só o profissional, com vínculo de
   * cuidado e justificativa (A2 do #67: admin sem perfil clínico não liga; desligar, qualquer um que
   * escreva). Adolescente (12–17): decisão caso a caso, tomada já na adolescência — ver responsaveis-regras.ts.
   */
  'responsaveis:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'responsaveis:escrever': ['admin', 'profissional', 'recepcao'],
  'responsaveis:liberar_informacao_clinica': ['profissional'],
  /** A5 do #67: CPF do responsável completo só para quem precisa (recibo/cadastro fiscal); os demais, mascarado. */
  'responsaveis:ver_cpf_completo': ['admin', 'financeiro'],
  /** A3 do #67: referência da decisão judicial e escopo da curatela (cifrados): dono e profissional. */
  'responsaveis:ver_curatela': ['admin', 'profissional'],
  /** Emancipação do paciente (data + documento): cadastro (dono e recepção). */
  'responsaveis:registrar_emancipacao': ['admin', 'recepcao'],
  'agenda:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'agenda:escrever': ['admin', 'profissional', 'recepcao'],
  /** Marcar "em atendimento"/"atendido": ato do profissional, não da recepção nem do admin. */
  'agenda:atender': ['profissional'],
  'cadastros:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'cadastros:gerir': ['admin'],
  /** Convênios (CNV-04.1): todos leem (forma de atendimento); só o dono cadastra/inativa. */
  'convenios:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'convenios:gerir': ['admin'],
  /**
   * Guias e pacotes (EP-24). Ler saldo/validade/alertas: todos (o profissional vê se a sessão está
   * coberta). Registrar, alterar e cancelar guia ou pacote: recepção, financeiro e dono. Consumir,
   * estornar e registrar a confirmação do paciente: também o profissional (sessão atendida). Nada
   * disto é conteúdo clínico: guia e pacote não levam procedimento, diagnóstico nem evolução.
   */
  'guias:ler': ['admin', 'profissional', 'recepcao', 'financeiro'],
  'guias:gerir': ['admin', 'recepcao', 'financeiro'],
  'guias:consumir': ['admin', 'profissional', 'recepcao', 'financeiro'],
  /** Relatório por convênio (faturamento, CNV-04.6): dono e financeiro. */
  'guias:faturar': ['admin', 'financeiro'],
  /**
   * Financeiro (rodada 15.2, FIN-01.1 a 01.4/01.8). Nada disto é conteúdo clínico: cobrança e recibo
   * não levam diagnóstico, especialidade nem procedimento (texto neutro configurável). O profissional
   * não opera o financeiro da clínica (o repasse dele é FIN-03, fora desta rodada).
   * - ler: contas a receber, caixa, recibos;
   * - operar: lançar e cancelar cobrança SEM recebimento, receber, abrir/fechar caixa, emitir recibo;
   * - estornar: estornar recebimento e cancelar recibo (mexe em dinheiro já registrado);
   * - fiscal: perfil fiscal do profissional PF e insumo do Receita Saúde (CPFs em lote);
   * - configurar: texto neutro do recibo, emitente e tipo de atendimento padrão.
   */
  'financeiro:ler': ['admin', 'recepcao', 'financeiro'],
  'financeiro:operar': ['admin', 'recepcao', 'financeiro'],
  'financeiro:estornar': ['admin', 'financeiro'],
  'financeiro:fiscal': ['admin', 'financeiro'],
  'financeiro:configurar': ['admin'],
  /**
   * CPF completo no recibo (2º parecer do #67, R3/A6): admin e financeiro. A recepção emite e entrega o
   * recibo, mas vê os CPFs (pagador, beneficiário e emitente PF) mascarados; o retrato gravado é o completo.
   */
  'recibos:ver_cpf_completo': ['admin', 'financeiro'],
  /**
   * Conteúdo clínico (prontuário, evoluções, anexos clínicos). Não há rota nesta rodada; a regra
   * fica explícita para a API de prontuário: perfil clínico E vínculo de cuidado (ver
   * `podeLerConteudoClinico`). Recepção, financeiro e admin não clínico: nunca.
   */
  'conteudo_clinico:ler': ['profissional'],
  /**
   * Rotas de atendimento/prontuário/notas privadas (rodada 14.1). O guarda deixa TODOS os perfis da
   * clínica chegarem à rota só para que a tentativa negada fique AUDITADA (HU-PRO-006/022: "recebe
   * 403 e a tentativa é auditada"). Quem decide é o porteiro `exigirConteudoClinico` (perfil clínico
   * E vínculo de cuidado), chamado antes de qualquer leitura: recepção, financeiro e admin não
   * clínico recebem 403 `sem_vinculo_de_cuidado` sem que nenhum registro seja consultado.
   */
  'prontuario:acessar': ['admin', 'profissional', 'recepcao', 'financeiro'],
  /** Sigilo do compartimento de psicologia (pergunta 1.11 em aberto): decisão do dono da clínica. */
  'prontuario:configurar': ['admin'],
} as const satisfies Record<string, readonly Perfil[]>;

export type Permissao = keyof typeof PERMISSOES;

export function temPermissao(perfis: readonly Perfil[], permissao: Permissao): boolean {
  const autorizados: readonly Perfil[] = PERMISSOES[permissao];
  return perfis.some((p) => autorizados.includes(p));
}

/**
 * De onde veio o vínculo (vinculo-de-cuidado.ts). Vai para a auditoria do acesso clínico.
 * `autoagendamento`: atendimento efetivo de um agendamento que o próprio profissional criou para si
 * (V1 do parecer #61); vale como vínculo, mas fica marcado e gera alerta na agenda.
 */
export type BaseDoVinculo = 'atendimento' | 'autoagendamento' | 'agenda_do_dia';

declare const calculadoNoServidor: unique symbol;

/**
 * Vínculo de cuidado do usuário com o paciente (R2 do parecer PR #57). Tipo MARCADO: só
 * `calcularVinculoDeCuidado` (vinculo-de-cuidado.ts), que deriva o vínculo da agenda no servidor,
 * produz um valor deste tipo. Um objeto vindo da requisição não satisfaz o tipo.
 */
export interface VinculoDeCuidado {
  readonly temVinculo: boolean;
  readonly base: BaseDoVinculo | null;
  readonly [calculadoNoServidor]: true;
}

/**
 * Regra B1 do Guardião (front-r8), valendo também para a API: conteúdo clínico só para perfil
 * clínico COM vínculo de cuidado. Ter o perfil não basta; ter o vínculo sem o perfil também não.
 */
export function podeLerConteudoClinico(perfis: readonly Perfil[], vinculo: VinculoDeCuidado): boolean {
  return temPermissao(perfis, 'conteudo_clinico:ler') && vinculo.temVinculo;
}

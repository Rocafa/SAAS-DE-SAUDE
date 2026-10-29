/**
 * Tipos da camada de dados do front. Hoje só existe o adaptador fake (dados FICTÍCIOS em memória);
 * a API real entra depois da decisão de login (D4).
 */

export type Papel = 'admin' | 'profissional' | 'recepcao';

export interface Usuario {
  id: string;
  nome: string;
  papel: Papel;
  clinica: string;
  /** Id opaco da clínica da sessão (só no modo http): trocar de clínica limpa o retrato em memória. */
  clinicaId?: string;
  /** Quando o usuário é um profissional de saúde. */
  profissionalId?: string;
}

export interface Adendo {
  texto: string;
  em: string;
  autor: string;
}

/** Registro clínico (evolução). Assinado não muda mais: correção vira adendo. */
export interface Registro {
  id: string;
  pacienteId: string;
  agendamentoId?: string;
  profissionalId: string;
  modelo: 'fisio' | 'to' | 'psicologia';
  data: string;
  campos: Record<string, string>;
  status: 'rascunho' | 'assinado';
  assinadoEm?: string;
  adendos: Adendo[];
  /** Psicologia: compartimento separado; só o profissional autor lê o conteúdo. */
  restrito: boolean;
  /**
   * true quando quem pediu não pode ler o conteúdo: aí `campos` e `adendos` vêm vazios e só os
   * metadados (data e profissional) aparecem. A tela decide a mensagem por este campo.
   */
  conteudoOculto?: boolean;
  motivoOculto?: 'perfil_nao_clinico' | 'sem_vinculo' | 'sigilo_psicologia';
}

export interface Responsavel {
  nome: string;
  parentesco: string;
  telefone: string;
}

export interface Paciente {
  id: string;
  /** Nome de registro. */
  nome: string;
  /** Nome social: quando existe, é o que aparece em destaque. */
  nomeSocial?: string;
  telefone: string;
  cpf: string;
  nascimento: string;
  responsaveis: Responsavel[];
  ativo: boolean;
  /** Inativar não apaga: o prontuário fica guardado pelo prazo legal do conselho. */
  inativacao?: { data: string; motivo: string };
  /** Todo paciente da demonstração é inventado. */
  ficticio: true;
}

export type StatusAgendamento =
  | 'agendado'
  | 'confirmado'
  | 'chegou'
  | 'em_atendimento'
  | 'atendido'
  | 'faltou'
  | 'cancelado';

export interface Profissional {
  id: string;
  nome: string;
  especialidade: string;
  /** Registro do conselho (CREFITO, CRP, CRM…). Sem ele o documento emitido não tem valor. */
  registro?: string;
  /** Quantos pacientes atende ao mesmo tempo (fisio em ginásio: mais de um). Padrão 1. */
  limiteSimultaneo?: number;
}

export interface TipoAtendimento {
  id: string;
  nome: string;
  minutos: number;
  valor: number;
}

export interface Agendamento {
  id: string;
  pacienteId: string;
  profissionalId: string;
  tipoId: string;
  /** AAAA-MM-DD */
  data: string;
  /** HH:MM */
  hora: string;
  minutos: number;
  status: StatusAgendamento;
  encaixe: boolean;
  /** Sessões recorrentes da mesma série. */
  serieId?: string;
  pacoteId?: string;
}

export interface ItemEspera {
  id: string;
  pacienteId: string;
  preferencia: string;
  criadoEm: string;
}

export interface Pacote {
  id: string;
  pacienteId: string;
  nome: string;
  total: number;
  usadas: number;
}

export interface Anexo {
  id: string;
  pacienteId: string;
  nome: string;
  tipo: 'exame' | 'laudo' | 'documento' | 'imagem';
  data: string;
  /** Exame, laudo e imagem são conteúdo clínico: o nome só aparece para quem cuida do paciente. */
  clinico: boolean;
  conteudoOculto?: boolean;
}

export interface EventoLinhaTempo {
  data: string;
  hora?: string;
  tipo: 'consulta' | 'falta' | 'cancelamento' | 'recibo' | 'anexo' | 'cadastro';
  texto: string;
}

export interface NovoPaciente {
  nome: string;
  nomeSocial?: string;
  telefone: string;
  cpf?: string;
  nascimento?: string;
  responsavel?: { nome: string; parentesco: string; telefone: string };
}

/** Correção de dados do cadastro (PATCH /pacientes/:id). Só o que a ficha deixa mudar. */
export interface AlteracaoPaciente {
  telefone?: string;
  /** AAAA-MM-DD; vazio ou null apaga a data. */
  nascimento?: string | null;
  /**
   * "Conferi o documento original": exigido quando a data nova reduz a idade de paciente com 12 anos ou
   * mais (ver `nascimento.ts`). Só admin ou profissional declara.
   */
  documentoConferido?: boolean;
}

export interface Repeticao {
  intervaloDias: 7 | 14;
  vezes: number;
  /** Cria um pacote com esse número de sessões. */
  pacote?: boolean;
}

export interface Recibo {
  id: string;
  agendamentoId: string;
  pacienteId: string;
  data: string;
  valor: number;
  forma: 'dinheiro' | 'cartao' | 'pix';
}

export interface Pendencia {
  id: string;
  texto: string;
  rota: string;
}

export interface NovoAgendamento {
  pacienteId: string;
  data: string;
  hora: string;
  profissionalId?: string;
  tipoId?: string;
  encaixe?: boolean;
}

export const NOME_STATUS: Record<StatusAgendamento, string> = {
  agendado: 'Falta confirmar',
  confirmado: 'Confirmado',
  chegou: 'Chegou',
  em_atendimento: 'Em atendimento',
  atendido: 'Atendido',
  faltou: 'Faltou',
  cancelado: 'Cancelado',
};

export function nomeExibido(p: Pick<Paciente, 'nome' | 'nomeSocial'>): string {
  return p.nomeSocial ?? p.nome;
}

/** Teto de nomes que o adaptador junta numa lista/busca (10 páginas de 100). */
export const TETO_LISTA_PACIENTES = 1000;

/**
 * Lista/busca de pacientes. `truncado: true` quando o servidor ainda tinha mais nomes e o adaptador
 * parou no teto (`TETO_LISTA_PACIENTES`): a tela avisa para refinar a busca. Continua sendo um array,
 * então quem só lê a lista não muda (mesmo espírito do `truncado` da agenda).
 */
export type ListaPacientes = Paciente[] & { truncado?: true };

/** Anota (ou não) o truncamento numa lista nova. */
export function comTruncado(lista: Paciente[], truncado: boolean | undefined): ListaPacientes {
  return truncado ? Object.assign(lista, { truncado: true as const }) : lista;
}

/** Controle simples de guia de convênio (M1, sem XML TISS). */
export interface Guia {
  id: string;
  pacienteId: string;
  convenio: string;
  numero: string;
  sessoesAutorizadas: number;
  sessoesUsadas: number;
  /** AAAA-MM-DD */
  validade: string;
}

export interface NovaGuia {
  pacienteId: string;
  convenio: string;
  numero: string;
  sessoesAutorizadas: number;
  validade: string;
}

/** Prévia da caixa de mensagens do WhatsApp (M2). Nada é enviado. */
export interface Conversa {
  id: string;
  pacienteId: string;
  naoLidas: number;
  mensagens: { de: 'paciente' | 'clinica'; texto: string; hora: string }[];
}

export interface MembroEquipe {
  id: string;
  nome: string;
  email: string;
  papel: Papel;
  situacao: 'ativo' | 'convite_enviado';
}

/** Registro de auditoria: quem fez o quê, sem conteúdo clínico. */
export interface EventoAuditoria {
  id: string;
  quando: string;
  quem: string;
  acao: string;
}

export interface Assinatura {
  plano: string;
  valorMensal: number;
  status: 'ativa' | 'cancelada';
  proximaCobranca?: string;
  canceladaEm?: string;
  /** Até quando os dados ficam em leitura e exportação (G3: no mínimo 90 dias). */
  disponivelAte?: string;
}

/** Exportação total (G2): MFA recente, aprovação do responsável técnico, link pessoal de 24 h. */
export interface PedidoExportacao {
  id: string;
  status: 'aguardando_rt' | 'pronto';
  pedidoEm: string;
  expiraEm?: string;
  downloadsRestantes?: number;
}

export interface DadosClinica {
  nome: string;
  cnpj: string;
  telefone: string;
  endereco: string;
  /** Cidade do documento ("São Paulo, 12 de outubro de 2026"). */
  cidade?: string;
}

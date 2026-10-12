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
}

export interface PedidoTitular {
  protocolo: string;
  tipo: 'ver_dados' | 'corrigir' | 'baixar' | 'apagar' | 'compartilhamento';
  abertoEm: string;
  prazo: string;
  detalhe?: string;
  situacao: 'aberto' | 'respondido';
}

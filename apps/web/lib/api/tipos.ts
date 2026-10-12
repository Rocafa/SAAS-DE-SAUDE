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

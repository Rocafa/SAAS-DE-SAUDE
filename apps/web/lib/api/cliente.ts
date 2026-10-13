import type {
  Agendamento,
  NovoAgendamento,
  Paciente,
  Pendencia,
  Profissional,
  Recibo,
  StatusAgendamento,
  TipoAtendimento,
  Usuario,
} from './tipos';

export interface FiltroAgenda {
  de?: string;
  ate?: string;
  pacienteId?: string;
  profissionalId?: string;
}

/**
 * Contrato da camada de dados. As telas só conhecem esta interface; trocar o adaptador fake
 * pela API real não muda nenhuma tela.
 */
export interface ApiClinica {
  usuarioAtual(): Promise<Usuario>;
  listarPacientes(): Promise<Paciente[]>;
  obterPaciente(id: string): Promise<Paciente | null>;
  listarProfissionais(): Promise<Profissional[]>;
  listarTiposAtendimento(): Promise<TipoAtendimento[]>;
  listarAgendamentos(filtro?: FiltroAgenda): Promise<Agendamento[]>;
  criarAgendamento(dados: NovoAgendamento): Promise<Agendamento>;
  /** Usado pelo "Desfazer" logo depois de marcar. */
  removerAgendamento(id: string): Promise<void>;
  /** Devolve dia e hora anteriores, para o "Desfazer". */
  remarcarAgendamento(id: string, data: string, hora: string): Promise<{ data: string; hora: string }>;
  /** Devolve o status anterior, para o "Desfazer". */
  alterarStatus(id: string, status: StatusAgendamento): Promise<StatusAgendamento>;
  listarRecibos(pacienteId?: string): Promise<Recibo[]>;
  pendenciasDoDia(data: string): Promise<Pendencia[]>;
}

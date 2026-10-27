import type {
  Agendamento,
  Anexo,
  EventoLinhaTempo,
  ItemEspera,
  NovoPaciente,
  Pacote,
  Repeticao,
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
  /**
   * Busca no servidor (modo http): a API audita a busca como leitura de cadastro, sem o termo.
   * Opcional: o fake procura na lista em memória.
   */
  buscarPacientes?(termo: string): Promise<Paciente[]>;
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

  /** Sessões recorrentes; com `pacote`, cria também o pacote de sessões. */
  criarSerie(dados: NovoAgendamento, repeticao: Repeticao): Promise<Agendamento[]>;
  removerSerie(serieId: string): Promise<void>;
  listarPacotes(pacienteId?: string): Promise<Pacote[]>;

  listarEspera(): Promise<ItemEspera[]>;
  adicionarEspera(pacienteId: string, preferencia: string): Promise<ItemEspera>;
  removerEspera(id: string): Promise<ItemEspera | null>;
  devolverEspera(item: ItemEspera): Promise<void>;

  criarPaciente(dados: NovoPaciente): Promise<Paciente>;
  removerPaciente(id: string): Promise<void>;
  inativarPaciente(id: string, motivo: string): Promise<void>;
  reativarPaciente(id: string): Promise<void>;
  listarAnexos(pacienteId: string): Promise<Anexo[]>;
  linhaDoTempo(pacienteId: string): Promise<EventoLinhaTempo[]>;
}

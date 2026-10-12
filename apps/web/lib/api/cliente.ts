import type {
  Agendamento,
  Anexo,
  Conversa,
  Guia,
  NovaGuia,
  EventoLinhaTempo,
  ItemEspera,
  NovoPaciente,
  Pacote,
  Registro,
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

  /** Registros do paciente. Conteúdo restrito volta com `campos` vazio para quem não é o autor. */
  listarRegistros(pacienteId: string): Promise<Registro[]>;
  obterRegistroDoAgendamento(agendamentoId: string): Promise<Registro | null>;
  salvarRascunho(agendamentoId: string, campos: Record<string, string>): Promise<Registro>;
  assinarRegistro(id: string): Promise<Registro>;
  adicionarAdendo(id: string, texto: string): Promise<Registro>;

  registrarPagamento(agendamentoId: string, forma: Recibo['forma']): Promise<Recibo>;
  removerRecibo(id: string): Promise<void>;
  listarGuias(): Promise<Guia[]>;
  criarGuia(dados: NovaGuia): Promise<Guia>;
  removerGuia(id: string): Promise<void>;
  listarConversas(): Promise<Conversa[]>;

  /** Só na demonstração: trocar quem está usando, para ver as permissões. */
  usuariosDemo(): Promise<Usuario[]>;
  entrarComo(id: string): Promise<Usuario>;
}

import type {
  AlteracaoPaciente,
  Agendamento,
  Anexo,
  Assinatura,
  DadosClinica,
  EventoAuditoria,
  MembroEquipe,
  PedidoExportacao,
  Papel,
  Conversa,
  Guia,
  NovaGuia,
  EventoLinhaTempo,
  ItemEspera,
  ListaPacientes,
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
  /** `truncado: true` quando passou do teto de 1.000 nomes (a tela avisa para refinar a busca). */
  listarPacientes(): Promise<ListaPacientes>;
  /**
   * Busca no servidor (modo http): a API audita a busca como leitura de cadastro, sem o termo.
   * Opcional: o fake procura na lista em memória. Mesmo teto e mesmo `truncado` da lista.
   */
  buscarPacientes?(termo: string): Promise<ListaPacientes>;
  obterPaciente(id: string): Promise<Paciente | null>;
  /**
   * Descarta o que o adaptador guarda em memória (retrato de pacientes). O provedor chama no `limpar()`
   * (sair, trocar de clínica, sessão mudou). Opcional: o fake não guarda nada além dos dados fictícios.
   */
  esquecerCache?(): void;
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
  /**
   * Corrige telefone e/ou nascimento. Mudar o nascimento pode exigir `documentoConferido` (só admin ou
   * profissional): sem ela, erro com a mensagem de conferência (422 `documento_nao_conferido` na API).
   */
  alterarPaciente(id: string, dados: AlteracaoPaciente): Promise<Paciente>;
  removerPaciente(id: string): Promise<void>;
  inativarPaciente(id: string, motivo: string): Promise<void>;
  reativarPaciente(id: string): Promise<void>;
  /** Anexo clínico (exame, laudo, imagem) só tem nome para quem cuida do paciente. */
  listarAnexos(pacienteId: string): Promise<Anexo[]>;
  linhaDoTempo(pacienteId: string): Promise<EventoLinhaTempo[]>;

  /**
   * Registros do paciente. `campos` e `adendos` só vêm para PERFIL CLÍNICO com VÍNCULO DE CUIDADO
   * com o paciente (profissional que tem ou teve agendamento com ele); psicologia, só para o autor.
   * Para os demais (recepção, administrador não clínico, profissional sem vínculo) vêm só os
   * metadados, com `conteudoOculto: true`.
   */
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
  /**
   * Registra a emissão/impressão de um documento (auditoria, sem o texto). Atestado só por perfil
   * clínico com vínculo de cuidado, assinado pelo próprio usuário; recepção emite declaração e recibo.
   */
  registrarEmissaoDocumento(d: { tipo: 'atestado' | 'declaracao' | 'recibo'; pacienteId: string; profissionalId?: string }): Promise<void>;

  obterClinica(): Promise<DadosClinica>;
  salvarClinica(d: DadosClinica): Promise<DadosClinica>;
  listarEquipe(): Promise<MembroEquipe[]>;
  convidar(email: string, papel: Papel): Promise<MembroEquipe>;
  removerAcesso(id: string): Promise<MembroEquipe | null>;
  devolverAcesso(m: MembroEquipe): Promise<void>;
  listarAuditoria(): Promise<EventoAuditoria[]>;
  obterAssinatura(): Promise<Assinatura>;
  cancelarAssinatura(): Promise<Assinatura>;
  reativarAssinatura(): Promise<Assinatura>;
  /** Exige o código do autenticador (MFA recente). */
  pedirExportacao(codigo: string): Promise<PedidoExportacao>;
  aprovarExportacao(id: string): Promise<PedidoExportacao>;


  /** Só na demonstração: trocar quem está usando, para ver as permissões. */
  usuariosDemo(): Promise<Usuario[]>;
  entrarComo(id: string): Promise<Usuario>;
}

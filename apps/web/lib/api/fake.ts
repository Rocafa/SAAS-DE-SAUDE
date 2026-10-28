/**
 * Adaptador FAKE em memória. Todos os pacientes, telefones e CPFs são INVENTADOS para demonstração;
 * nenhum dado real. Os CPFs começam com 000 de propósito (não existem).
 */
import { paraIsoLocal, somarDias } from '../ajudante/datas';
import type { ApiClinica, FiltroAgenda } from './cliente';
import { datasDaSerie } from '../agenda';
import { ErroApi, erroListaMudou, MENSAGENS, mensagemDeErro } from './http';
import { mudancaDeNascimentoExigeDocumento, podeConferirDocumento } from './nascimento';
import { ehPerfilClinico, ehRestrito, faltasParaAssinar, modeloDoProfissional } from '../prontuario';
import type {
  AlteracaoPaciente,
  Agendamento,
  Anexo,
  EventoLinhaTempo,
  ItemEspera,
  NovoPaciente,
  Pacote,
  Papel,
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

const NOMES: [string, string?][] = [
  ['Maria Silva'],
  ['João Pereira'],
  ['Ana Souza'],
  ['Pedro Santos'],
  ['José Oliveira'],
  ['Joana Lima'],
  ['Ana Paula Costa'],
  ['Carlos Rodrigues'],
  ['Fernanda Almeida'],
  ['Lucas Nascimento'],
  ['Juliana Ferreira'],
  ['Rafael Carvalho'],
  ['Beatriz Gomes'],
  ['Mateus Araújo'],
  ['Larissa Ribeiro'],
  ['Thiago Barbosa'],
  ['Camila Rocha'],
  ['Bruno Dias'],
  ['Patrícia Teixeira'],
  ['Ricardo Moreira'],
  ['Aline Cardoso'],
  ['Felipe Mendes'],
  ['Renata Castro'],
  ['Sofia Pinto'],
  ['Davi Correia'],
  ['Helena Moura'],
  ['Miguel Freitas'],
  ['Antônio Cavalcanti'],
  ['Alisson Prado', 'Alice Prado'],
  ['Maria Eduarda Santos'],
];

const PROFISSIONAIS: Profissional[] = [
  { id: 'pr1', nome: 'Dra. Beatriz Nogueira', especialidade: 'Fisioterapia', limiteSimultaneo: 3 },
  { id: 'pr2', nome: 'Dr. Henrique Sales', especialidade: 'Psicologia' },
  { id: 'pr3', nome: 'Dra. Lúcia Prates', especialidade: 'Terapia ocupacional' },
];

const TIPOS: TipoAtendimento[] = [
  { id: 't1', nome: 'Sessão de fisioterapia', minutos: 50, valor: 150 },
  { id: 't2', nome: 'Sessão de psicoterapia', minutos: 50, valor: 200 },
  { id: 't3', nome: 'Avaliação inicial', minutos: 60, valor: 250 },
  { id: 't4', nome: 'Sessão de terapia ocupacional', minutos: 45, valor: 160 },
];

function dois(n: number): string {
  return String(n).padStart(2, '0');
}

export function criarPacientesFicticios(): Paciente[] {
  return NOMES.map(([nome, nomeSocial], i) => {
    const n = i + 1;
    const p: Paciente = {
      id: `p${dois(n)}`,
      nome,
      telefone: `(11) 90000-${String(n).padStart(4, '0')}`,
      cpf: `000.000.${String(n).padStart(3, '0')}-${dois((n * 37) % 100)}`,
      nascimento: `${1960 + ((n * 7) % 55)}-${dois((n % 12) + 1)}-${dois((n % 27) + 1)}`,
      responsaveis: [],
      ativo: n !== 27,
      ficticio: true,
    };
    if (nomeSocial) p.nomeSocial = nomeSocial;
    if (nome === 'Sofia Pinto' || nome === 'Davi Correia') {
      p.nascimento = '2018-05-10';
      p.responsaveis = [{ nome: 'Responsável fictício', parentesco: 'Mãe', telefone: '(11) 90000-9999' }];
    }
    return p;
  });
}

interface Semente {
  paciente: number;
  prof: number;
  tipo: number;
  dia: number;
  hora: string;
  status: StatusAgendamento;
}

// Agenda relativa a "hoje" para a demonstração sempre parecer viva.
const SEMENTES: Semente[] = [
  { paciente: 9, prof: 2, tipo: 2, dia: 0, hora: '07:00', status: 'faltou' },
  { paciente: 1, prof: 1, tipo: 1, dia: 0, hora: '08:00', status: 'atendido' },
  { paciente: 4, prof: 2, tipo: 2, dia: 0, hora: '09:00', status: 'em_atendimento' },
  { paciente: 3, prof: 1, tipo: 1, dia: 0, hora: '09:00', status: 'chegou' },
  { paciente: 16, prof: 1, tipo: 1, dia: 0, hora: '09:00', status: 'chegou' },
  { paciente: 8, prof: 3, tipo: 4, dia: 0, hora: '10:00', status: 'confirmado' },
  { paciente: 2, prof: 1, tipo: 1, dia: 0, hora: '11:00', status: 'agendado' },
  { paciente: 12, prof: 2, tipo: 2, dia: 0, hora: '14:00', status: 'agendado' },
  { paciente: 15, prof: 1, tipo: 3, dia: 0, hora: '15:00', status: 'confirmado' },
  { paciente: 6, prof: 3, tipo: 4, dia: 0, hora: '16:00', status: 'agendado' },
  { paciente: 1, prof: 1, tipo: 1, dia: 1, hora: '09:00', status: 'agendado' },
  { paciente: 5, prof: 2, tipo: 2, dia: 1, hora: '10:00', status: 'confirmado' },
  { paciente: 7, prof: 1, tipo: 1, dia: 1, hora: '14:00', status: 'agendado' },
  { paciente: 24, prof: 3, tipo: 4, dia: 1, hora: '15:00', status: 'agendado' },
  { paciente: 3, prof: 1, tipo: 1, dia: 3, hora: '09:00', status: 'agendado' },
  { paciente: 10, prof: 2, tipo: 3, dia: 4, hora: '11:00', status: 'agendado' },
  { paciente: 29, prof: 2, tipo: 2, dia: 5, hora: '16:00', status: 'agendado' },
  { paciente: 1, prof: 1, tipo: 1, dia: -7, hora: '08:00', status: 'atendido' },
  { paciente: 1, prof: 1, tipo: 1, dia: -14, hora: '08:00', status: 'atendido' },
  { paciente: 2, prof: 1, tipo: 1, dia: -3, hora: '11:00', status: 'atendido' },
  { paciente: 3, prof: 1, tipo: 3, dia: -10, hora: '10:00', status: 'atendido' },
  { paciente: 4, prof: 2, tipo: 2, dia: -7, hora: '09:00', status: 'atendido' },
  { paciente: 13, prof: 2, tipo: 2, dia: -2, hora: '14:00', status: 'faltou' },
];

export interface OpcoesFake {
  agora?: Date;
  /**
   * Para demonstrar os estados de tela: "erro", "vazio", "lento" ou "lista_mudou" (o cursor da lista
   * foi recusado também no recomeço: mesmo erro que o adaptador HTTP entrega, `erroListaMudou`).
   */
  simular?: 'erro' | 'vazio' | 'lento' | 'lista_mudou';
  /** Papel do usuário da demonstração (padrão: admin). */
  papel?: Papel;
}

export function criarApiFake(opcoes: OpcoesFake = {}): ApiClinica {
  const agora = opcoes.agora ?? new Date();
  const vazio = opcoes.simular === 'vazio';
  const pacientes = vazio ? [] : criarPacientesFicticios();
  const agendamentos: Agendamento[] = vazio
    ? []
    : SEMENTES.map((s, i) => {
        const tipo = TIPOS[s.tipo - 1]!;
        return {
          id: `a${dois(i + 1)}`,
          pacienteId: `p${dois(s.paciente)}`,
          profissionalId: `pr${s.prof}`,
          tipoId: tipo.id,
          data: paraIsoLocal(somarDias(agora, s.dia)),
          hora: s.hora,
          minutos: tipo.minutos,
          status: s.status,
          encaixe: false,
        };
      });
  const recibos: Recibo[] = agendamentos
    .filter((a) => a.status === 'atendido')
    .map((a, i) => ({
      id: `r${dois(i + 1)}`,
      agendamentoId: a.id,
      pacienteId: a.pacienteId,
      data: a.data,
      valor: TIPOS.find((t) => t.id === a.tipoId)!.valor,
      forma: (['pix', 'cartao', 'dinheiro'] as const)[i % 3]!,
    }));
  let seq = agendamentos.length;
  let seqGeral = 100;
  const novoId = (prefixo: string) => `${prefixo}${++seqGeral}`;
  const hojeIso = paraIsoLocal(agora);
  const espera: ItemEspera[] = vazio
    ? []
    : [
        { id: 'e1', pacienteId: 'p17', preferencia: 'Qualquer manhã, com a Dra. Beatriz', criadoEm: paraIsoLocal(somarDias(agora, -2)) },
        { id: 'e2', pacienteId: 'p20', preferencia: 'Terça ou quinta depois das 17h', criadoEm: paraIsoLocal(somarDias(agora, -1)) },
      ];
  const pacotes: Pacote[] = vazio ? [] : [{ id: 'k1', pacienteId: 'p01', nome: 'Pacote de 10 sessões de fisioterapia', total: 10, usadas: 3 }];
  const USUARIOS: Usuario[] = [
    { id: 'u1', nome: 'Administradora (demonstração)', papel: 'admin', clinica: 'Clínica Demonstração' },
    { id: 'u2', nome: 'Dra. Beatriz Nogueira (fisioterapia)', papel: 'profissional', clinica: 'Clínica Demonstração', profissionalId: 'pr1' },
    { id: 'u3', nome: 'Dr. Henrique Sales (psicologia)', papel: 'profissional', clinica: 'Clínica Demonstração', profissionalId: 'pr2' },
    { id: 'u4', nome: 'Recepcionista (demonstração)', papel: 'recepcao', clinica: 'Clínica Demonstração' },
    { id: 'u5', nome: 'Dra. Lúcia Prates (administradora e terapeuta ocupacional)', papel: 'admin', clinica: 'Clínica Demonstração', profissionalId: 'pr3' },
  ];
  let usuario: Usuario = opcoes.papel ? { ...USUARIOS[0]!, papel: opcoes.papel } : USUARIOS[0]!;
  const registros: Registro[] = vazio
    ? []
    : agendamentos
        .filter((a) => a.status === 'atendido' && a.data < hojeIso)
        .map((a, i) => {
          const modelo = modeloDoProfissional(PROFISSIONAIS.find((p) => p.id === a.profissionalId));
          const campos: Record<string, string> =
            modelo === 'psicologia'
              ? { tema: 'Conteúdo fictício de demonstração.', evolucao: 'Processo em andamento (fictício).' }
              : { queixa: 'Relata melhora da dor no joelho (fictício).', dor: '3', conduta: 'Fortalecimento de quadríceps, 3 séries de 12 (fictício).', plano: 'Manter exercícios em casa.' };
          return {
            id: `g${i + 1}`,
            pacienteId: a.pacienteId,
            agendamentoId: a.id,
            profissionalId: a.profissionalId,
            modelo,
            data: a.data,
            campos,
            status: 'assinado' as const,
            assinadoEm: a.data,
            adendos: [],
            restrito: ehRestrito(modelo),
          };
        });
  /** Emissões de documento (auditoria: tipo, paciente, quem; nunca o texto). */
  const emissoes: { tipo: string; pacienteId: string; profissionalId?: string; por: string; em: string }[] = [];
  const temVinculo = (pacienteId: string) =>
    !!usuario.profissionalId && agendamentos.some((a) => a.pacienteId === pacienteId && a.profissionalId === usuario.profissionalId);
  const motivoOculto = (r: Registro): Registro['motivoOculto'] | null => {
    if (!ehPerfilClinico(usuario)) return 'perfil_nao_clinico';
    if (r.restrito) return usuario.profissionalId === r.profissionalId ? null : 'sigilo_psicologia';
    return temVinculo(r.pacienteId) ? null : 'sem_vinculo';
  };
  const visivel = (r: Registro): Registro => {
    const motivo = motivoOculto(r);
    return motivo ? { ...r, campos: {}, adendos: [], conteudoOculto: true, motivoOculto: motivo } : r;
  };
  const anexoVisivel = (x: Anexo): Anexo =>
    x.clinico && !(ehPerfilClinico(usuario) && temVinculo(x.pacienteId)) ? { ...x, nome: 'Anexo clínico', conteudoOculto: true } : x;
  const anexos: Anexo[] = vazio
    ? []
    : [
        { id: 'x1', pacienteId: 'p01', nome: 'Raio-x do joelho (fictício).pdf', tipo: 'exame', data: paraIsoLocal(somarDias(agora, -20)), clinico: true },
        { id: 'x2', pacienteId: 'p01', nome: 'Encaminhamento médico (fictício).pdf', tipo: 'laudo', data: paraIsoLocal(somarDias(agora, -21)), clinico: true },
        { id: 'x3', pacienteId: 'p01', nome: 'Carteirinha do convênio (fictício).pdf', tipo: 'documento', data: paraIsoLocal(somarDias(agora, -21)), clinico: false },
      ];

  async function resposta<T>(valor: T): Promise<T> {
    if (opcoes.simular === 'erro') throw new ErroApi('Não conseguimos falar com o servidor.', 0, 'rede');
    if (opcoes.simular === 'lento') await new Promise((r) => setTimeout(r, 1500));
    return structuredClone(valor);
  }

  return {
    usuarioAtual: () => resposta<Usuario>(usuario),
    usuariosDemo: () => resposta(USUARIOS),
    async registrarEmissaoDocumento(d) {
      if (d.tipo === 'atestado') {
        if (!ehPerfilClinico(usuario)) throw new Error('O atestado é emitido pelo profissional que atendeu.');
        if (d.profissionalId && d.profissionalId !== usuario.profissionalId) throw new Error('Você só assina atestado em seu próprio nome.');
        if (!temVinculo(d.pacienteId)) throw new Error('Você não atendeu este paciente. O atestado é do profissional que atendeu.');
      }
      emissoes.push({ ...d, por: usuario.id, em: hojeIso });
      await resposta(null);
    },
    async entrarComo(id) {
      const u = USUARIOS.find((x) => x.id === id);
      if (!u) throw new Error('Usuário não existe.');
      usuario = u;
      return resposta(u);
    },
    // O fake não pagina (devolve tudo de uma vez), mas entrega o mesmo erro final do HTTP quando o
    // recomeço por cursor recusado falha: nada parcial chega à tela.
    listarPacientes: async () => {
      if (opcoes.simular === 'lista_mudou') throw erroListaMudou();
      return resposta(pacientes);
    },
    obterPaciente: (id) => resposta(pacientes.find((p) => p.id === id) ?? null),
    listarProfissionais: () => resposta(PROFISSIONAIS),
    listarTiposAtendimento: () => resposta(TIPOS),
    listarAgendamentos: (filtro: FiltroAgenda = {}) =>
      resposta(
        agendamentos
          .filter(
            (a) =>
              (!filtro.de || a.data >= filtro.de) &&
              (!filtro.ate || a.data <= filtro.ate) &&
              (!filtro.pacienteId || a.pacienteId === filtro.pacienteId) &&
              (!filtro.profissionalId || a.profissionalId === filtro.profissionalId),
          )
          .sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora)),
      ),
    async criarAgendamento(dados: NovoAgendamento) {
      if (!pacientes.some((p) => p.id === dados.pacienteId)) throw new ErroApi('Falta o paciente. Escolha um nome da lista.', 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dados.data)) throw new ErroApi('Falta o dia. Escolha no calendário.', 400);
      if (!/^\d{2}:\d{2}$/.test(dados.hora)) throw new ErroApi('Falta o horário. Digite como 14:00.', 400);
      const tipo = TIPOS.find((t) => t.id === (dados.tipoId ?? 't1')) ?? TIPOS[0]!;
      const novo: Agendamento = {
        id: `a${++seq}`,
        pacienteId: dados.pacienteId,
        profissionalId: dados.profissionalId ?? 'pr1',
        tipoId: tipo.id,
        data: dados.data,
        hora: dados.hora,
        minutos: tipo.minutos,
        status: 'agendado',
        encaixe: dados.encaixe ?? false,
      };
      agendamentos.push(novo);
      return resposta(novo);
    },
    async removerAgendamento(id) {
      const i = agendamentos.findIndex((a) => a.id === id);
      if (i >= 0) agendamentos.splice(i, 1);
      await resposta(null);
    },
    async remarcarAgendamento(id, data, hora) {
      const a = agendamentos.find((x) => x.id === id);
      if (!a) throw new ErroApi('Esse horário não existe mais. Atualize a tela.', 404);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new ErroApi('Falta o dia. Escolha no calendário.', 400);
      if (!/^\d{2}:\d{2}$/.test(hora)) throw new ErroApi('Falta o horário. Digite como 14:00.', 400);
      const anterior = { data: a.data, hora: a.hora };
      a.data = data;
      a.hora = hora;
      await resposta(null);
      return anterior;
    },
    async alterarStatus(id, status) {
      const a = agendamentos.find((x) => x.id === id);
      if (!a) throw new ErroApi('Esse horário não existe mais. Atualize a tela.', 404);
      const anterior = a.status;
      a.status = status;
      await resposta(null);
      return anterior;
    },
    listarRecibos: (pacienteId) =>
      resposta(
        recibos
          .filter((r) => !pacienteId || r.pacienteId === pacienteId)
          .sort((x, y) => y.data.localeCompare(x.data)),
      ),
    pendenciasDoDia: (data) => {
      const doDia = agendamentos.filter((a) => a.data === data);
      const p: Pendencia[] = [];
      const semConfirmar = doDia.filter((a) => a.status === 'agendado').length;
      if (semConfirmar)
        p.push({ id: 'confirmar', texto: `Confirmar presença: ${semConfirmar} pessoa(s)`, rota: '/inicio#falta-confirmar' });
      const atendidos = doDia.filter((a) => a.status === 'atendido').length;
      if (atendidos) p.push({ id: 'assinar', texto: `Assinar prontuário: ${atendidos} atendimento(s)`, rota: '/atendimento' });
      const faltas = doDia.filter((a) => a.status === 'faltou').length;
      if (faltas) p.push({ id: 'faltas', texto: `Remarcar quem faltou: ${faltas} pessoa(s)`, rota: '/agenda' });
      return resposta(p);
    },

    async criarSerie(dados: NovoAgendamento, rep: Repeticao) {
      if (!pacientes.some((p) => p.id === dados.pacienteId)) throw new ErroApi('Falta o paciente. Escolha um nome da lista.', 400);
      let datas: string[];
      try {
        datas = datasDaSerie(dados.data, rep.intervaloDias, rep.vezes);
      } catch (e) {
        // Mensagem fixa em pt-BR da regra de repetição (lib/agenda.ts); vira erro do adaptador.
        throw new ErroApi(e instanceof Error ? e.message : MENSAGENS.regra, 400);
      }
      const serieId = novoId('s');
      let pacoteId: string | undefined;
      if (rep.pacote) {
        pacoteId = novoId('k');
        const tipo = TIPOS.find((t) => t.id === (dados.tipoId ?? 't1')) ?? TIPOS[0]!;
        pacotes.push({ id: pacoteId, pacienteId: dados.pacienteId, nome: `Pacote de ${rep.vezes} sessões (${tipo.nome.toLowerCase()})`, total: rep.vezes, usadas: 0 });
      }
      const tipo = TIPOS.find((t) => t.id === (dados.tipoId ?? 't1')) ?? TIPOS[0]!;
      const criados = datas.map((data) => {
        const a: Agendamento = {
          id: `a${++seq}`,
          pacienteId: dados.pacienteId,
          profissionalId: dados.profissionalId ?? 'pr1',
          tipoId: tipo.id,
          data,
          hora: dados.hora,
          minutos: tipo.minutos,
          status: 'agendado',
          encaixe: false,
          serieId,
        };
        if (pacoteId) a.pacoteId = pacoteId;
        return a;
      });
      agendamentos.push(...criados);
      return resposta(criados);
    },
    async removerSerie(serieId) {
      const pacoteId = agendamentos.find((a) => a.serieId === serieId)?.pacoteId;
      for (let i = agendamentos.length - 1; i >= 0; i--) if (agendamentos[i]!.serieId === serieId) agendamentos.splice(i, 1);
      if (pacoteId) pacotes.splice(pacotes.findIndex((k) => k.id === pacoteId), 1);
      await resposta(null);
    },
    listarPacotes: (pacienteId) => resposta(pacotes.filter((k) => !pacienteId || k.pacienteId === pacienteId)),

    listarEspera: () => resposta(espera),
    async adicionarEspera(pacienteId, preferencia) {
      if (!pacientes.some((p) => p.id === pacienteId)) throw new ErroApi('Falta o paciente. Escolha um nome da lista.', 400);
      const item: ItemEspera = { id: novoId('e'), pacienteId, preferencia: preferencia.trim() || 'Qualquer horário', criadoEm: hojeIso };
      espera.push(item);
      return resposta(item);
    },
    async removerEspera(id) {
      const i = espera.findIndex((e) => e.id === id);
      const [item] = i >= 0 ? espera.splice(i, 1) : [];
      return resposta(item ?? null);
    },
    async devolverEspera(item) {
      if (!espera.some((e) => e.id === item.id)) espera.push(item);
      await resposta(null);
    },

    async criarPaciente(dados: NovoPaciente) {
      const p: Paciente = {
        id: novoId('p'),
        nome: dados.nome.trim(),
        telefone: dados.telefone,
        cpf: dados.cpf ?? '',
        nascimento: dados.nascimento ?? '',
        responsaveis: dados.responsavel ? [dados.responsavel] : [],
        ativo: true,
        ficticio: true,
      };
      if (dados.nomeSocial?.trim()) p.nomeSocial = dados.nomeSocial.trim();
      pacientes.push(p);
      return resposta(p);
    },
    // Mesmas regras da API (rodada 19+): inativo não muda; nascimento que reduz a idade de quem tem 12+
    // exige documento conferido, e só admin ou profissional confere.
    async alterarPaciente(id, dados: AlteracaoPaciente) {
      const p = pacientes.find((x) => x.id === id);
      if (!p) throw new ErroApi(MENSAGENS.naoEncontrado, 404);
      if (!p.ativo) throw new ErroApi(MENSAGENS.inativo, 409, 'paciente_inativo');
      // Como a API (0053): a conferência só vale junto com a data; data futura é recusada (400).
      if (dados.documentoConferido !== undefined && dados.nascimento === undefined) throw mensagemDeErro(400, { campos: ['documentoConferido'] });
      if (dados.telefone === undefined && dados.nascimento === undefined) throw new ErroApi(MENSAGENS.nadaMudou, 400);
      const novoNascimento = dados.nascimento === undefined ? undefined : dados.nascimento?.trim() || '';
      if (novoNascimento && (!/^\d{4}-\d{2}-\d{2}$/.test(novoNascimento) || novoNascimento > hojeIso)) {
        throw mensagemDeErro(400, { campos: ['nascimento'] });
      }
      const mudou = novoNascimento !== undefined && novoNascimento !== p.nascimento;
      if (mudou && mudancaDeNascimentoExigeDocumento(p.nascimento, novoNascimento, hojeIso) && dados.documentoConferido !== true) {
        throw new ErroApi(MENSAGENS.documentoNaoConferido, 422, 'documento_nao_conferido');
      }
      if (mudou && dados.documentoConferido === true && !podeConferirDocumento(usuario.papel)) {
        throw new ErroApi(MENSAGENS.conferenciaPerfil, 403, 'conferencia_exige_perfil');
      }
      if (dados.telefone !== undefined) p.telefone = dados.telefone.trim();
      if (mudou) p.nascimento = novoNascimento;
      return resposta(p);
    },
    async removerPaciente(id) {
      const i = pacientes.findIndex((p) => p.id === id);
      if (i >= 0) pacientes.splice(i, 1);
      await resposta(null);
    },
    async inativarPaciente(id, motivo) {
      const p = pacientes.find((x) => x.id === id);
      if (!p) throw new ErroApi('Paciente não encontrado.', 404);
      p.ativo = false;
      p.inativacao = { data: hojeIso, motivo: motivo.trim() || 'Sem motivo informado' };
      // Consultas futuras saem da agenda; o histórico e o prontuário ficam.
      for (const a of agendamentos) if (a.pacienteId === id && a.data >= hojeIso && (a.status === 'agendado' || a.status === 'confirmado')) a.status = 'cancelado';
      await resposta(null);
    },
    async reativarPaciente(id) {
      const p = pacientes.find((x) => x.id === id);
      if (!p) throw new ErroApi('Paciente não encontrado.', 404);
      p.ativo = true;
      delete p.inativacao;
      await resposta(null);
    },
    listarAnexos: (pacienteId) => resposta(anexos.filter((x) => x.pacienteId === pacienteId).map(anexoVisivel)),
    linhaDoTempo: (pacienteId) => {
      const ev: EventoLinhaTempo[] = [];
      for (const a of agendamentos.filter((x) => x.pacienteId === pacienteId && x.data <= hojeIso)) {
        const prof = PROFISSIONAIS.find((p) => p.id === a.profissionalId)?.nome ?? '';
        if (a.status === 'atendido') ev.push({ data: a.data, hora: a.hora, tipo: 'consulta', texto: `Atendimento com ${prof}` });
        else if (a.status === 'faltou') ev.push({ data: a.data, hora: a.hora, tipo: 'falta', texto: `Faltou à consulta com ${prof}` });
        else if (a.status === 'cancelado') ev.push({ data: a.data, hora: a.hora, tipo: 'cancelamento', texto: `Consulta cancelada com ${prof}` });
      }
      for (const r of recibos.filter((x) => x.pacienteId === pacienteId)) ev.push({ data: r.data, tipo: 'recibo', texto: `Pagamento recebido: R$ ${r.valor},00` });
      for (const x of anexos.filter((y) => y.pacienteId === pacienteId)) ev.push({ data: x.data, tipo: 'anexo', texto: `Anexo: ${anexoVisivel(x).nome}` });
      return resposta(ev.sort((a, b) => (b.data + (b.hora ?? '')).localeCompare(a.data + (a.hora ?? ''))));
    },

    listarRegistros: (pacienteId) =>
      resposta(registros.filter((r) => r.pacienteId === pacienteId).map(visivel).sort((a, b) => b.data.localeCompare(a.data))),
    obterRegistroDoAgendamento: (agendamentoId) => {
      const r = registros.find((x) => x.agendamentoId === agendamentoId);
      return resposta(r ? visivel(r) : null);
    },
    async salvarRascunho(agendamentoId, campos) {
      const a = agendamentos.find((x) => x.id === agendamentoId);
      if (!a) throw new Error('Esse atendimento não existe mais. Volte para Atendimento.');
      if (usuario.profissionalId !== a.profissionalId) throw new Error('Só o profissional do atendimento pode escrever a evolução.');
      let r = registros.find((x) => x.agendamentoId === agendamentoId);
      if (r?.status === 'assinado') throw new Error('Registro já assinado. Para corrigir, use “Adicionar adendo”.');
      if (!r) {
        const modelo = modeloDoProfissional(PROFISSIONAIS.find((p) => p.id === a.profissionalId));
        r = { id: novoId('g'), pacienteId: a.pacienteId, agendamentoId, profissionalId: a.profissionalId, modelo, data: a.data, campos: {}, status: 'rascunho', adendos: [], restrito: ehRestrito(modelo) };
        registros.push(r);
        if (a.status !== 'atendido') a.status = 'em_atendimento';
      }
      r.campos = { ...campos };
      return resposta(r);
    },
    async assinarRegistro(id) {
      const r = registros.find((x) => x.id === id);
      if (!r) throw new Error('Registro não encontrado.');
      if (usuario.profissionalId !== r.profissionalId) throw new Error('Só o profissional do atendimento pode assinar.');
      const faltas = faltasParaAssinar(r.modelo, r.campos);
      if (faltas.length) throw new Error(faltas.join(' '));
      r.status = 'assinado';
      r.assinadoEm = hojeIso;
      const a = agendamentos.find((x) => x.id === r.agendamentoId);
      if (a) a.status = 'atendido';
      return resposta(r);
    },
    async adicionarAdendo(id, texto) {
      const r = registros.find((x) => x.id === id);
      if (!r) throw new Error('Registro não encontrado.');
      if (usuario.profissionalId !== r.profissionalId) throw new Error('Só o profissional do atendimento pode adicionar adendo.');
      if (!texto.trim()) throw new Error('Escreva o que precisa corrigir ou acrescentar.');
      r.adendos.push({ texto: texto.trim(), em: hojeIso, autor: usuario.nome });
      return resposta(r);
    },
  };
}

export const PROFISSIONAIS_FICTICIOS = PROFISSIONAIS;
export const TIPOS_FICTICIOS = TIPOS;

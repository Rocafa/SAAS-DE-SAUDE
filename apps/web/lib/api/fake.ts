/**
 * Adaptador FAKE em memória. Todos os pacientes, telefones e CPFs são INVENTADOS para demonstração;
 * nenhum dado real. Os CPFs começam com 000 de propósito (não existem).
 */
import { paraIsoLocal, somarDias } from '../ajudante/datas';
import type { ApiClinica, FiltroAgenda } from './cliente';
import { datasDaSerie } from '../agenda';
import { ehRestrito, faltasParaAssinar, modeloDoProfissional } from '../prontuario';
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

// Histórico de 4 semanas para os relatórios (dias úteis, 2 atendimentos e às vezes uma falta).
const HISTORICO: Semente[] = Array.from({ length: 28 }, (_, k) => -(k + 15)).flatMap((dia, k) => [
  { paciente: (k % 28) + 1, prof: (k % 3) + 1, tipo: (k % 4) + 1, dia, hora: '10:00', status: 'atendido' as const },
  { paciente: ((k + 7) % 28) + 1, prof: ((k + 1) % 3) + 1, tipo: 1, dia, hora: '15:00', status: (k % 5 === 0 ? 'faltou' : 'atendido') as StatusAgendamento },
]);
// E alguns atendimentos recentes ainda sem pagamento (contas a receber).
const SEM_PAGAMENTO: Semente[] = [
  { paciente: 11, prof: 1, tipo: 1, dia: -1, hora: '10:00', status: 'atendido' },
  { paciente: 14, prof: 3, tipo: 4, dia: -4, hora: '11:00', status: 'atendido' },
];

export interface OpcoesFake {
  agora?: Date;
  /** Para demonstrar os estados de tela: "erro", "vazio" ou "lento". */
  simular?: 'erro' | 'vazio' | 'lento';
}

export function criarApiFake(opcoes: OpcoesFake = {}): ApiClinica {
  const agora = opcoes.agora ?? new Date();
  const vazio = opcoes.simular === 'vazio';
  const pacientes = vazio ? [] : criarPacientesFicticios();
  const agendamentos: Agendamento[] = vazio
    ? []
    : [...SEMENTES, ...HISTORICO, ...SEM_PAGAMENTO].map((s, i) => {
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
  const semPagamentoIds = new Set(agendamentos.slice(SEMENTES.length + HISTORICO.length).map((a) => a.id));
  const recibos: Recibo[] = agendamentos
    .filter((a) => a.status === 'atendido' && !semPagamentoIds.has(a.id))
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
    { id: 'u1', nome: 'Recepção (demonstração)', papel: 'admin', clinica: 'Clínica Demonstração' },
    { id: 'u2', nome: 'Dra. Beatriz Nogueira (fisioterapia)', papel: 'profissional', clinica: 'Clínica Demonstração', profissionalId: 'pr1' },
    { id: 'u3', nome: 'Dr. Henrique Sales (psicologia)', papel: 'profissional', clinica: 'Clínica Demonstração', profissionalId: 'pr2' },
    { id: 'u4', nome: 'Recepcionista (demonstração)', papel: 'recepcao', clinica: 'Clínica Demonstração' },
  ];
  let usuario: Usuario = USUARIOS[0]!;
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
  const podeLer = (r: Registro) => !r.restrito || usuario.profissionalId === r.profissionalId;
  const visivel = (r: Registro): Registro => (podeLer(r) ? r : { ...r, campos: {}, adendos: [] });
  const guias: Guia[] = vazio
    ? []
    : [
        { id: 'gu1', pacienteId: 'p03', convenio: 'Convênio Exemplo (fictício)', numero: '000123', sessoesAutorizadas: 10, sessoesUsadas: 9, validade: paraIsoLocal(somarDias(agora, 20)) },
        { id: 'gu2', pacienteId: 'p07', convenio: 'Plano Demonstração (fictício)', numero: '000456', sessoesAutorizadas: 12, sessoesUsadas: 4, validade: paraIsoLocal(somarDias(agora, 5)) },
        { id: 'gu3', pacienteId: 'p08', convenio: 'Convênio Exemplo (fictício)', numero: '000789', sessoesAutorizadas: 8, sessoesUsadas: 2, validade: paraIsoLocal(somarDias(agora, 60)) },
      ];
  const conversas: Conversa[] = vazio
    ? []
    : [
        { id: 'c1', pacienteId: 'p02', naoLidas: 1, mensagens: [{ de: 'clinica', texto: 'Olá! Lembrete da sua consulta hoje às 11:00. Confirma?', hora: '08:00' }, { de: 'paciente', texto: 'Confirmo, obrigado!', hora: '08:12' }] },
        { id: 'c2', pacienteId: 'p12', naoLidas: 2, mensagens: [{ de: 'paciente', texto: 'Bom dia, posso trocar meu horário de hoje para amanhã?', hora: '07:40' }, { de: 'paciente', texto: 'Pode ser à tarde.', hora: '07:41' }] },
        { id: 'c3', pacienteId: 'p05', naoLidas: 0, mensagens: [{ de: 'clinica', texto: 'Sua consulta de amanhã às 10:00 está confirmada.', hora: 'ontem' }] },
      ];
  const anexos: Anexo[] = vazio
    ? []
    : [
        { id: 'x1', pacienteId: 'p01', nome: 'Raio-x do joelho (fictício).pdf', tipo: 'exame', data: paraIsoLocal(somarDias(agora, -20)) },
        { id: 'x2', pacienteId: 'p01', nome: 'Encaminhamento médico (fictício).pdf', tipo: 'documento', data: paraIsoLocal(somarDias(agora, -21)) },
      ];

  async function resposta<T>(valor: T): Promise<T> {
    if (opcoes.simular === 'erro') throw new Error('Não conseguimos falar com o servidor.');
    if (opcoes.simular === 'lento') await new Promise((r) => setTimeout(r, 1500));
    return structuredClone(valor);
  }

  return {
    usuarioAtual: () => resposta<Usuario>(usuario),
    usuariosDemo: () => resposta(USUARIOS),
    async entrarComo(id) {
      const u = USUARIOS.find((x) => x.id === id);
      if (!u) throw new Error('Usuário não existe.');
      usuario = u;
      return resposta(u);
    },
    listarPacientes: () => resposta(pacientes),
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
      if (!pacientes.some((p) => p.id === dados.pacienteId)) throw new Error('Falta o paciente. Escolha um nome da lista.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dados.data)) throw new Error('Falta o dia. Escolha no calendário.');
      if (!/^\d{2}:\d{2}$/.test(dados.hora)) throw new Error('Falta o horário. Digite como 14:00.');
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
      if (!a) throw new Error('Esse horário não existe mais. Atualize a tela.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Falta o dia. Escolha no calendário.');
      if (!/^\d{2}:\d{2}$/.test(hora)) throw new Error('Falta o horário. Digite como 14:00.');
      const anterior = { data: a.data, hora: a.hora };
      a.data = data;
      a.hora = hora;
      await resposta(null);
      return anterior;
    },
    async alterarStatus(id, status) {
      const a = agendamentos.find((x) => x.id === id);
      if (!a) throw new Error('Esse horário não existe mais. Atualize a tela.');
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
      if (!pacientes.some((p) => p.id === dados.pacienteId)) throw new Error('Falta o paciente. Escolha um nome da lista.');
      const datas = datasDaSerie(dados.data, rep.intervaloDias, rep.vezes);
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
      if (!pacientes.some((p) => p.id === pacienteId)) throw new Error('Falta o paciente. Escolha um nome da lista.');
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
    async removerPaciente(id) {
      const i = pacientes.findIndex((p) => p.id === id);
      if (i >= 0) pacientes.splice(i, 1);
      await resposta(null);
    },
    async inativarPaciente(id, motivo) {
      const p = pacientes.find((x) => x.id === id);
      if (!p) throw new Error('Paciente não encontrado.');
      p.ativo = false;
      p.inativacao = { data: hojeIso, motivo: motivo.trim() || 'Sem motivo informado' };
      // Consultas futuras saem da agenda; o histórico e o prontuário ficam.
      for (const a of agendamentos) if (a.pacienteId === id && a.data >= hojeIso && (a.status === 'agendado' || a.status === 'confirmado')) a.status = 'cancelado';
      await resposta(null);
    },
    async reativarPaciente(id) {
      const p = pacientes.find((x) => x.id === id);
      if (!p) throw new Error('Paciente não encontrado.');
      p.ativo = true;
      delete p.inativacao;
      await resposta(null);
    },
    listarAnexos: (pacienteId) => resposta(anexos.filter((x) => x.pacienteId === pacienteId)),
    linhaDoTempo: (pacienteId) => {
      const ev: EventoLinhaTempo[] = [];
      for (const a of agendamentos.filter((x) => x.pacienteId === pacienteId && x.data <= hojeIso)) {
        const prof = PROFISSIONAIS.find((p) => p.id === a.profissionalId)?.nome ?? '';
        if (a.status === 'atendido') ev.push({ data: a.data, hora: a.hora, tipo: 'consulta', texto: `Atendimento com ${prof}` });
        else if (a.status === 'faltou') ev.push({ data: a.data, hora: a.hora, tipo: 'falta', texto: `Faltou à consulta com ${prof}` });
        else if (a.status === 'cancelado') ev.push({ data: a.data, hora: a.hora, tipo: 'cancelamento', texto: `Consulta cancelada com ${prof}` });
      }
      for (const r of recibos.filter((x) => x.pacienteId === pacienteId)) ev.push({ data: r.data, tipo: 'recibo', texto: `Pagamento recebido: R$ ${r.valor},00` });
      for (const x of anexos.filter((y) => y.pacienteId === pacienteId)) ev.push({ data: x.data, tipo: 'anexo', texto: `Anexo: ${x.nome}` });
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

    async registrarPagamento(agendamentoId, forma) {
      const a = agendamentos.find((x) => x.id === agendamentoId);
      if (!a) throw new Error('Atendimento não encontrado.');
      if (recibos.some((r) => r.agendamentoId === agendamentoId)) throw new Error('Esse atendimento já está pago.');
      const r: Recibo = { id: novoId('r'), agendamentoId, pacienteId: a.pacienteId, data: hojeIso, valor: TIPOS.find((t) => t.id === a.tipoId)!.valor, forma };
      recibos.push(r);
      return resposta(r);
    },
    async removerRecibo(id) {
      const i = recibos.findIndex((r) => r.id === id);
      if (i >= 0) recibos.splice(i, 1);
      await resposta(null);
    },
    listarGuias: () => resposta(guias),
    async criarGuia(d: NovaGuia) {
      if (!pacientes.some((p) => p.id === d.pacienteId)) throw new Error('Falta o paciente. Escolha na lista.');
      if (!d.convenio.trim()) throw new Error('Falta o nome do convênio.');
      if (!d.numero.trim()) throw new Error('Falta o número da guia. Ele está no papel do convênio.');
      if (!(d.sessoesAutorizadas >= 1)) throw new Error('Quantas sessões o convênio autorizou? Digite um número.');
      const g: Guia = { id: novoId('gu'), ...d, convenio: d.convenio.trim(), numero: d.numero.trim(), sessoesUsadas: 0 };
      guias.push(g);
      return resposta(g);
    },
    async removerGuia(id) {
      const i = guias.findIndex((g) => g.id === id);
      if (i >= 0) guias.splice(i, 1);
      await resposta(null);
    },
    listarConversas: () => resposta(conversas),
  };
}

export const PROFISSIONAIS_FICTICIOS = PROFISSIONAIS;
export const TIPOS_FICTICIOS = TIPOS;

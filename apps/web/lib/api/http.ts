/**
 * Adaptador HTTP da ApiClinica: PACIENTES e AGENDA contra a API real (rotas do PR #57,
 * docs/04-arquitetura/api-dominio.md). As demais áreas continuam no fake (ver `selecionar.ts`).
 *
 * Regras (checklist de segurança e parecer front-r8):
 * - A clínica vem SÓ da sessão no servidor. Este módulo nunca envia tenant/clínica (nem cabeçalho,
 *   nem query, nem corpo). Cabeçalhos enviados: Accept, Content-Type (com corpo) e, só em
 *   dev/teste, Authorization com o token opaco da sessão fictícia. No navegador, a sessão vai no
 *   cookie HttpOnly do provedor real (D4): `credentials: 'include'`.
 * - Nada de log: nenhum console, nenhum dado pessoal em mensagem de erro. Erros viram `ErroApi`
 *   com texto fixo em pt-BR (o que as telas mostram) e o status HTTP.
 * - Timeout em toda chamada (padrão 10 s).
 * - Lista de pacientes = projeção mínima (id, nome, nome social, ativo): CPF, telefone e
 *   nascimento só chegam no detalhe (`obterPaciente`), que a API audita por paciente.
 * - Agenda sempre por período limitado: sem `de`/`ate`, usa a janela padrão (−30/+90 dias);
 *   períodos longos são quebrados em janelas de até 31 dias (limite da API), com teto de 180 dias.
 * - Rodada 19+ (#73): a API conta lista/busca por usuário (429 `limite_por_usuario`, 60/min; alerta de
 *   anomalia acima de 40 páginas em 10 min). Por isso o retrato de pacientes fica em memória por
 *   `RETRATO_TTL_MS` e chamadas simultâneas compartilham a mesma ida ao servidor; cadastrar, alterar e
 *   inativar invalidam o retrato. Mudar o nascimento pode exigir a conferência de documento (422
 *   `documento_nao_conferido`; só admin ou profissional declara: 403 `conferencia_exige_perfil`).
 */
import type { ApiClinica, FiltroAgenda } from './cliente';
import type {
  AlteracaoPaciente,
  Agendamento,
  NovoAgendamento,
  NovoPaciente,
  Paciente,
  Papel,
  Pendencia,
  Profissional,
  Repeticao,
  StatusAgendamento,
  TipoAtendimento,
  Usuario,
} from './tipos';

/** Parte da ApiClinica que já fala com a API real. */
export type ApiHttpPacientesAgenda = Pick<
  ApiClinica,
  | 'usuarioAtual'
  | 'listarPacientes'
  | 'obterPaciente'
  | 'criarPaciente'
  | 'alterarPaciente'
  | 'removerPaciente'
  | 'inativarPaciente'
  | 'reativarPaciente'
  | 'listarProfissionais'
  | 'listarTiposAtendimento'
  | 'listarAgendamentos'
  | 'criarAgendamento'
  | 'removerAgendamento'
  | 'remarcarAgendamento'
  | 'alterarStatus'
  | 'criarSerie'
  | 'removerSerie'
  | 'pendenciasDoDia'
  | 'buscarPacientes'
>;

export interface OpcoesHttp {
  /** Origem da API (esquema://host[:porta]), sem barra no fim. */
  baseUrl: string;
  /** Para testes; padrão: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Tempo máximo de cada chamada, em ms (padrão 10 000). */
  timeoutMs?: number;
  /**
   * Só dev/teste (sessão fictícia da API): devolve o token opaco que vai em
   * `Authorization: Bearer`. No navegador fica sem isso; a sessão real é cookie HttpOnly (D4).
   */
  obterToken?: () => string | null;
  /** Chamado em 401: o provedor limpa o retrato em memória (ressalva R1c). */
  aoPerderSessao?: () => void;
  /** Para testes de data. */
  agora?: () => Date;
  /** Para testes: validade do retrato de pacientes em memória, em ms (padrão `RETRATO_TTL_MS`). */
  retratoTtlMs?: number;
}

/** Erro com mensagem pronta para a tela. Nunca carrega valor de campo nem corpo da resposta. */
export class ErroApi extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codigo?: string,
  ) {
    super(message);
    this.name = 'ErroApi';
  }
}

export const MENSAGENS = {
  sessao: 'Sua sessão terminou. Entre de novo para continuar.',
  proibido: 'Seu perfil não tem permissão para fazer isso. Peça ao administrador da clínica.',
  assinatura: 'A assinatura da clínica não permite mais alterações. Fale com o administrador.',
  naoEncontrado: 'Não encontramos esse registro. Atualize a tela e tente de novo.',
  lotado: 'Esse horário já está lotado. Escolha outro horário ou marque como encaixe.',
  inativo: 'Esse paciente está inativo. Reative o cadastro antes de mudar os dados.',
  transicao: 'Não dá para mudar para esse estado agora. Atualize a tela e confira o horário.',
  conflito: 'Alguém mudou esse registro agora mesmo. Atualize a tela e tente de novo.',
  muitas: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.',
  limiteUsuario: 'Você abriu muitas listas de pacientes em pouco tempo. Espere um minuto e tente de novo.',
  passado: 'Esse horário já passou. Escolha um horário a partir de agora.',
  foraDoHorario:
    'Só dá para mudar esse atendimento perto do horário da consulta. Para corrigir um registro antigo, fale com o administrador.',
  documentoNaoConferido:
    'Para mudar a data de nascimento, confira o documento original do paciente e marque “Conferi o documento original”. Só o administrador ou o profissional pode fazer isso.',
  conferenciaPerfil: 'Só o administrador ou o profissional pode confirmar que conferiu o documento. Peça a um deles.',
  perfilNaoRegistrado: 'Seu perfil não está registrado nesta clínica. Peça ao administrador para conferir seu acesso.',
  regra: 'Falta cumprir uma regra antes de salvar. Confira os dados e tente de novo.',
  nadaMudou: 'Nada mudou. Confira os dados e tente de novo.',
  indisponivel: 'O sistema está passando por manutenção. Tente de novo em alguns instantes.',
  servidor: 'Não conseguimos falar com o servidor.',
  rede: 'Não conseguimos falar com o servidor. Confira a internet e tente de novo.',
  demorou: 'O servidor demorou para responder. Tente de novo.',
  periodoLongo: 'Escolha um período de até 6 meses.',
  semResponsavel:
    'O cadastro de responsável ainda não está ligado ao sistema. Cadastre o paciente sem o responsável e anote-o na ficha depois.',
  semReativar: 'Reativar paciente ainda não está disponível nesta versão. Peça ao suporte.',
  semPacote: 'Pacote de sessões ainda não está disponível nesta versão. Marque as sessões sem o pacote.',
  faltaProfissional: 'Falta o profissional. Escolha um nome da lista.',
  faltaTipo: 'Falta o tipo de atendimento. Escolha um da lista.',
} as const;

const NOMES_CAMPOS: Record<string, string> = {
  nome: 'nome',
  nomeSocial: 'nome social',
  telefone: 'telefone',
  cpf: 'CPF',
  nascimento: 'data de nascimento',
  data: 'dia',
  hora: 'horário',
  pacienteId: 'paciente',
  profissionalId: 'profissional',
  tipoId: 'tipo de atendimento',
  status: 'situação',
  documentoConferido: 'conferência do documento',
  busca: 'busca',
  de: 'período',
  ate: 'período',
};

/** Traduz a resposta de erro da API em mensagem fixa. Só lê `codigo` e nomes de `campos`. */
export function mensagemDeErro(status: number, corpo: unknown): ErroApi {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as { codigo?: unknown; campos?: unknown };
  const codigo = typeof c.codigo === 'string' ? c.codigo : undefined;
  if (status === 400) {
    const campos = Array.isArray(c.campos)
      ? [...new Set(c.campos.filter((x): x is string => typeof x === 'string').map((x) => NOMES_CAMPOS[x] ?? 'um campo'))]
      : [];
    const texto = campos.length ? `Confira ${campos.join(', ')}: algum dado não está certo.` : 'Algum dado não está certo. Confira e tente de novo.';
    return new ErroApi(texto, 400);
  }
  if (status === 401) return new ErroApi(MENSAGENS.sessao, 401);
  if (status === 403) {
    if (codigo === 'assinatura_bloqueia_escrita' || codigo === 'janela_de_saida_encerrada') return new ErroApi(MENSAGENS.assinatura, 403, codigo);
    if (codigo === 'conferencia_exige_perfil') return new ErroApi(MENSAGENS.conferenciaPerfil, 403, codigo);
    if (codigo === 'perfil_nao_registrado') return new ErroApi(MENSAGENS.perfilNaoRegistrado, 403, codigo);
    return new ErroApi(MENSAGENS.proibido, 403, codigo);
  }
  if (status === 404) return new ErroApi(MENSAGENS.naoEncontrado, 404);
  if (status === 409) {
    if (codigo === 'horario_lotado') return new ErroApi(MENSAGENS.lotado, 409, codigo);
    if (codigo === 'paciente_inativo') return new ErroApi(MENSAGENS.inativo, 409, codigo);
    if (codigo === 'transicao_invalida' || codigo === 'status_nao_permite') return new ErroApi(MENSAGENS.transicao, 409, codigo);
    if (codigo === 'horario_no_passado') return new ErroApi(MENSAGENS.passado, 409, codigo);
    if (codigo === 'fora_do_horario') return new ErroApi(MENSAGENS.foraDoHorario, 409, codigo);
    return new ErroApi(MENSAGENS.conflito, 409, codigo);
  }
  if (status === 422) {
    if (codigo === 'documento_nao_conferido') return new ErroApi(MENSAGENS.documentoNaoConferido, 422, codigo);
    return new ErroApi(MENSAGENS.regra, 422, codigo);
  }
  if (status === 429) {
    if (codigo === 'limite_por_usuario') return new ErroApi(MENSAGENS.limiteUsuario, 429, codigo);
    return new ErroApi(MENSAGENS.muitas, 429);
  }
  if (status === 503) return new ErroApi(MENSAGENS.indisponivel, 503);
  return new ErroApi(MENSAGENS.servidor, status);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Janela da API (≤ 31 dias, contando os dois extremos). */
const JANELA_API_DIAS = 31;
/** Janela padrão da agenda em memória (ressalva R1b). */
export const JANELA_PADRAO = { antes: 30, depois: 90 } as const;
const PERIODO_MAXIMO_DIAS = 180;
/** Retrato de pacientes: até 10 páginas de 100 (1000 nomes); a busca da tela vai ao servidor. */
const PAGINAS_MAXIMAS_INDICE = 10;
const LIMITE_PAGINA = 100;
/**
 * Validade do retrato de pacientes em memória (ms). Clínica com 1000 nomes = 10 páginas por retrato:
 * no máximo 20 páginas em 10 min só com o retrato, abaixo do alerta de anomalia da API (40).
 */
export const RETRATO_TTL_MS = 5 * 60_000;

function isoDia(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function somar(iso: string, dias: number): string {
  const [a, m, d] = iso.split('-').map(Number) as [number, number, number];
  return isoDia(new Date(a, m - 1, d + dias));
}
function diasEntre(de: string, ate: string): number {
  const [a1, m1, d1] = de.split('-').map(Number) as [number, number, number];
  const [a2, m2, d2] = ate.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
}

interface PacienteApi {
  id: string;
  nome: string;
  nomeSocial: string | null;
  ativo: boolean;
  cpf?: string | null;
  telefone?: string | null;
  nascimento?: string | null;
}

function paraPaciente(p: PacienteApi): Paciente {
  const r: Paciente = {
    id: p.id,
    nome: p.nome,
    telefone: p.telefone ?? '',
    cpf: p.cpf ?? '',
    nascimento: p.nascimento ?? '',
    responsaveis: [],
    ativo: p.ativo,
    // Fora de produção a API só recebe dados fictícios (NODE_ENV development/test).
    ficticio: true,
  };
  if (p.nomeSocial) r.nomeSocial = p.nomeSocial;
  return r;
}

function paraAgendamento(a: Agendamento & { inicio?: string; fim?: string }): Agendamento {
  return {
    id: a.id,
    pacienteId: a.pacienteId,
    profissionalId: a.profissionalId,
    tipoId: a.tipoId,
    data: a.data,
    hora: a.hora,
    minutos: a.minutos,
    status: a.status,
    encaixe: a.encaixe,
  };
}

/** Perfis da API → papel da tela (o servidor é quem barra; isto só escolhe o que mostrar). */
export function papelDosPerfis(perfis: readonly string[]): Papel {
  if (perfis.includes('admin')) return 'admin';
  if (perfis.includes('profissional')) return 'profissional';
  return 'recepcao';
}

export function criarApiHttp(opcoes: OpcoesHttp): ApiHttpPacientesAgenda {
  const base = opcoes.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(base)) throw new Error('Origem da API inválida');
  const fazerFetch = opcoes.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opcoes.timeoutMs ?? 10_000;
  const agora = opcoes.agora ?? (() => new Date());
  const retratoTtlMs = opcoes.retratoTtlMs ?? RETRATO_TTL_MS;
  /** Retrato compartilhado: a promessa em andamento ou já resolvida, com o instante em que nasceu. */
  let retrato: { promessa: Promise<Paciente[]>; desde: number } | null = null;
  function invalidarRetrato() {
    retrato = null;
  }
  function retratoDePacientes(): Promise<Paciente[]> {
    const t = agora().getTime();
    if (!retrato || t - retrato.desde >= retratoTtlMs) {
      const atual = { promessa: paginasDePacientes(), desde: t };
      retrato = atual;
      // Falhou: não guarda o erro (a próxima tela tenta de novo).
      atual.promessa.catch(() => {
        if (retrato === atual) retrato = null;
      });
    }
    // Cópia: uma tela não altera o retrato da outra.
    return retrato.promessa.then((l) => l.map((p) => ({ ...p })));
  }
  /** Séries criadas nesta aba (para o "Desfazer"): a API ainda não tem série. */
  const series = new Map<string, string[]>();
  let seqSerie = 0;

  async function chamar<T>(metodo: 'GET' | 'POST' | 'PATCH', caminho: string, corpo?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    const token = opcoes.obterToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), timeoutMs);
    let resposta: Response;
    try {
      resposta = await fazerFetch(`${base}${caminho}`, {
        method: metodo,
        headers,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controle.signal,
        ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
      });
    } catch {
      throw controle.signal.aborted ? new ErroApi(MENSAGENS.demorou, 0, 'timeout') : new ErroApi(MENSAGENS.rede, 0, 'rede');
    } finally {
      clearTimeout(relogio);
    }
    if (!resposta.ok) {
      const corpoErro: unknown = await resposta.json().catch(() => null);
      const erro = mensagemDeErro(resposta.status, corpoErro);
      if (resposta.status === 401) {
        invalidarRetrato();
        opcoes.aoPerderSessao?.();
      }
      throw erro;
    }
    if (resposta.status === 204) return undefined as T;
    try {
      return (await resposta.json()) as T;
    } catch {
      throw new ErroApi(MENSAGENS.servidor, resposta.status, 'resposta_invalida');
    }
  }

  function qs(params: Record<string, string | number | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : '';
  }

  async function paginasDePacientes(busca?: string): Promise<Paciente[]> {
    const todos: Paciente[] = [];
    for (let pagina = 1; pagina <= PAGINAS_MAXIMAS_INDICE; pagina++) {
      // Busca: termo SÓ no corpo de um POST (nome não pode ir para URL, logs de ALB/WAF ou
      // histórico; veto do Guardião). A query de GET leva apenas paginação e situação.
      const r =
        busca === undefined
          ? await chamar<{ itens: PacienteApi[]; temMais: boolean }>(
              'GET',
              `/pacientes${qs({ situacao: 'todos', pagina, limite: LIMITE_PAGINA })}`,
            )
          : await chamar<{ itens: PacienteApi[]; temMais: boolean }>('POST', '/pacientes/busca', {
              busca,
              situacao: 'todos',
              pagina,
              limite: LIMITE_PAGINA,
            });
      todos.push(...r.itens.map(paraPaciente));
      if (!r.temMais) break;
    }
    return todos;
  }

  async function listarAgendamentos(filtro: FiltroAgenda = {}): Promise<Agendamento[]> {
    const hoje = isoDia(agora());
    const de = filtro.de ?? (filtro.ate ? somar(filtro.ate, -JANELA_PADRAO.antes - JANELA_PADRAO.depois) : somar(hoje, -JANELA_PADRAO.antes));
    const ate = filtro.ate ?? (filtro.de ? somar(filtro.de, JANELA_PADRAO.antes + JANELA_PADRAO.depois) : somar(hoje, JANELA_PADRAO.depois));
    const total = diasEntre(de, ate);
    if (total < 0) return [];
    if (total >= PERIODO_MAXIMO_DIAS) throw new ErroApi(MENSAGENS.periodoLongo, 400);
    if (filtro.pacienteId && !UUID_RE.test(filtro.pacienteId)) return [];
    if (filtro.profissionalId && !UUID_RE.test(filtro.profissionalId)) return [];
    const janelas: [string, string][] = [];
    for (let ini = de; diasEntre(ini, ate) >= 0; ini = somar(ini, JANELA_API_DIAS)) {
      const fim = somar(ini, JANELA_API_DIAS - 1);
      janelas.push([ini, diasEntre(fim, ate) >= 0 ? fim : ate]);
    }
    const partes = await Promise.all(
      janelas.map(([d, a]) =>
        chamar<{ itens: Agendamento[] }>(
          'GET',
          `/agendamentos${qs({ de: d, ate: a, pacienteId: filtro.pacienteId, profissionalId: filtro.profissionalId })}`,
        ),
      ),
    );
    return partes
      .flatMap((p) => p.itens.map(paraAgendamento))
      .sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora));
  }

  async function criarAgendamento(dados: NovoAgendamento): Promise<Agendamento> {
    if (!dados.profissionalId || !UUID_RE.test(dados.profissionalId)) throw new ErroApi(MENSAGENS.faltaProfissional, 400);
    if (!dados.tipoId || !UUID_RE.test(dados.tipoId)) throw new ErroApi(MENSAGENS.faltaTipo, 400);
    const a = await chamar<Agendamento>('POST', '/agendamentos', {
      pacienteId: dados.pacienteId,
      profissionalId: dados.profissionalId,
      tipoId: dados.tipoId,
      data: dados.data,
      hora: dados.hora,
      ...(dados.encaixe ? { encaixe: true } : {}),
    });
    return paraAgendamento(a);
  }

  async function cancelar(id: string): Promise<void> {
    await chamar('POST', `/agendamentos/${encodeURIComponent(id)}/cancelar`, {});
  }

  return {
    async usuarioAtual(): Promise<Usuario> {
      const s = await chamar<{ usuarioId: string; clinicaId: string; perfis: string[] }>('GET', '/sessao');
      // O nome do usuário e da clínica chegam com o provedor real (D4).
      return { id: s.usuarioId, nome: 'Você', papel: papelDosPerfis(s.perfis), clinica: '', clinicaId: s.clinicaId };
    },
    listarPacientes: retratoDePacientes,
    async buscarPacientes(termo: string) {
      const t = termo.trim().replace(/\s+/g, ' ');
      if (t.length < 2) return [];
      return paginasDePacientes(t.slice(0, 80));
    },
    async obterPaciente(id) {
      if (!UUID_RE.test(id)) return null;
      try {
        return paraPaciente(await chamar<PacienteApi>('GET', `/pacientes/${encodeURIComponent(id)}`));
      } catch (e) {
        if (e instanceof ErroApi && e.status === 404) return null;
        throw e;
      }
    },
    async criarPaciente(dados: NovoPaciente) {
      if (dados.responsavel) throw new ErroApi(MENSAGENS.semResponsavel, 400);
      const corpo: Record<string, string> = { nome: dados.nome.trim(), telefone: dados.telefone };
      if (dados.nomeSocial?.trim()) corpo.nomeSocial = dados.nomeSocial.trim();
      if (dados.cpf?.trim()) corpo.cpf = dados.cpf.trim();
      if (dados.nascimento?.trim()) corpo.nascimento = dados.nascimento.trim();
      const p = paraPaciente(await chamar<PacienteApi>('POST', '/pacientes', corpo));
      invalidarRetrato();
      return p;
    },
    async alterarPaciente(id, dados: AlteracaoPaciente) {
      if (!UUID_RE.test(id)) throw new ErroApi(MENSAGENS.naoEncontrado, 404);
      const corpo: Record<string, string | boolean | null> = {};
      if (dados.telefone !== undefined) corpo.telefone = dados.telefone.trim();
      if (dados.nascimento !== undefined) {
        corpo.nascimento = dados.nascimento?.trim() || null;
        // A API recusa `documentoConferido` sem `nascimento`; só vai quando a pessoa marcou.
        if (dados.documentoConferido) corpo.documentoConferido = true;
      }
      if (!Object.keys(corpo).length) throw new ErroApi(MENSAGENS.nadaMudou, 400);
      const p = paraPaciente(await chamar<PacienteApi>('PATCH', `/pacientes/${encodeURIComponent(id)}`, corpo));
      invalidarRetrato();
      return p;
    },
    // A API não apaga paciente (retenção, R4): o "Desfazer" do cadastro inativa.
    async removerPaciente(id) {
      await chamar('POST', `/pacientes/${encodeURIComponent(id)}/inativar`, {});
      invalidarRetrato();
    },
    // O motivo ainda não é gravado pela API; fica só na tela.
    async inativarPaciente(id) {
      await chamar('POST', `/pacientes/${encodeURIComponent(id)}/inativar`, {});
      invalidarRetrato();
    },
    reativarPaciente: () => Promise.reject(new ErroApi(MENSAGENS.semReativar, 501)),
    async listarProfissionais(): Promise<Profissional[]> {
      const r = await chamar<{ id: string; nome: string; especialidade: string; capacidade: number }[]>('GET', '/profissionais');
      return r.map((p) => ({ id: p.id, nome: p.nome, especialidade: p.especialidade, limiteSimultaneo: p.capacidade }));
    },
    async listarTiposAtendimento(): Promise<TipoAtendimento[]> {
      const r = await chamar<{ id: string; nome: string; minutos: number }[]>('GET', '/tipos-atendimento');
      // Valor do tipo ainda não existe na API (fora da rodada 11.1).
      return r.map((t) => ({ id: t.id, nome: t.nome, minutos: t.minutos, valor: 0 }));
    },
    listarAgendamentos,
    criarAgendamento,
    removerAgendamento: cancelar,
    remarcarAgendamento: (id, data, hora) =>
      chamar<{ data: string; hora: string }>('POST', `/agendamentos/${encodeURIComponent(id)}/remarcar`, { data, hora }),
    async alterarStatus(id, status: StatusAgendamento) {
      const caminho = `/agendamentos/${encodeURIComponent(id)}`;
      const r =
        status === 'chegou'
          ? await chamar<{ statusAnterior: StatusAgendamento }>('POST', `${caminho}/check-in`, {})
          : await chamar<{ statusAnterior: StatusAgendamento }>('POST', `${caminho}/status`, { status });
      return r.statusAnterior;
    },
    async criarSerie(dados: NovoAgendamento, rep: Repeticao) {
      if (rep.pacote) throw new ErroApi(MENSAGENS.semPacote, 400);
      const serieId = `serie-local-${++seqSerie}`;
      const criados: Agendamento[] = [];
      try {
        for (let i = 0; i < rep.vezes; i++) {
          const a = await criarAgendamento({ ...dados, data: somar(dados.data, i * rep.intervaloDias) });
          criados.push({ ...a, serieId });
        }
      } catch (e) {
        // Tudo ou nada: cancela o que já foi marcado antes de mostrar o erro.
        await Promise.allSettled(criados.map((a) => cancelar(a.id)));
        throw e;
      }
      series.set(
        serieId,
        criados.map((a) => a.id),
      );
      return criados;
    },
    async removerSerie(serieId) {
      const ids = series.get(serieId) ?? [];
      await Promise.all(ids.map(cancelar));
      series.delete(serieId);
    },
    async pendenciasDoDia(data): Promise<Pendencia[]> {
      const doDia = await listarAgendamentos({ de: data, ate: data });
      const p: Pendencia[] = [];
      const semConfirmar = doDia.filter((a) => a.status === 'agendado').length;
      if (semConfirmar) p.push({ id: 'confirmar', texto: `Confirmar presença: ${semConfirmar} pessoa(s)`, rota: '/inicio#falta-confirmar' });
      const faltas = doDia.filter((a) => a.status === 'faltou').length;
      if (faltas) p.push({ id: 'faltas', texto: `Remarcar quem faltou: ${faltas} pessoa(s)`, rota: '/agenda' });
      return p;
    },
  };
}

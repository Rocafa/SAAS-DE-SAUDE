/**
 * Linha do tempo do paciente (HU-PAC-007): regras puras (sem banco) de quem vê o quê e de como cada linha
 * de origem vira um evento. O serviço (linha-do-tempo.service.ts) só lê e chama estas funções.
 *
 * Princípios (docs/03-seguranca-lgpd; parecer pendente do Guardião LGPD):
 * - NUNCA conteúdo clínico: o evento clínico é só metadado ("atendimento registrado por X em D"); não sai
 *   modelo, especialidade, compartimento, versão, queixa, evolução, adendo nem nota privada.
 * - Agenda: todos os perfis da clínica (é o que `GET /agendamentos` já mostra a eles).
 * - Financeiro: todos veem que houve cobrança/pagamento/recibo; VALORES e número do recibo só com
 *   `financeiro:ler` (admin, recepção, financeiro). O profissional vê o fato, sem valor.
 * - Clínico: só perfil clínico COM vínculo de cuidado (`podeLerConteudoClinico`). Recepção, financeiro e
 *   admin não clínico nunca recebem evento clínico.
 * - Psicologia (compartimento de sigilo): o atendimento só aparece para o AUTOR (o psicólogo responsável),
 *   em qualquer modo de sigilo da clínica — mais restrito que o prontuário de propósito: aqui não há MFA
 *   recente nem motivo de ocultação, então o mais simples e protetor é não listar.
 * - Profissional de área sensível (psicologia, psiquiatria, saúde mental): o nome dele não entra no texto
 *   dos eventos de agenda, salvo para ele mesmo (a timeline junta tudo num lugar só; não reforça o vínculo).
 *
 * Autor (`autor`): só sai quando o mesmo perfil já recebe essa informação em outra rota.
 * - Atendimento registrado: o profissional do atendimento (`profissionalId` em `GET /pacientes/:id/prontuario`
 *   para quem tem vínculo, e o nome em `GET /profissionais`). Sai.
 * - Agenda: quem marcou/remarcou/cancelou (`created_by`/`rescheduled_by`) NÃO é exposto por nenhuma rota. Não sai.
 * - Financeiro: quem lançou/recebeu/estornou/emitiu (`created_by`/`received_by`/...) NÃO é exposto. Não sai.
 */
import { temPermissao, type Perfil } from '../auth/perfis';
import { noFusoDaClinica } from '../scheduling/agenda-regras';

/** Mesmos valores do `EventoLinhaTempo.tipo` do front (apps/web/lib/api/tipos.ts): o ícone/selo da tela. */
export type TipoLinhaDoTempo = 'consulta' | 'falta' | 'cancelamento' | 'recibo' | 'anexo' | 'cadastro';

export const EVENTOS_DA_LINHA_DO_TEMPO = [
  'agenda_marcada',
  'agenda_remarcada',
  'agenda_cancelada',
  'agenda_compareceu',
  'agenda_faltou',
  'cobranca_registrada',
  'cobranca_cancelada',
  'pagamento_recebido',
  'pagamento_estornado',
  'recibo_emitido',
  'recibo_cancelado',
  'atendimento_registrado',
] as const;
export type EventoDaLinhaDoTempo = (typeof EVENTOS_DA_LINHA_DO_TEMPO)[number];

export type CategoriaDoEvento = 'agenda' | 'financeiro' | 'documento' | 'clinico';

/**
 * Evento devolvido pela API. Compatível com `EventoLinhaTempo` do front (`data`, `hora?`, `tipo`, `texto`,
 * `autor?`), com campos a mais (`id`, `evento`, `categoria`, `ocorridoEm`) que o front pode ignorar.
 */
export interface EventoLinhaDoTempoDto {
  /** Id opaco do evento (`<evento>:<id da linha de origem>`), estável entre páginas. */
  readonly id: string;
  /** AAAA-MM-DD e HH:MM no fuso da clínica. */
  readonly data: string;
  readonly hora: string;
  /** Instante ISO-8601 em UTC (ordenação). */
  readonly ocorridoEm: string;
  readonly tipo: TipoLinhaDoTempo;
  readonly evento: EventoDaLinhaDoTempo;
  readonly categoria: CategoriaDoEvento;
  /** Texto administrativo, montado aqui. Nunca conteúdo clínico. */
  readonly texto: string;
  /** Só quando o mesmo perfil já vê essa pessoa em outra rota (ver cabeçalho). */
  readonly autor?: string;
}

/** O que a sessão pode ver nesta linha do tempo. Calculado no servidor; nada vem da requisição. */
export interface EscopoDaLinhaDoTempo {
  readonly agenda: boolean;
  readonly financeiro: boolean;
  /** Valores (R$) e número do recibo. */
  readonly valores: boolean;
  /** Eventos clínicos (metadado de atendimento). Exige perfil clínico + vínculo de cuidado. */
  readonly clinico: boolean;
}

/**
 * `podeVerClinico` é o resultado de `podeLerConteudoClinico(perfis, vinculo)` (perfil clínico + vínculo de
 * cuidado calculado no servidor). Recebido pronto para esta função não abrir o tipo marcado do vínculo.
 */
export function escopoDaLinhaDoTempo(perfis: readonly Perfil[], podeVerClinico: boolean): EscopoDaLinhaDoTempo {
  return {
    agenda: temPermissao(perfis, 'agenda:ler'),
    financeiro: perfis.length > 0,
    valores: temPermissao(perfis, 'financeiro:ler'),
    clinico: podeVerClinico && temPermissao(perfis, 'conteudo_clinico:ler'),
  };
}

export function categoriaDo(evento: EventoDaLinhaDoTempo): CategoriaDoEvento {
  if (evento.startsWith('agenda_')) return 'agenda';
  if (evento.startsWith('recibo_')) return 'documento';
  if (evento === 'atendimento_registrado') return 'clinico';
  return 'financeiro';
}

export function eventoPermitido(evento: EventoDaLinhaDoTempo, escopo: EscopoDaLinhaDoTempo): boolean {
  const c = categoriaDo(evento);
  if (c === 'agenda') return escopo.agenda;
  if (c === 'clinico') return escopo.clinico;
  return escopo.financeiro;
}

/** Linha crua vinda do banco (UNION das fontes). Só colunas administrativas: nenhuma coluna cifrada ou clínica. */
export interface LinhaDeOrigem {
  readonly evento: EventoDaLinhaDoTempo;
  readonly origemId: string;
  /** `AAAA-MM-DD HH:MM:SS.UUUUUU` em UTC (chave exata do keyset). */
  readonly chave: string;
  /** Início da consulta (agenda), ou novo início (remarcada). `AAAA-MM-DD HH:MM:SS.UUUUUU` em UTC. */
  readonly inicio: string | null;
  /** Início anterior (remarcada). */
  readonly inicioAnterior: string | null;
  readonly profissionalNome: string | null;
  readonly profissionalSensivel: boolean | null;
  readonly profissionalUsuarioId: string | null;
  /** Psicologia: compartimento do atendimento e autor (defesa além do filtro SQL). */
  readonly compartimento: string | null;
  readonly autorUsuarioId: string | null;
  readonly valorCentavos: number | null;
  readonly numero: number | null;
}

/** `AAAA-MM-DD HH:MM:SS.UUUUUU` (UTC) -> Date (milissegundos). */
export function instanteDaChave(chave: string): Date {
  return new Date(`${chave.slice(0, 23).replace(' ', 'T')}Z`);
}

function dataHora(chave: string): { data: string; hora: string; br: string } {
  const { data, hora } = noFusoDaClinica(instanteDaChave(chave));
  const [a, m, d] = data.split('-');
  return { data, hora, br: `${d}/${m}/${a}` };
}

export function reais(centavos: number): string {
  const sinal = centavos < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(centavos));
  const inteiro = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sinal}R$ ${inteiro},${String(abs % 100).padStart(2, '0')}`;
}

/** Nome do profissional no texto de agenda: omitido para área sensível, salvo para ele mesmo. */
function comProfissional(l: LinhaDeOrigem, usuarioId: string): string {
  if (!l.profissionalNome) return '';
  if (l.profissionalSensivel && l.profissionalUsuarioId !== usuarioId) return '';
  return ` com ${l.profissionalNome}`;
}

/**
 * Converte a linha em evento visível para a sessão, ou `null` se o escopo não permite. Segunda barreira: o
 * serviço já não consulta as fontes fora do escopo.
 */
export function paraEvento(l: LinhaDeOrigem, escopo: EscopoDaLinhaDoTempo, usuarioId: string): EventoLinhaDoTempoDto | null {
  if (!eventoPermitido(l.evento, escopo)) return null;
  if (l.evento === 'atendimento_registrado' && l.compartimento === 'psicologia' && l.autorUsuarioId !== usuarioId) return null;
  const quando = dataHora(l.chave);
  const consulta = l.inicio ? dataHora(l.inicio) : null;
  const valor = escopo.valores && l.valorCentavos !== null ? `: ${reais(l.valorCentavos)}` : '';
  const numero = escopo.valores && l.numero !== null ? ` nº ${l.numero}` : '';
  const prof = comProfissional(l, usuarioId);
  let tipo: TipoLinhaDoTempo;
  let texto: string;
  let autor: string | undefined;
  switch (l.evento) {
    case 'agenda_marcada':
      tipo = 'consulta';
      texto = `Consulta marcada para ${consulta?.br ?? ''} às ${consulta?.hora ?? ''}${prof}`;
      break;
    case 'agenda_remarcada': {
      const de = l.inicioAnterior ? dataHora(l.inicioAnterior) : null;
      tipo = 'consulta';
      texto = `Consulta remarcada de ${de?.br ?? ''} ${de?.hora ?? ''} para ${consulta?.br ?? ''} ${consulta?.hora ?? ''}${prof}`;
      break;
    }
    case 'agenda_cancelada':
      tipo = 'cancelamento';
      texto = `Consulta de ${consulta?.br ?? ''} às ${consulta?.hora ?? ''} cancelada${prof}`;
      break;
    case 'agenda_compareceu':
      tipo = 'consulta';
      texto = `Compareceu à consulta${prof}`;
      break;
    case 'agenda_faltou':
      tipo = 'falta';
      texto = `Faltou à consulta${prof}`;
      break;
    case 'cobranca_registrada':
      tipo = 'recibo';
      texto = `Cobrança registrada${valor}`;
      break;
    case 'cobranca_cancelada':
      tipo = 'recibo';
      texto = 'Cobrança cancelada';
      break;
    case 'pagamento_recebido':
      tipo = 'recibo';
      texto = `Pagamento recebido${valor}`;
      break;
    case 'pagamento_estornado':
      tipo = 'recibo';
      texto = `Pagamento estornado${valor}`;
      break;
    case 'recibo_emitido':
      tipo = 'recibo';
      texto = `Recibo${numero} emitido`;
      break;
    case 'recibo_cancelado':
      tipo = 'recibo';
      texto = `Recibo${numero} cancelado`;
      break;
    case 'atendimento_registrado':
      tipo = 'consulta';
      texto = `Atendimento registrado${l.profissionalNome ? ` por ${l.profissionalNome}` : ''} em ${quando.br}`;
      autor = l.profissionalNome ?? undefined;
      break;
  }
  return {
    id: `${l.evento}:${l.origemId}`,
    data: quando.data,
    hora: quando.hora,
    ocorridoEm: instanteDaChave(l.chave).toISOString(),
    tipo,
    evento: l.evento,
    categoria: categoriaDo(l.evento),
    texto,
    ...(autor ? { autor } : {}),
  };
}

/** Nome da âncora no cursor (vira só marca HMAC; nunca vai no cursor em claro). */
export function nomeDaAncora(l: Pick<LinhaDeOrigem, 'evento' | 'chave'>): string {
  return `${l.evento}|${l.chave}`;
}

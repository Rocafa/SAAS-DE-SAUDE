/**
 * Regras puras do portal do paciente (rodada 18.1). Sem banco: testadas em portal-regras.test.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  AiConsentState,
  PortalConsentPurpose,
  PortalConsentResponse,
  RightsRequestKind,
  RightsRequestStatus,
} from '../../db/schema';

/** Versão dos textos de consentimento apresentados no portal. Mudou o texto? Nova versão. */
export const VERSAO_TEXTOS_CONSENTIMENTO = 'portal-textos-v1';

/**
 * Textos apresentados ao titular (os mesmos do front, `apps/web/lib/portal.ts`). O hash do texto vai em
 * cada evento de consentimento (R15 do front-r8): prova do que foi mostrado.
 */
export const CONSENTIMENTOS: Readonly<Record<PortalConsentPurpose, { readonly titulo: string; readonly explicacao: string }>> = {
  lembretes_whatsapp: {
    titulo: 'Lembretes de consulta pelo WhatsApp',
    explicacao: 'Avisos de dia e hora. Nunca mandamos informação de saúde na mensagem.',
  },
  escriba_ia: {
    titulo: 'Uso de inteligência artificial para escrever o rascunho da consulta',
    explicacao: 'O profissional sempre revisa antes de assinar. Você pode recusar e o atendimento é igual.',
  },
  pesquisa: {
    titulo: 'Pesquisa de satisfação depois da consulta',
    explicacao: 'Uma pergunta rápida por mensagem.',
  },
};

export function hashDoTexto(finalidade: PortalConsentPurpose): string {
  const t = CONSENTIMENTOS[finalidade];
  return createHash('sha256').update(`${VERSAO_TEXTOS_CONSENTIMENTO}\n${finalidade}\n${t.titulo}\n${t.explicacao}`, 'utf8').digest('hex');
}

/** Três estados: "não respondido" vale como NÃO (só `sim` permite). */
export type RespostaConsentimento = 'sim' | 'nao' | 'nao_respondido';

/** Estado atual = último evento; `desfeito` (ou nenhum evento) = não respondido. */
export function estadoDoConsentimento(ultimo: PortalConsentResponse | undefined): RespostaConsentimento {
  return ultimo === 'sim' || ultimo === 'nao' ? ultimo : 'nao_respondido';
}

export function permitido(r: RespostaConsentimento): boolean {
  return r === 'sim';
}

/**
 * Consentimento de IA no vocabulário do escriba (RIPD, R12; Res. CFM 2.454/2026), em 3 estados:
 * não respondido = `nao_informado` (nega), sim = `informado_nao_recusou`, não = `recusou`.
 */
export function consentimentoIa(r: RespostaConsentimento): AiConsentState {
  if (r === 'sim') return 'informado_nao_recusou';
  if (r === 'nao') return 'recusou';
  return 'nao_informado';
}

/** Tipos de pedido aceitos (LGPD art. 18) e os apelidos do front (`apps/web/lib/portal.ts`). */
const APELIDOS: Readonly<Record<string, RightsRequestKind>> = {
  acesso: 'acesso',
  ver_dados: 'acesso',
  correcao: 'correcao',
  corrigir: 'correcao',
  portabilidade: 'portabilidade',
  baixar: 'portabilidade',
  eliminacao: 'eliminacao',
  apagar: 'eliminacao',
  compartilhamento: 'compartilhamento',
};
export const TIPOS_DE_PEDIDO_ACEITOS = Object.keys(APELIDOS);

export function tipoDePedido(valor: string): RightsRequestKind | undefined {
  return Object.prototype.hasOwnProperty.call(APELIDOS, valor) ? APELIDOS[valor] : undefined;
}

/** Situação do pedido para o titular (o front mostra "aberto" ou "respondido"). */
export function situacaoParaOTitular(s: RightsRequestStatus): 'aberto' | 'respondido' {
  return s === 'atendida' || s === 'recusada' ? 'respondido' : 'aberto';
}

/**
 * Teto diário de pedidos do titular por vínculo (A3c do #68): no máximo 5 em 24 h. O banco confere o
 * mesmo número no gatilho de portal_rights_requests (migração 0033).
 */
export const TETO_DIARIO_PEDIDOS = 5;

/** Estados finais do pedido exigem resposta ao titular (LGPD art. 18 §4º e art. 19; A3a do #68). */
export function exigeResposta(s: RightsRequestStatus): boolean {
  return s === 'atendida' || s === 'recusada';
}

/**
 * Texto-modelo para a CLÍNICA responder pedido de eliminação (A3d do #68): o prontuário tem guarda mínima
 * de 20 anos (Lei 13.787/2018, art. 6º) e a LGPD permite a conservação para cumprir obrigação legal
 * (art. 16, I). A clínica adapta antes de enviar; nada é enviado automaticamente.
 */
export const MODELO_RESPOSTA_ELIMINACAO =
  'Recebemos seu pedido de eliminação. Os dados de cadastro e de contato que não são exigidos por lei serão eliminados. ' +
  'O prontuário e os registros de atendimento precisam ser guardados por no mínimo 20 anos desde o último registro ' +
  '(Lei 13.787/2018) e por isso ficam conservados, com acesso restrito, para cumprir essa obrigação legal (LGPD, art. 16, I). ' +
  'Documentos fiscais seguem o prazo da legislação tributária.';

/** Protocolo AAAAMMDD-XXXXXXXX (8 hex aleatórios, maiúsculos): não sequencial, não enumerável. */
export function novoProtocolo(agora: Date = new Date()): string {
  const d = agora.toISOString().slice(0, 10).replace(/-/g, '');
  return `${d}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Token do convite (vai para o paciente, por fora da plataforma) e o hash que fica no banco. */
export function novoTokenDeConvite(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashDoToken(token) };
}

export function hashDoToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const TOKEN_CONVITE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Validade do convite: padrão 72 h, de 1 h a 7 dias (o banco confere o teto). */
export const VALIDADE_CONVITE_HORAS = { padrao: 72, min: 1, max: 168 } as const;

/** CPF só com os 2 últimos dígitos à mostra (o titular vê o próprio dado mascarado na tela). */
export function mascararCpf(cpf: string | null): string | null {
  if (!cpf) return null;
  const d = cpf.replace(/\D/g, '');
  return d.length === 11 ? `***.***.***-${d.slice(9)}` : null;
}

/** Primeiro nome para a saudação (nome social primeiro, como o resto do produto). */
export function primeiroNome(nome: string, nomeSocial: string | null): string {
  return (nomeSocial ?? nome).trim().split(/\s+/)[0] ?? '';
}

/**
 * Antecedência mínima para o paciente cancelar pelo portal (horas antes do início). Padrão 2 h;
 * 0..168 (`PORTAL_CANCEL_MIN_HOURS`). Confirmar só exige que a consulta ainda não tenha começado.
 */
export const ANTECEDENCIA_CANCELAMENTO_PADRAO_H = 2;
export function loadAntecedenciaCancelamento(env: NodeJS.ProcessEnv = process.env): number {
  const bruto = env.PORTAL_CANCEL_MIN_HOURS;
  if (bruto === undefined || bruto.trim() === '') return ANTECEDENCIA_CANCELAMENTO_PADRAO_H;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < 0 || n > 168) throw new Error('PORTAL_CANCEL_MIN_HOURS inválida: inteiro 0..168');
  return n;
}

export type AcaoNaConsulta = 'confirmar' | 'desfazer_confirmacao' | 'cancelar';

/** Transições que o PORTAL pode fazer (o banco confere o mesmo: zz_appointments_portal_guard). */
export function transicaoDoPortal(acao: AcaoNaConsulta, statusAtual: string): 'scheduled' | 'confirmed' | 'cancelled' | null {
  if (acao === 'confirmar') return statusAtual === 'scheduled' ? 'confirmed' : null;
  if (acao === 'desfazer_confirmacao') return statusAtual === 'confirmed' ? 'scheduled' : null;
  return statusAtual === 'scheduled' || statusAtual === 'confirmed' ? 'cancelled' : null;
}

/** Janela das "próximas consultas": de 2 h atrás até 180 dias à frente, no máximo 50. */
export const JANELA_CONSULTAS = { passadoMs: 2 * 3_600_000, futuroDias: 180, maximo: 50 } as const;

/**
 * Consentimento de menor (LGPD art. 14 §1º): dado por pelo menos um dos pais ou o responsável legal.
 * Conservador até o parecer do advogado (D8 ⚖️ — adolescente pode consentir sozinho?): abaixo de 18
 * anos, a conta que age como o PRÓPRIO titular não responde consentimento; o responsável legal sim.
 */
export const IDADE_CONSENTIMENTO_PROPRIO = 18;

/**
 * V1 do parecer do #68 — responsável legal no portal.
 * - Convite `titular` abaixo de 12 anos: recusado. De 12 a 17: recusado até haver decisão registrada (A1;
 *   parecer D8 ⚖️ pendente). Sem data de nascimento o titular entra, mas não consente (falha fechada).
 * - Convite `responsavel_legal`: só com um vínculo VIGENTE da 0028 do mesmo paciente e, fora a curatela,
 *   paciente MENOR não emancipado. A representação acaba no dia dos 18 anos ou no fim da vigência do
 *   vínculo da 0028, o que vier antes (`fimDaRepresentacao`); a curatela segue a vigência do vínculo.
 */
export const IDADE_MINIMA_TITULAR = 12;

export function fimDaRepresentacao(dezoitoAnos: string, fimDaVigencia: string | null): string {
  return fimDaVigencia !== null && fimDaVigencia < dezoitoAnos ? fimDaVigencia : dezoitoAnos;
}

/**
 * Evento de consentimento ainda vale HOJE? O do titular, sempre. O do responsável, só enquanto a
 * representação valia (`representUntil` exclusivo; null = curatela, segue enquanto o vínculo existir).
 * Depois da maioridade o estado volta a "não respondido" até o titular responder (V1.3 do #68).
 */
export function eventoVale(e: { actingAs: PortalActingAsRegra; representUntil: string | null }, hoje: string): boolean {
  return e.actingAs === 'titular' || e.representUntil === null || hoje < e.representUntil;
}
type PortalActingAsRegra = 'titular' | 'responsavel_legal';

/**
 * Sigilo do adolescente no portal (A1 do #68; C3 da re-revisão do #67): o responsável vê agenda, financeiro e
 * cadastro, NADA clínico — nem com a marca de informação clínica da 0031 ligada (o portal não a consulta).
 * Na agenda, consulta de área sensível (psicologia/psiquiatria) de paciente com 12 anos ou mais (ou idade
 * desconhecida) fica OCULTA ao responsável por padrão.
 */
export function especialidadeSensivel(especialidade: string): boolean {
  const e = especialidade.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /psic|psiq/.test(e);
}

export function consultaOcultaAoResponsavel(
  agindoComo: PortalActingAsRegra,
  faixa: 'crianca' | 'adolescente' | 'adulto' | null,
  especialidade: string,
): boolean {
  return agindoComo === 'responsavel_legal' && faixa !== 'crianca' && especialidadeSensivel(especialidade);
}
export function idadeEm(nascimento: string, hoje: string): number {
  const [an, mn, dn] = nascimento.split('-').map(Number) as [number, number, number];
  const [ah, mh, dh] = hoje.split('-').map(Number) as [number, number, number];
  return ah - an - (mh < mn || (mh === mn && dh < dn) ? 1 : 0);
}

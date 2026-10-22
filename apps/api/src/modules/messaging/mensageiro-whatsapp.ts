import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ModeloDaPlataforma } from './lembretes-regras';

/**
 * Porta do canal WhatsApp (rodada 18.3, HU-COM-003/004/010/011). Toda integração fica atrás desta
 * interface (docs/04-arquitetura/integracoes.md §1): o domínio nunca fala com a Meta direto.
 *
 * Adaptadores:
 * - `MensageiroFalso` (mensageiro-falso.ts): só development/test (lista fechada), guarda em memória;
 * - `MensageiroCloudApi` (mensageiro-cloud-api.ts): ESQUELETO da WhatsApp Business Cloud API, desligado
 *   por padrão e sem credencial no código (tudo vem do ambiente/Secrets Manager).
 *
 * O que passa por aqui é o MÍNIMO: número do destinatário, nome do modelo aprovado e os parâmetros
 * (clínica com nome neutro, data, hora). Nunca conteúdo clínico, nome de profissional ou especialidade
 * (RIPD-whatsapp §4; o texto é checado antes de chegar à porta, em lembretes-regras.ts).
 */

export interface MensagemDeSaida {
  /** Número do destinatário, só dígitos com DDI (ex.: 5511900000000). */
  readonly para: string;
  /** Identificador do número de negócio da clínica no provedor (phone_number_id; não é segredo). */
  readonly remetente: string;
  /** Modelo aprovado: nome no provedor e parâmetros posicionais ({{1}}, {{2}}...). */
  readonly modelo: { readonly nomeNoProvedor: string; readonly idioma: 'pt_BR'; readonly parametros: readonly string[] };
  /** Texto já renderizado (o que o paciente lê); o adaptador real manda só o modelo + parâmetros. */
  readonly texto: string;
  /** Chave de idempotência do envio (id da linha da fila). */
  readonly idempotencia: string;
}

export type ResultadoDeEnvio =
  | { readonly ok: true; readonly idProvedor: string }
  /** `definitivo`: não adianta tentar de novo (número inválido, modelo recusado). */
  | { readonly ok: false; readonly codigo: string; readonly definitivo: boolean };

export interface MensageiroWhatsApp {
  readonly nome: 'falso' | 'cloud_api';
  enviar(mensagem: MensagemDeSaida): Promise<ResultadoDeEnvio>;
  /** Confere `X-Hub-Signature-256` contra o corpo BRUTO (bytes exatos recebidos). */
  assinaturaValida(corpoBruto: Buffer, cabecalho: string | undefined): boolean;
  /** Aperto de mão da inscrição do webhook (GET hub.*): devolve o desafio ou null (403). */
  desafioDaInscricao(modo: unknown, token: unknown, desafio: unknown): string | null;
  /**
   * Confere, NA SUBIDA, que cada modelo da plataforma existe no provedor com o MESMO texto aprovado
   * (V3 do parecer #69). Diferença, modelo ausente ou não aprovado: lança e a API não sobe.
   */
  conferirModelos(modelos: readonly ModeloDaPlataforma[]): Promise<void>;
}

export class ModeloDivergenteError extends Error {
  constructor(readonly nomeNoProvedor: string, readonly motivo: 'ausente' | 'nao_aprovado' | 'texto_diferente' | 'consulta_falhou') {
    super(`WhatsApp: modelo ${nomeNoProvedor} ${motivo} no provedor; a API não sobe (V3 do parecer #69)`);
    this.name = 'ModeloDivergenteError';
  }
}

/** Cabeçalho de assinatura da Meta: `sha256=<hex do HMAC-SHA256 do corpo com o app secret>`. */
export const CABECALHO_ASSINATURA = 'x-hub-signature-256';

/**
 * HMAC-SHA256 do corpo bruto com o segredo do app, comparado em tempo constante. Sem segredo
 * configurado, nada é válido (falha fechada).
 */
export function assinaturaHmacValida(segredo: Buffer | undefined, corpoBruto: Buffer, cabecalho: string | undefined): boolean {
  if (!segredo || segredo.length < 16 || typeof cabecalho !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(cabecalho.trim());
  if (!m?.[1]) return false;
  const esperado = createHmac('sha256', segredo).update(corpoBruto).digest();
  const recebido = Buffer.from(m[1], 'hex');
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

/** Assinatura no formato da Meta (para o adaptador falso e os testes). */
export function assinarCorpo(segredo: Buffer, corpoBruto: Buffer | string): string {
  return `sha256=${createHmac('sha256', segredo).update(corpoBruto).digest('hex')}`;
}

/** Comparação em tempo constante do token de verificação da inscrição. */
export function tokenConfere(esperado: string | undefined, recebido: unknown): boolean {
  if (!esperado || esperado.length < 16 || typeof recebido !== 'string') return false;
  const a = Buffer.from(esperado);
  const b = Buffer.from(recebido);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function desafioSeConfere(esperado: string | undefined, modo: unknown, token: unknown, desafio: unknown): string | null {
  if (modo !== 'subscribe' || !tokenConfere(esperado, token)) return null;
  if (typeof desafio !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(desafio)) return null;
  return desafio;
}

// ---------------------------------------------------------------------------------------------------
// Eventos do webhook (formato da Cloud API, o mesmo para os dois adaptadores)
// ---------------------------------------------------------------------------------------------------

export type StatusDoProvedor = 'sent' | 'delivered' | 'read' | 'failed';

export interface EventoDeStatus {
  readonly tipo: 'status';
  readonly numeroDaClinica: string;
  readonly idProvedor: string;
  readonly status: StatusDoProvedor;
  readonly instante: Date;
  /** Código do erro do provedor (só o número/código, nunca a mensagem). */
  readonly codigoErro: string | null;
}

export interface EventoDeResposta {
  readonly tipo: 'resposta';
  readonly numeroDaClinica: string;
  /** id da mensagem recebida (idempotência). */
  readonly idProvedor: string;
  /** Número de quem respondeu (só dígitos). */
  readonly de: string;
  /** id da NOSSA mensagem a que ele respondeu (context.id), quando o aplicativo informa. */
  readonly emRespostaA: string | null;
  /** Texto digitado ou do botão; nunca vai para log nem trilha. */
  readonly texto: string;
  readonly instante: Date;
}

export type EventoDoWebhook = EventoDeStatus | EventoDeResposta;

/** Limites do webhook: além disto o corpo inteiro é recusado (413/400), sem processar nada. */
export const MAX_EVENTOS_POR_WEBHOOK = 100;
export const MAX_TEXTO_RECEBIDO = 1000;

export class WebhookInvalidoError extends Error {
  constructor(readonly motivo: 'formato' | 'eventos_demais') {
    super(`webhook inválido: ${motivo}`);
    this.name = 'WebhookInvalidoError';
  }
}

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texto = (v: unknown, max = 128): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const digitos = (v: unknown): string | null => {
  const t = texto(v, 20);
  return t && /^[0-9]{8,15}$/.test(t) ? t : null;
};
const instante = (v: unknown): Date => {
  const n = typeof v === 'string' && /^[0-9]{1,12}$/.test(v) ? Number(v) * 1000 : NaN;
  return Number.isFinite(n) ? new Date(n) : new Date();
};
const STATUS_ACEITOS: readonly StatusDoProvedor[] = ['sent', 'delivered', 'read', 'failed'];

/**
 * Lê o corpo do webhook da Cloud API (`object: whatsapp_business_account`). Item malformado é
 * ignorado; corpo fora do formato ou com eventos demais é recusado inteiro.
 */
export function lerEventosDoWebhook(corpo: unknown): EventoDoWebhook[] {
  if (!ehObj(corpo) || corpo.object !== 'whatsapp_business_account' || !Array.isArray(corpo.entry)) {
    throw new WebhookInvalidoError('formato');
  }
  const eventos: EventoDoWebhook[] = [];
  for (const entrada of lista(corpo.entry)) {
    if (!ehObj(entrada)) continue;
    for (const mudanca of lista(entrada.changes)) {
      if (!ehObj(mudanca) || mudanca.field !== 'messages' || !ehObj(mudanca.value)) continue;
      const valor = mudanca.value;
      const numeroDaClinica = ehObj(valor.metadata) ? texto(valor.metadata.phone_number_id, 64) : null;
      if (!numeroDaClinica) continue;
      for (const s of lista(valor.statuses)) {
        if (!ehObj(s)) continue;
        const idProvedor = texto(s.id, 128);
        const status = STATUS_ACEITOS.find((x) => x === s.status);
        if (!idProvedor || !status) continue;
        const erro = lista(s.errors)[0];
        const codigoErro = ehObj(erro) && (typeof erro.code === 'number' || typeof erro.code === 'string') ? String(erro.code).slice(0, 16) : null;
        eventos.push({ tipo: 'status', numeroDaClinica, idProvedor, status, instante: instante(s.timestamp), codigoErro });
      }
      for (const m of lista(valor.messages)) {
        if (!ehObj(m)) continue;
        const idProvedor = texto(m.id, 128);
        const de = digitos(m.from);
        if (!idProvedor || !de) continue;
        let conteudo: string | null = null;
        if (m.type === 'text' && ehObj(m.text)) conteudo = texto(m.text.body, MAX_TEXTO_RECEBIDO);
        else if (m.type === 'button' && ehObj(m.button)) conteudo = texto(m.button.payload, 64) ?? texto(m.button.text, 64);
        else if (m.type === 'interactive' && ehObj(m.interactive) && ehObj(m.interactive.button_reply)) {
          conteudo = texto(m.interactive.button_reply.id, 64) ?? texto(m.interactive.button_reply.title, 64);
        }
        // Mídia (foto, PDF, áudio) não é aceita neste MVP: vira "outro" sem conteúdo (R16 do RIPD).
        const emRespostaA = ehObj(m.context) ? texto(m.context.id, 128) : null;
        eventos.push({ tipo: 'resposta', numeroDaClinica, idProvedor, de, emRespostaA, texto: conteudo ?? '', instante: instante(m.timestamp) });
      }
      if (eventos.length > MAX_EVENTOS_POR_WEBHOOK) throw new WebhookInvalidoError('eventos_demais');
    }
  }
  return eventos;
}

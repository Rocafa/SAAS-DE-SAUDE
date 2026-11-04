import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { loadRateLimitHashKey } from './rate-limit-store';

/**
 * Log de segurança estruturado (produção: uma linha JSON por evento, para filtro e alarme no CloudWatch).
 *
 * Regras (LGPD arts. 6 III e 46; ver docs/03-seguranca-lgpd/logs-de-seguranca.md):
 * - Só eventos do catálogo `EVENTOS_DE_SEGURANCA` (lista fechada, cada um com severidade e alarme).
 * - Só campos da lista fechada `CampoDeSeguranca`, cada um com formato validado. Valor fora do formato vira
 *   `[invalido]`: nome, CPF, telefone, e-mail, conteúdo clínico ou mensagem de erro NUNCA chegam ao log.
 * - IP nunca em claro: `origem` é um HMAC (mesmo segredo do rate limit), só para correlacionar.
 * - O log de segurança não substitui a trilha de auditoria (audit_log): a trilha é a prova; este log é para
 *   detectar e alarmar em tempo real, inclusive quando a trilha não pôde gravar.
 */
export const EVENTOS_DE_SEGURANCA = {
  SESSAO_INVALIDA: { severidade: 'aviso', alarme: 'volume', descricao: 'requisição sem sessão válida (401)' },
  ACESSO_NEGADO_PERFIL: { severidade: 'aviso', alarme: 'volume', descricao: 'perfil sem permissão para a rota (403)' },
  MFA_RECUSADO: { severidade: 'aviso', alarme: 'volume', descricao: 'rota recusada por falta de MFA ou MFA antigo' },
  MFA_LIMITE_DE_RECUSAS: { severidade: 'alto', alarme: 'imediato', descricao: 'usuário passou do teto de recusas por MFA (429)' },
  RATE_LIMIT_EXCEDIDO: { severidade: 'aviso', alarme: 'volume', descricao: 'origem passou do limite de requisições (429)' },
  RATE_LIMIT_FAIL_OPEN: { severidade: 'alto', alarme: 'imediato', descricao: 'contador indisponível; requisição seguiu sem limite' },
  WEBHOOK_ASSINATURA_INVALIDA: { severidade: 'alto', alarme: 'volume', descricao: 'webhook com assinatura inválida' },
  ALERTA_ANOMALIA: { severidade: 'alto', alarme: 'imediato', descricao: 'regra de vigilância disparou (detalhe na trilha)' },
  TRILHA_NAO_GRAVADA: { severidade: 'critico', alarme: 'imediato', descricao: 'evento que devia ir para a trilha de auditoria não gravou' },
  EXPORTACAO_FALHOU: { severidade: 'alto', alarme: 'imediato', descricao: 'exportação total falhou (motivo genérico)' },
  PORTAL_RESGATE_RECUSADO: { severidade: 'aviso', alarme: 'volume', descricao: 'resgate de convite do portal recusado' },
} as const satisfies Record<string, { severidade: Severidade; alarme: 'imediato' | 'volume'; descricao: string }>;

export type EventoDeSeguranca = keyof typeof EVENTOS_DE_SEGURANCA;
export type Severidade = 'aviso' | 'alto' | 'critico';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODIGO = /^[a-z][a-z0-9_]{0,63}$/;
const ROTA = /^[A-Z]{3,7} \/[A-Za-z0-9/_:.-]{0,120}$/;
const HANDLER = /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9]{0,63}$/;
const HEX = /^[0-9a-f]{16}$/;

/** Campos permitidos e o formato de cada um. Nada além disto entra numa linha do log de segurança. */
const FORMATOS = {
  tenantId: (v: unknown) => typeof v === 'string' && UUID.test(v),
  userId: (v: unknown) => typeof v === 'string' && UUID.test(v),
  /** Método + caminho do TEMPLATE da rota (`GET /pacientes/:id`), nunca a URL com ids ou query. */
  rota: (v: unknown) => typeof v === 'string' && ROTA.test(v),
  handler: (v: unknown) => typeof v === 'string' && HANDLER.test(v),
  motivo: (v: unknown) => typeof v === 'string' && CODIGO.test(v),
  regra: (v: unknown) => typeof v === 'string' && CODIGO.test(v),
  status: (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
  contagem: (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000,
  origem: (v: unknown) => typeof v === 'string' && HEX.test(v),
} as const;

export type CampoDeSeguranca = keyof typeof FORMATOS;
export type CamposDeSeguranca = Partial<Record<CampoDeSeguranca, string | number>>;

export const VALOR_INVALIDO = '[invalido]';

/** Monta a linha (exportada para teste). Campo desconhecido é descartado; valor fora do formato vira `[invalido]`. */
export function linhaDeSeguranca(evento: EventoDeSeguranca, campos: CamposDeSeguranca = {}, agora: Date = new Date()): string {
  const def = EVENTOS_DE_SEGURANCA[evento];
  const saida: Record<string, string | number> = { tipo: 'seguranca', evento, severidade: def.severidade, alarme: def.alarme, em: agora.toISOString() };
  for (const [k, v] of Object.entries(campos)) {
    if (!(k in FORMATOS) || v === undefined) continue;
    saida[k] = FORMATOS[k as CampoDeSeguranca](v) ? v : VALOR_INVALIDO;
  }
  return JSON.stringify(saida);
}

/** Correlaciona a mesma origem sem guardar o IP (HMAC truncado, mesmo segredo do rate limit). */
export function origemDaRequisicao(ip: string | undefined, segredo: Uint8Array = loadRateLimitHashKey()): string {
  return createHmac('sha256', segredo).update(`log:${ip ?? 'desconhecido'}`).digest('hex').slice(0, 16);
}

const logger = new Logger('seguranca');

/** Escreve um evento de segurança. Severidade crítica/alta vai como erro (alarme), aviso como warn. */
export function registrarEventoDeSeguranca(evento: EventoDeSeguranca, campos: CamposDeSeguranca = {}, saida: Pick<Logger, 'warn' | 'error'> = logger): void {
  const linha = linhaDeSeguranca(evento, campos);
  if (EVENTOS_DE_SEGURANCA[evento].severidade === 'aviso') saida.warn(linha);
  else saida.error(linha);
}

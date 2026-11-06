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
  LOGIN_OK: { severidade: 'aviso', alarme: 'volume', descricao: 'login com senha aceito (D4)' },
  LOGIN_SENHA_OK: { severidade: 'aviso', alarme: 'volume', descricao: 'senha aceita; sessão provisória aguardando o código do TOTP (D4)' },
  LOGIN_FALHOU: { severidade: 'aviso', alarme: 'volume', descricao: 'login recusado (sem dizer se a conta existe)' },
  LOGOUT: { severidade: 'aviso', alarme: 'volume', descricao: 'sessão encerrada no servidor (logout, prazo absoluto ou conta inativa)' },
  LOGIN_BLOQUEADO: { severidade: 'alto', alarme: 'imediato', descricao: 'login recusado pelo bloqueio de 5 falhas em 15 min (resposta igual à senha errada)' },
  MFA_CADASTRADO: { severidade: 'aviso', alarme: 'volume', descricao: 'cadastro do TOTP concluído (primeira verificação do código)' },
  MFA_VERIFICADO: { severidade: 'aviso', alarme: 'volume', descricao: 'código do TOTP aceito (login em duas etapas ou reverificação)' },
  MFA_FALHOU: { severidade: 'aviso', alarme: 'volume', descricao: 'código do TOTP ou senha do cadastro recusados' },
  SENHA_TROCADA: { severidade: 'aviso', alarme: 'volume', descricao: 'senha trocada pela própria pessoa; as outras sessões caem (D4 PR 3b-2)' },
  BLOQUEIO_ZERADO: { severidade: 'alto', alarme: 'volume', descricao: 'admin zerou os contadores de bloqueio de uma pessoa da clínica (D4 PR 3b-2)' },
  SENHA_VAZADA_RECUSADA: { severidade: 'aviso', alarme: 'volume', descricao: 'senha nova recusada por aparecer na base de senhas vazadas (k-anonimato)' },
  CONFERENCIA_DE_SENHA_INDISPONIVEL: { severidade: 'alto', alarme: 'volume', descricao: 'base de senhas vazadas fora do ar; a troca seguiu sem a conferência' },
  MFA_BLOQUEADO: { severidade: 'alto', alarme: 'imediato', descricao: 'segundo fator bloqueado por 5 falhas em 15 min' },
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
  PERFIS_NAO_CONFERIDOS: { severidade: 'alto', alarme: 'imediato', descricao: 'leitura de clinic_members falhou; requisição negada' },
  CSRF_RECUSADO: { severidade: 'alto', alarme: 'volume', descricao: 'escrita vinda de origem fora da allowlist (403)' },
  PORTAL_RESGATE_RECUSADO: { severidade: 'aviso', alarme: 'volume', descricao: 'resgate de convite do portal recusado' },
} as const satisfies Record<string, { severidade: Severidade; alarme: 'imediato' | 'volume'; descricao: string }>;

export type EventoDeSeguranca = keyof typeof EVENTOS_DE_SEGURANCA;
export type Severidade = 'aviso' | 'alto' | 'critico';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Método + segmentos fixos (letras minúsculas e hífen, sem dígito nem ponto) ou `:param`. */
const ROTA = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/(?:[a-z][a-z-]{0,40}|:[A-Za-z]{1,30}))*\/?$/;
/** `PacientesController.listar`: só classes de controller (o nome vem do código, não do cliente). */
const HANDLER = /^[A-Z][A-Za-z0-9]{0,60}Controller\.[a-z][A-Za-z0-9]{0,60}$/;
const HEX = /^[0-9a-f]{16}$/;

/**
 * Listas FECHADAS de motivo e regra (R1 do parecer do #129): um formato de código deixava passar `maria_silva`.
 * Valor novo entra aqui, no mesmo PR que o usa; um teste confere que todo literal usado em `src` está na lista.
 */
export const MOTIVOS_DE_SEGURANCA = [
  'mfa_obrigatorio',
  'mfa_recente_obrigatorio',
  'mfa_alerta_de_volume',
  'mfa_recusa',
  'rate_limit_por_ip',
  'vigilancia_de_leitura',
  'portal',
  'whatsapp',
  'exportacao_falhou',
  'janela_de_saida_encerrada',
  'cifra_ausente',
  'erro_interno',
  'alerta_de_anomalia',
  'aviso_pedido_titular',
  'sigilo_desligado',
  'representacao_estendida',
  'titular_menor_revogado',
  'perfil_revogado',
  'origem_nao_permitida',
  'aviso_de_anomalia',
  'erro_na_autenticacao',
  'logout',
  'logout_global',
  'prazo_absoluto',
  'conta_inativa',
  'senha_errada',
  'bloqueio_de_login',
  'bloqueio_do_fator',
  'codigo_errado',
  'codigo_reutilizado',
  'cadastro_do_fator',
  'login_em_duas_etapas',
  'reverificacao',
  'aguardando_fator',
  'login_em_duas_etapas_sem_clinica',
  'senha_vazada',
  'pela_pessoa',
  'desbloqueio_pelo_admin',
  'recuperacao_pelo_admin',
  'conferencia_indisponivel',
] as const;
export const REGRAS_DE_SEGURANCA = [
  'paginas_de_pacientes',
  'fichas_distintas',
  'limite_por_usuario',
  'portal_limite_por_conta',
  'portal_teto_diario_pedidos',
  'portal_resgate',
  'portal_sigilo_transicao',
  'vinculo_autoagendado',
  'mfa_recusas_por_usuario',
  'vinculo_cruzado',
  'login_por_email',
  'login_por_origem',
  'fator_por_pessoa',
  'fator_por_origem',
] as const;
const MOTIVOS: ReadonlySet<string> = new Set(MOTIVOS_DE_SEGURANCA);
const REGRAS: ReadonlySet<string> = new Set(REGRAS_DE_SEGURANCA);

/** Campos permitidos e o formato de cada um. Nada além disto entra numa linha do log de segurança. */
const FORMATOS = {
  tenantId: (v: unknown) => typeof v === 'string' && UUID.test(v),
  userId: (v: unknown) => typeof v === 'string' && UUID.test(v),
  /** Método + caminho do TEMPLATE da rota (`GET /pacientes/:id`), nunca a URL com ids ou query. */
  rota: (v: unknown) => typeof v === 'string' && ROTA.test(v),
  handler: (v: unknown) => typeof v === 'string' && HANDLER.test(v),
  motivo: (v: unknown) => typeof v === 'string' && MOTIVOS.has(v),
  regra: (v: unknown) => typeof v === 'string' && REGRAS.has(v),
  status: (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
  contagem: (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000,
  origem: (v: unknown) => typeof v === 'string' && HEX.test(v),
} as const;

export type CampoDeSeguranca = keyof typeof FORMATOS;
export type CamposDeSeguranca = Partial<Record<CampoDeSeguranca, string | number | undefined>>;

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

let segredoDaOrigem: Uint8Array | null | undefined;

/**
 * Correlaciona a mesma origem sem guardar o IP (HMAC truncado, mesmo segredo do rate limit). O segredo é lido uma
 * vez. Sem ele (produção mal configurada), devolve `undefined` e o campo some da linha: o log nunca derruba a
 * requisição (R9 do parecer do #129). A falta do segredo já impede o boot do rate limit em produção.
 */
export function origemDaRequisicao(ip: string | undefined, segredo?: Uint8Array): string | undefined {
  if (!segredo) {
    if (segredoDaOrigem === undefined) {
      try {
        segredoDaOrigem = loadRateLimitHashKey();
      } catch {
        segredoDaOrigem = null;
      }
    }
    if (!segredoDaOrigem) return undefined;
  }
  return createHmac('sha256', segredo ?? (segredoDaOrigem as Uint8Array)).update(`log:${ip ?? 'desconhecido'}`).digest('hex').slice(0, 16);
}

const logger = new Logger('seguranca');

/** Últimas emissões por chave, para `registrarNoMaximoUmaVez`. Limitado: acima do teto, começa de novo. */
const ultimas = new Map<string, number>();
const TETO_DE_CHAVES = 10_000;

/** Só para teste: zera as janelas de `registrarNoMaximoUmaVez` (o estado é do processo). */
export function zerarJanelasDoLog(): void {
  ultimas.clear();
}

/**
 * Como `registrarEventoDeSeguranca`, mas no máximo uma linha por `chave` a cada `intervaloMs` (R3 e R6 do parecer
 * do #129). Para eventos que se repetem a cada requisição (contador fora do ar, recusa de MFA insistente). A chave
 * fica só em memória, nunca no log.
 */
export function registrarNoMaximoUmaVez(
  chave: string,
  intervaloMs: number,
  evento: EventoDeSeguranca,
  campos: CamposDeSeguranca = {},
  saida: Pick<Logger, 'warn' | 'error'> = logger,
  agora: number = Date.now(),
): boolean {
  const ultima = ultimas.get(chave);
  if (ultima !== undefined && agora - ultima < intervaloMs) return false;
  if (ultimas.size >= TETO_DE_CHAVES) ultimas.clear();
  ultimas.set(chave, agora);
  registrarEventoDeSeguranca(evento, campos, saida);
  return true;
}

/** Escreve um evento de segurança. Severidade crítica/alta vai como erro (alarme), aviso como warn. */
export function registrarEventoDeSeguranca(evento: EventoDeSeguranca, campos: CamposDeSeguranca = {}, saida: Pick<Logger, 'warn' | 'error'> = logger): void {
  const linha = linhaDeSeguranca(evento, campos);
  if (EVENTOS_DE_SEGURANCA[evento].severidade === 'aviso') saida.warn(linha);
  else saida.error(linha);
}

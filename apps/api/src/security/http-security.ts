import { Logger, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadHttpSecurityConfig, type HttpSecurityConfig } from './http-security.config';
import {
  chaveDeHmac,
  MemoryRateLimitStore,
  rateLimitKey,
  registerRateLimitStore,
  type RateLimitStore,
} from './rate-limit-store';
import { origemDaRequisicao, registrarEventoDeSeguranca, registrarNoMaximoUmaVez } from './log-de-seguranca';

type Next = (err?: unknown) => void;
type Req = IncomingMessage & { ip?: string };

const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Endurecimento da borda HTTP. Chamar UMA vez, logo após `NestFactory.create`, antes de
 * `listen`/`init` (os body-parsers precisam ser registrados antes dos padrões do Nest).
 *
 * - helmet: CSP `default-src 'none'; frame-ancestors 'none'`, nosniff, HSTS, sem X-Powered-By.
 * - CORS por allowlist exata (nunca `*`); origem desconhecida não recebe Access-Control-Allow-*.
 * - Limite de corpo (413) e rate limit global por IP (429).
 * - Erros da camada express (corpo grande, JSON malformado) sem stack trace nem detalhe interno.
 *
 * O rate limit usa o `store` recebido: em produção, Redis compartilhado entre as instâncias com
 * fallback em memória (createRateLimitStore); por padrão, só memória (local e testes).
 */
export function applyHttpSecurity(
  app: INestApplication,
  config: HttpSecurityConfig = loadHttpSecurityConfig(),
  store: RateLimitStore = new MemoryRateLimitStore(),
  hashKey: Uint8Array = chaveDeHmac('rate-limit'),
  /** D4: handler do Better Auth, depois das travas da borda e ANTES do parser JSON (a biblioteca lê o corpo cru). */
  montagemDaAutenticacao?: (req: Req, res: ServerResponse, next: Next) => void,
): void {
  const expressApp = app as NestExpressApplication;
  expressApp.disable('x-powered-by');
  if (config.trustProxyHops > 0) expressApp.set('trust proxy', config.trustProxyHops);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      xFrameOptions: { action: 'deny' },
    }),
  );
  app.use(noStore);

  const allowed = new Set(config.corsAllowedOrigins);
  if (allowed.has('*')) throw new Error('CORS com curinga é proibido');
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
      cb(null, origin !== undefined && allowed.has(origin)),
    methods: CORS_METHODS,
    credentials: true,
    maxAge: 600,
  });

  registerRateLimitStore(store);
  app.use(rateLimiter(config.rateLimitMax, config.rateLimitWindowMs, store, RATE_LIMIT_EXEMPT_PATHS, hashKey));

  // E6: antes dos parsers. Só o parser JSON: a API é só JSON (o CSV do importador lê o corpo cru). A app precisa ser
  // criada com `bodyParser: false` (main.ts), senão o Nest registra urlencoded de novo no init (R2 do parecer do #132).
  app.use(protecaoCsrf(allowed));
  if (montagemDaAutenticacao) app.use(montagemDaAutenticacao);
  expressApp.useBodyParser('json', { limit: config.bodyLimit });
  app.use(safeErrorHandler);
}

/** Respostas da API carregam dado de saúde: nunca em cache compartilhado/navegador. */
function noStore(_req: Req, res: ServerResponse, next: Next): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, message }));
}

/**
 * Sondas de saúde ficam FORA do rate limit: o balanceador/orquestrador as consulta sem parar a
 * partir de poucos IPs, e um 429 ali tiraria instâncias saudáveis de serviço. Elas não tocam dado
 * de clínica; a readiness tem cache curto e agrupa chamadas simultâneas (readiness-probe.ts),
 * então rajadas não chegam ao banco.
 */
export const RATE_LIMIT_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/health', '/health/ready']);

let failOpenCount = 0;
const rateLimitLogger = new Logger('rate-limit');

/** Quantas requisições passaram sem contagem porque o store falhou (métrica; ver R4 do Guardião). */
export function rateLimitFailOpenCount(): number {
  return failOpenCount;
}

/**
 * Janela fixa por IP. A chave é derivada AQUI, uma vez (HMAC do IP com segredo): nenhum store
 * recebe o IP em claro. A contagem vem do `store` (Redis ou memória). Se o store falhar mesmo assim
 * (o FallbackRateLimitStore já cobre o Redis fora), a requisição segue — um erro no contador não pode
 * derrubar a API inteira —, mas nunca em silêncio: log de erro com marcador fixo
 * (RATE_LIMIT_FAIL_OPEN, para filtro de métrica e alarme) e contador.
 */
export function rateLimiter(
  max: number,
  windowMs: number,
  store: RateLimitStore = new MemoryRateLimitStore(),
  exemptPaths: ReadonlySet<string> = RATE_LIMIT_EXEMPT_PATHS,
  hashKey: Uint8Array = chaveDeHmac('rate-limit'),
) {
  return (req: Req, res: ServerResponse, next: Next): void => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (exemptPaths.has(path)) {
      next();
      return;
    }
    // R6 do parecer do desenho do B9: o IP tem prefixo próprio, como as vigilâncias (`usr`, `portal`).
    const key = rateLimitKey(`ip\u001f${req.ip ?? req.socket.remoteAddress ?? 'desconhecido'}`, hashKey);
    store.hit(key, windowMs).then(
      ({ count, resetMs }) => {
        const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
        res.setHeader('RateLimit-Reset', String(resetSeconds));
        if (count > max) {
          res.setHeader('Retry-After', String(resetSeconds));
          // Só no primeiro estouro da janela (evita inundar o log com um robô insistente).
          if (count === max + 1) registrarEventoDeSeguranca('RATE_LIMIT_EXCEDIDO', { origem: origemDaRequisicao(req.ip ?? req.socket.remoteAddress), contagem: count });
          sendJson(res, 429, 'Too Many Requests');
          return;
        }
        next();
      },
      (err: unknown) => {
        failOpenCount++;
        const name = err instanceof Error ? err.name : typeof err;
        rateLimitLogger.error(`RATE_LIMIT_FAIL_OPEN: contador indisponível (${name}); requisição seguiu sem limite`);
        registrarNoMaximoUmaVez('fail_open:rate_limit_por_ip', 60_000, 'RATE_LIMIT_FAIL_OPEN', { motivo: 'rate_limit_por_ip' });
        next();
      },
    );
  };
}

const SAFE_MESSAGES: Record<number, string> = {
  400: 'Bad Request',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
};

/**
 * Handler de erro do express (4 argumentos) para falhas dos body-parsers. Sem ele, a resposta
 * ecoa a mensagem interna do parser (ex.: "Expected double-quoted property name in JSON at
 * position 13") — detalhe de implementação que não deve sair da API.
 */
function safeErrorHandler(err: unknown, _req: Req, res: ServerResponse, next: Next): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const raw = (err as { status?: unknown; statusCode?: unknown } | null) ?? {};
  const status = Number(raw.status ?? raw.statusCode);
  const safe = Number.isInteger(status) && SAFE_MESSAGES[status] ? status : 500;
  sendJson(res, safe, SAFE_MESSAGES[safe] ?? 'Internal Server Error');
}

const METODOS_DE_ESCRITA: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Corpos não-JSON aceitos, por rota exata (método + caminho sem query). Hoje só o envio do CSV do importador, que lê
 * o corpo cru com teto e confere o próprio Content-Type (importacao.validation.ts).
 */
export const CORPOS_NAO_JSON: ReadonlyMap<string, string> = new Map([['POST /importacoes', 'text/csv']]);

/**
 * E6 da revisão interna de 04/11 (CSRF, ASVS 4.2.2 e 13.2.3). Em método de escrita:
 * - `Origin` fora da allowlist, ou `Sec-Fetch-Site: cross-site` sem origem permitida: 403 (navegador de outro site
 *   não escreve, nem com cookie). Sem `Origin` (cliente servidor-a-servidor, webhook): segue; a sessão é Bearer/
 *   cookie `__Host-` e o CORS já barra a leitura da resposta.
 * - Corpo que não é `application/json` (fora de `CORPOS_NAO_JSON`): 415. Formulário HTML não chega aos controllers.
 */
export function protecaoCsrf(allowedOrigins: ReadonlySet<string>) {
  return (req: Req, res: ServerResponse, next: Next): void => {
    const metodo = (req.method ?? 'GET').toUpperCase();
    if (!METODOS_DE_ESCRITA.has(metodo)) {
      next();
      return;
    }
    const origem = req.headers.origin;
    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    const origemPermitida = typeof origem === 'string' && allowedOrigins.has(origem);
    if ((typeof origem === 'string' && !origemPermitida) || (site === 'cross-site' && !origemPermitida)) {
      registrarNoMaximoUmaVez(`csrf:${origemDaRequisicao(req.ip ?? req.socket.remoteAddress) ?? 'sem'}`, 60_000, 'CSRF_RECUSADO', {
        origem: origemDaRequisicao(req.ip ?? req.socket.remoteAddress),
        motivo: 'origem_nao_permitida',
      });
      sendJson(res, 403, 'Forbidden');
      return;
    }
    const temCorpo = Number(req.headers['content-length'] ?? '0') > 0 || req.headers['transfer-encoding'] !== undefined;
    if (temCorpo) {
      const tipo = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const caminho = (req.url ?? '').split('?')[0] ?? '';
      const aceitoAqui = CORPOS_NAO_JSON.get(`${metodo} ${caminho}`);
      if (tipo !== 'application/json' && tipo !== aceitoAqui) {
        sendJson(res, 415, 'Unsupported Media Type');
        return;
      }
    }
    next();
  };
}

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadHttpSecurityConfig, type HttpSecurityConfig } from './http-security.config';
import { MemoryRateLimitStore, type RateLimitStore } from './rate-limit-store';

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

  app.use(rateLimiter(config.rateLimitMax, config.rateLimitWindowMs, store));

  expressApp.useBodyParser('json', { limit: config.bodyLimit });
  expressApp.useBodyParser('urlencoded', { limit: config.bodyLimit, extended: false });
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

/**
 * Janela fixa por IP. A contagem vem do `store` (Redis ou memória). Se o store falhar mesmo assim
 * (o FallbackRateLimitStore já cobre o Redis fora), a requisição segue: um erro no contador não
 * pode derrubar a API inteira.
 */
export function rateLimiter(
  max: number,
  windowMs: number,
  store: RateLimitStore = new MemoryRateLimitStore(),
  exemptPaths: ReadonlySet<string> = RATE_LIMIT_EXEMPT_PATHS,
) {
  return (req: Req, res: ServerResponse, next: Next): void => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (exemptPaths.has(path)) {
      next();
      return;
    }
    const key = req.ip ?? req.socket.remoteAddress ?? 'desconhecido';
    store.hit(key, windowMs).then(
      ({ count, resetMs }) => {
        const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
        res.setHeader('RateLimit-Reset', String(resetSeconds));
        if (count > max) {
          res.setHeader('Retry-After', String(resetSeconds));
          sendJson(res, 429, 'Too Many Requests');
          return;
        }
        next();
      },
      () => next(),
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

/**
 * Configuração da borda HTTP (headers, CORS, limites). Vem do ambiente; nada de segredo aqui.
 * Ver docs/04-arquitetura/testes-de-seguranca.md.
 */
export interface HttpSecurityConfig {
  /** Origens permitidas no CORS (allowlist exata). Vazia = nenhuma origem cruzada. Nunca `*`. */
  readonly corsAllowedOrigins: readonly string[];
  /** Tamanho máximo do corpo (formato do body-parser, ex.: `100kb`). */
  readonly bodyLimit: string;
  /** Máximo de requisições por IP na janela. */
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  /** Saltos de proxy confiáveis (ALB = 1) para o IP real em X-Forwarded-For. 0 = não confiar. */
  readonly trustProxyHops: number;
}

export const HTTP_SECURITY_DEFAULTS: HttpSecurityConfig = {
  corsAllowedOrigins: [],
  bodyLimit: '100kb',
  rateLimitMax: 300,
  rateLimitWindowMs: 60_000,
  trustProxyHops: 0,
};

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Valida uma origem da allowlist: esquema+host(+porta), sem curinga, sem caminho; http só local. */
export function parseOrigin(raw: string): string {
  const origin = raw.trim().toLowerCase();
  if (origin === '*' || origin === 'null' || origin.includes('*')) {
    throw new Error(`CORS_ALLOWED_ORIGINS: curinga/null não é permitido (${raw})`);
  }
  if (!ORIGIN_RE.test(origin)) {
    throw new Error(`CORS_ALLOWED_ORIGINS: origem inválida (${raw}); use esquema://host[:porta]`);
  }
  const url = new URL(origin);
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`CORS_ALLOWED_ORIGINS: http só é aceito para localhost (${raw})`);
  }
  return origin;
}

function positiveInt(value: string | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} inválida: inteiro >= ${min}`);
  return n;
}

export function loadHttpSecurityConfig(env: NodeJS.ProcessEnv = process.env): HttpSecurityConfig {
  const origins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseOrigin);
  const bodyLimit = env.HTTP_BODY_LIMIT?.trim() || HTTP_SECURITY_DEFAULTS.bodyLimit;
  if (!/^\d+(?:b|kb|mb)$/i.test(bodyLimit)) throw new Error('HTTP_BODY_LIMIT inválida (ex.: 100kb)');
  return {
    corsAllowedOrigins: origins,
    bodyLimit,
    rateLimitMax: positiveInt(env.RATE_LIMIT_MAX, HTTP_SECURITY_DEFAULTS.rateLimitMax, 'RATE_LIMIT_MAX'),
    rateLimitWindowMs: positiveInt(
      env.RATE_LIMIT_WINDOW_MS,
      HTTP_SECURITY_DEFAULTS.rateLimitWindowMs,
      'RATE_LIMIT_WINDOW_MS',
      1_000,
    ),
    trustProxyHops: positiveInt(env.HTTP_TRUST_PROXY_HOPS, 0, 'HTTP_TRUST_PROXY_HOPS', 0),
  };
}

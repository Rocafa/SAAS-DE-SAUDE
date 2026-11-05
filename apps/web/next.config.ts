import type { NextConfig } from 'next';

/**
 * Headers de segurança do front (ver docs/04-arquitetura/testes-de-seguranca.md).
 *
 * CSP: tudo da própria origem; nada de objetos, frames, base/form externos. `connect-src` só
 * libera a API configurada em NEXT_PUBLIC_API_ORIGIN. `script-src 'unsafe-inline'` é exigido
 * pelos scripts inline de hidratação do App Router enquanto não houver CSP com nonce (proxy.ts);
 * `'unsafe-eval'` só em desenvolvimento (React Refresh).
 */
export function contentSecurityPolicy(env: NodeJS.ProcessEnv = process.env): string {
  return montarCsp(env);
}

/**
 * Origem da API para o `connect-src`; o adaptador HTTP (`lib/api/selecionar.ts`) valida igual.
 * Só esquema://host[:porta], sem caminho nem curinga. Com `NEXT_PUBLIC_API_MODO=http` a origem é
 * obrigatória; em produção, só https. É a ÚNICA origem externa que o navegador pode chamar.
 */
export function origemDaApi(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const modo = env.NEXT_PUBLIC_API_MODO?.trim() || 'fake';
  if (modo !== 'fake' && modo !== 'http') throw new Error('NEXT_PUBLIC_API_MODO inválido: use fake ou http');
  const apiOrigin = env.NEXT_PUBLIC_API_ORIGIN?.trim();
  if (!apiOrigin) {
    if (modo === 'http') throw new Error('NEXT_PUBLIC_API_ORIGIN é obrigatória com NEXT_PUBLIC_API_MODO=http');
    return undefined;
  }
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(apiOrigin)) {
    throw new Error('NEXT_PUBLIC_API_ORIGIN inválida: use esquema://host[:porta], sem curinga');
  }
  if (env.NODE_ENV === 'production' && !apiOrigin.toLowerCase().startsWith('https://')) {
    throw new Error('NEXT_PUBLIC_API_ORIGIN inválida: em produção só https');
  }
  return apiOrigin.toLowerCase();
}

function montarCsp(env: NodeJS.ProcessEnv = process.env): string {
  const dev = env.NODE_ENV === 'development';
  const apiOrigin = origemDaApi(env);
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(apiOrigin ? [apiOrigin] : []), ...(dev ? ['ws:'] : [])],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`);
  if (!dev) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

export function securityHeaders(env: NodeJS.ProcessEnv = process.env): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value:
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), ' +
        'magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()',
    },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  ];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
};

export default nextConfig;

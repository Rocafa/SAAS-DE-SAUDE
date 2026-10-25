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
  const dev = env.NODE_ENV === 'development';
  const apiOrigin = env.NEXT_PUBLIC_API_ORIGIN?.trim();
  if (apiOrigin && !/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(apiOrigin)) {
    throw new Error('NEXT_PUBLIC_API_ORIGIN inválida: use esquema://host[:porta], sem curinga');
  }
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

/**
 * Portal do paciente em modo http só em desenvolvimento até a D4 (`lib/api/portal-selecionar.ts` recusa
 * igual). Em build de produção, nem o modo http nem a sessão fictícia (`ptl_…`) podem ir para o bundle.
 */
export function conferirConfigPortal(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if ((env.NEXT_PUBLIC_PORTAL_MODO?.trim() || 'fake') !== 'fake') {
    throw new Error('NEXT_PUBLIC_PORTAL_MODO=http só em desenvolvimento até a D4 (login real do portal)');
  }
  if (env.NEXT_PUBLIC_PORTAL_SESSAO_DEV?.trim()) {
    throw new Error('NEXT_PUBLIC_PORTAL_SESSAO_DEV é só de desenvolvimento: não pode entrar em build de produção');
  }
}

conferirConfigPortal();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders() },
      // Convite do portal: o token vem no #fragmento; nenhum Referer sai desta página (P4).
      { source: '/portal/convite', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
};

export default nextConfig;

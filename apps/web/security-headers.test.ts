import { describe, expect, it } from 'vitest';
import nextConfig, { conferirConfigClinica, conferirConfigPortal, contentSecurityPolicy, securityHeaders } from './next.config';

function directive(csp: string, name: string): string[] {
  const found = csp.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name);
  return found ? found.slice(1) : [];
}

describe('headers de segurança do web', () => {
  it('aplicados a todas as rotas, sem X-Powered-By', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(2);
    expect(rules[0]?.source).toBe('/:path*');
    const keys = rules[0]!.headers.map((h) => h.key);
    for (const k of [
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Strict-Transport-Security',
    ]) {
      expect(keys).toContain(k);
    }
  });

  it('CSP de produção é restritiva: frame-ancestors none, sem curinga, sem eval, sem objetos', () => {
    const csp = contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_ORIGIN: 'https://api.exemplo.test' });
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'frame-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'https://api.exemplo.test']);
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-eval'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)|https:\s|http:\s/);
  });

  it("'unsafe-eval' e ws: só em desenvolvimento", () => {
    const csp = contentSecurityPolicy({ NODE_ENV: 'development' });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toContain('ws:');
  });

  it('origem da API inválida/curinga é recusada', () => {
    for (const v of ['*', 'https://*.exemplo.test', 'javascript:alert(1)', "https://api.test 'unsafe-inline'"]) {
      expect(() => contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_ORIGIN: v })).toThrow(
        /NEXT_PUBLIC_API_ORIGIN/,
      );
    }
  });

  it('modo http: connect-src libera só a origem da API configurada (obrigatória; https em produção)', () => {
    const csp = contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_MODO: 'http', NEXT_PUBLIC_API_ORIGIN: 'https://API.exemplo.test' });
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'https://api.exemplo.test']);
    expect(() => contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_MODO: 'http' })).toThrow(/obrigatória/);
    expect(() =>
      contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_MODO: 'http', NEXT_PUBLIC_API_ORIGIN: 'http://api.exemplo.test' }),
    ).toThrow(/https/);
    expect(() => contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_MODO: 'outro' })).toThrow(/MODO/);
    // Modo fake (padrão) sem origem: nenhuma origem externa no connect-src.
    expect(directive(contentSecurityPolicy({ NODE_ENV: 'production' }), 'connect-src')).toEqual(["'self'"]);
  });

  it('convite do portal sem Referer (o token vem no #fragmento; P4)', async () => {
    const rules = await nextConfig.headers!();
    const convite = rules.find((r) => r.source === '/portal/convite');
    expect(convite?.headers).toEqual([{ key: 'Referrer-Policy', value: 'no-referrer' }]);
    // Vem depois da regra geral: no Next, a última que casa vence.
    expect(rules.indexOf(convite!)).toBeGreaterThan(0);
  });

  it('portal em modo http e sessão fictícia recusados em build de produção (até a D4)', () => {
    expect(() => conferirConfigPortal({ NODE_ENV: 'production', NEXT_PUBLIC_PORTAL_MODO: 'http' })).toThrow(/D4/);
    expect(() => conferirConfigPortal({ NODE_ENV: 'production', NEXT_PUBLIC_PORTAL_SESSAO_DEV: 'ptl_x' })).toThrow(/desenvolvimento/);
    expect(() => conferirConfigPortal({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => conferirConfigPortal({ NODE_ENV: 'development', NEXT_PUBLIC_PORTAL_MODO: 'http' })).not.toThrow();
  });

  it('clínica em modo http recusada em build de produção enquanto a D4 não existe', () => {
    expect(() => conferirConfigClinica({ NODE_ENV: 'production', NEXT_PUBLIC_API_MODO: 'http' })).toThrow(/D4/);
    expect(() => conferirConfigClinica({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => conferirConfigClinica({ NODE_ENV: 'production', NEXT_PUBLIC_API_MODO: 'fake' })).not.toThrow();
    expect(() => conferirConfigClinica({ NODE_ENV: 'development', NEXT_PUBLIC_API_MODO: 'http' })).not.toThrow();
  });

  it('referrer-policy e permissions-policy restritivas', () => {
    const h = Object.fromEntries(securityHeaders({ NODE_ENV: 'production' }).map((x) => [x.key, x.value]));
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['X-Frame-Options']).toBe('DENY');
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(h['Permissions-Policy']).toContain(`${feature}=()`);
    }
  });
});

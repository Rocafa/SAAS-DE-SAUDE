/**
 * Escolha do adaptador do PORTAL por variável de ambiente (lida no build do Next), no mesmo padrão do
 * adaptador da clínica (PR #60), mas separado dele (R-47a):
 * - `NEXT_PUBLIC_PORTAL_MODO=fake` (padrão): demonstração em memória, como antes.
 * - `NEXT_PUBLIC_PORTAL_MODO=http`: o portal na API real (`NEXT_PUBLIC_API_ORIGIN`, a origem já liberada no
 *   `connect-src` da CSP). Enquanto não houver D4 (login real do portal), SÓ em desenvolvimento e com a
 *   sessão fictícia do backend em `NEXT_PUBLIC_PORTAL_SESSAO_DEV` (`ptl_…`, criada por script contra a API
 *   local; nunca vai para o git). Em build de produção o modo http é RECUSADO (falha fechada).
 */
import type { ClientePortal } from './portal';
import { criarApiPortalFake, type OpcoesPortalFake } from './portal-fake';
import { criarApiPortalHttp, type OpcoesPortalHttp } from './portal-http';

export type ModoPortal = 'fake' | 'http';

export type ConfigPortal = { modo: 'fake' } | { modo: 'http'; origem: string; tokenDev: string };

interface EnvPortal {
  NEXT_PUBLIC_PORTAL_MODO?: string | undefined;
  NEXT_PUBLIC_API_ORIGIN?: string | undefined;
  NEXT_PUBLIC_PORTAL_SESSAO_DEV?: string | undefined;
  NODE_ENV?: string | undefined;
}

export function lerConfigPortal(
  env: EnvPortal = {
    // Acesso literal: o Next só embute NEXT_PUBLIC_* escritos assim.
    NEXT_PUBLIC_PORTAL_MODO: process.env.NEXT_PUBLIC_PORTAL_MODO,
    NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
    NEXT_PUBLIC_PORTAL_SESSAO_DEV: process.env.NEXT_PUBLIC_PORTAL_SESSAO_DEV,
    NODE_ENV: process.env.NODE_ENV,
  },
): ConfigPortal {
  const modo = env.NEXT_PUBLIC_PORTAL_MODO?.trim() || 'fake';
  if (modo !== 'fake' && modo !== 'http') throw new Error('NEXT_PUBLIC_PORTAL_MODO inválido: use fake ou http');
  if (modo === 'fake') return { modo };
  if (env.NODE_ENV !== 'development') {
    throw new Error('Portal em modo http só em desenvolvimento até a D4 (login real do portal). Use NEXT_PUBLIC_PORTAL_MODO=fake.');
  }
  const origem = env.NEXT_PUBLIC_API_ORIGIN?.trim().toLowerCase();
  if (!origem || !/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(origem)) {
    throw new Error('NEXT_PUBLIC_API_ORIGIN obrigatória e válida com NEXT_PUBLIC_PORTAL_MODO=http');
  }
  const tokenDev = env.NEXT_PUBLIC_PORTAL_SESSAO_DEV?.trim() ?? '';
  if (!/^ptl_[A-Za-z0-9_-]{43}$/.test(tokenDev)) {
    throw new Error('NEXT_PUBLIC_PORTAL_SESSAO_DEV obrigatória com NEXT_PUBLIC_PORTAL_MODO=http (sessão fictícia ptl_… da API local)');
  }
  return { modo, origem, tokenDev };
}

export function criarClientePortal(
  config: ConfigPortal,
  opcoes: { fake?: OpcoesPortalFake; http?: Omit<OpcoesPortalHttp, 'baseUrl' | 'sessao'> } = {},
): ClientePortal {
  if (config.modo === 'fake') return criarApiPortalFake(opcoes.fake ?? {});
  return criarApiPortalHttp({ ...opcoes.http, baseUrl: config.origem, sessao: { tipo: 'dev', token: config.tokenDev } });
}

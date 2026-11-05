import type { AuthProvider } from './auth-context';
import { DevSessionProvider } from './dev-session.provider';

/** Únicos ambientes em que a sessão fictícia pode existir (lista fechada: falha fechada). */
export const AMBIENTES_SESSAO_FICTICIA: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * Tipos de provedor aceitos em `AUTH_PROVIDER`. Todo tipo novo precisa de bancada no teste de contrato
 * (`contrato-provedor.test.ts`, R6 do parecer do #123): o registro de bancadas é tipado por esta lista.
 */
export const TIPOS_DE_PROVEDOR = ['dev'] as const;
export type TipoDeProvedor = (typeof TIPOS_DE_PROVEDOR)[number];

/**
 * Escolhe o provedor de autenticação no boot. Hoje só existe o de dev (sessão fictícia), que só
 * sobe com NODE_ENV explicitamente `development` ou `test`. Produção, staging, NODE_ENV vazio ou
 * qualquer outro valor: sem provedor real (D4 pendente), a API NÃO SOBE — melhor fora do ar do que
 * aberta. `AUTH_PROVIDER` (opcional) só aceita `dev` por enquanto; o adaptador real entra depois da D4.
 */
export function createAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  if (!AMBIENTES_SESSAO_FICTICIA.has(env.NODE_ENV ?? '')) {
    throw new Error(
      `Nenhum provedor de autenticação real configurado: a sessão fictícia só existe em development/test, nunca em produção ou staging (NODE_ENV=${env.NODE_ENV ?? 'vazio'}; D4)`,
    );
  }
  const tipo = env.AUTH_PROVIDER ?? 'dev';
  if (!(TIPOS_DE_PROVEDOR as readonly string[]).includes(tipo)) throw new Error('AUTH_PROVIDER desconhecido');
  return new DevSessionProvider(env.NODE_ENV);
}

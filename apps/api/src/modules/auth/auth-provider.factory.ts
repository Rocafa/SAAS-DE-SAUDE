import type { AuthProvider } from './auth-context';
import { DevSessionProvider } from './dev-session.provider';

/**
 * Escolhe o provedor de autenticação no boot. Hoje só existe o de dev (sessão fictícia). Em
 * produção, sem provedor real (D4 pendente), a API NÃO SOBE: melhor fora do ar do que aberta.
 * `AUTH_PROVIDER` (opcional) só aceita `dev` por enquanto; o adaptador real entra depois da D4.
 */
export function createAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  if (env.NODE_ENV === 'production') {
    throw new Error('Nenhum provedor de autenticação real configurado: a sessão fictícia é proibida em produção (D4)');
  }
  const tipo = env.AUTH_PROVIDER ?? 'dev';
  if (tipo !== 'dev') throw new Error('AUTH_PROVIDER desconhecido');
  return new DevSessionProvider(env.NODE_ENV);
}

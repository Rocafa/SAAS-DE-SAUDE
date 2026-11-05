/**
 * Boot do Better Auth (D4): só quando `AUTH_PROVIDER=better-auth`. Lê a configuração obrigatória (sem valor padrão,
 * R2 do parecer do desenho), abre o pool do papel `app_auth` (R1) e um pool pequeno do `app_user` para os perfis,
 * e devolve o provedor e a montagem HTTP. A fábrica (`createAuthProvider`) continua decidindo em quais ambientes o
 * tipo pode subir (só dev/test até o PR 3).
 */
import { createDatabase } from '../../../db/tenant-transaction';
import { loadRateLimitHashKey } from '../../../security/rate-limit-store';
import { criarAutenticacao } from './instancia';
import { montarAutenticacao } from './montagem';
import { BetterAuthProvider } from './provedor';

function obrigatoria(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new Error(`${nome} é obrigatória com AUTH_PROVIDER=better-auth`);
  return v;
}

export function bootDoBetterAuth(env: NodeJS.ProcessEnv, origensConfiaveis: readonly string[]) {
  const dbAuth = createDatabase(obrigatoria(env, 'DATABASE_AUTH_URL'), { max: 5 });
  const dbClinica = createDatabase(obrigatoria(env, 'DATABASE_URL'), { max: 5 });
  const producao = env.NODE_ENV === 'production';
  const auth = criarAutenticacao({
    db: dbAuth.db,
    segredo: obrigatoria(env, 'BETTER_AUTH_SECRET'),
    baseURL: obrigatoria(env, 'API_BASE_URL'),
    origensConfiaveis,
    producao,
    chaveHmac: loadRateLimitHashKey(env),
  });
  const provider = new BetterAuthProvider({ auth, dbAuth: dbAuth.db, dbClinica: dbClinica.db });
  return {
    provider,
    montagem: montarAutenticacao(auth, provider),
    async fechar(): Promise<void> {
      await Promise.all([dbAuth.close(), dbClinica.close()]);
    },
  };
}

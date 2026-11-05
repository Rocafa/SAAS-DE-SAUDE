/**
 * Boot do Better Auth (D4): só quando `AUTH_PROVIDER=better-auth`. Lê a configuração obrigatória (sem valor padrão,
 * R2 do parecer do desenho), abre o pool do papel `app_auth` (R1) e um pool pequeno do `app_user` para os perfis,
 * e devolve o provedor e a montagem HTTP. A fábrica (`createAuthProvider`) continua decidindo em quais ambientes o
 * tipo pode subir (só dev/test até o PR 3).
 */
import { createDatabase } from '../../../db/tenant-transaction';
import { AMBIENTES_SESSAO_FICTICIA } from '../auth-provider.factory';
import { loadRateLimitHashKey, type RateLimitStore } from '../../../security/rate-limit-store';
import { criarAutenticacao, nomeDoCookie } from './instancia';
import { montarAutenticacao } from './montagem';
import { BetterAuthProvider } from './provedor';
import { conferidorPorKAnonimato } from './senha-vazada';

function obrigatoria(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new Error(`${nome} é obrigatória com AUTH_PROVIDER=better-auth`);
  return v;
}

export function bootDoBetterAuth(env: NodeJS.ProcessEnv, origensConfiaveis: readonly string[], store: RateLimitStore) {
  const dbAuth = createDatabase(obrigatoria(env, 'DATABASE_AUTH_URL'), { max: 5 });
  const dbClinica = createDatabase(obrigatoria(env, 'DATABASE_URL'), { max: 5 });
  // Falha fechada (R8 do parecer do código): cookie seguro em tudo que NÃO for development/test (staging, vazio…).
  const producao = !AMBIENTES_SESSAO_FICTICIA.has(env.NODE_ENV ?? '');
  // O provedor nasce depois da instância; os ganchos do fator só rodam em requisição, quando ele já existe.
  const ref: { provedor?: BetterAuthProvider } = {};
  const doProvedor = (): BetterAuthProvider => {
    if (!ref.provedor) throw new Error('provedor do Better Auth ainda não montado');
    return ref.provedor;
  };
  const auth = criarAutenticacao({
    db: dbAuth.db,
    segredo: obrigatoria(env, 'BETTER_AUTH_SECRET'),
    baseURL: obrigatoria(env, 'API_BASE_URL'),
    origensConfiaveis,
    producao,
    chaveHmac: loadRateLimitHashKey(env),
    store,
    conferirSenhaVazada: conferidorPorKAnonimato(),
    fator: {
      aoVerificarMfa: (e) => doProvedor().aposMfaVerificado(e.sessaoId, e.userId, e.motivo),
      aoFalharMfa: (e) => doProvedor().aposMfaRecusado(e.sessaoId, e.userId, e.bloqueou),
    },
  });
  const provider = new BetterAuthProvider({
    auth,
    dbAuth: dbAuth.db,
    dbClinica: dbClinica.db,
    cookieDeEncerramento: `${nomeDoCookie(producao)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${producao ? '; Secure' : ''}`,
  });
  ref.provedor = provider;
  return {
    provider,
    montagem: montarAutenticacao(auth, provider),
    async fechar(): Promise<void> {
      await Promise.all([dbAuth.close(), dbClinica.close()]);
    },
  };
}

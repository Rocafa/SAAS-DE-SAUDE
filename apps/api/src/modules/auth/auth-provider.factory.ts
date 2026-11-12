import type { AuthProvider } from './auth-context';
import { DevSessionProvider } from './dev-session.provider';

/** Únicos ambientes em que a sessão fictícia pode existir (lista fechada: falha fechada). */
export const AMBIENTES_SESSAO_FICTICIA: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * Tipos de provedor aceitos em `AUTH_PROVIDER`. Todo tipo novo precisa de bancada no contrato
 * (`contrato-provedor.test.ts` declara onde ela roda; R6 do parecer do #123 e R2 do #128).
 */
export const TIPOS_DE_PROVEDOR = ['dev', 'better-auth'] as const;
export type TipoDeProvedor = (typeof TIPOS_DE_PROVEDOR)[number];

/**
 * Ambientes em que cada tipo pode subir. `better-auth` (D4) fica restrito a development/test ATÉ o PR 3 da
 * autenticação (R13 do parecer do desenho): antes disso faltam a escolha de clínica, o convite e o desligamento.
 * O PR 3 abre `production` para ele; a sessão fictícia nunca sobe fora de dev/test.
 */
export const AMBIENTES_POR_TIPO: Readonly<Record<TipoDeProvedor, ReadonlySet<string>>> = {
  dev: AMBIENTES_SESSAO_FICTICIA,
  // 3c da D4: o provedor real sobe também em produção (e staging). O dev provider continua SÓ em development/test.
  'better-auth': new Set([...AMBIENTES_SESSAO_FICTICIA, 'production', 'staging']),
};

/** O que só o boot sabe montar (pools e instância da biblioteca); ver main.ts. */
export interface DependenciasDaFabrica {
  readonly betterAuth?: () => AuthProvider;
}

/**
 * Escolhe o provedor no boot (R4 do parecer do #128: mapa por tipo). Produção, staging, NODE_ENV vazio ou qualquer
 * ambiente fora da lista do tipo: a API NÃO SOBE — melhor fora do ar do que aberta.
 */
export function createAuthProvider(env: NodeJS.ProcessEnv = process.env, deps: DependenciasDaFabrica = {}): AuthProvider {
  const tipo = env.AUTH_PROVIDER ?? 'dev';
  if (!(TIPOS_DE_PROVEDOR as readonly string[]).includes(tipo)) throw new Error('AUTH_PROVIDER desconhecido');
  const t = tipo as TipoDeProvedor;
  if (!AMBIENTES_POR_TIPO[t].has(env.NODE_ENV ?? '')) {
    throw new Error(
      `Provedor de autenticação "${t}" não sobe em NODE_ENV=${env.NODE_ENV ?? 'vazio'}: a sessão fictícia só existe em development/test; em produção, o login é o real da D4 (AUTH_PROVIDER=better-auth)`,
    );
  }
  const fabricas: Record<TipoDeProvedor, () => AuthProvider> = {
    dev: () => new DevSessionProvider(env.NODE_ENV),
    'better-auth': () => {
      if (!deps.betterAuth) throw new Error('AUTH_PROVIDER=better-auth exige a instância montada no boot (main.ts)');
      return deps.betterAuth();
    },
  };
  return fabricas[t]();
}

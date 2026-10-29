import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import type { Perfil } from './perfis';

/**
 * Quem está chamando, resolvido NO SERVIDOR a partir da sessão. É a única origem do tenant de
 * uma requisição (regra 1 da D4): nenhum cabeçalho, parâmetro ou corpo enviado pelo cliente entra
 * aqui.
 */
export interface AuthContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly perfis: readonly Perfil[];
}

/** Só o que o provedor pode ler da requisição: cabeçalhos (cookie/Authorization). */
export interface RequisicaoParaSessao {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Porta de autenticação. Implementações: `DevSessionProvider` (dev/teste, sessão fictícia em
 * memória) e, depois da D4, o adaptador do provedor real (Better Auth recomendado), que lê a
 * sessão guardada no servidor. Devolve null quando não há sessão válida (401).
 */
export interface AuthProvider {
  readonly tipo: string;
  resolver(req: RequisicaoParaSessao): Promise<AuthContext | null>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

export function paraRequestContext(auth: AuthContext): RequestContext {
  return { tenantId: auth.tenantId, userId: auth.userId, roles: auth.perfis };
}

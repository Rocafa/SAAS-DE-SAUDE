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
  /**
   * Quando o usuário passou pelo segundo fator nesta sessão (informado pelo provedor), ou null se não passou. A
   * obrigatoriedade é decidida pela API (mfa.ts), não pelo provedor.
   */
  readonly mfaEm: Date | null;
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

/** Sessão sem clínica (PR 3a da D4): só a pessoa, para escolher a clínica e cuidar das próprias sessões. */
export interface SessaoDePessoa {
  readonly sessaoId: string;
  readonly userId: string;
}

export interface ClinicaDaPessoa {
  readonly id: string;
  readonly nome: string;
}

/** Sessão listada para a própria pessoa (R20): sem IP, user-agent nem clínica. */
export interface SessaoListada {
  readonly id: string;
  readonly criadaEm: string;
  readonly ultimaAtividade: string;
  readonly atual: boolean;
}

/**
 * Parte OPCIONAL da porta, só do provedor real (Better Auth): as rotas da pessoa sem clínica. Com o dev provider, as
 * rotas respondem 404 (o guard confere com `ehProvedorDePessoa`).
 */
export interface ProvedorDePessoa {
  sessaoDePessoa(req: RequisicaoParaSessao): Promise<SessaoDePessoa | null>;
  clinicasDaPessoa(userId: string): Promise<ClinicaDaPessoa[]>;
  escolherClinica(s: SessaoDePessoa, clinicaId: string): Promise<boolean>;
  sessoesDaPessoa(s: SessaoDePessoa): Promise<SessaoListada[]>;
  encerrarSessaoDaPessoa(s: SessaoDePessoa, sessaoId: string): Promise<boolean>;
  encerrarTodasDaPessoa(s: SessaoDePessoa): Promise<number>;
}

export function ehProvedorDePessoa(p: AuthProvider): p is AuthProvider & ProvedorDePessoa {
  return typeof (p as Partial<ProvedorDePessoa>).sessaoDePessoa === 'function';
}

export function paraRequestContext(auth: AuthContext): RequestContext {
  return { tenantId: auth.tenantId, userId: auth.userId, roles: auth.perfis, mfaEm: auth.mfaEm };
}

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
  /** Rota de polling (`@SemRenovarSessao`, R19): a leitura não estende a sessão nem devolve cookie (R5 do desenho do PR 3). */
  readonly semRenovar?: boolean;
  /** Recebe o `Set-Cookie` da SESSÃO quando o provedor a estende (só o cookie de sessão, nada mais da biblioteca). */
  readonly aoRenovarCookie?: (cookies: string[]) => void;
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
  /** `Set-Cookie` que expira o cookie de sessão no navegador (logout). */
  cookieDeEncerramento(): string;
}

/** Parte OPCIONAL da porta para o aceite do convite da equipe (PR 3b): só o provedor real. */
export interface ProvedorDeConvite {
  criarContaDoConvite(e: {
    userId: string;
    reaproveita: boolean;
    email: string;
    nome: string;
    senha: string;
    clinicaDeOrigem: string;
    conviteDeOrigem: string;
  }): Promise<{ userId: string } | 'conta_existente' | 'senha_vazada'>;
  /**
   * Id da conta do aceite: novo, ou o de uma conta ABANDONADA por um aceite que falhou depois de criá-la (inativa, sem
   * senha, sem vínculo, nascida de convite), para o mesmo e-mail não ficar preso (R1 do código do 3b-1).
   */
  idParaContaDoConvite(email: string): Promise<{ userId: string; reaproveita: boolean } | 'conta_existente'>;
  /** Desfaz a conta de um aceite que não fechou: inativa e sem senha (o app_auth não apaga identidade, R18). */
  desfazerContaDoConvite(userId: string): Promise<void>;
  /**
   * Login COMPLETO de conta existente (senha e código TOTP) para o aceite do convite (R1 e R2 do desenho do PR 3; R15:
   * passa pelo bloqueio de login e de fator). Sem fator cadastrado, recusa e apaga a sessão aberta.
   */
  conferirCredenciais(e: { email: string; senha: string; codigo: string; cabecalhos?: Headers }): Promise<{ userId: string } | 'falhou' | 'sem_fator' | 'bloqueado' | 'indisponivel'>;
  /** Depois do commit da clínica: nome e origem da conta abandonada que foi reaproveitada. */
  completarContaReaproveitada(e: { userId: string; nome: string; clinicaDeOrigem: string; conviteDeOrigem: string }): Promise<void>;
  /** Entra com a senha recém-definida e marca a sessão como só de cadastro do fator (15 min, R8). */
  abrirSessaoDeCadastro(e: { email: string; senha: string; cabecalhos: Headers }): Promise<string[]>;
}

/** Parte OPCIONAL da porta para credenciais (PR 3b-2): só o provedor real. */
export interface ProvedorDeCredencial {
  /** Troca de senha pela própria pessoa (R16): apaga as outras sessões; devolve o Set-Cookie da sessão nova. */
  trocarSenhaDaPessoa(e: {
    headers: RequisicaoParaSessao['headers'];
    userId: string;
    atual: string;
    nova: string;
  }): Promise<string[] | 'senha_atual_errada' | 'senha_vazada' | 'recusada' | 'bloqueado' | 'indisponivel'>;
  /** Desbloqueio pelo admin (R4 do #152): só zera os contadores (e-mail e fator), sem trocar senha nem fator. */
  desbloquear(userId: string): Promise<void>;
}

export type TipoDeRecuperacao = 'senha' | 'fator';
export type ResultadoDaRecuperacao = { readonly tipo: TipoDeRecuperacao; readonly cookies: string[] } | 'invalido' | 'credencial_errada' | 'senha_vazada' | 'bloqueado' | 'indisponivel';

/** Recuperação pelo admin (R17; R1 do desenho do PR 3): nenhum token restaura os dois fatores. */
export interface ProvedorDeRecuperacao {
  emitirRecuperacao(e: { userId: string; tipo: TipoDeRecuperacao; clinicaId: string; criadoPor: string }): Promise<{ token: string; expiraEm: string } | 'teto'>;
  invalidarRecuperacao(token: string): Promise<void>;
  usarRecuperacao(e: { token: string; senhaNova?: string; senhaAtual?: string; codigo?: string; cabecalhos: Headers }): Promise<ResultadoDaRecuperacao>;
}

export function ehProvedorDeRecuperacao(p: AuthProvider): p is AuthProvider & ProvedorDeRecuperacao {
  return typeof (p as Partial<ProvedorDeRecuperacao>).usarRecuperacao === 'function';
}

export function ehProvedorDeCredencial(p: AuthProvider): p is AuthProvider & ProvedorDeCredencial {
  return typeof (p as Partial<ProvedorDeCredencial>).trocarSenhaDaPessoa === 'function';
}

export function ehProvedorDeConvite(p: AuthProvider): p is AuthProvider & ProvedorDeConvite {
  return typeof (p as Partial<ProvedorDeConvite>).criarContaDoConvite === 'function';
}

export function ehProvedorDePessoa(p: AuthProvider): p is AuthProvider & ProvedorDePessoa {
  return typeof (p as Partial<ProvedorDePessoa>).sessaoDePessoa === 'function';
}

export function paraRequestContext(auth: AuthContext): RequestContext {
  return { tenantId: auth.tenantId, userId: auth.userId, roles: auth.perfis, mfaEm: auth.mfaEm };
}

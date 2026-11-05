import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { RequisicaoParaSessao } from '../auth/auth-context';

/**
 * Sessão do PORTAL DO PACIENTE (veto B3 do parecer front-r8; recomendação da D4: login do portal
 * separado do da clínica). É outra porta, outro provedor e outro guard:
 *
 * - a sessão da clínica (`AuthProvider`/`SessaoGuard`) NUNCA abre rota `/portal/*`, e a do portal nunca
 *   abre rota da clínica (tokens de formatos diferentes, mapas diferentes; teste em test/security);
 * - a identidade é só a CONTA do portal (`contaId`), guardada no servidor. Nenhum id de paciente ou de
 *   clínica vem do cliente: o paciente e a clínica saem do VÍNCULO conta↔paciente↔clínica escolhido
 *   nesta sessão (também guardado no servidor) e conferido no banco a cada requisição
 *   (`app_set_portal_session`, migração 0027). Vínculo revogado deixa de valer na hora;
 * - a escolha da clínica (quando a conta tem vínculo com mais de uma) é um ato da sessão
 *   (`POST /portal/sessao/vinculo`), nunca um cabeçalho.
 */
export interface SessaoDoPortal {
  /** Conta do portal (pessoa que entrou). Nunca vem do cliente. */
  readonly contaId: string;
  /** Vínculo escolhido nesta sessão (conta↔paciente↔clínica); null até escolher. */
  readonly vinculoId: string | null;
}

/**
 * Porta de autenticação do portal. Implementações: `DevPortalSessionProvider` (dev/teste, sessão
 * fictícia em memória) e, depois da D4, o adaptador do login real do portal (OTP por SMS/WhatsApp com
 * limite de tentativas e código de 10 min, R14 do front-r8; cookie próprio, separado do da clínica).
 */
export interface PortalAuthProvider {
  readonly tipo: string;
  resolver(req: RequisicaoParaSessao): Promise<SessaoDoPortal | null>;
  /** Grava o vínculo escolhido NA SESSÃO do servidor (já conferido no banco por quem chama). */
  escolherVinculo(req: RequisicaoParaSessao, vinculoId: string): Promise<void>;
}

export const PORTAL_AUTH_PROVIDER = Symbol('PORTAL_AUTH_PROVIDER');

/** Únicos ambientes da sessão fictícia do portal (lista fechada, como o AuthContext da clínica). */
export const AMBIENTES_SESSAO_FICTICIA_PORTAL: ReadonlySet<string> = new Set(['development', 'test']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Prefixo próprio: o token do portal nunca casa com o formato da sessão da clínica (43 caracteres). */
const PREFIXO = 'ptl_';
const TOKEN_RE = /^Bearer ptl_([A-Za-z0-9_-]{43})$/;

/**
 * Sessão FICTÍCIA do portal, em memória NO SERVIDOR (só o SHA-256 do token é guardado). Só existe em
 * NODE_ENV development/test. Sessões são criadas por código (testes); não há tela de login.
 */
export class DevPortalSessionProvider implements PortalAuthProvider {
  readonly tipo = 'dev';
  private readonly sessoes = new Map<string, { contaId: string; vinculoId: string | null }>();

  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (!AMBIENTES_SESSAO_FICTICIA_PORTAL.has(nodeEnv ?? '')) {
      throw new Error('DevPortalSessionProvider é só para development/test: em produção ou staging use o login real do portal (D4)');
    }
  }

  /** Cria a sessão de uma conta do portal e devolve o token (`Authorization: Bearer ptl_<token>`). */
  criarSessao(dados: { contaId: string }): string {
    if (!UUID_RE.test(dados.contaId)) throw new Error('conta do portal inválida');
    const token = randomBytes(32).toString('base64url');
    this.sessoes.set(hash(token), { contaId: dados.contaId.toLowerCase(), vinculoId: null });
    return `${PREFIXO}${token}`;
  }

  encerrarSessao(token: string): void {
    this.sessoes.delete(hash(token.startsWith(PREFIXO) ? token.slice(PREFIXO.length) : token));
  }

  resolver(req: RequisicaoParaSessao): Promise<SessaoDoPortal | null> {
    const s = this.sessao(req);
    return Promise.resolve(s ? Object.freeze({ contaId: s.contaId, vinculoId: s.vinculoId }) : null);
  }

  escolherVinculo(req: RequisicaoParaSessao, vinculoId: string): Promise<void> {
    const s = this.sessao(req);
    if (!s || !UUID_RE.test(vinculoId)) return Promise.reject(new Error('sessão do portal inválida'));
    s.vinculoId = vinculoId.toLowerCase();
    return Promise.resolve();
  }

  private sessao(req: RequisicaoParaSessao): { contaId: string; vinculoId: string | null } | undefined {
    const cabecalho = req.headers.authorization;
    if (typeof cabecalho !== 'string') return undefined;
    const m = TOKEN_RE.exec(cabecalho);
    return m?.[1] ? this.sessoes.get(hash(m[1])) : undefined;
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Escolhe o provedor do portal no boot. Hoje só o de dev, com NODE_ENV `development`/`test`. Qualquer
 * outro ambiente: sem login real do portal (D4), a API NÃO SOBE.
 */
export function createPortalAuthProvider(env: NodeJS.ProcessEnv = process.env): PortalAuthProvider {
  if (!AMBIENTES_SESSAO_FICTICIA_PORTAL.has(env.NODE_ENV ?? '')) {
    throw new Error(
      `Nenhum login real do portal do paciente configurado: a sessão fictícia só existe em development/test, nunca em produção ou staging (NODE_ENV=${env.NODE_ENV ?? 'vazio'}; D4)`,
    );
  }
  const tipo = env.PORTAL_AUTH_PROVIDER ?? 'dev';
  if (tipo !== 'dev') throw new Error('PORTAL_AUTH_PROVIDER desconhecido');
  return new DevPortalSessionProvider(env.NODE_ENV);
}

interface RequisicaoDoPortal extends RequisicaoParaSessao {
  portal?: SessaoDoPortal;
}

/**
 * Guard de TODA rota `/portal/*`: só aceita a sessão do portal (401 genérico sem ela). Não lê
 * cabeçalho de clínica nem de paciente: não existe caminho do cliente até o titular.
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(@Inject(PORTAL_AUTH_PROVIDER) private readonly provider: PortalAuthProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequisicaoDoPortal>();
    const sessao = await this.provider.resolver(req);
    if (!sessao) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
    req.portal = sessao;
    return true;
  }
}

/** Sessão do portal resolvida pelo PortalGuard. */
export const SessaoPortal = createParamDecorator((_: unknown, ctx: ExecutionContext): SessaoDoPortal => {
  const s = ctx.switchToHttp().getRequest<RequisicaoDoPortal>().portal;
  if (!s) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
  return s;
});

/** Requisição crua (para gravar a escolha do vínculo na sessão do servidor). */
export const RequisicaoPortal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequisicaoParaSessao => ctx.switchToHttp().getRequest<RequisicaoParaSessao>(),
);

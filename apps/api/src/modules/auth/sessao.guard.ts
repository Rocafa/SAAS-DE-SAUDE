import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_PROVIDER, type AuthContext, type AuthProvider, type RequisicaoParaSessao } from './auth-context';
import { AuditAction } from '@plataforma/shared';
import { ProibidoError } from '../../common/erros-dominio';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { paraRequestContext } from './auth-context';
import { MFA_RECENTE_KEY, recusaDeMfa } from './mfa';
import { temPermissao, type Permissao as NomePermissao } from './perfis';

const PERMISSAO_KEY = 'plataforma:permissao';

/** Permissão exigida pela rota. Rota sob o guard SEM este decorator é negada (falha fechada). */
export const Permissao = (permissao: NomePermissao): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSAO_KEY, permissao);

interface RequisicaoComSessao extends RequisicaoParaSessao {
  auth?: AuthContext;
  params?: Readonly<Record<string, string | undefined>>;
}

/** Escopo da linha da trilha de uma recusa por MFA em rota sensível (B2 do parecer de 03/11 sobre o #123). */
export const SCOPE_MFA_RECUSADO = 'mfa_denied';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard das rotas de domínio: (1) resolve a sessão pelo provedor (porta AuthProvider) — sem sessão,
 * 401; (2) confere a permissão do perfil — sem permissão, 403; (3) confere o MFA (mfa.ts) — 403 com código. A clínica usada daqui em diante é a
 * da sessão. O guard NÃO lê nenhum cabeçalho de clínica (`x-tenant-id`, `x-clinica-id`...): não
 * existe caminho do cliente até o tenant (regra 1 da D4; teste em test/security).
 */
@Injectable()
export class SessaoGuard implements CanActivate {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    @Inject(Reflector) private readonly reflector: Reflector,
    // Opcional só para módulos de teste sem banco; em produção o TenancyModule é global.
    @Optional() @Inject(TenantDatabase) private readonly db?: TenantDatabase,
  ) {}

  private readonly logger = new Logger('sessao');

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequisicaoComSessao>();
    const auth = await this.provider.resolver(req);
    if (!auth) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
    const permissao = this.reflector.getAllAndOverride<NomePermissao | undefined>(PERMISSAO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissao || !temPermissao(auth.perfis, permissao)) {
      throw new ForbiddenException({ statusCode: 403, message: 'Sem permissão' });
    }
    // (3) MFA (issue #106): obrigatório para todo perfil e recente nas rotas marcadas. Recusa antes de qualquer leitura.
    const janela = this.reflector.getAllAndOverride<number | undefined>(MFA_RECENTE_KEY, [context.getHandler(), context.getClass()]) ?? null;
    const recusa = recusaDeMfa(auth, janela);
    if (recusa) {
      if (janela !== null) await this.auditarRecusa(auth, recusa, `${context.getClass().name}.${context.getHandler().name}`, req.params?.id);
      throw new ProibidoError(recusa);
    }
    req.auth = auth;
    return true;
  }

  /**
   * B2: a recusa por MFA numa rota sensível vai para a trilha da clínica da sessão, só com ids (o handler e o id do
   * alvo, se for UUID). Se a gravação falhar, a recusa continua (falha fechada) e o erro vai para o log sem dado.
   */
  private async auditarRecusa(auth: AuthContext, motivo: string, handler: string, alvo: string | undefined): Promise<void> {
    if (!this.db) return;
    const ctx = paraRequestContext(auth);
    try {
      await this.db.run(
        ctx.tenantId,
        (tx) =>
          recordAudit(tx, ctx, {
            action: AuditAction.Read,
            scope: SCOPE_MFA_RECUSADO,
            metadata: { op: handler.slice(0, 64), reason: motivo, ...(alvo && UUID_RE.test(alvo) ? { target_id: alvo } : {}) },
          }),
        ctx.userId,
      );
    } catch (err) {
      this.logger.error(`MFA_RECUSA_NAO_AUDITADA (${err instanceof Error ? err.name : typeof err})`);
    }
  }
}

/** Contexto da sessão resolvido pelo SessaoGuard. */
export const Sessao = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<RequisicaoComSessao>().auth;
  // Só acontece se a rota esquecer o guard: falha fechada.
  if (!auth) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
  return auth;
});

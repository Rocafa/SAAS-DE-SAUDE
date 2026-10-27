import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_PROVIDER, type AuthContext, type AuthProvider, type RequisicaoParaSessao } from './auth-context';
import { temPermissao, type Permissao as NomePermissao } from './perfis';

const PERMISSAO_KEY = 'plataforma:permissao';

/** Permissão exigida pela rota. Rota sob o guard SEM este decorator é negada (falha fechada). */
export const Permissao = (permissao: NomePermissao): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSAO_KEY, permissao);

interface RequisicaoComSessao extends RequisicaoParaSessao {
  auth?: AuthContext;
}

/**
 * Guard das rotas de domínio: (1) resolve a sessão pelo provedor (porta AuthProvider) — sem sessão,
 * 401; (2) confere a permissão do perfil — sem permissão, 403. A clínica usada daqui em diante é a
 * da sessão. O guard NÃO lê nenhum cabeçalho de clínica (`x-tenant-id`, `x-clinica-id`...): não
 * existe caminho do cliente até o tenant (regra 1 da D4; teste em test/security).
 */
@Injectable()
export class SessaoGuard implements CanActivate {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

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
    req.auth = auth;
    return true;
  }
}

/** Contexto da sessão resolvido pelo SessaoGuard. */
export const Sessao = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<RequisicaoComSessao>().auth;
  // Só acontece se a rota esquecer o guard: falha fechada.
  if (!auth) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
  return auth;
});

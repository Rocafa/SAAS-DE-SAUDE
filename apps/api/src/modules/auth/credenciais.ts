/**
 * Credenciais (D4, PR 3b-2; desenho §14.2): troca de senha pela própria pessoa (R16) e desbloqueio pelo admin (R4 do
 * parecer do código do #152). Só com o provedor real; com o dev provider, 404.
 *
 * - Troca de senha: MFA recente, conferência de senha vazada (gancho da biblioteca), apaga as outras sessões, a sessão
 *   nova nasce sem MFA e sem clínica, e a trilha vai para as clínicas da pessoa.
 * - Desbloqueio: o admin zera SÓ os contadores de bloqueio (e-mail e fator) de quem tem vínculo ativo na clínica dele;
 *   não troca senha nem fator. Fora da clínica: 404.
 */
import { Body, Controller, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica } from '../../common/transacao-clinica';
import { exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { clinicMembers } from '../../db/schema';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { AUTH_PROVIDER, ehProvedorDeCredencial, paraRequestContext, type AuthContext, type AuthProvider, type ProvedorDeCredencial } from './auth-context';
import { exigirPerfilNoBanco } from './membros';
import { ExigeMfaRecente } from './mfa';
import { Permissao, Sessao, SessaoGuard } from './sessao.guard';

@Injectable()
export class CredenciaisService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
  ) {}

  private get credenciais(): ProvedorDeCredencial {
    if (!ehProvedorDeCredencial(this.provider)) throw new NotFoundException({ statusCode: 404, message: 'Not Found' });
    return this.provider;
  }

  async trocarSenha(e: { headers: Record<string, string | string[] | undefined>; userId: string; atual: string; nova: string }): Promise<string[]> {
    const r = await this.credenciais.trocarSenhaDaPessoa(e);
    if (r === 'senha_atual_errada') throw new ConflitoError('senha_atual_errada', ['senhaAtual']);
    if (r === 'senha_vazada') throw new ConflitoError('senha_vazada', ['senhaNova']);
    return r;
  }

  /** R16: só quem tem vínculo ATIVO na clínica do admin; a trilha fica na clínica do admin. */
  async desbloquear(ctx: RequestContext, usuarioId: string): Promise<void> {
    const credenciais = this.credenciais;
    await escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const [ativo] = await tx
        .select({ id: clinicMembers.id })
        .from(clinicMembers)
        .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.userId, usuarioId), isNull(clinicMembers.revokedAt)))
        .limit(1);
      if (!ativo) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.PermissionChange, scope: 'clinic_members', metadata: { op: 'member_unlock', user_id: usuarioId } });
    });
    await credenciais.desbloquear(usuarioId);
  }
}

@Controller()
@UseGuards(SessaoGuard)
export class CredenciaisController {
  constructor(@Inject(CredenciaisService) private readonly service: CredenciaisService) {}

  @Post('sessao/senha')
  @ExigeMfaRecente()
  @HttpCode(204)
  @Permissao('sessao:ler')
  async trocarSenha(
    @Sessao() auth: AuthContext,
    @Body() corpo: unknown,
    @Req() req: { headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) res: { append(nome: string, valor: string[]): void },
  ): Promise<void> {
    const v = new Validador(exigirObjeto(corpo, ['senhaAtual', 'senhaNova']));
    const atual = v.texto('senhaAtual', { max: 128, obrigatorio: true });
    const nova = v.texto('senhaNova', { max: 128, obrigatorio: true });
    v.concluir();
    if (nova.length < 12) throw new ConflitoError('senha_curta', ['senhaNova']);
    const cookies = await this.service.trocarSenha({ headers: req.headers, userId: auth.userId, atual, nova });
    if (cookies.length > 0) res.append('Set-Cookie', cookies);
  }

  @Post('clinica/membros/:usuarioId/desbloqueio')
  @ExigeMfaRecente()
  @HttpCode(204)
  @Permissao('cadastros:gerir')
  desbloquear(@Sessao() auth: AuthContext, @Param('usuarioId') usuarioId: string): Promise<void> {
    return this.service.desbloquear(paraRequestContext(auth), exigirUuid(usuarioId, 'usuarioId'));
  }
}

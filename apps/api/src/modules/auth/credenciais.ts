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
import {
  AUTH_PROVIDER,
  ehProvedorDeCredencial,
  ehProvedorDeRecuperacao,
  paraRequestContext,
  type AuthContext,
  type AuthProvider,
  type ProvedorDeCredencial,
  type ProvedorDeRecuperacao,
  type TipoDeRecuperacao,
} from './auth-context';
import { origemDaRequisicao } from '../../security/log-de-seguranca';
import { CABECALHO_ORIGEM } from './better-auth/protecao';
import { exigirPerfilNoBanco } from './membros';
import { ExigeMfaRecente } from './mfa';
import { Permissao, Sessao, SessaoGuard } from './sessao.guard';

/**
 * Motivo da recuperação: LISTA FECHADA (o contrato da trilha, 0005, não aceita texto livre, e nenhum texto livre fica
 * para sempre na trilha). Substitui a "justificativa de 10 a 500 caracteres" do desenho.
 */
export const MOTIVOS_DE_RECUPERACAO = ['esqueceu_a_senha', 'perdeu_o_aparelho', 'troca_de_aparelho', 'suspeita_de_invasao', 'conta_bloqueada'] as const;
export type MotivoDeRecuperacao = (typeof MOTIVOS_DE_RECUPERACAO)[number];

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

  private get recuperacoes(): ProvedorDeRecuperacao {
    if (!ehProvedorDeRecuperacao(this.provider)) throw new NotFoundException({ statusCode: 404, message: 'Not Found' });
    return this.provider;
  }

  /**
   * Emite o token de recuperação (R17): só para quem tem vínculo ativo na clínica do admin (R16); trilha na clínica do
   * admin com o tipo e o motivo. O token é emitido DENTRO da transação da trilha; se ela não confirmar, é invalidado.
   */
  async emitirRecuperacao(ctx: RequestContext, usuarioId: string, tipo: TipoDeRecuperacao, motivo: MotivoDeRecuperacao): Promise<{ token: string; expiraEm: string }> {
    const recuperacoes = this.recuperacoes;
    let emitido: { token: string; expiraEm: string } | undefined;
    try {
      await escreverNaClinica(this.db, ctx, async (tx) => {
        await exigirPerfilNoBanco(tx, ctx, 'admin');
        const [ativo] = await tx
          .select({ id: clinicMembers.id })
          .from(clinicMembers)
          .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.userId, usuarioId), isNull(clinicMembers.revokedAt)))
          .limit(1);
        if (!ativo) throw new NaoEncontradoError();
        await recordAudit(tx, ctx, {
          action: AuditAction.PermissionChange,
          scope: 'clinic_members',
          metadata: { op: 'credential_recovery_issued', user_id: usuarioId, kind: tipo, reason: motivo },
        });
        emitido = await recuperacoes.emitirRecuperacao({ userId: usuarioId, tipo, clinicaId: ctx.tenantId, criadoPor: ctx.userId });
      });
    } catch (err) {
      if (emitido) await recuperacoes.invalidarRecuperacao(emitido.token);
      throw err;
    }
    if (!emitido) throw new Error('recuperação não emitida');
    return emitido;
  }

  async usarRecuperacao(e: { token: string; senhaNova?: string; senhaAtual?: string; codigo?: string; cabecalhos: Headers }): Promise<string[]> {
    const r = await this.recuperacoes.usarRecuperacao(e);
    if (r === 'invalido') throw new NaoEncontradoError();
    if (r === 'senha_vazada') throw new ConflitoError('senha_vazada', ['senhaNova']);
    // Credencial errada e bloqueio respondem igual (sem dizer qual).
    if (r === 'credencial_errada' || r === 'bloqueado') throw new ConflitoError('credencial_invalida');
    return r.cookies;
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

  @Post('clinica/membros/:usuarioId/recuperacao')
  @ExigeMfaRecente()
  @Permissao('cadastros:gerir')
  emitirRecuperacao(@Sessao() auth: AuthContext, @Param('usuarioId') usuarioId: string, @Body() corpo: unknown): Promise<{ token: string; expiraEm: string }> {
    const v = new Validador(exigirObjeto(corpo, ['tipo', 'motivo']));
    const tipo = v.texto('tipo', { max: 10, obrigatorio: true });
    const motivo = v.texto('motivo', { max: 40, obrigatorio: true });
    v.concluir();
    if (tipo !== 'senha' && tipo !== 'fator') throw new ConflitoError('tipo_invalido', ['tipo']);
    if (!(MOTIVOS_DE_RECUPERACAO as readonly string[]).includes(motivo)) throw new ConflitoError('motivo_invalido', ['motivo']);
    return this.service.emitirRecuperacao(paraRequestContext(auth), exigirUuid(usuarioId, 'usuarioId'), tipo, motivo as MotivoDeRecuperacao);
  }

  @Post('clinica/membros/:usuarioId/desbloqueio')
  @ExigeMfaRecente()
  @HttpCode(204)
  @Permissao('cadastros:gerir')
  desbloquear(@Sessao() auth: AuthContext, @Param('usuarioId') usuarioId: string): Promise<void> {
    return this.service.desbloquear(paraRequestContext(auth), exigirUuid(usuarioId, 'usuarioId'));
  }
}

/** Uso do token de recuperação: sem sessão (a pessoa perdeu a senha ou o aparelho). Rate limit e CSRF da borda valem. */
@Controller('recuperacao')
export class UsoDaRecuperacaoController {
  constructor(@Inject(CredenciaisService) private readonly service: CredenciaisService) {}

  @Post('usar')
  @HttpCode(204)
  async usar(
    @Body() corpo: unknown,
    @Req() req: { headers: Record<string, string | string[] | undefined>; ip?: string },
    @Res({ passthrough: true }) res: { append(nome: string, valor: string[]): void },
  ): Promise<void> {
    const v = new Validador(exigirObjeto(corpo, ['token', 'senhaNova', 'senhaAtual', 'codigo']));
    const token = v.texto('token', { max: 64, obrigatorio: true });
    const senhaNova = v.texto('senhaNova', { max: 128 });
    const senhaAtual = v.texto('senhaAtual', { max: 128 });
    const codigo = v.texto('codigo', { max: 6 });
    v.concluir();
    const cabecalhos = new Headers();
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') cabecalhos.set('user-agent', ua);
    // Origem calculada no servidor, nunca aceita do cliente.
    const origem = origemDaRequisicao(req.ip);
    if (origem) cabecalhos.set(CABECALHO_ORIGEM, origem);
    const cookies = await this.service.usarRecuperacao({
      token,
      cabecalhos,
      ...(senhaNova ? { senhaNova } : {}),
      ...(senhaAtual ? { senhaAtual } : {}),
      ...(codigo ? { codigo } : {}),
    });
    if (cookies.length > 0) res.append('Set-Cookie', cookies);
  }
}

/**
 * Autorização de acesso do suporte pela clínica (migração 0059, S9 do checklist da rodada 7).
 *
 * Nossa equipe só acessa dados de uma clínica com chamado aberto por ela. O administrador da clínica autoriza
 * o chamado (`SUP-<até 7 dígitos>`) por tempo limitado (1 a 72 horas; padrão 24) e pode revogar antes. A trilha
 * (gatilho da 0059) recusa linha de suporte com motivo `pedido_da_clinica` sem autorização vigente para aquele
 * chamado. A autorização guarda só ids, o chamado e datas; a trilha da autorização leva o mesmo.
 */
import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { supportAccessGrants } from '../../db/schema';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { exigirPerfilNoBanco } from '../auth/membros';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { recordAudit } from './audit-log';

export const SCOPE_AUTORIZACAO_SUPORTE = 'support_access_grants';
export const HORAS_PADRAO_SUPORTE = 24;
export const HORAS_MAXIMAS_SUPORTE = 72;
const CHAMADO_RE = /^SUP-\d{1,7}$/;

export interface NovaAutorizacaoDeSuporte {
  readonly chamado: string;
  readonly horas: number;
}

export interface AutorizacaoDeSuporteDto {
  readonly id: string;
  readonly chamado: string;
  readonly autorizadoPor: string;
  readonly autorizadoEm: string;
  readonly expiraEm: string;
  readonly revogadoPor: string | null;
  readonly revogadoEm: string | null;
  /** Não revogada e dentro do prazo, no momento da resposta. */
  readonly vigente: boolean;
}

export function validarNovaAutorizacaoDeSuporte(corpo: unknown): NovaAutorizacaoDeSuporte {
  const v = new Validador(exigirObjeto(corpo, ['chamado', 'horas']));
  const chamado = v.texto('chamado', { max: 11, obrigatorio: true });
  if (!CHAMADO_RE.test(chamado)) v.falhar('chamado');
  const horas = v.inteiro('horas', { min: 1, max: HORAS_MAXIMAS_SUPORTE }) ?? HORAS_PADRAO_SUPORTE;
  v.concluir();
  return { chamado, horas };
}

export function validarCorpoVazio(corpo: unknown): void {
  new Validador(exigirObjeto(corpo ?? {}, [])).concluir();
}

type Linha = typeof supportAccessGrants.$inferSelect;

function paraDto(g: Linha, agora: Date): AutorizacaoDeSuporteDto {
  return {
    id: g.id,
    chamado: g.ticket,
    autorizadoPor: g.grantedBy,
    autorizadoEm: g.grantedAt.toISOString(),
    expiraEm: g.expiresAt.toISOString(),
    revogadoPor: g.revokedBy,
    revogadoEm: g.revokedAt?.toISOString() ?? null,
    vigente: g.revokedAt === null && g.expiresAt > agora,
  };
}

@Injectable()
export class AutorizacaoDeSuporteService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  /** Autoriza o chamado. Já há autorização vigente para ele: 409 `autorizacao_ja_vigente`. */
  autorizar(ctx: RequestContext, dados: NovaAutorizacaoDeSuporte): Promise<AutorizacaoDeSuporteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const [vigente] = await tx
        .select({ id: supportAccessGrants.id })
        .from(supportAccessGrants)
        .where(
          and(
            eq(supportAccessGrants.tenantId, ctx.tenantId),
            eq(supportAccessGrants.ticket, dados.chamado),
            isNull(supportAccessGrants.revokedAt),
            gt(supportAccessGrants.expiresAt, sql`now()`),
          ),
        );
      if (vigente) throw new ConflitoError('autorizacao_ja_vigente');
      const [g] = await tx
        .insert(supportAccessGrants)
        .values({
          tenantId: ctx.tenantId,
          ticket: dados.chamado,
          grantedBy: ctx.userId,
          // Prazo pela data do banco (o gatilho recalcula a partir do granted_at da transação).
          expiresAt: sql`now() + make_interval(hours => ${dados.horas})`,
        })
        .returning();
      const linha = g as Linha;
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_AUTORIZACAO_SUPORTE,
        metadata: { grant_id: linha.id, ticket: linha.ticket, hours: dados.horas },
      });
      return paraDto(linha, new Date());
    });
  }

  /** Revoga antes do prazo. Revogada ou vencida: 409 `autorizacao_nao_vigente`. */
  revogar(ctx: RequestContext, id: string): Promise<AutorizacaoDeSuporteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const [atual] = await tx
        .select({ revokedAt: supportAccessGrants.revokedAt, noPrazo: sql<boolean>`${supportAccessGrants.expiresAt} > now()` })
        .from(supportAccessGrants)
        .where(and(eq(supportAccessGrants.tenantId, ctx.tenantId), eq(supportAccessGrants.id, id)))
        .for('update');
      if (!atual) throw new NaoEncontradoError();
      if (atual.revokedAt !== null || !atual.noPrazo) throw new ConflitoError('autorizacao_nao_vigente');
      const [g] = await tx
        .update(supportAccessGrants)
        .set({ revokedBy: ctx.userId, revokedAt: new Date() })
        .where(and(eq(supportAccessGrants.tenantId, ctx.tenantId), eq(supportAccessGrants.id, id)))
        .returning();
      const linha = g as Linha;
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_AUTORIZACAO_SUPORTE,
        metadata: { grant_id: linha.id, ticket: linha.ticket, op: 'revoke' },
      });
      return paraDto(linha, new Date());
    });
  }

  /** Autorizações da clínica, da mais recente para a mais antiga (até 200). */
  listar(ctx: RequestContext): Promise<readonly AutorizacaoDeSuporteDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(supportAccessGrants)
        .where(eq(supportAccessGrants.tenantId, ctx.tenantId))
        .orderBy(desc(supportAccessGrants.grantedAt), desc(supportAccessGrants.id))
        .limit(200);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_AUTORIZACAO_SUPORTE, metadata: { count: linhas.length } });
      const agora = new Date();
      return linhas.map((l) => paraDto(l, agora));
    });
  }
}

/** Rotas do administrador da clínica: autorizar, listar e revogar o acesso do suporte a um chamado. */
@Controller('suporte/autorizacoes')
@UseGuards(SessaoGuard)
export class AutorizacaoDeSuporteController {
  constructor(@Inject(AutorizacaoDeSuporteService) private readonly service: AutorizacaoDeSuporteService) {}

  @Post()
  @Permissao('suporte:autorizar')
  autorizar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<AutorizacaoDeSuporteDto> {
    return this.service.autorizar(paraRequestContext(auth), validarNovaAutorizacaoDeSuporte(corpo));
  }

  @Get()
  @Permissao('suporte:autorizar')
  listar(@Sessao() auth: AuthContext): Promise<readonly AutorizacaoDeSuporteDto[]> {
    return this.service.listar(paraRequestContext(auth));
  }

  @Post(':id/revogar')
  @HttpCode(200)
  @Permissao('suporte:autorizar')
  revogar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<AutorizacaoDeSuporteDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return this.service.revogar(paraRequestContext(auth), alvo);
  }
}

/**
 * Perfis da clínica NO BANCO (R13 do parecer do Guardião sobre o PR #63; migração 0020).
 *
 * A sessão (provedor plugável) diz à API quais perfis o usuário tem; o banco não via isso, então a
 * exigência de admin (retenção legal) e de psicólogo (custódia) era só da API. Agora a API mantém
 * `clinic_members` (usuário × clínica × perfil) por estas rotas, e os triggers de retenção legal e de
 * custódia conferem o perfil ali, com o usuário travado da sessão (0016/0019):
 *
 * - `POST /clinica/membros/fundador`: o primeiro admin de uma clínica SEM nenhum membro registra a si
 *   mesmo (o banco recusa se já houver qualquer linha).
 * - `POST /clinica/membros`: admin ATIVO NO BANCO concede um perfil (`psicologo` é a qualificação
 *   clínica exigida pela custódia). Idempotente.
 * - `DELETE /clinica/membros/:usuarioId/:perfil`: admin ativo revoga (a linha fica, com quem e quando).
 *   O último admin ativo não é revogado.
 *
 * Tudo auditado com ids e perfil (sem dado pessoal). Só o usuário da sessão concede/revoga: o banco
 * confere `granted_by`/`revoked_by` = app_current_user().
 */
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { CLINIC_MEMBER_ROLES, clinicMembers, type ClinicMemberRole } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { paraRequestContext, type AuthContext } from './auth-context';
import { Permissao, Sessao, SessaoGuard } from './sessao.guard';

const SCOPE = 'clinic_members';

export interface MembroDto {
  readonly usuarioId: string;
  readonly perfil: ClinicMemberRole;
  readonly concedidoPor: string;
  readonly concedidoEm: string;
}

export function ehPerfilDoBanco(valor: unknown): valor is ClinicMemberRole {
  return typeof valor === 'string' && (CLINIC_MEMBER_ROLES as readonly string[]).includes(valor);
}

/** O usuário tem o perfil ATIVO no banco? (na transação do chamador, clínica da sessão) */
export async function temPerfilNoBanco(tx: TenantTx, ctx: RequestContext, usuarioId: string, perfil: ClinicMemberRole): Promise<boolean> {
  const [m] = await tx
    .select({ id: clinicMembers.id })
    .from(clinicMembers)
    .where(
      and(
        eq(clinicMembers.tenantId, ctx.tenantId),
        eq(clinicMembers.userId, usuarioId),
        eq(clinicMembers.role, perfil),
        isNull(clinicMembers.revokedAt),
      ),
    );
  return !!m;
}

/** O usuário JÁ TEVE o perfil na clínica (ativo ou revogado)? */
export async function tevePerfilNoBanco(tx: TenantTx, ctx: RequestContext, usuarioId: string, perfil: ClinicMemberRole): Promise<boolean> {
  const [m] = await tx
    .select({ id: clinicMembers.id })
    .from(clinicMembers)
    .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.userId, usuarioId), eq(clinicMembers.role, perfil)));
  return !!m;
}

/**
 * 403 `perfil_nao_registrado` quando a sessão diz admin mas o banco não: a ação seria recusada pelo
 * trigger de qualquer forma; aqui só vira uma resposta legível antes de qualquer escrita.
 */
export async function exigirPerfilNoBanco(tx: TenantTx, ctx: RequestContext, perfil: ClinicMemberRole): Promise<void> {
  if (!(await temPerfilNoBanco(tx, ctx, ctx.userId, perfil))) throw new ProibidoError('perfil_nao_registrado');
}

@Injectable()
export class MembrosService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  listar(ctx: RequestContext): Promise<MembroDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(clinicMembers)
        .where(and(eq(clinicMembers.tenantId, ctx.tenantId), isNull(clinicMembers.revokedAt)))
        .orderBy(asc(clinicMembers.grantedAt), asc(clinicMembers.id));
      return linhas.map((m) => ({ usuarioId: m.userId, perfil: m.role, concedidoPor: m.grantedBy, concedidoEm: m.grantedAt.toISOString() }));
    });
  }

  /** Fundação: clínica sem nenhum membro; o admin da sessão registra a si mesmo. */
  fundar(ctx: RequestContext): Promise<MembroDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [algum] = await tx.select({ id: clinicMembers.id }).from(clinicMembers).where(eq(clinicMembers.tenantId, ctx.tenantId)).limit(1);
      if (algum) throw new ConflitoError('clinica_ja_tem_membros');
      return this.inserir(tx, ctx, ctx.userId, 'admin', 'member_found');
    });
  }

  conceder(ctx: RequestContext, usuarioId: string, perfil: ClinicMemberRole): Promise<MembroDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const [ativo] = await tx
        .select()
        .from(clinicMembers)
        .where(
          and(
            eq(clinicMembers.tenantId, ctx.tenantId),
            eq(clinicMembers.userId, usuarioId),
            eq(clinicMembers.role, perfil),
            isNull(clinicMembers.revokedAt),
          ),
        );
      if (ativo) return { usuarioId: ativo.userId, perfil: ativo.role, concedidoPor: ativo.grantedBy, concedidoEm: ativo.grantedAt.toISOString() };
      return this.inserir(tx, ctx, usuarioId, perfil, 'member_grant');
    });
  }

  revogar(ctx: RequestContext, usuarioId: string, perfil: ClinicMemberRole): Promise<void> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const [ativo] = await tx
        .select()
        .from(clinicMembers)
        .where(
          and(
            eq(clinicMembers.tenantId, ctx.tenantId),
            eq(clinicMembers.userId, usuarioId),
            eq(clinicMembers.role, perfil),
            isNull(clinicMembers.revokedAt),
          ),
        )
        .for('update');
      if (!ativo) throw new NaoEncontradoError();
      if (perfil === 'admin') {
        const admins = await tx
          .select({ id: clinicMembers.id })
          .from(clinicMembers)
          .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)));
        if (admins.length <= 1) throw new ConflitoError('ultimo_admin');
      }
      await tx
        .update(clinicMembers)
        .set({ revokedBy: ctx.userId, revokedAt: new Date() })
        .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.id, ativo.id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.PermissionChange,
        scope: SCOPE,
        metadata: { op: 'member_revoke', member_id: ativo.id, user_id: usuarioId, role: perfil },
      });
    });
  }

  private async inserir(tx: TenantTx, ctx: RequestContext, usuarioId: string, perfil: ClinicMemberRole, op: string): Promise<MembroDto> {
    const [m] = await tx
      .insert(clinicMembers)
      .values({ tenantId: ctx.tenantId, userId: usuarioId, role: perfil, grantedBy: ctx.userId })
      .returning();
    if (!m) throw new Error('falha ao conceder perfil');
    await recordAudit(tx, ctx, {
      action: AuditAction.PermissionChange,
      scope: SCOPE,
      metadata: { op, member_id: m.id, user_id: usuarioId, role: perfil },
    });
    return { usuarioId: m.userId, perfil: m.role, concedidoPor: m.grantedBy, concedidoEm: m.grantedAt.toISOString() };
  }
}

function exigirPerfilDoBanco(valor: unknown): ClinicMemberRole {
  if (!ehPerfilDoBanco(valor)) throw new ConflitoError('perfil_invalido', ['perfil']);
  return valor;
}

@Controller('clinica/membros')
@UseGuards(SessaoGuard)
export class MembrosController {
  constructor(@Inject(MembrosService) private readonly membros: MembrosService) {}

  @Get()
  @Permissao('cadastros:gerir')
  listar(@Sessao() auth: AuthContext): Promise<MembroDto[]> {
    return this.membros.listar(paraRequestContext(auth));
  }

  @Post('fundador')
  @Permissao('cadastros:gerir')
  fundar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<MembroDto> {
    new Validador(exigirObjeto(corpo ?? {}, [])).concluir();
    return this.membros.fundar(paraRequestContext(auth));
  }

  @Post()
  @Permissao('cadastros:gerir')
  conceder(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<MembroDto> {
    const v = new Validador(exigirObjeto(corpo, ['usuarioId', 'perfil']));
    const usuarioId = v.uuid('usuarioId', true) as string;
    const perfil = v.texto('perfil', { max: 20, obrigatorio: true });
    v.concluir();
    return this.membros.conceder(paraRequestContext(auth), usuarioId, exigirPerfilDoBanco(perfil));
  }

  @Delete(':usuarioId/:perfil')
  @HttpCode(204)
  @Permissao('cadastros:gerir')
  revogar(@Sessao() auth: AuthContext, @Param('usuarioId') usuarioId: string, @Param('perfil') perfil: string): Promise<void> {
    return this.membros.revogar(paraRequestContext(auth), exigirUuid(usuarioId, 'usuarioId'), exigirPerfilDoBanco(perfil));
  }
}

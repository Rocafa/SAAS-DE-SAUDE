/**
 * Perfis da clínica NO BANCO (R13 do parecer do Guardião sobre o PR #63; migração 0020).
 *
 * A sessão (provedor plugável) diz à API quais perfis o usuário tem; o banco não via isso, então a
 * exigência de admin (retenção legal) e de psicólogo (custódia) era só da API. Agora a API mantém
 * `clinic_members` (usuário × clínica × perfil) por estas rotas, e os triggers de retenção legal e de
 * custódia conferem o perfil ali, com o usuário travado da sessão (0016/0019):
 *
 * - Fundação (0022, R15): o primeiro admin vem do FLUXO DE CRIAÇÃO DA CLÍNICA (`criarClinica`), na mesma
 *   transação que cria o tenant, com `tenants.founder_user_id` = usuário da sessão (o banco confere e, no
 *   COMMIT, exige o fundador como admin). Não há mais rota de "fundador": numa clínica sem membros, ninguém
 *   além do fundador registrado vira admin. Clínicas antigas sem fundador: runbook
 *   (docs/04-arquitetura/runbook-fundador-clinicas-existentes.md).
 * - `POST /clinica/membros`: admin ATIVO NO BANCO concede um perfil (`psicologo` é a qualificação
 *   clínica exigida pela custódia). Idempotente.
 * - `DELETE /clinica/membros/:usuarioId/:perfil`: admin ativo revoga (a linha fica, com quem e quando).
 *   O último admin ativo não é revogado.
 *
 * Tudo auditado com ids e perfil (sem dado pessoal); o banco recusa, no COMMIT, linha nova ou revogação
 * sem o evento correspondente na trilha (0022). Concessão e revogação avisam os DEMAIS admins ativos pela
 * caixa de avisos (R13 do #63). Só o usuário da sessão concede/revoga: o banco
 * confere `granted_by`/`revoked_by` = app_current_user().
 */
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId, type UserId } from '@plataforma/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { CLINIC_MEMBER_ROLES, clinicMembers, tenants, type ClinicMemberRole } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit-log';
import { avisarDemaisAdmins } from '../records/avisos';
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

  /**
   * Fluxo de criação da clínica (R15): cria o tenant com o fundador = usuário da sessão e, NA MESMA
   * transação, registra-o como o primeiro admin. Auditado (`tenant_create` e `member_found`).
   * Chamado pelo provisionamento/onboarding (não há rota pública: quem cria clínica é a plataforma).
   */
  async criarClinica(entrada: { readonly nome: string; readonly fundadorUserId: string }): Promise<{ clinicaId: TenantId; fundador: MembroDto }> {
    const clinicaId = randomUUID() as TenantId;
    const ctx: RequestContext = { tenantId: clinicaId, userId: entrada.fundadorUserId as UserId, roles: ['admin'] };
    const fundador = await this.db.run(
      clinicaId,
      async (tx) => {
        await tx.insert(tenants).values({ id: clinicaId, displayName: entrada.nome, founderUserId: entrada.fundadorUserId });
        await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'tenants', metadata: { op: 'tenant_create' } });
        return this.inserir(tx, ctx, entrada.fundadorUserId, 'admin', 'member_found');
      },
      entrada.fundadorUserId,
    );
    return { clinicaId, fundador };
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
        metadata: {
          op: 'member_revoke',
          member_id: ativo.id,
          user_id: usuarioId,
          role: perfil,
          admins_avisados: await avisarDemaisAdmins(tx, ctx, { tipo: 'perfil_alterado', usuarioId, perfil, mudanca: 'revogado' }),
        },
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
      metadata: {
        op,
        member_id: m.id,
        user_id: usuarioId,
        role: perfil,
        // A fundação não tem "demais admins"; a concessão avisa todos os outros admins ativos.
        admins_avisados: op === 'member_found' ? 0 : await avisarDemaisAdmins(tx, ctx, { tipo: 'perfil_alterado', usuarioId, perfil, mudanca: 'concedido' }),
      },
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

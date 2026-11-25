import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { rooms, units } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { traduzirErroDeSala } from './sala-erros';
import type { AlteracaoSala, AlteracaoUnidade, FiltroSalas, NovaSala, NovaUnidade } from './unidades.validation';

export interface UnidadeDto {
  readonly id: string;
  readonly nome: string;
  readonly ativa: boolean;
}

export interface SalaDto {
  readonly id: string;
  readonly unidadeId: string;
  readonly nome: string;
  /** Atendimentos simultâneos na sala (1 = individual). */
  readonly capacidade: number;
  readonly ativa: boolean;
}

function unidadeDto(u: typeof units.$inferSelect): UnidadeDto {
  return { id: u.id, nome: u.name, ativa: u.active };
}

function salaDto(s: typeof rooms.$inferSelect): SalaDto {
  return { id: s.id, unidadeId: s.unitId, nome: s.name, capacidade: s.capacity, ativa: s.active };
}

/**
 * Unidades e salas da clínica (HU-NUC-002, migração 0101). Mesmas garantias dos outros cadastros da agenda: clínica
 * da sessão (RLS), política de assinatura e auditoria na mesma transação (só ids e o que mudou, nunca nome).
 * Nada se apaga: inativar. Unidade inativa tira as salas dela da agenda (o gatilho da 0101 confere as duas).
 */
@Injectable()
export class UnidadesService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  listarUnidades(ctx: RequestContext): Promise<UnidadeDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(units)
        .where(eq(units.tenantId, ctx.tenantId))
        .orderBy(asc(units.name), asc(units.id));
      return linhas.map(unidadeDto);
    });
  }

  criarUnidade(ctx: RequestContext, dados: NovaUnidade): Promise<UnidadeDto> {
    return this.escrita(ctx, async (tx) => {
      const [u] = await tx.insert(units).values({ tenantId: ctx.tenantId, name: dados.nome }).returning();
      if (!u) throw new Error('falha ao criar unidade');
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'units', metadata: { unit_id: u.id } });
      return unidadeDto(u);
    });
  }

  alterarUnidade(ctx: RequestContext, id: string, dados: AlteracaoUnidade): Promise<UnidadeDto> {
    return this.escrita(ctx, async (tx) => {
      const [antes] = await tx
        .select()
        .from(units)
        .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id)))
        .for('update');
      if (!antes) throw new NaoEncontradoError();
      const [u] = await tx
        .update(units)
        .set({
          ...(dados.nome !== undefined ? { name: dados.nome } : {}),
          ...(dados.ativa !== undefined ? { active: dados.ativa } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id)))
        .returning();
      if (!u) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'units',
        metadata: { unit_id: id, renamed: u.name !== antes.name, active_from: antes.active, active_to: u.active },
      });
      return unidadeDto(u);
    });
  }

  listarSalas(ctx: RequestContext, filtro: FiltroSalas): Promise<SalaDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes: SQL[] = [eq(rooms.tenantId, ctx.tenantId)];
      if (filtro.unidadeId) condicoes.push(eq(rooms.unitId, filtro.unidadeId));
      const linhas = await tx
        .select()
        .from(rooms)
        .where(and(...condicoes))
        .orderBy(asc(rooms.name), asc(rooms.id));
      return linhas.map(salaDto);
    });
  }

  criarSala(ctx: RequestContext, dados: NovaSala): Promise<SalaDto> {
    return this.escrita(ctx, async (tx) => {
      // Unidade de outra clínica é invisível pelo RLS: mesmo 404 de inexistente.
      const [unidade] = await tx
        .select({ id: units.id })
        .from(units)
        .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, dados.unidadeId)));
      if (!unidade) throw new NaoEncontradoError();
      const [s] = await tx
        .insert(rooms)
        .values({ tenantId: ctx.tenantId, unitId: unidade.id, name: dados.nome, capacity: dados.capacidade })
        .returning();
      if (!s) throw new Error('falha ao criar sala');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: 'rooms',
        metadata: { room_id: s.id, unit_id: s.unitId, capacity: s.capacity },
      });
      return salaDto(s);
    });
  }

  alterarSala(ctx: RequestContext, id: string, dados: AlteracaoSala): Promise<SalaDto> {
    return this.escrita(ctx, async (tx) => {
      const [antes] = await tx
        .select()
        .from(rooms)
        .where(and(eq(rooms.tenantId, ctx.tenantId), eq(rooms.id, id)))
        .for('update');
      if (!antes) throw new NaoEncontradoError();
      const [s] = await tx
        .update(rooms)
        .set({
          ...(dados.nome !== undefined ? { name: dados.nome } : {}),
          ...(dados.capacidade !== undefined ? { capacity: dados.capacidade } : {}),
          ...(dados.ativa !== undefined ? { active: dados.ativa } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(rooms.tenantId, ctx.tenantId), eq(rooms.id, id)))
        .returning();
      if (!s) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'rooms',
        metadata: {
          room_id: id,
          renamed: s.name !== antes.name,
          capacity_from: antes.capacity,
          capacity_to: s.capacity,
          active_from: antes.active,
          active_to: s.active,
        },
      });
      return salaDto(s);
    });
  }

  private escrita<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return escreverNaClinica(this.db, ctx, fn).catch(traduzirErroDeSala);
  }
}

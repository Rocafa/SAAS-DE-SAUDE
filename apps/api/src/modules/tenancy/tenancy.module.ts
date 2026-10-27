import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  isTenantId,
  withTenant,
  type DatabaseHandle,
  type TenantTx,
} from '../../db/tenant-transaction';
import type { DatabaseTuning } from '../../db/pool-config';

export const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

/**
 * Ponto único de acesso ao banco para código de domínio: só existe `run(tenantId, fn)`,
 * então não há como consultar tabelas de tenant sem contexto definido.
 * (TenantGuard/TenantContextInterceptor vão resolver o tenantId da sessão em microparte própria.)
 */
@Injectable()
export class TenantDatabase implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  /** `userId`: usuário da sessão, travado na transação (migração 0016). */
  run<T>(tenantId: TenantId, fn: (tx: TenantTx) => Promise<T>, userId?: string): Promise<T> {
    return withTenant(this.handle.db, tenantId, fn, userId);
  }

  /**
   * Transação do PORTAL DO PACIENTE (migração 0027): `app_set_portal_session(conta, vínculo)` confere no
   * banco o vínculo ATIVO da conta e trava clínica, paciente e conta na transação (o slot do usuário fica
   * com o sentinela de sistema). Vínculo revogado ou de outra conta: 42501 (quem chama traduz). Com as
   * policies restritivas da 0027, só as linhas do próprio paciente são visíveis.
   */
  runPortal<T>(contaId: string, vinculoId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!isTenantId(contaId) || !isTenantId(vinculoId)) throw new Error('sessão do portal inválida: esperado UUID');
    return this.handle.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${contaId}::uuid, ${vinculoId}::uuid)`);
      return fn(tx);
    });
  }

  /**
   * Transação SEM contexto de clínica, só para as duas funções SECURITY DEFINER do portal que precisam
   * achar a clínica antes de haver contexto: vínculos da conta e resgate do convite (0027). Sob RLS
   * forçado nenhuma tabela da clínica é visível aqui.
   */
  semContextoDoPortal<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.handle.db.transaction(fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

/**
 * Rota do webhook do WhatsApp (R8 do parecer #69): a ÚNICA consulta sem contexto de clínica que o domínio
 * precisa (número de negócio -> clínica, pela função SECURITY DEFINER da 0032). Provider estreito, no lugar
 * de exportar o handle cru do banco: nenhum módulo injeta DATABASE_HANDLE.
 */
@Injectable()
export class RotaDoWhatsapp {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  async clinicaDoNumero(numero: string): Promise<TenantId | null> {
    if (!/^[0-9]{5,32}$/.test(numero)) return null;
    const [r] = await this.handle.db.execute<{ t: string | null }>(sql`select app_whatsapp_tenant_for_number(${numero}) as t`);
    return (r?.t ?? null) as TenantId | null;
  }
}

/**
 * Lista de clínicas do agendador de jobs (0043): só ids, por `app_job_tenants()` (SECURITY DEFINER), FORA de
 * contexto de clínica (dentro de withTenant o banco recusa). Provider estreito, como RotaDoWhatsapp: o domínio
 * continua sem o handle cru; o job de cada clínica roda depois em withTenant (TenantDatabase.run).
 */
@Injectable()
export class ClinicasDoAgendador {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  async listar(): Promise<TenantId[]> {
    const linhas = await this.handle.db.execute<{ t: string }>(sql`select t from app_job_tenants() as t`);
    return linhas.map((r) => r.t).filter(isTenantId);
  }
}

@Module({})
export class TenancyModule {
  static forRoot(options: { databaseUrl: string; tuning?: Partial<DatabaseTuning> }): DynamicModule {
    return {
      module: TenancyModule,
      global: true,
      providers: [
        { provide: DATABASE_HANDLE, useFactory: () => createDatabase(options.databaseUrl, options.tuning) },
        TenantDatabase,
        RotaDoWhatsapp,
        ClinicasDoAgendador,
      ],
      // O handle cru NÃO sai (R8 do #69): tabela de clínica só por TenantDatabase.run; a rota do webhook do
      // WhatsApp, só por RotaDoWhatsapp.clinicaDoNumero.
      exports: [TenantDatabase, RotaDoWhatsapp, ClinicasDoAgendador],
    };
  }
}

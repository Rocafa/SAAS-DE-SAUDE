import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
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
      ],
      // O handle cru NÃO sai (R8 do #69): tabela de clínica só por TenantDatabase.run; a rota do webhook do
      // WhatsApp, só por RotaDoWhatsapp.clinicaDoNumero.
      exports: [TenantDatabase, RotaDoWhatsapp],
    };
  }
}

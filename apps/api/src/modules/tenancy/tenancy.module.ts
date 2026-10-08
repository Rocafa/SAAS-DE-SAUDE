import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
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

  run<T>(tenantId: TenantId, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, tenantId, fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
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
      ],
      exports: [TenantDatabase],
    };
  }
}

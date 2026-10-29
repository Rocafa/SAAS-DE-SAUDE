import { type DynamicModule, Inject, Injectable, Module } from '@nestjs/common';
import type { RequestContext } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { exportInTransaction, type TenantExportPackage } from './tenant-export';

export const EXIT_WINDOW_DAYS_TOKEN = Symbol('EXIT_WINDOW_DAYS');

/**
 * Serviço de exportação (Garantia de Saída). Sem controller ainda: a rota HTTP só entra
 * junto com autenticação + RBAC/MFA (checklist LGPD item 9) — exportar exige papel de gestor.
 */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(TenantDatabase) private readonly tenantDb: TenantDatabase,
    @Inject(EXIT_WINDOW_DAYS_TOKEN) private readonly exitWindowDays: number,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  exportTenantData(ctx: RequestContext, now: Date = new Date()): Promise<TenantExportPackage> {
    return this.tenantDb.run(ctx.tenantId, (tx) =>
      exportInTransaction(tx, ctx, { now, exitWindowDays: this.exitWindowDays, cipher: this.cipher }),
      ctx.userId,
    );
  }
}

@Module({})
export class ExportsModule {
  static forRoot(options: { exitWindowDays: number }): DynamicModule {
    return {
      module: ExportsModule,
      providers: [{ provide: EXIT_WINDOW_DAYS_TOKEN, useValue: options.exitWindowDays }, ExportsService],
      exports: [ExportsService],
    };
  }
}

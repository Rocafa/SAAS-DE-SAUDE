import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config';
import { HealthModule } from './health/health.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { ExportsModule } from './modules/exports/exports.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LifecycleModule,
        HealthModule.forRoot({ databaseUrl: config.databaseUrl }),
        TenancyModule.forRoot({ databaseUrl: config.databaseUrl, tuning: config.database }),
        ExportsModule.forRoot({ exitWindowDays: config.exitWindowDays }),
      ],
    };
  }
}

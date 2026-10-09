import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule, TenancyModule.forRoot({ databaseUrl: config.databaseUrl })],
    };
  }
}

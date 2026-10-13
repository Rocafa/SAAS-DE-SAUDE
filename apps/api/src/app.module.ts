import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config';
import { HealthModule } from './health/health.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import type { AuthProvider } from './modules/auth/auth-context';
import { createAuthProvider } from './modules/auth/auth-provider.factory';
import { AuthModule } from './modules/auth/auth.module';
import { createKeyProvider, CryptoModule } from './modules/crypto/crypto.module';
import type { KeyProvider } from './modules/crypto/key-provider';
import { ExportsModule } from './modules/exports/exports.module';
import { PatientsModule } from './modules/patients/patients.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

/** Peças plugáveis escolhidas no boot (testes injetam as suas). */
export interface AppAdapters {
  readonly authProvider?: AuthProvider;
  readonly keyProvider?: KeyProvider;
}

@Module({})
export class AppModule {
  /**
   * Sem adaptador explícito, escolhe pelo ambiente: em NODE_ENV=production sem provedor real de
   * login (D4) e sem KMS, lança aqui e a API não sobe.
   */
  static forRoot(config: AppConfig, adapters: AppAdapters = {}): DynamicModule {
    const authProvider = adapters.authProvider ?? createAuthProvider(process.env);
    const keyProvider = adapters.keyProvider ?? createKeyProvider(process.env);
    return {
      module: AppModule,
      imports: [
        LifecycleModule,
        HealthModule.forRoot({ databaseUrl: config.databaseUrl }),
        TenancyModule.forRoot({ databaseUrl: config.databaseUrl, tuning: config.database }),
        AuthModule.forRoot(authProvider),
        CryptoModule.forRoot(keyProvider),
        ExportsModule.forRoot({ exitWindowDays: config.exitWindowDays }),
        PatientsModule,
        SchedulingModule,
      ],
    };
  }
}

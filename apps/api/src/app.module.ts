import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config';
import { HealthModule } from './health/health.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { createPseudonymSigner, type PseudonymSigner } from './modules/audit/ator-suporte';
import { AuditModule } from './modules/audit/audit.module';
import type { AuthProvider } from './modules/auth/auth-context';
import { createAuthProvider } from './modules/auth/auth-provider.factory';
import { AuthModule } from './modules/auth/auth.module';
import { createKeyProvider, CryptoModule } from './modules/crypto/crypto.module';
import type { KeyProvider } from './modules/crypto/key-provider';
import { ExportsModule } from './modules/exports/exports.module';
import { InsuranceModule } from './modules/insurance/insurance.module';
import { PatientsModule } from './modules/patients/patients.module';
import { loadVigilanciaConfig, type VigilanciaConfig } from './modules/patients/vigilancia-de-leitura';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { createRateLimitStore, loadRateLimitHashKey, type RateLimitStore } from './security/rate-limit-store';

/** Peças plugáveis escolhidas no boot (testes injetam as suas). */
export interface AppAdapters {
  readonly authProvider?: AuthProvider;
  readonly keyProvider?: KeyProvider;
  /**
   * Store dos contadores por usuário (R5). O main.ts passa o MESMO store do rate limit por IP
   * (Redis com fallback); sem ele, cria um pelo ambiente e o fecha no shutdown.
   */
  readonly rateLimitStore?: RateLimitStore;
  /** Limites da vigilância de leitura de pacientes; padrão: ambiente (loadVigilanciaConfig). */
  readonly vigilancia?: VigilanciaConfig;
  /** Pseudônimo do suporte (N1); padrão: createPseudonymSigner (KMS fora de development/test). */
  readonly pseudonymSigner?: PseudonymSigner;
}

@Module({})
export class AppModule {
  /**
   * Sem adaptador explícito, escolhe pelo ambiente: em NODE_ENV=production sem provedor real de
   * login (D4), sem KMS das chaves de dados ou sem KMS do pseudônimo do suporte (N1), lança aqui
   * e a API não sobe.
   */
  static forRoot(config: AppConfig, adapters: AppAdapters = {}): DynamicModule {
    const authProvider = adapters.authProvider ?? createAuthProvider(process.env);
    const keyProvider = adapters.keyProvider ?? createKeyProvider(process.env);
    const pseudonymSigner = adapters.pseudonymSigner ?? createPseudonymSigner(process.env);
    const store = adapters.rateLimitStore ?? createRateLimitStore(process.env);
    const pacientes = PatientsModule.forRoot({
      store,
      fecharStore: adapters.rateLimitStore === undefined,
      hashKey: loadRateLimitHashKey(process.env),
      config: adapters.vigilancia ?? loadVigilanciaConfig(process.env),
    });
    return {
      module: AppModule,
      imports: [
        LifecycleModule,
        HealthModule.forRoot({ databaseUrl: config.databaseUrl }),
        TenancyModule.forRoot({ databaseUrl: config.databaseUrl, tuning: config.database }),
        AuthModule.forRoot(authProvider),
        CryptoModule.forRoot(keyProvider),
        AuditModule.forRoot(pseudonymSigner),
        ExportsModule.forRoot({ exitWindowDays: config.exitWindowDays }),
        pacientes,
        SchedulingModule,
        // Mesma instância de PatientsModule: guias/pacotes contam no MESMO limite por usuário (R5).
        InsuranceModule.forRoot(pacientes),
      ],
    };
  }
}

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
import { FinanceModule } from './modules/finance/finance.module';
import { ImportsModule } from './modules/imports/imports.module';
import { InsuranceModule } from './modules/insurance/insurance.module';
import { criarMensageiro } from './modules/messaging/mensageiro.factory';
import type { MensageiroWhatsApp } from './modules/messaging/mensageiro-whatsapp';
import { MessagingModule } from './modules/messaging/messaging.module';
import type { FonteDeResponsaveis } from './modules/messaging/responsaveis.port';
import { PatientsModule } from './modules/patients/patients.module';
import { loadVigilanciaConfig, type VigilanciaConfig } from './modules/patients/vigilancia-de-leitura';
import { createPortalAuthProvider, type PortalAuthProvider } from './modules/portal/portal-auth';
import { PortalModule } from './modules/portal/portal.module';
import { createPortalOtpSender, type PortalOtpSender } from './modules/portal/portal-otp';
import { loadPortalLimites, type PortalLimites } from './modules/portal/portal-vigilancia';
import { RecordsModule } from './modules/records/records.module';
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
  /** Sessão do PORTAL DO PACIENTE, separada da da clínica (D4); padrão: createPortalAuthProvider. */
  readonly portalAuthProvider?: PortalAuthProvider;
  /** Envio do código de resgate do convite (A2 do #68); padrão: createPortalOtpSender (dev/test; real com a D4). */
  readonly portalOtpSender?: PortalOtpSender;
  /** Limite por conta do portal; padrão: ambiente (loadPortalLimites). */
  readonly portalLimites?: PortalLimites;
  /** Canal WhatsApp; padrão: criarMensageiro (WHATSAPP_PROVEDOR; desligado se vazio). `null` = desligado. */
  readonly mensageiro?: MensageiroWhatsApp | null;
  /** Telefone do responsável do paciente; padrão: pelo catálogo (tolera a ausência da 0028). */
  readonly responsaveis?: FonteDeResponsaveis;
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
    const portalAuthProvider = adapters.portalAuthProvider ?? createPortalAuthProvider(process.env);
    const portalOtpSender = adapters.portalOtpSender ?? createPortalOtpSender(process.env);
    const store = adapters.rateLimitStore ?? createRateLimitStore(process.env);
    const mensageiro = adapters.mensageiro !== undefined ? adapters.mensageiro : criarMensageiro(process.env);
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
        // Prontuário: o histórico conta como ficha aberta na mesma vigilância (R5).
        RecordsModule.forRoot(pacientes),
        // Financeiro: listas e recibos contam na mesma vigilância (R5).
        FinanceModule.forRoot(pacientes),
        // Portal do paciente: sessão própria; limite por conta no mesmo store (rodada 18.1).
        PortalModule.forRoot({
          pacientes,
          provider: portalAuthProvider,
          otp: portalOtpSender,
          limites: adapters.portalLimites ?? loadPortalLimites(process.env),
        }),
        // Importador: grava pacientes com a mesma cifra/regras do cadastro (mesma instância).
        ImportsModule.forRoot(pacientes),
        // WhatsApp (rodada 18.3): lembretes D-1 e confirmação; desligado por padrão.
        MessagingModule.forRoot({ mensageiro, ...(adapters.responsaveis ? { responsaveis: adapters.responsaveis } : {}) }),
      ],
    };
  }
}

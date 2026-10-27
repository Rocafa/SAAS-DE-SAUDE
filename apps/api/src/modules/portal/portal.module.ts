import { type DynamicModule, Module } from '@nestjs/common';
import { PORTAL_AUTH_PROVIDER, PortalGuard, type PortalAuthProvider } from './portal-auth';
import { PortalClinicaService } from './portal-clinica.service';
import { PORTAL_OTP_SENDER, type PortalOtpSender } from './portal-otp';
import { loadAntecedenciaCancelamento } from './portal-regras';
import { PORTAL_LIMITES, PortalVigilanciaService, type PortalLimites } from './portal-vigilancia';
import { PortalClinicaController, PortalController } from './portal.controller';
import { ANTECEDENCIA_CANCELAMENTO, PortalService } from './portal.service';

/**
 * Portal do paciente (rodada 18.1). Provedor de sessão PRÓPRIO (separado do da clínica, D4) e a MESMA
 * instância de PatientsModule do AppModule, para o limite por conta usar o mesmo store do rate limit.
 */
@Module({})
export class PortalModule {
  static forRoot(opcoes: {
    pacientes: DynamicModule;
    provider: PortalAuthProvider;
    otp: PortalOtpSender;
    limites: PortalLimites;
    antecedenciaCancelamentoH?: number;
  }): DynamicModule {
    return {
      module: PortalModule,
      imports: [opcoes.pacientes],
      controllers: [PortalController, PortalClinicaController],
      providers: [
        { provide: PORTAL_AUTH_PROVIDER, useValue: opcoes.provider },
        { provide: PORTAL_OTP_SENDER, useValue: opcoes.otp },
        { provide: PORTAL_LIMITES, useValue: opcoes.limites },
        { provide: ANTECEDENCIA_CANCELAMENTO, useValue: opcoes.antecedenciaCancelamentoH ?? loadAntecedenciaCancelamento(process.env) },
        PortalGuard,
        PortalVigilanciaService,
        PortalService,
        PortalClinicaService,
      ],
      exports: [PortalService, PortalClinicaService],
    };
  }
}

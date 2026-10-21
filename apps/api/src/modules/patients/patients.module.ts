import { type DynamicModule, Module } from '@nestjs/common';
import type { RateLimitStore } from '../../security/rate-limit-store';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import {
  VIGILANCIA_OPCOES,
  VIGILANCIA_STORE,
  VigilanciaDeLeituraService,
  type VigilanciaOpcoes,
} from './vigilancia-de-leitura';

/**
 * Depende dos módulos globais: TenancyModule (banco), CryptoModule (cifra) e AuthModule (sessão).
 * A vigilância (limite por usuário e alerta de anomalia, R5) recebe o store do rate limit no boot.
 */
@Module({})
export class PatientsModule {
  static forRoot(vigilancia: { readonly store: RateLimitStore } & VigilanciaOpcoes): DynamicModule {
    const { store, ...opcoes } = vigilancia;
    return {
      module: PatientsModule,
      controllers: [PatientsController],
      providers: [
        PatientsService,
        VigilanciaDeLeituraService,
        { provide: VIGILANCIA_STORE, useValue: store },
        { provide: VIGILANCIA_OPCOES, useValue: opcoes },
      ],
      // Store e opções também saem para o portal contar no MESMO store (limite por conta, rodada 18.1).
      exports: [PatientsService, VigilanciaDeLeituraService, VIGILANCIA_STORE, VIGILANCIA_OPCOES],
    };
  }
}

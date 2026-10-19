import { type DynamicModule, Module } from '@nestjs/common';
import type { RateLimitStore } from '../../security/rate-limit-store';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { ResponsaveisController } from './responsaveis.controller';
import { ResponsaveisService } from './responsaveis.service';
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
      controllers: [PatientsController, ResponsaveisController],
      providers: [
        PatientsService,
        ResponsaveisService,
        VigilanciaDeLeituraService,
        { provide: VIGILANCIA_STORE, useValue: store },
        { provide: VIGILANCIA_OPCOES, useValue: opcoes },
      ],
      exports: [PatientsService, ResponsaveisService, VigilanciaDeLeituraService],
    };
  }
}

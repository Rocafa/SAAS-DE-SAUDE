import { type DynamicModule, Module } from '@nestjs/common';
import type { RateLimitStore } from '../../security/rate-limit-store';
import { CURSOR_DE_PAGINACAO, CursorDePaginacao } from './cursor-de-paginacao';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { PAGINA_MAXIMA } from './patients.validation';
import { DescarteDeResponsaveisController, ResponsaveisController } from './responsaveis.controller';
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
 * O cursor da lista (R5 do parecer #76) recebe o segredo (PAGINATION_CURSOR_KEY; cifra + HMAC) no boot.
 */
@Module({})
export class PatientsModule {
  static forRoot(vigilancia: { readonly store: RateLimitStore; readonly cursorKey: Uint8Array } & VigilanciaOpcoes): DynamicModule {
    const { store, cursorKey, ...opcoes } = vigilancia;
    return {
      module: PatientsModule,
      controllers: [PatientsController, ResponsaveisController, DescarteDeResponsaveisController],
      providers: [
        PatientsService,
        ResponsaveisService,
        VigilanciaDeLeituraService,
        { provide: VIGILANCIA_STORE, useValue: store },
        { provide: VIGILANCIA_OPCOES, useValue: opcoes },
        { provide: CURSOR_DE_PAGINACAO, useValue: new CursorDePaginacao(cursorKey, 'pacientes', Date.now, undefined, PAGINA_MAXIMA) },
      ],
      // Store e opções também saem para o portal contar no MESMO store (limite por conta, rodada 18.1).
      exports: [PatientsService, ResponsaveisService, VigilanciaDeLeituraService, VIGILANCIA_STORE, VIGILANCIA_OPCOES, CURSOR_DE_PAGINACAO],
    };
  }
}

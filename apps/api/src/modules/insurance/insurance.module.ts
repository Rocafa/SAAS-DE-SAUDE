import { type DynamicModule, Module } from '@nestjs/common';
import { ConveniosController, GuiasController, PacotesController } from './guias.controller';
import { GuiasService } from './guias.service';
import { PacotesService } from './pacotes.service';

/**
 * Convênios, guias simples (sem XML TISS) e pacotes de sessões — EP-24.
 * Depende dos módulos globais: TenancyModule (banco), CryptoModule (cifra) e AuthModule (sessão), e
 * da MESMA instância de PatientsModule do AppModule, para usar a vigilância de leitura (limite por
 * usuário e alerta de anomalia, R5) com os mesmos contadores das listas de pacientes.
 */
@Module({})
export class InsuranceModule {
  static forRoot(pacientes: DynamicModule): DynamicModule {
    return {
      module: InsuranceModule,
      imports: [pacientes],
      controllers: [ConveniosController, GuiasController, PacotesController],
      providers: [GuiasService, PacotesService],
      exports: [GuiasService, PacotesService],
    };
  }
}

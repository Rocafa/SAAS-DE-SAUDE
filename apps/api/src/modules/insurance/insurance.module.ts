import { Module } from '@nestjs/common';
import { ConveniosController, GuiasController, PacotesController } from './guias.controller';
import { GuiasService } from './guias.service';
import { PacotesService } from './pacotes.service';

/**
 * Convênios, guias simples (sem XML TISS) e pacotes de sessões — EP-24.
 * Depende dos módulos globais: TenancyModule (banco), CryptoModule (cifra) e AuthModule (sessão).
 */
@Module({
  controllers: [ConveniosController, GuiasController, PacotesController],
  providers: [GuiasService, PacotesService],
  exports: [GuiasService, PacotesService],
})
export class InsuranceModule {}

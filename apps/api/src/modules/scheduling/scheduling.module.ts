import { Module } from '@nestjs/common';
import { loadJanelaDeAtendimento } from './agenda-regras';
import { ListaEsperaController } from './lista-espera.controller';
import { ListaEsperaService } from './lista-espera.service';
import { AgendaController, CadastrosAgendaController } from './scheduling.controller';
import { JANELA_DE_ATENDIMENTO, SchedulingService } from './scheduling.service';

/** Depende dos módulos globais: TenancyModule (banco), AuthModule (sessão) e CryptoModule (observação da espera). */
@Module({
  controllers: [AgendaController, CadastrosAgendaController, ListaEsperaController],
  providers: [
    SchedulingService,
    ListaEsperaService,
    // Janela de "em atendimento" (V1 do parecer #61); ambiente inválido derruba o boot.
    { provide: JANELA_DE_ATENDIMENTO, useFactory: () => loadJanelaDeAtendimento(process.env) },
  ],
  exports: [SchedulingService, ListaEsperaService],
})
export class SchedulingModule {}

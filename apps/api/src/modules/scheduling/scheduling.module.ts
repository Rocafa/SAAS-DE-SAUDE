import { Module } from '@nestjs/common';
import { loadJanelaDeAtendimento } from './agenda-regras';
import { AgendaController, CadastrosAgendaController } from './scheduling.controller';
import { JANELA_DE_ATENDIMENTO, SchedulingService } from './scheduling.service';

/** Depende dos módulos globais: TenancyModule (banco) e AuthModule (sessão). */
@Module({
  controllers: [AgendaController, CadastrosAgendaController],
  providers: [
    SchedulingService,
    // Janela de "em atendimento" (V1 do parecer #61); ambiente inválido derruba o boot.
    { provide: JANELA_DE_ATENDIMENTO, useFactory: () => loadJanelaDeAtendimento(process.env) },
  ],
  exports: [SchedulingService],
})
export class SchedulingModule {}

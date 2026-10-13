import { Module } from '@nestjs/common';
import { AgendaController, CadastrosAgendaController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';

/** Depende dos módulos globais: TenancyModule (banco) e AuthModule (sessão). */
@Module({
  controllers: [AgendaController, CadastrosAgendaController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}

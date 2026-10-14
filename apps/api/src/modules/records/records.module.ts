import { type DynamicModule, Module } from '@nestjs/common';
import { NotasPrivadasService } from './notas-privadas.service';
import {
  AtendimentosController,
  ConfiguracaoProntuarioController,
  NotasPrivadasController,
  ProntuarioDoPacienteController,
} from './prontuario.controller';
import { ProntuarioService } from './prontuario.service';

/**
 * Atendimento, prontuário (evolução versionada, finalização, adendos, histórico) e notas privadas —
 * rodada 14.1. Depende dos módulos globais (banco, cifra, sessão) e da MESMA instância de
 * PatientsModule do AppModule, para o histórico contar na vigilância de leitura (R5).
 */
@Module({})
export class RecordsModule {
  static forRoot(pacientes: DynamicModule): DynamicModule {
    return {
      module: RecordsModule,
      imports: [pacientes],
      controllers: [AtendimentosController, ProntuarioDoPacienteController, NotasPrivadasController, ConfiguracaoProntuarioController],
      providers: [ProntuarioService, NotasPrivadasService],
      exports: [ProntuarioService, NotasPrivadasService],
    };
  }
}

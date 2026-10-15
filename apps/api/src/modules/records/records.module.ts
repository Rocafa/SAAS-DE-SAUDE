import { type DynamicModule, Module } from '@nestjs/common';
import { CicloNotasPrivadasService } from './ciclo-notas-privadas';
import { NotasPrivadasService } from './notas-privadas.service';
import {
  AtendimentosController,
  CicloNotasPrivadasController,
  ConfiguracaoProntuarioController,
  NotasPrivadasController,
  ProntuarioDoPacienteController,
} from './prontuario.controller';
import { ProntuarioService } from './prontuario.service';

/**
 * Atendimento, prontuário (evolução versionada, finalização, adendos, histórico) e notas privadas —
 * rodada 14.1. Depende dos módulos globais (banco, cifra, sessão) e da MESMA instância de
 * PatientsModule do AppModule, para o histórico contar na vigilância de leitura (R5).
 * Ciclo das notas privadas (descarte, expurgo e desligamento do autor): D1/D2 do parecer #63.
 */
@Module({})
export class RecordsModule {
  static forRoot(pacientes: DynamicModule): DynamicModule {
    return {
      module: RecordsModule,
      imports: [pacientes],
      controllers: [
        AtendimentosController,
        ProntuarioDoPacienteController,
        NotasPrivadasController,
        ConfiguracaoProntuarioController,
        CicloNotasPrivadasController,
      ],
      providers: [ProntuarioService, NotasPrivadasService, CicloNotasPrivadasService],
      exports: [ProntuarioService, NotasPrivadasService, CicloNotasPrivadasService],
    };
  }
}

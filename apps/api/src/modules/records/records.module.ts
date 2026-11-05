import { type DynamicModule, Module } from '@nestjs/common';
import { AvisosService } from './avisos';
import { CicloNotasPrivadasService } from './ciclo-notas-privadas';
import { CustodiaService } from './custodia';
import { NotasPrivadasService } from './notas-privadas.service';
import {
  AtendimentosController,
  AvisosController,
  CustodiaController,
  CicloNotasPrivadasController,
  ConfiguracaoProntuarioController,
  NotasPrivadasController,
  ProntuarioDoPacienteController,
  RetencaoLegalController,
} from './prontuario.controller';
import { ProntuarioService } from './prontuario.service';
import { RetencaoLegalService } from './retencao-legal';

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
        RetencaoLegalController,
        CustodiaController,
        AvisosController,
      ],
      providers: [ProntuarioService, NotasPrivadasService, CicloNotasPrivadasService, RetencaoLegalService, CustodiaService, AvisosService],
      exports: [ProntuarioService, NotasPrivadasService, CicloNotasPrivadasService, RetencaoLegalService, CustodiaService, AvisosService],
    };
  }
}

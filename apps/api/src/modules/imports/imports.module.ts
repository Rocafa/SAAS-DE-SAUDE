import { type DynamicModule, Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ImportacaoController } from './importacao.controller';
import { IMPORTACAO_CONFIG, ImportacaoService, loadImportacaoConfig } from './importacao.service';

/**
 * Importador de planilha (rodada 17.3, MIG-01/02). Usa as regras e a cifra do cadastro de pacientes
 * (MESMA instância de PatientsModule do AppModule) e as regras da agenda (SchedulingModule).
 */
@Module({})
export class ImportsModule {
  static forRoot(pacientes: DynamicModule): DynamicModule {
    return {
      module: ImportsModule,
      imports: [pacientes, SchedulingModule],
      controllers: [ImportacaoController],
      providers: [ImportacaoService, { provide: IMPORTACAO_CONFIG, useFactory: () => loadImportacaoConfig(process.env) }],
      exports: [ImportacaoService],
    };
  }
}

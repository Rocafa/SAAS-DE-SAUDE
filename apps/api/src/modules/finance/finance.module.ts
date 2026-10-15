import { type DynamicModule, Module } from '@nestjs/common';
import { CaixaService } from './caixa.service';
import { FinanceiroController } from './financeiro.controller';
import { FinanceiroService } from './financeiro.service';
import { RecibosService } from './recibos.service';

/**
 * Financeiro do MVP (rodada 15.2): cobranças, recebimentos, estornos, caixa, recibos e insumo do
 * Receita Saúde. Depende dos módulos globais (banco, cifra, sessão) e da MESMA instância de
 * PatientsModule do AppModule, para as listas contarem na vigilância de leitura (R5).
 */
@Module({})
export class FinanceModule {
  static forRoot(pacientes: DynamicModule): DynamicModule {
    return {
      module: FinanceModule,
      imports: [pacientes],
      controllers: [FinanceiroController],
      providers: [FinanceiroService, CaixaService, RecibosService],
      exports: [FinanceiroService, CaixaService, RecibosService],
    };
  }
}

import { Body, Controller, type DynamicModule, Get, Inject, Module, Put, UseGuards } from '@nestjs/common';
import { exigirObjeto, Validador } from '../../common/validacao';
import { AUTH_PROVIDER, paraRequestContext, type AuthContext, type AuthProvider } from './auth-context';
import { Permissao, Sessao, SessaoGuard } from './sessao.guard';
import { VINCULO_ATENDIMENTO_DIAS_TETO, VinculoDeCuidadoService } from './vinculo-de-cuidado';

/** `usuarioAtual()` do contrato do front: só ids e perfis, nada de dado pessoal. */
@Controller('sessao')
@UseGuards(SessaoGuard)
export class SessaoController {
  @Get()
  @Permissao('sessao:ler')
  atual(@Sessao() auth: AuthContext): { usuarioId: string; clinicaId: string; perfis: readonly string[] } {
    return { usuarioId: auth.userId, clinicaId: auth.tenantId, perfis: auth.perfis };
  }
}

/**
 * Janela de continuidade do vínculo de cuidado da clínica (R1 do parecer #61): quantos dias depois
 * de um atendimento o profissional mantém o vínculo. Padrão 90, teto 180. Só o admin muda; auditado.
 */
@Controller('clinica/vinculo-de-cuidado')
@UseGuards(SessaoGuard)
export class VinculoDeCuidadoController {
  constructor(@Inject(VinculoDeCuidadoService) private readonly service: VinculoDeCuidadoService) {}

  @Get()
  @Permissao('cadastros:ler')
  ler(@Sessao() auth: AuthContext): Promise<{ dias: number; teto: number }> {
    return this.service.janelaDeContinuidade(paraRequestContext(auth));
  }

  @Put()
  @Permissao('cadastros:gerir')
  definir(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<{ dias: number; teto: number }> {
    const v = new Validador(exigirObjeto(corpo, ['dias']));
    const dias = v.inteiro('dias', { min: 1, max: VINCULO_ATENDIMENTO_DIAS_TETO, obrigatorio: true });
    v.concluir();
    return this.service.definirJanelaDeContinuidade(paraRequestContext(auth), dias as number);
  }
}

/**
 * Autenticação plugável: o provedor (porta AuthProvider) é escolhido no boot por
 * `createAuthProvider` e injetado aqui. Global para que o SessaoGuard e o vínculo de cuidado
 * (VinculoDeCuidadoService, R2) funcionem em qualquer módulo.
 */
@Module({})
export class AuthModule {
  static forRoot(provider: AuthProvider): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      controllers: [SessaoController, VinculoDeCuidadoController],
      providers: [{ provide: AUTH_PROVIDER, useValue: provider }, SessaoGuard, VinculoDeCuidadoService],
      exports: [AUTH_PROVIDER, SessaoGuard, VinculoDeCuidadoService],
    };
  }
}

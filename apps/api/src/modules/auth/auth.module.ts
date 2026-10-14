import { Controller, type DynamicModule, Get, Module, UseGuards } from '@nestjs/common';
import { AUTH_PROVIDER, type AuthContext, type AuthProvider } from './auth-context';
import { Permissao, Sessao, SessaoGuard } from './sessao.guard';
import { VinculoDeCuidadoService } from './vinculo-de-cuidado';

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
      controllers: [SessaoController],
      providers: [{ provide: AUTH_PROVIDER, useValue: provider }, SessaoGuard, VinculoDeCuidadoService],
      exports: [AUTH_PROVIDER, SessaoGuard, VinculoDeCuidadoService],
    };
  }
}

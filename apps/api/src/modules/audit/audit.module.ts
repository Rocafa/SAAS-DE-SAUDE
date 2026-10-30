import { type DynamicModule, Module } from '@nestjs/common';
import { PSEUDONYM_SIGNER, type PseudonymSigner } from './ator-suporte';
import { AutorizacaoDeSuporteController, AutorizacaoDeSuporteService } from './autorizacao-suporte';

/**
 * Auditoria: a porta do pseudônimo do suporte (N1) e a autorização de acesso do suporte pela clínica (0059). O signer é escolhido no boot por
 * `createPseudonymSigner` (KMS fora de development/test; sem ele, a API não sobe). Global para que
 * o futuro fluxo de acesso de suporte o injete em qualquer módulo.
 */
@Module({})
export class AuditModule {
  static forRoot(signer: PseudonymSigner): DynamicModule {
    return {
      module: AuditModule,
      global: true,
      controllers: [AutorizacaoDeSuporteController],
      providers: [{ provide: PSEUDONYM_SIGNER, useValue: signer }, AutorizacaoDeSuporteService],
      exports: [PSEUDONYM_SIGNER, AutorizacaoDeSuporteService],
    };
  }
}

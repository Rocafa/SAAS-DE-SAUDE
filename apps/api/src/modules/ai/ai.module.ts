import { type DynamicModule, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import type { LlmProvider } from './llm-provider';
import { FakeLlmProvider } from './providers/fake-llm.provider';

/**
 * Rotas de IA conhecidas. Só `fake` está implementada: as rotas reais dependem da D3
 * (provedor de LLM para dado sensível) e entram cada uma em PR próprio, com eval aprovado
 * e revisão do Guardião LGPD. Até lá, configurar uma delas é erro de deploy (falha no boot).
 */
export const AI_PROVIDER_IDS = ['fake', 'vertex-gemini-sp', 'maritaca'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export function parseAiProvider(env: NodeJS.ProcessEnv = process.env): AiProviderId {
  const raw = env.AI_PROVIDER ?? 'fake';
  if (!(AI_PROVIDER_IDS as readonly string[]).includes(raw)) {
    throw new Error(`AI_PROVIDER inválido: "${raw}" (use ${AI_PROVIDER_IDS.join(' | ')})`);
  }
  // O `fake` é o padrão de desenvolvimento, e padrão silencioso é como ele chegaria em
  // produção: rascunho de IA vazio, sem ninguém perceber. Em produção, falha no boot.
  if (raw === 'fake' && env.NODE_ENV === 'production') {
    throw new Error(
      'AI_PROVIDER=fake não sobe em produção: é a rota de desenvolvimento e não gera documento. ' +
        'Configure uma rota real (depende da decisão D3) ou não habilite o módulo de IA.',
    );
  }
  return raw as AiProviderId;
}

export function createProviders(id: AiProviderId): LlmProvider[] {
  switch (id) {
    case 'fake':
      return [new FakeLlmProvider()];
    case 'vertex-gemini-sp':
    case 'maritaca':
      throw new Error(`AI_PROVIDER "${id}" aguarda a D3 e o eval do escriba; use "fake" por enquanto`);
  }
}

@Module({})
export class AiModule {
  static forRoot(options: { providers?: readonly LlmProvider[] } = {}): DynamicModule {
    const providers = options.providers ?? createProviders(parseAiProvider());
    return {
      module: AiModule,
      providers: [{ provide: AiService, useFactory: () => new AiService(providers) }],
      exports: [AiService],
    };
  }
}

import { type DynamicModule, Module } from '@nestjs/common';
import type { TenantTx } from '../../db/tenant-transaction';
import { PgDataKeyStore } from './data-key-store';
import { FieldCipher } from './field-cipher';
import { auditKeyEvents } from './key-audit';
import type { KeyProvider } from './key-provider';
import { LocalKeyProvider } from './local-key-provider';

export const FIELD_CIPHER = Symbol('FIELD_CIPHER');

/**
 * Escolhe o provedor de chave mestra no boot. Em produção o KMS ainda não está ligado (Portão A):
 * a API recusa subir em vez de cifrar com chave local. Em dev, `FIELD_KEYS_DEV_ROOT_SECRET`
 * (base64, >= 32 bytes, opcional) mantém as chaves entre reinícios; sem ele, vivem só na memória.
 */
export function createKeyProvider(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  // Lista fechada: chave local só em development/test. Produção, staging, vazio ou qualquer outro
  // valor recusam subir (o KMS ainda não está ligado — Portão A).
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error(`KMS não configurado: o provedor de chave local é proibido fora de development/test, inclusive em produção e staging (NODE_ENV=${env.NODE_ENV ?? 'vazio'})`);
  }
  const raiz = env.FIELD_KEYS_DEV_ROOT_SECRET;
  return new LocalKeyProvider({
    nodeEnv: env.NODE_ENV,
    ...(raiz ? { rootSecret: Buffer.from(raiz, 'base64') } : {}),
  });
}

/** Cifra de campo da aplicação (uma instância: o cache de DEK é compartilhado). */
@Module({})
export class CryptoModule {
  static forRoot(provider: KeyProvider): DynamicModule {
    return {
      module: CryptoModule,
      global: true,
      providers: [
        {
          provide: FIELD_CIPHER,
          useFactory: () => new FieldCipher<TenantTx>(provider, new PgDataKeyStore(), auditKeyEvents),
        },
      ],
      exports: [FIELD_CIPHER],
    };
  }
}

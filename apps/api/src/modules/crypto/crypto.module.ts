import { type DynamicModule, Module } from '@nestjs/common';
import type { TenantTx } from '../../db/tenant-transaction';
import { PgDataKeyStore } from './data-key-store';
import { DisposableKeys } from './disposable-keys';
import { FieldCipher } from './field-cipher';
import { auditKeyEvents } from './key-audit';
import type { KeyProvider } from './key-provider';
import { createAwsKmsCliente, loadKmsConfig } from './kms-client';
import { KmsKeyProvider, type KmsApi } from './kms-key-provider';
import { LocalKeyProvider } from './local-key-provider';

export const FIELD_CIPHER = Symbol('FIELD_CIPHER');
/** Chaves descartáveis por escopo (R3 do importador), sobre o MESMO provedor de chave mestra. */
export const DISPOSABLE_KEYS = Symbol('DISPOSABLE_KEYS');

/**
 * Escolhe o provedor de chave mestra no boot:
 * - development/test: chave local. `FIELD_KEYS_DEV_ROOT_SECRET` (base64, >= 32 bytes, opcional) mantém
 *   as chaves entre reinícios; sem ele, vivem só na memória;
 * - qualquer outro NODE_ENV (production, staging, vazio...): AWS KMS, uma chave mestra por clínica
 *   (Portão A). Sem a configuração do KMS (`loadKmsConfig`: AWS_REGION em sa-east-1, só a role da
 *   tarefa), lança e a API não sobe; o segredo local de dev também é recusado ali.
 * `deps.kms` injeta o cliente (o AppModule passa o mesmo do pseudônimo; testes passam um falso).
 */
export function createKeyProvider(env: NodeJS.ProcessEnv = process.env, deps: { readonly kms?: KmsApi } = {}): KeyProvider {
  // Lista fechada: chave local só em development/test.
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    if (env.FIELD_KEYS_DEV_ROOT_SECRET?.trim()) {
      throw new Error('FIELD_KEYS_DEV_ROOT_SECRET é proibida fora de development/test: a chave mestra fica no KMS');
    }
    // A configuração é conferida mesmo com cliente injetado: região e credencial valem para os dois.
    const config = loadKmsConfig(env, 'chave mestra das clínicas');
    return new KmsKeyProvider(deps.kms ?? createAwsKmsCliente(config));
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
        { provide: DISPOSABLE_KEYS, useFactory: () => new DisposableKeys(provider) },
      ],
      exports: [FIELD_CIPHER, DISPOSABLE_KEYS],
    };
  }
}

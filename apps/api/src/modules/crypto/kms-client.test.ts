import { describe, expect, it } from 'vitest';
import { KmsKeyProvider } from './kms-key-provider';
import { createKeyProvider } from './crypto.module';
import { createAwsKmsCliente, loadKmsConfig, regiaoDoArnKms } from './kms-client';
import { fakeKms } from '../../../test/kms-falso';

describe('configuração do KMS (Portão A)', () => {
  it('exige AWS_REGION (ou AWS_DEFAULT_REGION igual) e só aceita sa-east-1', () => {
    expect(() => loadKmsConfig({ NODE_ENV: 'production' }, 'x')).toThrow(/KMS não configurado \(x\).*AWS_REGION/);
    expect(loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1' }, 'x')).toEqual({ region: 'sa-east-1' });
    expect(loadKmsConfig({ NODE_ENV: 'production', AWS_DEFAULT_REGION: 'sa-east-1' }, 'x')).toEqual({ region: 'sa-east-1' });
    expect(() => loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1', AWS_DEFAULT_REGION: 'us-east-1' }, 'x')).toThrow(/divergem/);
    expect(() => loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'us-east-1' }, 'x')).toThrow(/lista permitida/);
  });

  it('fora de development/test, recusa credencial estática, perfil e endpoint alternativo; em dev, aceita', () => {
    for (const nome of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_KMS']) {
      for (const NODE_ENV of ['production', 'staging', undefined]) {
        expect(() => loadKmsConfig({ NODE_ENV, AWS_REGION: 'sa-east-1', [nome]: 'valor-de-teste' }, 'x'), `${nome}/${NODE_ENV}`).toThrow(
          new RegExp(`${nome} proibida`),
        );
      }
      expect(loadKmsConfig({ NODE_ENV: 'development', AWS_REGION: 'sa-east-1', [nome]: 'valor-de-teste' }, 'x').region).toBe('sa-east-1');
    }
  });

  it('createKeyProvider fora de dev/test: KmsKeyProvider com o cliente injetado ou com o do SDK', () => {
    expect(createKeyProvider({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1' }, { kms: fakeKms() })).toBeInstanceOf(KmsKeyProvider);
    // Mesmo com cliente injetado, a configuração é conferida (falha fechada).
    expect(() => createKeyProvider({ NODE_ENV: 'production' }, { kms: fakeKms() })).toThrow(/KMS não configurado/);
    expect(createKeyProvider({ NODE_ENV: 'staging', AWS_REGION: 'sa-east-1' })).toBeInstanceOf(KmsKeyProvider);
    expect(() => createKeyProvider({ NODE_ENV: 'production' })).toThrow(/KMS não configurado/);
  });

  it('o adaptador do SDK expõe as duas portas (chave mestra e MAC) sem chamar a rede ao ser criado', () => {
    const c = createAwsKmsCliente({ region: 'sa-east-1' });
    for (const op of ['createKey', 'generateDataKey', 'decrypt', 'reEncrypt', 'scheduleKeyDeletion', 'describeKey', 'generateMac', 'verifyMac'] as const) {
      expect(typeof c[op]).toBe('function');
    }
  });

  it('regiaoDoArnKms só reconhece ARN de chave', () => {
    expect(regiaoDoArnKms('arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-000000000000')).toBe('sa-east-1');
    for (const v of ['alias/x', 'arn:aws:kms:sa-east-1:000000000000:alias/x', '00000000-0000-4000-8000-000000000000', '']) {
      expect(regiaoDoArnKms(v)).toBeNull();
    }
  });
});

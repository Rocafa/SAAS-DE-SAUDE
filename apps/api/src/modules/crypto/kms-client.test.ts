import { describe, expect, it } from 'vitest';
import { KmsKeyProvider } from './kms-key-provider';
import { createKeyProvider } from './crypto.module';
import { contaDoArnKms, createAwsKmsCliente, loadKmsConfig, PREFIXOS_AWS_PROIBIDOS, regiaoDoArnKms, VARIAVEIS_AWS_PROIBIDAS } from './kms-client';
import { fakeKms } from '../../../test/kms-falso';

const ARN_HMAC = 'arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-000000000000';

// K-a1 (parecer #76, 27/10): a lista é IGUAL à do Terraform (`api_variaveis_aws_proibidas` em
// infra/terraform/staging/app.tf) e o prefixo AWS_ENDPOINT_URL é vetado por startsWith.
const PROIBIDAS_DO_TERRAFORM = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'KMS_ENDPOINT',
];

describe('configuração do KMS (Portão A)', () => {
  it('exige AWS_REGION (ou AWS_DEFAULT_REGION igual) e só aceita sa-east-1', () => {
    expect(() => loadKmsConfig({ NODE_ENV: 'production' }, 'x')).toThrow(/KMS não configurado \(x\).*AWS_REGION/);
    expect(loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1' }, 'x')).toEqual({ region: 'sa-east-1' });
    expect(loadKmsConfig({ NODE_ENV: 'production', AWS_DEFAULT_REGION: 'sa-east-1' }, 'x')).toEqual({ region: 'sa-east-1' });
    expect(() => loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1', AWS_DEFAULT_REGION: 'us-east-1' }, 'x')).toThrow(/divergem/);
    expect(() => loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'us-east-1' }, 'x')).toThrow(/lista permitida/);
  });

  it('K-a1: a lista exportada é exatamente a do Terraform, e o prefixo é AWS_ENDPOINT_URL', () => {
    expect([...VARIAVEIS_AWS_PROIBIDAS].sort()).toEqual([...PROIBIDAS_DO_TERRAFORM].sort());
    expect(PREFIXOS_AWS_PROIBIDOS).toEqual(['AWS_ENDPOINT_URL']);
  });

  it.each(PROIBIDAS_DO_TERRAFORM)('K-a1: fora de development/test recusa %s; em development aceita', (nome) => {
    for (const NODE_ENV of ['production', 'staging', undefined]) {
      expect(() => loadKmsConfig({ NODE_ENV, AWS_REGION: 'sa-east-1', [nome]: 'valor-de-teste' }, 'x'), `${nome}/${NODE_ENV}`).toThrow(
        new RegExp(`${nome} proibida`),
      );
    }
    // A mensagem cita só o nome, nunca o valor.
    expect(() => loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1', [nome]: 'valor-de-teste' }, 'x')).not.toThrow(/valor-de-teste/);
    expect(loadKmsConfig({ NODE_ENV: 'development', AWS_REGION: 'sa-east-1', [nome]: 'valor-de-teste' }, 'x').region).toBe('sa-east-1');
  });

  it.each(['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_KMS', 'AWS_ENDPOINT_URL_STS', 'AWS_ENDPOINT_URL_SSO_OIDC', 'AWS_ENDPOINT_URLX'])(
    'K-a1: recusa qualquer variável que comece com AWS_ENDPOINT_URL (%s)',
    (nome) => {
      expect(() => loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1', [nome]: 'http://valor-de-teste' }, 'x')).toThrow(
        new RegExp(`${nome} proibida`),
      );
      expect(loadKmsConfig({ NODE_ENV: 'test', AWS_REGION: 'sa-east-1', [nome]: 'http://valor-de-teste' }, 'x').region).toBe('sa-east-1');
    },
  );

  it('K-a1: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI continua permitida (é como o ECS entrega a role da tarefa)', () => {
    expect(
      loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/valor-de-teste' }, 'x'),
    ).toEqual({ region: 'sa-east-1' });
  });

  it('variável proibida vazia (só espaços) não conta como definida', () => {
    expect(loadKmsConfig({ NODE_ENV: 'production', AWS_REGION: 'sa-east-1', AWS_PROFILE: '  ', AWS_ENDPOINT_URL_KMS: '' }, 'x').region).toBe('sa-east-1');
  });

  it('createKeyProvider fora de dev/test: KmsKeyProvider com o cliente injetado ou com o do SDK', () => {
    const ok = { AWS_REGION: 'sa-east-1', SUPPORT_PSEUDONYM_KMS_KEY_ID: ARN_HMAC };
    expect(createKeyProvider({ NODE_ENV: 'production', ...ok }, { kms: fakeKms() })).toBeInstanceOf(KmsKeyProvider);
    // Mesmo com cliente injetado, a configuração é conferida (falha fechada).
    expect(() => createKeyProvider({ NODE_ENV: 'production' }, { kms: fakeKms() })).toThrow(/KMS não configurado/);
    expect(createKeyProvider({ NODE_ENV: 'staging', ...ok })).toBeInstanceOf(KmsKeyProvider);
    expect(() => createKeyProvider({ NODE_ENV: 'production' })).toThrow(/KMS não configurado/);
  });

  it('K-c2: sem o ARN da chave HMAC (de onde sai a conta da key policy), a chave das clínicas não sobe', () => {
    for (const v of [undefined, '', 'alias/x', '00000000-0000-4000-8000-000000000000']) {
      const env = { NODE_ENV: 'production', AWS_REGION: 'sa-east-1', ...(v === undefined ? {} : { SUPPORT_PSEUDONYM_KMS_KEY_ID: v }) };
      expect(() => createKeyProvider(env, { kms: fakeKms() }), String(v)).toThrow(/SUPPORT_PSEUDONYM_KMS_KEY_ID.*conta/);
    }
  });

  it('o adaptador do SDK expõe as duas portas (chave mestra e MAC) sem chamar a rede ao ser criado', () => {
    const c = createAwsKmsCliente({ region: 'sa-east-1' });
    for (const op of ['createKey', 'generateDataKey', 'decrypt', 'reEncrypt', 'scheduleKeyDeletion', 'describeKey', 'generateMac'] as const) {
      expect(typeof c[op]).toBe('function');
    }
    // K-c4a: a role não tem kms:VerifyMac; o adaptador nem expõe a operação.
    expect('verifyMac' in c).toBe(false);
  });

  it('contaDoArnKms extrai a conta só de ARN de chave', () => {
    expect(contaDoArnKms('arn:aws:kms:sa-east-1:111122223333:key/00000000-0000-4000-8000-000000000000')).toBe('111122223333');
    for (const v of ['alias/x', 'arn:aws:kms:sa-east-1:111122223333:alias/x', 'arn:aws:kms:sa-east-1:1111:key/x', '']) {
      expect(contaDoArnKms(v)).toBeNull();
    }
  });

  it('regiaoDoArnKms só reconhece ARN de chave', () => {
    expect(regiaoDoArnKms('arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-000000000000')).toBe('sa-east-1');
    for (const v of ['alias/x', 'arn:aws:kms:sa-east-1:000000000000:alias/x', '00000000-0000-4000-8000-000000000000', '']) {
      expect(regiaoDoArnKms(v)).toBeNull();
    }
  });
});

/**
 * Cliente AWS KMS da API (Portão A): um só adaptador do SDK v3 que satisfaz as duas portas,
 * `KmsApi` (chave mestra por clínica, `KmsKeyProvider`) e `KmsMacApi` (HMAC do pseudônimo do
 * suporte, `KmsPseudonymSigner`). As portas continuam sendo interfaces: testes usam KMS falso.
 *
 * Configuração (falha fechada, lida só no boot):
 * - região: `AWS_REGION` (ou `AWS_DEFAULT_REGION`; se as duas vierem, têm de ser iguais), só
 *   `sa-east-1` (lista fechada: a chave mestra e o HMAC não saem do Brasil);
 * - credencial: SEMPRE a da role da tarefa (cadeia padrão do SDK, metadados do ECS). Fora de
 *   development/test, chave estática (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`),
 *   perfil local (`AWS_PROFILE`) e desvio de endpoint (`AWS_ENDPOINT_URL*`) são recusados;
 * - nenhuma mensagem de erro inclui valor de variável (só nomes), e erro do SDK nunca chega ao log
 *   cru: as portas trocam por erro de mensagem fixa (`guard`).
 */
import {
  CancelKeyDeletionCommand,
  CreateKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
  EnableKeyCommand,
  EnableKeyRotationCommand,
  GenerateDataKeyCommand,
  GenerateMacCommand,
  KMSClient,
  ReEncryptCommand,
  ScheduleKeyDeletionCommand,
  VerifyMacCommand,
} from '@aws-sdk/client-kms';
import type { KmsMacApi } from '../audit/ator-suporte';
import type { KmsApi } from './kms-key-provider';

/** Regiões aceitas para o KMS (lista fechada). Outra região exige decisão do Guardião. */
export const REGIOES_KMS_PERMITIDAS: readonly string[] = ['sa-east-1'];
const AMBIENTES_LOCAIS: readonly string[] = ['development', 'test'];
/** Variáveis que trocariam a role da tarefa por outra credencial ou desviariam o tráfego do KMS. */
const VARIAVEIS_AWS_PROIBIDAS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_KMS'];

export interface KmsConfig {
  readonly region: string;
}

/** Os dois papéis do KMS na API, num cliente só. */
export type KmsCliente = KmsApi & KmsMacApi;

/**
 * Lê e valida a configuração do KMS. Lança com mensagem que cita só NOMES de variáveis.
 * `motivo` diz quem precisa do KMS (aparece na mensagem para o operador saber o que destravar).
 */
export function loadKmsConfig(env: NodeJS.ProcessEnv, motivo: string): KmsConfig {
  const local = AMBIENTES_LOCAIS.includes(env.NODE_ENV ?? '');
  if (!local) {
    const presentes = VARIAVEIS_AWS_PROIBIDAS.filter((n) => env[n]?.trim());
    if (presentes.length > 0) {
      throw new Error(
        `KMS (${motivo}): ${presentes.join(', ')} proibida(s) fora de development/test — a API usa só a role da tarefa, sem chave estática nem endpoint alternativo`,
      );
    }
  }
  const regiao = env.AWS_REGION?.trim();
  const padrao = env.AWS_DEFAULT_REGION?.trim();
  if (regiao && padrao && regiao !== padrao) {
    throw new Error(`KMS (${motivo}): AWS_REGION e AWS_DEFAULT_REGION divergem`);
  }
  const region = regiao || padrao;
  if (!region) {
    throw new Error(`KMS não configurado (${motivo}): defina AWS_REGION; fora de development/test não há chave local (NODE_ENV=${env.NODE_ENV ?? 'vazio'})`);
  }
  if (!REGIOES_KMS_PERMITIDAS.includes(region)) {
    throw new Error(`KMS (${motivo}): região fora da lista permitida (${REGIOES_KMS_PERMITIDAS.join(', ')}) em AWS_REGION`);
  }
  return { region };
}

/** Adaptador do SDK v3 (credencial pela cadeia padrão: role da tarefa no ECS). Não chama a rede ao criar. */
export function createAwsKmsCliente(config: KmsConfig): KmsCliente {
  // Sem retry infinito: o SDK já faz 3 tentativas com backoff; falha vira KeyUnavailableError na porta.
  const c = new KMSClient({ region: config.region });
  return {
    createKey: (input) => c.send(new CreateKeyCommand(input)),
    enableKeyRotation: (input) => c.send(new EnableKeyRotationCommand(input)),
    generateDataKey: (input) => c.send(new GenerateDataKeyCommand(input)),
    decrypt: (input) => c.send(new DecryptCommand(input)),
    reEncrypt: (input) => c.send(new ReEncryptCommand(input)),
    scheduleKeyDeletion: (input) => c.send(new ScheduleKeyDeletionCommand(input)),
    cancelKeyDeletion: (input) => c.send(new CancelKeyDeletionCommand(input)),
    describeKey: (input) => c.send(new DescribeKeyCommand(input)),
    enableKey: (input) => c.send(new EnableKeyCommand(input)),
    generateMac: (input) => c.send(new GenerateMacCommand(input)),
    verifyMac: (input) => c.send(new VerifyMacCommand(input)),
  };
}

/** Região de um ARN de chave KMS (`arn:aws:kms:<região>:<conta>:key/<id>`), ou `null` se não for um. */
export function regiaoDoArnKms(valor: string): string | null {
  const m = /^arn:aws:kms:([a-z0-9-]+):\d{12}:key\/[A-Za-z0-9-]+$/.exec(valor);
  return m?.[1] ?? null;
}

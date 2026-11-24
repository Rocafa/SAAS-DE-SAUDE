import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { criarParametrosSsm, EntregaPendente, FalhaDoSsm, lerConfigDoSsm, VALIDADE_DA_ENTREGA_HORAS, type ComandoDoSsm, type EnviaAoSsm } from './parametros-ssm';

// Só nomes e valores fictícios: conta 000000000000, chave e token inventados.
const CHAVE = 'arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-000000000000';
const ENTREGA = '/provisionamento/0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d/entrega';
const TOKEN_FICTICIO = 'token-ficticio-de-teste-0123456789abcdef';
const AGORA = new Date('2026-11-17T12:00:00.000Z');

const erroDoSdk = (name: string, message = `${name}: ${ENTREGA} valor=${TOKEN_FICTICIO}`) => Object.assign(new Error(message), { name });

function dubleDoSsm(resposta: (c: ComandoDoSsm) => Promise<unknown> = () => Promise.resolve({})) {
  const send = vi.fn(resposta);
  return { ssm: { send } satisfies EnviaAoSsm, send };
}

describe('cliente SSM das tarefas avulsas (C4 do parecer de 16/11; C2 do parecer de 17/11)', () => {
  it.each([
    ['provisionamento', VALIDADE_DA_ENTREGA_HORAS.provisionamento, '2026-11-20T12:00:00.000Z'],
    ['recuperação', VALIDADE_DA_ENTREGA_HORAS.recuperacao, '2026-11-18T12:00:00.000Z'],
  ])('gravar (%s): SecureString com a chave do fluxo, sem sobrescrever, Advanced e Expiration no vencimento', async (_f, horas, vence) => {
    const { ssm, send } = dubleDoSsm();
    await criarParametrosSsm({ ssm, chaveKms: CHAVE, validadeHoras: horas, agora: () => AGORA }).gravar(ENTREGA, TOKEN_FICTICIO);
    expect(send).toHaveBeenCalledTimes(1);
    const comando = send.mock.calls[0]?.[0];
    expect(comando).toBeInstanceOf(PutParameterCommand);
    const input = (comando as PutParameterCommand).input;
    expect(input).toMatchObject({ Name: ENTREGA, Value: TOKEN_FICTICIO, Type: 'SecureString', KeyId: CHAVE, Overwrite: false, Tier: 'Advanced' });
    expect(JSON.parse(input.Policies ?? 'null')).toEqual([{ Type: 'Expiration', Version: '1.0', Attributes: { Timestamp: vence } }]);
  });

  it('validades: 72 h no provisionamento e 24 h na recuperação (iguais às do banco)', () => {
    expect(VALIDADE_DA_ENTREGA_HORAS).toEqual({ provisionamento: 72, recuperacao: 24, troca: 24 });
  });

  it('gravar sobre entrega existente: EntregaPendente, sem tentar de novo e sem a mensagem do SDK', async () => {
    const { ssm, send } = dubleDoSsm(() => Promise.reject(erroDoSdk('ParameterAlreadyExists')));
    const err = await criarParametrosSsm({ ssm, chaveKms: CHAVE, validadeHoras: 72 }).gravar(ENTREGA, TOKEN_FICTICIO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntregaPendente);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String((err as Error).message)).toBe('entrega_pendente');
  });

  it.each(['gravar', 'ler', 'apagar'] as const)('%s: outro erro do SDK vira FalhaDoSsm de mensagem fixa, sem cause, sem nome nem token', async (op) => {
    const { ssm } = dubleDoSsm(() => Promise.reject(erroDoSdk('AccessDeniedException')));
    const p = criarParametrosSsm({ ssm, chaveKms: CHAVE, validadeHoras: 24 });
    const err = (await (op === 'gravar' ? p.gravar(ENTREGA, TOKEN_FICTICIO) : p[op](ENTREGA)).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(FalhaDoSsm);
    expect(err.message).toBe(`ssm_falhou_${op}`);
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain(TOKEN_FICTICIO);
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain(ENTREGA);
  });

  it('ler: GetParameter com WithDecryption; ausente vira null', async () => {
    const { ssm, send } = dubleDoSsm(() => Promise.resolve({ Parameter: { Value: '{"email":"x"}' } }));
    const p = criarParametrosSsm({ ssm, chaveKms: CHAVE, validadeHoras: 72 });
    expect(await p.ler('/provisionamento/x')).toBe('{"email":"x"}');
    const comando = send.mock.calls[0]?.[0];
    expect(comando).toBeInstanceOf(GetParameterCommand);
    expect((comando as GetParameterCommand).input).toEqual({ Name: '/provisionamento/x', WithDecryption: true });

    const ausente = dubleDoSsm(() => Promise.reject(erroDoSdk('ParameterNotFound')));
    expect(await criarParametrosSsm({ ssm: ausente.ssm, chaveKms: CHAVE, validadeHoras: 72 }).ler('/provisionamento/x')).toBeNull();
  });

  it('ler: resposta sem valor é falha, não string vazia', async () => {
    const { ssm } = dubleDoSsm(() => Promise.resolve({ Parameter: {} }));
    await expect(criarParametrosSsm({ ssm, chaveKms: CHAVE, validadeHoras: 72 }).ler('/provisionamento/x')).rejects.toBeInstanceOf(FalhaDoSsm);
  });

  it('apagar: DeleteParameter; ausente não é erro', async () => {
    const { ssm, send } = dubleDoSsm();
    await criarParametrosSsm({ ssm, chaveKms: CHAVE, validadeHoras: 24 }).apagar(ENTREGA);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteParameterCommand);
    expect((send.mock.calls[0]?.[0] as DeleteParameterCommand).input).toEqual({ Name: ENTREGA });

    const ausente = dubleDoSsm(() => Promise.reject(erroDoSdk('ParameterNotFound')));
    await expect(criarParametrosSsm({ ssm: ausente.ssm, chaveKms: CHAVE, validadeHoras: 24 }).apagar(ENTREGA)).resolves.toBeUndefined();
  });
});

describe('configuração do cliente SSM (falha fechada: null vira ssm_nao_configurado)', () => {
  const BASE = { NODE_ENV: 'production', AWS_REGION: 'sa-east-1', SSM_KMS_KEY_ID: CHAVE } as NodeJS.ProcessEnv;

  it('com a chave do fluxo e sa-east-1: configurado', () => {
    expect(lerConfigDoSsm(BASE)).toEqual({ regiao: 'sa-east-1', chaveKms: CHAVE });
    expect(lerConfigDoSsm({ ...BASE, SSM_KMS_KEY_ID: 'arn:aws:kms:sa-east-1:000000000000:alias/staging-ops-recuperacao' })).not.toBeNull();
  });

  it.each([
    ['sem chave', { SSM_KMS_KEY_ID: undefined }],
    ['chave que não é ARN', { SSM_KMS_KEY_ID: 'alias/qualquer' }],
    ['chave de outra região', { SSM_KMS_KEY_ID: CHAVE.replace('sa-east-1', 'us-east-1') }],
    ['sem região', { AWS_REGION: undefined }],
    ['outra região', { AWS_REGION: 'us-east-1' }],
    ['regiões divergentes', { AWS_DEFAULT_REGION: 'us-east-1' }],
    ['credencial estática em produção', { AWS_ACCESS_KEY_ID: 'chave-estatica-ficticia' }],
    ['endpoint desviado em produção', { AWS_ENDPOINT_URL_SSM: 'http://127.0.0.1:4566' }],
  ])('%s: null', (_c, extra) => {
    expect(lerConfigDoSsm({ ...BASE, ...extra })).toBeNull();
  });

  it('em test, endpoint local é aceito (desenvolvimento com emulador)', () => {
    expect(lerConfigDoSsm({ ...BASE, NODE_ENV: 'test', AWS_ENDPOINT_URL_SSM: 'http://127.0.0.1:4566' })).not.toBeNull();
  });
});

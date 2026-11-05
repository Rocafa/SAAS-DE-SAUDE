import type { TenantId } from '@plataforma/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyUnavailableError } from './crypto-errors';
import type { DataKey } from './data-key';
import { KMS_DELETION_WINDOW_DAYS, KmsKeyProvider, papeisHumanosExtraDoAmbiente, politicaDaChaveDaClinica } from './kms-key-provider';
import { createKeyProvider } from './crypto.module';
import { DisposableKeys } from './disposable-keys';
import { LocalKeyProvider } from './local-key-provider';
import { CONTA_DE_TESTE as CONTA, fakeKms, kmsErro, type FakeKms } from '../../../test/kms-falso';

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const bytesOf = (k: DataKey): Buffer => k.use((b) => Buffer.from(b));

describe('LocalKeyProvider', () => {
  it('é recusado em produção', () => {
    expect(() => new LocalKeyProvider({ nodeEnv: 'production' })).toThrow(/produção/);
  });

  it('só aceita development/test (lista fechada): staging, vazio e variações são recusados', () => {
    for (const nodeEnv of ['staging', 'homolog', 'prod', 'Production', '', undefined]) {
      expect(() => new LocalKeyProvider({ nodeEnv })).toThrow();
      expect(() => createKeyProvider({ NODE_ENV: nodeEnv })).toThrow(/KMS não configurado/);
    }
    expect(() => new LocalKeyProvider({ nodeEnv: 'development' })).not.toThrow();
  });

  it('gera DEK de 32 bytes que volta igual ao abrir; a cifrada não contém a chave', async () => {
    const p = new LocalKeyProvider({ nodeEnv: 'test' });
    const master = await p.createMasterKey();
    const g = await p.generateDataKey(master, tenantA);
    const dek = bytesOf(g.plaintext);
    expect(dek).toHaveLength(32);
    expect(g.wrapped.includes(dek)).toBe(false);
    expect(bytesOf(await p.unwrapDataKey(g, tenantA))).toEqual(dek);
  });

  it('DEK de A não abre como B; chave mestra desconhecida ou destruída falha', async () => {
    const p = new LocalKeyProvider({ nodeEnv: 'test' });
    const master = await p.createMasterKey();
    const g = await p.generateDataKey(master, tenantA);
    await expect(p.unwrapDataKey(g, tenantB)).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(p.unwrapDataKey({ ...g, masterKeyId: 'local:outra' }, tenantA)).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
    await p.destroyMasterKey(master);
    await expect(p.unwrapDataKey(g, tenantA)).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(p.generateDataKey(master, tenantA)).rejects.toBeInstanceOf(KeyUnavailableError);
    // Dentro da janela, cancelar devolve a chave (como no KMS).
    await p.cancelMasterKeyDestruction(master);
    expect(bytesOf(await p.unwrapDataKey(g, tenantA))).toEqual(bytesOf(g.plaintext));
  });

  it('com rootSecret, outra instância (reinício) abre a mesma DEK; segredo curto é recusado', async () => {
    const secret = randomBytes(32);
    const p1 = new LocalKeyProvider({ nodeEnv: 'test', rootSecret: secret });
    const master = await p1.createMasterKey();
    const g = await p1.generateDataKey(master, tenantA);
    const p2 = new LocalKeyProvider({ nodeEnv: 'test', rootSecret: secret });
    expect(bytesOf(await p2.unwrapDataKey(g, tenantA))).toEqual(bytesOf(g.plaintext));
    expect(() => new LocalKeyProvider({ nodeEnv: 'test', rootSecret: randomBytes(16) })).toThrow();
  });

  it('rewrap troca a chave mestra sem mudar a DEK', async () => {
    const p = new LocalKeyProvider({ nodeEnv: 'test' });
    const m1 = await p.createMasterKey();
    const m2 = await p.createMasterKey();
    const g = await p.generateDataKey(m1, tenantA);
    const r = await p.rewrapDataKey(g, m2, tenantA);
    expect(r.masterKeyId).toBe(m2);
    await p.destroyMasterKey(m1);
    expect(bytesOf(await p.unwrapDataKey(r, tenantA))).toEqual(bytesOf(g.plaintext));
  });
});

describe('K-c2/K-c3: key policy da chave da clínica (parecer #76, 27/10)', () => {
  type Statement = {
    Sid: string;
    Effect: string;
    Principal: unknown;
    Action: string | string[];
    Resource: string;
    Condition?: Record<string, Record<string, string>>;
  };
  const OPERACOES = ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'];
  const ler = (tenant: TenantId) => JSON.parse(politicaDaChaveDaClinica(CONTA, tenant)) as { Version: string; Statement: Statement[] };

  it('tem o statement padrão da conta (administração por IAM; satisfaz a trava de lockout)', () => {
    const p = ler(tenantA);
    expect(p.Version).toBe('2012-10-17');
    expect(p.Statement).toContainEqual({
      Sid: 'Enable IAM User Permissions',
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${CONTA}:root` },
      Action: 'kms:*',
      Resource: '*',
    });
  });

  it('nega a todos (Principal "*") as operações de dados com tenant_id ausente (Null) OU diferente (StringNotEquals)', () => {
    const negacoes = ler(tenantA).Statement.filter((s) => s.Effect === 'Deny' && s.Principal === '*');
    expect(negacoes).toHaveLength(2);
    for (const s of negacoes) {
      expect(s.Principal).toBe('*');
      expect([...(s.Action as string[])].sort()).toEqual([...OPERACOES].sort());
      expect(s.Resource).toBe('*');
    }
    const condicoes = negacoes.map((s) => s.Condition);
    expect(condicoes).toContainEqual({ Null: { 'kms:EncryptionContext:tenant_id': 'true' } });
    // tenant_id LITERAL da clínica (nada de ${aws:ResourceTag/tenant_id}).
    expect(condicoes).toContainEqual({ StringNotEquals: { 'kms:EncryptionContext:tenant_id': tenantA } });
    expect(politicaDaChaveDaClinica(CONTA, tenantA)).not.toContain('${');
    expect(politicaDaChaveDaClinica(CONTA, tenantA)).not.toContain('ResourceTag');
  });

  it('é por clínica: a política de B não cita A', () => {
    expect(politicaDaChaveDaClinica(CONTA, tenantB)).toContain(tenantB);
    expect(politicaDaChaveDaClinica(CONTA, tenantB)).not.toContain(tenantA);
  });

  it('recusa conta que não seja 12 dígitos e tenant vazio ou com caractere fora de [A-Za-z0-9-]', () => {
    for (const c of ['', '123', '12345678901a', '1234567890123']) expect(() => politicaDaChaveDaClinica(c, tenantA), c).toThrow(/conta/);
    for (const t of ['', 'a"b', 'a b', '*']) expect(() => politicaDaChaveDaClinica(CONTA, t as TenantId), t).toThrow(/tenant/);
  });

  it('createMasterKey passa a Policy (clínica e lote), sem BypassPolicyLockoutSafetyCheck', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    await p.createMasterKey(tenantA);
    await p.createMasterKey(tenantA, { purpose: 'import_batch', batchId: randomUUID() });
    const criacoes = kms.calls.filter((c) => c.op === 'createKey').map((c) => c.input as Record<string, unknown>);
    expect(criacoes).toHaveLength(2);
    for (const input of criacoes) {
      expect(input.Policy).toBe(politicaDaChaveDaClinica(CONTA, tenantA));
      expect(input).not.toHaveProperty('BypassPolicyLockoutSafetyCheck');
      expect(JSON.stringify(input)).not.toContain('Bypass');
    }
  });

  it('o construtor exige a conta (12 dígitos): sem ela não há como montar a política', () => {
    expect(() => new KmsKeyProvider(fakeKms(), '')).toThrow(/conta/);
    expect(() => new KmsKeyProvider(fakeKms(), 'abc')).toThrow(/conta/);
  });

  it('KMS falso aplica a política: DEK sem contexto ou com outro tenant é negada (AccessDenied → acesso_negado)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    await expect(p.generateDataKey(arn, tenantB)).rejects.toMatchObject({ kind: 'acesso_negado' });
    await expect(kms.generateDataKey({ KeyId: arn, KeySpec: 'AES_256', EncryptionContext: {} })).rejects.toMatchObject({ name: 'AccessDeniedException' });
    const g = await p.generateDataKey(arn, tenantA);
    await expect(p.unwrapDataKey(g, tenantB)).rejects.toMatchObject({ kind: 'acesso_negado' });
  });

  it('KMS falso recusa CreateKey sem Policy ou com BypassPolicyLockoutSafetyCheck', async () => {
    const kms = fakeKms();
    const base = { Description: 'x', KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT', Tags: [] } as const;
    await expect(kms.createKey({ ...base, Tags: [] } as never)).rejects.toMatchObject({ name: 'MalformedPolicyDocumentException' });
    await expect(
      kms.createKey({ ...base, Tags: [], Policy: politicaDaChaveDaClinica(CONTA, tenantA), BypassPolicyLockoutSafetyCheck: true } as never),
    ).rejects.toMatchObject({ name: 'MalformedPolicyDocumentException' });
  });
});

describe('R4 (parecer #58): HumanoNaoDecifra na key policy da chave da clínica e do lote', () => {
  type Statement = { Sid: string; Effect: string; Principal: unknown; Action: string | string[]; Resource: string; Condition?: Record<string, Record<string, string[]>> };
  const ler = (extra?: readonly string[]) => JSON.parse(politicaDaChaveDaClinica(CONTA, tenantA, extra)) as { Statement: Statement[] };
  const PADROES = [`arn:aws:iam::${CONTA}:role/aws-reserved/sso.amazonaws.com/*`, `arn:aws:iam::${CONTA}:user/*`, `arn:aws:iam::${CONTA}:root`];
  const ROLE_API = `arn:aws:iam::${CONTA}:role/plataforma-saude-staging-api-tarefa`;
  const ROLE_GESTOR = `arn:aws:iam::${CONTA}:role/plataforma-saude-staging-gestor-chaves`;
  const ROLE_BREAK_GLASS = `arn:aws:iam::${CONTA}:role/plataforma-saude-staging-break-glass`;
  const HUMANOS = [
    `arn:aws:iam::${CONTA}:role/aws-reserved/sso.amazonaws.com/sa-east-1/AWSReservedSSO_Admin_0123456789abcdef`,
    `arn:aws:iam::${CONTA}:user/usuario-ficticio`,
    `arn:aws:iam::${CONTA}:root`,
  ];
  const EXTRA = `arn:aws:iam::${CONTA}:role/idp-externo-*`;

  it('Deny Decrypt/ReEncrypt*/CreateGrant por ArnLike aws:PrincipalArn (CreateGrant: parecer #76, 27/10)', () => {
    expect(ler().Statement.find((x) => x.Sid === 'HumanoNaoDecifra')).toEqual({
      Sid: 'HumanoNaoDecifra',
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: ['kms:Decrypt', 'kms:ReEncrypt*', 'kms:CreateGrant'],
      Resource: '*',
      Condition: { ArnLike: { 'aws:PrincipalArn': PADROES } },
    });
  });

  it('createMasterKey: chave da clínica E chave de lote levam o HumanoNaoDecifra (com os extras do provedor)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA, [EXTRA]);
    await p.createMasterKey(tenantA);
    await p.createMasterKey(tenantA, { purpose: 'import_batch', batchId: randomUUID() });
    const politicas = kms.calls
      .filter((c) => c.op === 'createKey')
      .map((c) => JSON.parse((c.input as { Policy: string }).Policy) as { Statement: Statement[] });
    expect(politicas).toHaveLength(2);
    for (const pol of politicas) {
      expect(pol.Statement.find((x) => x.Sid === 'HumanoNaoDecifra')?.Condition?.ArnLike?.['aws:PrincipalArn']).toEqual([...PADROES, EXTRA]);
    }
  });

  it('extras (var.papeis_humanos_extra) somam aos padrões fixos', () => {
    const extra = [EXTRA, `arn:aws:iam::${CONTA}:role/federado/medico-?`];
    expect(ler(extra).Statement.find((x) => x.Sid === 'HumanoNaoDecifra')?.Condition?.ArnLike?.['aws:PrincipalArn']).toEqual([...PADROES, ...extra]);
  });

  it('recusa extra de outra conta, fora do formato, vazio ou curinga total', () => {
    const ruins = [
      'arn:aws:iam::111111111111:role/idp-externo',
      'arn:aws:iam::*:role/idp',
      'role/idp',
      '',
      ' ',
      '*',
      `arn:aws:iam::${CONTA}:*`,
      `arn:aws:iam::${CONTA}:role/*`,
      `arn:aws:iam::${CONTA}:role/**`,
      `arn:aws:iam::${CONTA}:role/?*`,
      `arn:aws:iam::${CONTA}:user/`,
      `arn:aws:iam::${CONTA}:role/*api`,
      `arn:aws:iam::${CONTA}:role/a"b`,
      `arn:aws:sts::${CONTA}:assumed-role/x`,
      `arn:aws:iam::${CONTA}:group/admins`,
    ];
    for (const r of ruins) {
      expect(() => politicaDaChaveDaClinica(CONTA, tenantA, [r]), r).toThrow(/papel humano/);
      expect(() => new KmsKeyProvider(fakeKms(), CONTA, [r]), r).toThrow(/papel humano/);
    }
  });

  it('papeisHumanosExtraDoAmbiente: lista separada por vírgula; ausente/vazia = nenhum; item vazio recusado', () => {
    expect(papeisHumanosExtraDoAmbiente(undefined)).toEqual([]);
    expect(papeisHumanosExtraDoAmbiente('  ')).toEqual([]);
    expect(papeisHumanosExtraDoAmbiente(` arn:aws:iam::${CONTA}:role/a-* , arn:aws:iam::${CONTA}:role/b `)).toEqual([
      `arn:aws:iam::${CONTA}:role/a-*`,
      `arn:aws:iam::${CONTA}:role/b`,
    ]);
    expect(() => papeisHumanosExtraDoAmbiente(`arn:aws:iam::${CONTA}:role/a,,arn:aws:iam::${CONTA}:role/b`)).toThrow(/KMS_PAPEIS_HUMANOS_EXTRA/);
    expect(() => papeisHumanosExtraDoAmbiente(`arn:aws:iam::${CONTA}:role/a,`)).toThrow(/KMS_PAPEIS_HUMANOS_EXTRA/);
  });

  it('createKeyProvider lê KMS_PAPEIS_HUMANOS_EXTRA e recusa no boot o que for inválido (outra conta)', async () => {
    const env = {
      NODE_ENV: 'production',
      AWS_REGION: 'sa-east-1',
      SUPPORT_PSEUDONYM_KMS_KEY_ID: `arn:aws:kms:sa-east-1:${CONTA}:key/00000000-0000-0000-0000-000000000000`,
    };
    const kms = fakeKms();
    await createKeyProvider({ ...env, KMS_PAPEIS_HUMANOS_EXTRA: EXTRA }, { kms }).createMasterKey(tenantA);
    expect((kms.calls[0]?.input as { Policy: string }).Policy).toContain('idp-externo-*');
    expect(() => createKeyProvider({ ...env, KMS_PAPEIS_HUMANOS_EXTRA: 'arn:aws:iam::111111111111:role/x' }, { kms: fakeKms() })).toThrow(/papel humano/);
  });

  it('nenhum Deny atinge a role da API, o gestor de chaves nem o break-glass (fora dos padrões)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA, [EXTRA]);
    const arn = await p.createMasterKey(tenantA);
    const g = await p.generateDataKey(arn, tenantA);
    for (const principal of [ROLE_API, ROLE_GESTOR, ROLE_BREAK_GLASS]) {
      kms.principalArn = principal;
      await expect(p.unwrapDataKey(g, tenantA), principal).resolves.toBeDefined();
      await expect(p.rewrapDataKey(g, arn, tenantA), principal).resolves.toBeDefined();
    }
  });

  it('KMS falso aplica o Deny: humano (SSO, usuário IAM, root, extra) não decifra nem recifra, nem com o contexto certo', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA, [EXTRA]);
    const arn = await p.createMasterKey(tenantA);
    const g = await p.generateDataKey(arn, tenantA);
    for (const principal of [...HUMANOS, `arn:aws:iam::${CONTA}:role/idp-externo-medico`]) {
      kms.principalArn = principal;
      await expect(p.unwrapDataKey(g, tenantA), principal).rejects.toMatchObject({ kind: 'acesso_negado' });
      await expect(p.rewrapDataKey(g, arn, tenantA), principal).rejects.toMatchObject({ kind: 'acesso_negado' });
      // GenerateDataKey fica fora do Deny (igual ao Terraform).
      await expect(p.generateDataKey(arn, tenantA), principal).resolves.toBeDefined();
    }
  });

  it('KMS falso: humano não cria grant (nem para um papel de máquina que assume); API, gestor e break-glass não são atingidos', async () => {
    const kms = fakeKms();
    const arn = await new KmsKeyProvider(kms, CONTA, [EXTRA]).createMasterKey(tenantA);
    const grant = { KeyId: arn, GranteePrincipal: ROLE_API, Operations: ['Decrypt'] };
    for (const principal of [...HUMANOS, `arn:aws:iam::${CONTA}:role/idp-externo-medico`]) {
      kms.principalArn = principal;
      await expect(kms.createGrant(grant), principal).rejects.toMatchObject({ name: 'AccessDeniedException' });
    }
    for (const principal of [ROLE_API, ROLE_GESTOR, ROLE_BREAK_GLASS]) {
      kms.principalArn = principal;
      await expect(kms.createGrant(grant), principal).resolves.toBeDefined();
    }
  });
});

describe('KmsKeyProvider (contra KMS falso)', () => {
  it('cria uma chave por clínica com tag e rotação automática ligada', async () => {
    const kms = fakeKms();
    const arn = await new KmsKeyProvider(kms, CONTA).createMasterKey(tenantA);
    expect(arn).toMatch(/^arn:aws:kms:sa-east-1:/);
    expect(kms.calls[0]?.input).toMatchObject({
      Description: 'plataforma-saude: chave mestra de dados de uma clínica',
      Tags: [
        { TagKey: 'tenant_id', TagValue: tenantA },
        { TagKey: 'purpose', TagValue: 'tenant_data' },
      ],
    });
    expect(kms.calls[1]).toEqual({ op: 'enableKeyRotation', input: { KeyId: arn } });
  });

  it('R3-b: a chave de lote nasce com purpose=import_batch, batch_id e descrição própria, sem rotação', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const lote = randomUUID();
    await p.createMasterKey(tenantA, { purpose: 'import_batch', batchId: lote });
    await p.createMasterKey(tenantA);
    const [doLote, daClinica] = kms.calls.filter((c) => c.op === 'createKey').map((c) => c.input as { Description: string; Tags: { TagKey: string; TagValue: string }[] });
    expect(doLote?.Tags).toEqual([
      { TagKey: 'tenant_id', TagValue: tenantA },
      { TagKey: 'purpose', TagValue: 'import_batch' },
      { TagKey: 'batch_id', TagValue: lote },
    ]);
    // Descrição e tag `purpose` diferentes das da chave da clínica: é o que o IAM usa para separar as duas.
    expect(doLote?.Description).not.toBe(daClinica?.Description);
    expect(daClinica?.Tags.find((t) => t.TagKey === 'purpose')?.TagValue).toBe('tenant_data');
    expect(daClinica?.Tags.some((t) => t.TagKey === 'batch_id')).toBe(false);
    // Rotação só na chave da clínica (a de lote vive ≤ 7 dias).
    expect(kms.calls.filter((c) => c.op === 'enableKeyRotation')).toHaveLength(1);
  });

  it('amarra a DEK à clínica pelo EncryptionContext', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    const g = await p.generateDataKey(arn, tenantA);
    expect(kms.calls.find((c) => c.op === 'generateDataKey')?.input).toMatchObject({
      KeySpec: 'AES_256',
      EncryptionContext: { tenant_id: tenantA },
    });
    expect(bytesOf(await p.unwrapDataKey(g, tenantA))).toEqual(bytesOf(g.plaintext));
    await expect(p.unwrapDataKey(g, tenantB)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('destruição agenda a exclusão com a janela mínima de 7 dias', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    await p.destroyMasterKey(arn);
    expect(KMS_DELETION_WINDOW_DAYS).toBe(7);
    expect(kms.calls.at(-1)).toEqual({ op: 'scheduleKeyDeletion', input: { KeyId: arn, PendingWindowInDays: 7 } });
  });

  it('destruir de novo uma chave já pendente é idempotente (retomada da eliminação)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    await p.destroyMasterKey(arn);
    await expect(p.destroyMasterKey(arn)).resolves.toBeUndefined();
    expect(kms.calls.at(-1)).toEqual({ op: 'describeKey', input: { KeyId: arn } });
  });

  it('erro de agendamento com a chave ainda ativa NÃO é tratado como feito', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    kms.scheduleKeyDeletion = () => Promise.reject(kmsErro('AccessDeniedException'));
    await expect(p.destroyMasterKey(await p.createMasterKey(tenantA))).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('observação 2: chave que o KMS já excluiu (passou a janela de 7 dias) conta como destruída', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    // Agendada, a linha não fechou (banco caiu) e o KMS excluiu depois dos 7 dias: NotFound no agendamento.
    const arn = await p.createMasterKey(tenantA, { purpose: 'import_batch', batchId: randomUUID() });
    await p.destroyMasterKey(arn);
    kms.excluir(arn);
    await expect(p.destroyMasterKey(arn)).resolves.toBeUndefined();
    // KMSInvalidStateException no agendamento e NotFound no describe (excluída entre as duas chamadas).
    const outra = await p.createMasterKey(tenantA, { purpose: 'import_batch', batchId: randomUUID() });
    await p.destroyMasterKey(outra);
    const describe = kms.describeKey.bind(kms);
    kms.describeKey = (input) => {
      kms.excluir(input.KeyId);
      return describe(input);
    };
    await expect(p.destroyMasterKey(outra)).resolves.toBeUndefined();
    expect(kms.calls.slice(-2).map((c) => c.op)).toEqual(['scheduleKeyDeletion', 'describeKey']);
  });

  it('observação 2: NotFound só conta como feito para NotFound; outro erro no describe segue falhando', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    kms.scheduleKeyDeletion = () => Promise.reject(kmsErro('KMSInvalidStateException'));
    kms.describeKey = () => Promise.reject(kmsErro('ThrottlingException', 'Rate exceeded', 400));
    const err = await p.destroyMasterKey(arn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect((err as KeyUnavailableError).kind).toBe('indisponivel');
  });

  it('observação 3: o erro do KMS vira um TIPO de lista fechada (sem mensagem nem ARN)', async () => {
    const casos: readonly [Error, string][] = [
      [kmsErro('AccessDeniedException', 'User: arn:aws:iam::123456789012:role/api is not authorized'), 'acesso_negado'],
      [kmsErro('ThrottlingException', 'Rate exceeded'), 'indisponivel'],
      [kmsErro('KMSInternalException'), 'indisponivel'],
      [kmsErro('DependencyTimeoutException'), 'indisponivel'],
      [kmsErro('KMSInvalidStateException', 'arn:aws:kms:sa-east-1:123456789012:key/x is pending deletion'), 'estado_invalido'],
      [kmsErro('DisabledException'), 'estado_invalido'],
      [kmsErro('Desconhecido', 'qualquer', 403), 'acesso_negado'],
      [kmsErro('Desconhecido', 'qualquer', 503), 'indisponivel'],
      [new Error('AccessDeniedException arn:aws:kms:sa-east-1:123456789012:key/x'), 'outro'],
      [kmsErro('ValidationException'), 'outro'],
    ];
    for (const [erro, tipo] of casos) {
      const kms = fakeKms();
      kms.createKey = () => Promise.reject(erro);
      const err = await new KmsKeyProvider(kms, CONTA).createMasterKey(tenantA).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeyUnavailableError);
      expect((err as KeyUnavailableError).kind, erro.name).toBe(tipo);
      expect((err as Error).message).toBe('chave de criptografia indisponível');
      expect(JSON.stringify(err)).not.toMatch(/arn:|123456789012|Rate|pending/);
    }
    // Agendamento recusado pelo IAM: a destruição falha com o tipo do agendamento (não do describe).
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    kms.scheduleKeyDeletion = () => Promise.reject(kmsErro('AccessDeniedException'));
    expect(((await p.destroyMasterKey(arn).catch((e: unknown) => e)) as KeyUnavailableError).kind).toBe('acesso_negado');
  });

  it('cancelar a destruição cancela o agendamento e reabilita a chave (fica Disabled no KMS)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms, CONTA);
    const arn = await p.createMasterKey(tenantA);
    await p.destroyMasterKey(arn);
    await p.cancelMasterKeyDestruction(arn);
    expect(kms.calls.slice(-2)).toEqual([
      { op: 'cancelKeyDeletion', input: { KeyId: arn } },
      { op: 'enableKey', input: { KeyId: arn } },
    ]);
  });

  it('erro do SDK vira erro de mensagem fixa, sem ARN nem causa', async () => {
    const kms = fakeKms();
    kms.fail = true;
    const err = await new KmsKeyProvider(kms, CONTA).createMasterKey(tenantA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect((err as Error).message).not.toMatch(/arn|segredo|AccessDenied/);
    expect((err as Error).cause).toBeUndefined();
  });
});

describe('DisposableKeys: chave descartável por escopo (R3 do importador, crypto-shredding por lote)', () => {
  const lote = randomUUID();
  const ref = { tenantId: tenantA, table: 'import_raw_files', column: 'content', rowId: lote };
  const bruto = Buffer.from('nome;cpf\nPaciente Ficticio;00000000191\n');
  const provedores: readonly [string, () => { provider: LocalKeyProvider | KmsKeyProvider; kms?: FakeKms }][] = [
    ['provedor local', () => ({ provider: new LocalKeyProvider({ nodeEnv: 'test' }) })],
    [
      'KMS falso',
      () => {
        const kms = fakeKms();
        return { provider: new KmsKeyProvider(kms, CONTA), kms };
      },
    ],
  ];

  for (const [nome, criar] of provedores) {
    it(`${nome}: abre antes; depois de destruir, nem a cópia de backup (chave embrulhada + cifra) abre`, async () => {
      const { provider, kms } = criar();
      const chaves = new DisposableKeys(provider);
      const { key, sealed } = await chaves.createAndSeal(tenantA, lote, ref, bruto);
      expect(sealed.startsWith(`v1:${lote}:`)).toBe(true);
      expect(sealed).not.toContain('Ficticio');
      expect(await chaves.open(tenantA, key, ref, sealed)).toEqual(bruto);
      // Outra clínica e outra linha não abrem (EncryptionContext/AAD).
      await expect(chaves.open(tenantB, key, { ...ref, tenantId: tenantB }, sealed)).rejects.toThrow();
      await expect(chaves.open(tenantA, key, { ...ref, rowId: randomUUID() }, sealed)).rejects.toThrow();
      // "Backup": cópia da linha da chave e do valor cifrado tirada ANTES do descarte.
      const backup = { key: { ...key, wrapped: Buffer.from(key.wrapped) }, sealed };
      await chaves.destroy(tenantA, key.masterKeyId);
      await expect(chaves.open(tenantA, backup.key, ref, backup.sealed)).rejects.toBeInstanceOf(KeyUnavailableError);
      if (kms) {
        // R3-b: a tag de finalidade vai NA CRIAÇÃO (o IAM condiciona CreateKey a aws:RequestTag/purpose).
        expect(kms.calls.find((c) => c.op === 'createKey')?.input).toMatchObject({
          Tags: [
            { TagKey: 'tenant_id', TagValue: tenantA },
            { TagKey: 'purpose', TagValue: 'import_batch' },
            { TagKey: 'batch_id', TagValue: lote },
          ],
        });
        expect(kms.calls.some((c) => c.op === 'enableKeyRotation')).toBe(false);
        expect(kms.calls.find((c) => c.op === 'generateDataKey')?.input).toMatchObject({ EncryptionContext: { tenant_id: tenantA } });
        expect(kms.calls.find((c) => c.op === 'scheduleKeyDeletion')).toEqual({
          op: 'scheduleKeyDeletion',
          input: { KeyId: key.masterKeyId, PendingWindowInDays: 7 },
        });
      }
      // Idempotente.
      await expect(chaves.destroy(tenantA, key.masterKeyId)).resolves.toBeUndefined();
    });
  }

  it('cada escopo tem a própria chave mestra: destruir um lote não afeta outro da mesma clínica', async () => {
    const chaves = new DisposableKeys(new LocalKeyProvider({ nodeEnv: 'test' }));
    const outro = randomUUID();
    const a = await chaves.createAndSeal(tenantA, lote, ref, bruto);
    const b = await chaves.createAndSeal(tenantA, outro, { ...ref, rowId: outro }, bruto);
    expect(a.key.masterKeyId).not.toBe(b.key.masterKeyId);
    await chaves.destroy(tenantA, a.key.masterKeyId);
    expect(await chaves.open(tenantA, b.key, { ...ref, rowId: outro }, b.sealed)).toEqual(bruto);
  });
});

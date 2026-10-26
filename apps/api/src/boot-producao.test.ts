/**
 * Boot com NODE_ENV=production (rodada 27): com a configuração que o Terraform entrega, só a D4
 * (login real da clínica, login e código do portal) impede a API de subir. Aqui a D4 é simulada por
 * stubs DE TESTE (nenhum provedor real é criado) e o KMS é o falso de test/kms-falso.ts.
 * Os segredos são aleatórios por execução: nada fixo, nada real.
 */
import 'reflect-metadata';
import type { DynamicModule, Provider } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeKms, kmsFalso } from '../test/kms-falso';
import { AppModule, type AppAdapters } from './app.module';
import { PSEUDONYM_SIGNER, type PseudonymSigner } from './modules/audit/ator-suporte';
import { AuditModule } from './modules/audit/audit.module';
import type { AuthProvider } from './modules/auth/auth-context';
import { CryptoModule, DISPOSABLE_KEYS } from './modules/crypto/crypto.module';
import type { DisposableKeys } from './modules/crypto/disposable-keys';
import type { KmsCliente } from './modules/crypto/kms-client';
import type { PortalAuthProvider } from './modules/portal/portal-auth';
import type { PortalOtpSender } from './modules/portal/portal-otp';
import { MemoryRateLimitStore } from './security/rate-limit-store';

const ARN_HMAC = 'arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-000000000000';
const config = { port: 1, databaseUrl: 'postgresql://ninguem@127.0.0.1:1/x', exitWindowDays: 90 } as never;

/** Stubs da D4: só existem neste teste e recusam qualquer uso. */
const d4: { authProvider: AuthProvider; portalAuthProvider: PortalAuthProvider; portalOtpSender: PortalOtpSender } = {
  authProvider: { tipo: 'stub-d4', resolver: () => Promise.reject(new Error('stub D4')) } satisfies AuthProvider,
  portalAuthProvider: {
    tipo: 'stub-d4',
    resolver: () => Promise.reject(new Error('stub D4')),
    escolherVinculo: () => Promise.reject(new Error('stub D4')),
  } satisfies PortalAuthProvider,
  portalOtpSender: { tipo: 'stub-d4', enviar: () => Promise.reject(new Error('stub D4')) } satisfies PortalOtpSender,
};

/** O ambiente de produção como o Terraform (#58, infra-staging.md §4.5) o monta, com AWS_REGION explícita. */
function ambienteDeProducao(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    AWS_REGION: 'sa-east-1',
    SUPPORT_PSEUDONYM_KMS_KEY_ID: ARN_HMAC,
    PAGINATION_CURSOR_KEY: randomBytes(48).toString('base64url'),
    RATE_LIMIT_HASH_KEY: randomBytes(48).toString('base64url'),
    WHATSAPP_PROVEDOR: 'desligado',
    IMPORTADOR_HABILITADO: 'false',
  };
}

function kmsDuplo(): KmsCliente & { calls: { op: string }[] } {
  const chaves = fakeKms();
  const mac = kmsFalso(randomBytes(32));
  return Object.assign(chaves, {
    generateMac: (input: Parameters<typeof mac.generateMac>[0]) => mac.generateMac(input),
    verifyMac: (input: Parameters<typeof mac.verifyMac>[0]) => mac.verifyMac(input),
  });
}

function providerDe(mod: DynamicModule, alvo: unknown, token: symbol): Provider & { useValue?: unknown; useFactory?: () => unknown } {
  const m = (mod.imports ?? []).find((i): i is DynamicModule => typeof i === 'object' && i !== null && 'module' in i && i.module === alvo);
  const p = m?.providers?.find((x) => typeof x === 'object' && 'provide' in x && x.provide === token);
  if (!p) throw new Error('provider não encontrado');
  return p as Provider & { useValue?: unknown; useFactory?: () => unknown };
}

describe('boot em NODE_ENV=production: só a D4 impede a subida', () => {
  const original = { ...process.env };
  const nomes = [...Object.keys(ambienteDeProducao()), 'REDIS_URL', 'AWS_DEFAULT_REGION', 'FIELD_KEYS_DEV_ROOT_SECRET', 'SUPPORT_PSEUDONYM_KEY'];
  let env: Record<string, string>;

  beforeEach(() => {
    for (const n of nomes) delete process.env[n];
    env = ambienteDeProducao();
    Object.assign(process.env, env);
  });
  afterEach(() => {
    for (const n of nomes) delete process.env[n];
    for (const n of nomes) if (original[n] !== undefined) process.env[n] = original[n];
    vi.restoreAllMocks();
  });

  const adapters = (extra: AppAdapters = {}): AppAdapters => ({ ...d4, rateLimitStore: new MemoryRateLimitStore(), ...extra });

  it('configuração completa + stub da D4: monta, com chave mestra e pseudônimo no KMS', async () => {
    const kms = kmsDuplo();
    const mod = AppModule.forRoot(config, adapters({ kms }));

    const signer = providerDe(mod, AuditModule, PSEUDONYM_SIGNER).useValue as PseudonymSigner;
    expect(signer.tipo).toBe('kms');
    const tenant = randomUUID() as TenantId;
    expect(await signer.pseudonimo(tenant, 'atendente-01')).toMatch(/^[0-9a-f-]{36}$/);

    // A chave mestra sai do KmsKeyProvider (a chave descartável usa o MESMO provedor).
    const descartaveis = providerDe(mod, CryptoModule, DISPOSABLE_KEYS).useFactory?.() as DisposableKeys;
    const arn = await descartaveis.create(tenant, randomUUID());
    expect(arn).toMatch(/^arn:aws:kms:sa-east-1:/);
    expect(kms.calls.map((c) => c.op)).toContain('createKey');
  });

  it('sem cliente injetado, monta o adaptador do @aws-sdk/client-kms a partir do ambiente (sem rede no boot)', () => {
    const mod = AppModule.forRoot(config, adapters());
    expect((providerDe(mod, AuditModule, PSEUDONYM_SIGNER).useValue as PseudonymSigner).tipo).toBe('kms');
  });

  it('sem a D4 (sem stub), recusa: é o único bloqueio restante', () => {
    expect(() => AppModule.forRoot(config, { rateLimitStore: new MemoryRateLimitStore(), kms: kmsDuplo() })).toThrow(/D4/);
    const semLoginDoPortal: AppAdapters = { authProvider: d4.authProvider, portalOtpSender: d4.portalOtpSender, rateLimitStore: new MemoryRateLimitStore(), kms: kmsDuplo() };
    expect(() => AppModule.forRoot(config, semLoginDoPortal)).toThrow(/D4/);
    const semCodigoDoPortal: AppAdapters = { authProvider: d4.authProvider, portalAuthProvider: d4.portalAuthProvider, rateLimitStore: new MemoryRateLimitStore(), kms: kmsDuplo() };
    expect(() => AppModule.forRoot(config, semCodigoDoPortal)).toThrow(/D4/);
  });

  it.each([
    ['AWS_REGION', /KMS não configurado.*AWS_REGION/],
    ['SUPPORT_PSEUDONYM_KMS_KEY_ID', /KMS do pseudônimo do suporte não configurado/],
    ['PAGINATION_CURSOR_KEY', /PAGINATION_CURSOR_KEY é obrigatória/],
    ['RATE_LIMIT_HASH_KEY', /RATE_LIMIT_HASH_KEY é obrigatória/],
  ])('sem %s, recusa com mensagem clara', (nome, mensagem) => {
    delete process.env[nome];
    expect(() => AppModule.forRoot(config, adapters())).toThrow(mensagem);
  });

  it('recusa região fora da lista, credencial estática, endpoint desviado e segredos locais de dev', () => {
    const casos: [string, string, RegExp][] = [
      ['AWS_REGION', 'us-east-1', /lista permitida/],
      ['AWS_DEFAULT_REGION', 'us-east-2', /divergem/],
      ['AWS_ACCESS_KEY_ID', 'AKIA' + randomBytes(8).toString('hex').toUpperCase(), /AWS_ACCESS_KEY_ID proibida/],
      ['AWS_SECRET_ACCESS_KEY', randomBytes(30).toString('base64'), /AWS_SECRET_ACCESS_KEY proibida/],
      ['AWS_ENDPOINT_URL_KMS', 'http://127.0.0.1:1', /AWS_ENDPOINT_URL_KMS proibida/],
      ['FIELD_KEYS_DEV_ROOT_SECRET', randomBytes(32).toString('base64'), /FIELD_KEYS_DEV_ROOT_SECRET é proibida/],
      ['SUPPORT_PSEUDONYM_KEY', randomBytes(32).toString('base64'), /SUPPORT_PSEUDONYM_KEY é proibida/],
      ['SUPPORT_PSEUDONYM_KMS_KEY_ID', 'alias/qualquer', /precisa ser o ARN/],
    ];
    for (const [nome, valor, mensagem] of casos) {
      const antes = process.env[nome];
      process.env[nome] = valor;
      try {
        let erro: Error | undefined;
        try {
          AppModule.forRoot(config, adapters());
        } catch (e) {
          erro = e as Error;
        }
        expect(erro?.message, nome).toMatch(mensagem);
        // Nenhum valor de variável (segredo, chave, endpoint) aparece na mensagem.
        expect(erro?.message, nome).not.toContain(valor);
      } finally {
        if (antes === undefined) delete process.env[nome];
        else process.env[nome] = antes;
      }
    }
  });

  it('nenhum segredo vai para o log no boot', () => {
    const saidas: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void saidas.push(a.map(String).join(' ')));
    }
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (saidas.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (saidas.push(String(c)), true));
    AppModule.forRoot(config, adapters({ kms: kmsDuplo() }));
    vi.restoreAllMocks();
    const tudo = saidas.join('\n');
    for (const nome of ['PAGINATION_CURSOR_KEY', 'RATE_LIMIT_HASH_KEY']) expect(tudo).not.toContain(env[nome]);
    expect(tudo).not.toContain(ARN_HMAC);
  });
});

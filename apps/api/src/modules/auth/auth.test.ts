import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { createKeyProvider } from '../crypto/crypto.module';
import { createAuthProvider } from './auth-provider.factory';
import { DevSessionProvider } from './dev-session.provider';
import { PERFIS, PERMISSOES, podeLerConteudoClinico, temPermissao } from './perfis';

const tenant = randomUUID();
const usuario = randomUUID();

describe('provedor de autenticação plugável', () => {
  const envOriginal = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = envOriginal;
  });

  it('em produção, sem provedor real, recusa subir', () => {
    expect(() => createAuthProvider({ NODE_ENV: 'production' })).toThrow(/produção/);
    expect(() => createAuthProvider({ NODE_ENV: 'production', AUTH_PROVIDER: 'dev' })).toThrow(/produção/);
    expect(() => new DevSessionProvider('production')).toThrow();
    expect(() => createKeyProvider({ NODE_ENV: 'production' })).toThrow(/produção/);
  });

  it('o AppModule não monta em NODE_ENV=production (falha no boot, antes de abrir porta)', () => {
    process.env.NODE_ENV = 'production';
    const config = { port: 1, databaseUrl: 'postgresql://ninguem@127.0.0.1:1/x', exitWindowDays: 90 } as never;
    expect(() => AppModule.forRoot(config)).toThrow(/produção/);
  });

  it('sessão fictícia só com NODE_ENV development/test: staging, vazio ou qualquer outro valor recusa subir', () => {
    for (const nodeEnv of ['staging', 'homolog', 'prod', 'Production', '', undefined]) {
      expect(() => createAuthProvider({ NODE_ENV: nodeEnv })).toThrow(/produção|staging/);
    }
    // undefined no construtor cai no padrão (process.env.NODE_ENV, que no Vitest é 'test').
    for (const nodeEnv of ['staging', 'homolog', 'prod', 'Production', '']) {
      expect(() => new DevSessionProvider(nodeEnv)).toThrow();
    }
  });

  it('fora de produção usa a sessão fictícia; provedor desconhecido é erro', () => {
    expect(createAuthProvider({ NODE_ENV: 'test' }).tipo).toBe('dev');
    expect(() => createAuthProvider({ NODE_ENV: 'development', AUTH_PROVIDER: 'zitadel' })).toThrow();
  });
});

describe('DevSessionProvider', () => {
  it('resolve a sessão só pelo token; clínica e perfis vêm do servidor', async () => {
    const p = new DevSessionProvider('test');
    const token = p.criarSessao({ tenantId: tenant, userId: usuario, perfis: ['recepcao'] });
    const outra = randomUUID();
    const ctx = await p.resolver({ headers: { authorization: `Bearer ${token}`, 'x-tenant-id': outra, 'x-clinica-id': outra } });
    expect(ctx).toEqual({ tenantId: tenant, userId: usuario, perfis: ['recepcao'] });
  });

  it('sem token, token malformado, desconhecido ou de sessão encerrada: null', async () => {
    const p = new DevSessionProvider('test');
    const token = p.criarSessao({ tenantId: tenant, userId: usuario, perfis: ['admin'] });
    expect(await p.resolver({ headers: {} })).toBeNull();
    expect(await p.resolver({ headers: { authorization: token } })).toBeNull();
    expect(await p.resolver({ headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).toBeNull();
    expect(await p.resolver({ headers: { authorization: [`Bearer ${token}`] } })).toBeNull();
    p.encerrarSessao(token);
    expect(await p.resolver({ headers: { authorization: `Bearer ${token}` } })).toBeNull();
  });

  it('recusa sessão com clínica/usuário que não são UUID ou perfil desconhecido', () => {
    const p = new DevSessionProvider('test');
    expect(() => p.criarSessao({ tenantId: 'clinica-a', userId: usuario, perfis: ['admin'] })).toThrow();
    expect(() => p.criarSessao({ tenantId: tenant, userId: usuario, perfis: [] })).toThrow();
    expect(() => p.criarSessao({ tenantId: tenant, userId: usuario, perfis: ['root'] })).toThrow();
  });
});

describe('perfis e permissões', () => {
  it('recepção cadastra e agenda, mas não atende nem lê conteúdo clínico', () => {
    expect(temPermissao(['recepcao'], 'pacientes:escrever')).toBe(true);
    expect(temPermissao(['recepcao'], 'agenda:escrever')).toBe(true);
    expect(temPermissao(['recepcao'], 'agenda:atender')).toBe(false);
    expect(temPermissao(['recepcao'], 'conteudo_clinico:ler')).toBe(false);
  });

  it('financeiro só lê; admin gere cadastros mas não é perfil clínico (front-r8 B1)', () => {
    expect(temPermissao(['financeiro'], 'pacientes:ler')).toBe(true);
    expect(temPermissao(['financeiro'], 'pacientes:escrever')).toBe(false);
    expect(temPermissao(['financeiro'], 'agenda:escrever')).toBe(false);
    expect(temPermissao(['admin'], 'cadastros:gerir')).toBe(true);
    expect(temPermissao(['admin'], 'conteudo_clinico:ler')).toBe(false);
    expect(temPermissao(['admin', 'profissional'], 'conteudo_clinico:ler')).toBe(true);
  });

  it('conteúdo clínico exige perfil clínico E vínculo de cuidado', () => {
    expect(podeLerConteudoClinico(['profissional'], { temVinculo: true })).toBe(true);
    expect(podeLerConteudoClinico(['profissional'], { temVinculo: false })).toBe(false);
    for (const p of PERFIS.filter((x) => x !== 'profissional')) {
      expect(podeLerConteudoClinico([p], { temVinculo: true }), p).toBe(false);
    }
  });

  it('só os perfis conhecidos aparecem na matriz', () => {
    for (const autorizados of Object.values(PERMISSOES)) {
      expect(autorizados.every((p) => (PERFIS as readonly string[]).includes(p))).toBe(true);
    }
  });
});

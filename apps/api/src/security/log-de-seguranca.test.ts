/**
 * Log de segurança: formato fechado, nenhum dado pessoal, IP nunca em claro, e os eventos certos no guard de sessão.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessaoGuard } from '../modules/auth/sessao.guard';
import type { AuthContext, AuthProvider } from '../modules/auth/auth-context';
import { MFA_RECENTE_KEY } from '../modules/auth/mfa';
import {
  EVENTOS_DE_SEGURANCA,
  linhaDeSeguranca,
  MOTIVOS_DE_SEGURANCA,
  origemDaRequisicao,
  REGRAS_DE_SEGURANCA,
  registrarEventoDeSeguranca,
  registrarNoMaximoUmaVez,
  VALOR_INVALIDO,
} from './log-de-seguranca';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const DADOS_PESSOAIS = ['Maria da Silva', '123.456.789-09', '12345678909', '(11) 98765-4321', 'maria@exemplo.com', 'queixa: ansiedade', 'Error: paciente Maria não encontrado'];

describe('linhaDeSeguranca', () => {
  it('uma linha JSON com tipo, evento, severidade, alarme e data', () => {
    const l = JSON.parse(linhaDeSeguranca('MFA_RECUSADO', { tenantId: TENANT, userId: USER, motivo: 'mfa_recente_obrigatorio' }, new Date('2026-11-04T10:00:00Z'))) as Record<string, unknown>;
    expect(l).toEqual({
      tipo: 'seguranca',
      evento: 'MFA_RECUSADO',
      severidade: 'aviso',
      alarme: 'volume',
      em: '2026-11-04T10:00:00.000Z',
      tenantId: TENANT,
      userId: USER,
      motivo: 'mfa_recente_obrigatorio',
    });
  });

  it('dado pessoal em qualquer campo vira [invalido] e nunca aparece na linha', () => {
    for (const dado of DADOS_PESSOAIS) {
      const linha = linhaDeSeguranca('ALERTA_ANOMALIA', { tenantId: dado, userId: dado, motivo: dado, regra: dado, rota: dado, handler: dado, origem: dado });
      expect(linha).not.toContain(dado);
      expect(JSON.parse(linha)).toMatchObject({ tenantId: VALOR_INVALIDO, motivo: VALOR_INVALIDO, rota: VALOR_INVALIDO });
    }
  });

  it('rota só como template: URL real com id ou query é recusada', () => {
    expect(JSON.parse(linhaDeSeguranca('SESSAO_INVALIDA', { rota: 'GET /pacientes/:id' }))).toMatchObject({ rota: 'GET /pacientes/:id' });
    expect(JSON.parse(linhaDeSeguranca('SESSAO_INVALIDA', { rota: 'GET /pacientes?cpf=12345678909' }))).toMatchObject({ rota: VALOR_INVALIDO });
  });

  it('campo fora da lista fechada é descartado', () => {
    const linha = linhaDeSeguranca('SESSAO_INVALIDA', { nome: 'Maria da Silva', cpf: '12345678909' } as never);
    expect(linha).not.toContain('Maria');
    expect(linha).not.toContain('cpf');
  });

  it('números fora da faixa são recusados', () => {
    expect(JSON.parse(linhaDeSeguranca('RATE_LIMIT_EXCEDIDO', { contagem: -1, status: 42 }))).toMatchObject({ contagem: VALOR_INVALIDO, status: VALOR_INVALIDO });
  });

  it('todo evento do catálogo tem severidade, alarme e descrição', () => {
    for (const [nome, def] of Object.entries(EVENTOS_DE_SEGURANCA)) {
      expect(nome).toMatch(/^[A-Z][A-Z_]+$/);
      expect(['aviso', 'alto', 'critico']).toContain(def.severidade);
      expect(['imediato', 'volume']).toContain(def.alarme);
      expect(def.descricao.length).toBeGreaterThan(10);
    }
  });
});

describe('origemDaRequisicao', () => {
  it('nunca devolve o IP: HMAC de 16 hex, estável para o mesmo IP e diferente entre IPs', () => {
    const segredo = Buffer.alloc(32, 7);
    const a = origemDaRequisicao('198.51.100.9', segredo);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('198');
    expect(origemDaRequisicao('198.51.100.9', segredo)).toBe(a);
    expect(origemDaRequisicao('198.51.100.10', segredo)).not.toBe(a);
  });
});

describe('registrarEventoDeSeguranca', () => {
  it('aviso vai como warn; alto e crítico vão como error (alarme)', () => {
    const saida = { warn: vi.fn(), error: vi.fn() };
    registrarEventoDeSeguranca('SESSAO_INVALIDA', {}, saida);
    registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', {}, saida);
    registrarEventoDeSeguranca('ALERTA_ANOMALIA', {}, saida);
    expect(saida.warn).toHaveBeenCalledTimes(1);
    expect(saida.error).toHaveBeenCalledTimes(2);
  });
});

describe('guard de sessão gera os eventos de segurança', () => {
  afterEach(() => vi.restoreAllMocks());

  const contexto = (req: Record<string, unknown>, permissao: string | undefined, janelaMfa?: number): { ctx: ExecutionContext; reflector: Reflector } => {
    const handler = function listar(): void {};
    class PacientesController {}
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((chave: unknown) => (chave === 'plataforma:permissao' ? permissao : chave === MFA_RECENTE_KEY ? janelaMfa : undefined));
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => PacientesController,
    } as unknown as ExecutionContext;
    return { ctx, reflector };
  };
  const provider = (auth: AuthContext | null): AuthProvider => ({ tipo: 'teste', resolver: () => Promise.resolve(auth) });
  const linhas = (espiao: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    espiao.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.startsWith("{")).map((s: string) => JSON.parse(s) as Record<string, unknown>);

  it('401: SESSAO_INVALIDA com o template da rota e a origem em HMAC, sem token nem IP', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const req = { headers: { authorization: 'Bearer token-secreto-do-cliente' }, method: 'GET', route: { path: '/pacientes/:id' }, ip: '203.0.113.7' };
    const { ctx, reflector } = contexto(req, 'pacientes:ler');
    await expect(new SessaoGuard(provider(null), reflector).canActivate(ctx)).rejects.toMatchObject({ status: 401 });
    const [l] = linhas(warn);
    expect(l).toMatchObject({ evento: 'SESSAO_INVALIDA', rota: 'GET /pacientes/:id' });
    expect(l?.origem).toMatch(/^[0-9a-f]{16}$/);
    const tudo = JSON.stringify(warn.mock.calls);
    expect(tudo).not.toContain('token-secreto');
    expect(tudo).not.toContain('203.0.113.7');
  });

  it('403 por perfil: ACESSO_NEGADO_PERFIL com clínica, usuário e handler', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { ctx, reflector } = contexto({ headers: {}, method: 'GET', route: { path: '/financeiro' } }, undefined);
    const auth: AuthContext = { tenantId: TENANT as never, userId: USER as never, perfis: ['recepcao'], mfaEm: new Date() };
    await expect(new SessaoGuard(provider(auth), reflector).canActivate(ctx)).rejects.toMatchObject({ status: 403 });
    expect(linhas(warn)[0]).toMatchObject({ evento: 'ACESSO_NEGADO_PERFIL', tenantId: TENANT, userId: USER, handler: 'PacientesController.listar', rota: 'GET /financeiro' });
  });

  it('R4 do parecer do #130: falha ao ler os perfis no banco nega e gera PERFIS_NAO_CONFERIDOS', async () => {
    const erro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { ctx, reflector } = contexto({ headers: {}, method: 'GET', route: { path: '/pacientes' } }, 'pacientes:ler');
    const auth: AuthContext = { tenantId: TENANT as never, userId: USER as never, perfis: ['admin'], mfaEm: new Date() };
    const dbFora = { run: () => Promise.reject(new Error('banco fora')) };
    await expect(new SessaoGuard(provider(auth), reflector, dbFora as never).canActivate(ctx)).rejects.toThrow('banco fora');
    expect(linhas(erro)[0]).toMatchObject({ evento: 'PERFIS_NAO_CONFERIDOS', tenantId: TENANT, userId: USER });
  });

  it('recusa por MFA: MFA_RECUSADO com o motivo', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { ctx, reflector } = contexto({ headers: {}, method: 'GET', route: { path: '/pacientes' } }, 'pacientes:ler');
    const auth: AuthContext = { tenantId: TENANT as never, userId: USER as never, perfis: ['admin'], mfaEm: null };
    await expect(new SessaoGuard(provider(auth), reflector).canActivate(ctx)).rejects.toMatchObject({ status: 403 });
    expect(linhas(warn)[0]).toMatchObject({ evento: 'MFA_RECUSADO', tenantId: TENANT, userId: USER, motivo: 'mfa_obrigatorio' });
  });
});

describe('R1 do parecer do #129: listas fechadas e rota só de template', () => {
  it('os casos que passavam pelo formato agora são recusados', () => {
    const l = JSON.parse(linhaDeSeguranca('ALERTA_ANOMALIA', { motivo: 'maria_silva', regra: 'joao_souza', handler: 'Maria.Silva', rota: 'GET /pacientes/12345678909/joao.souza' })) as Record<string, unknown>;
    expect(l).toMatchObject({ motivo: VALOR_INVALIDO, regra: VALOR_INVALIDO, handler: VALOR_INVALIDO, rota: VALOR_INVALIDO });
  });

  it('valores das listas passam', () => {
    expect(JSON.parse(linhaDeSeguranca('MFA_RECUSADO', { motivo: 'mfa_obrigatorio', regra: 'portal_resgate', handler: 'PacientesController.listar', rota: 'PATCH /clinica/membros/:userId' }))).toMatchObject({
      motivo: 'mfa_obrigatorio',
      regra: 'portal_resgate',
      handler: 'PacientesController.listar',
      rota: 'PATCH /clinica/membros/:userId',
    });
  });

  it('todo motivo e toda regra literal usados em src estão nas listas (nada vira [invalido] em produção)', () => {
    const raiz = join(__dirname, '..');
    const arquivos: string[] = [];
    const ir = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) ir(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) arquivos.push(p);
      }
    };
    ir(raiz);
    const fora: string[] = [];
    for (const p of arquivos) {
      const s = readFileSync(p, 'utf8');
      if (!s.includes('registrarEventoDeSeguranca') && !s.includes('registrarNoMaximoUmaVez')) continue;
      for (const m of s.matchAll(/\b(motivo|regra): '([a-z_]+)'/g)) {
        const lista: readonly string[] = m[1] === 'motivo' ? MOTIVOS_DE_SEGURANCA : REGRAS_DE_SEGURANCA;
        if (!lista.includes(m[2] ?? '')) fora.push(`${p}: ${m[1]}=${m[2]}`);
      }
    }
    expect(fora).toEqual([]);
  });

  it('origem sem segredo explícito usa o do processo e nunca lança', () => {
    expect(origemDaRequisicao('203.0.113.7')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('registrarNoMaximoUmaVez (R3 e R6 do parecer do #129)', () => {
  it('uma linha por chave dentro do intervalo; volta a registrar depois dele', () => {
    const saida = { warn: vi.fn(), error: vi.fn() };
    const chave = `teste:${Math.random()}`;
    expect(registrarNoMaximoUmaVez(chave, 60_000, 'RATE_LIMIT_FAIL_OPEN', { motivo: 'portal' }, saida, 1_000)).toBe(true);
    expect(registrarNoMaximoUmaVez(chave, 60_000, 'RATE_LIMIT_FAIL_OPEN', { motivo: 'portal' }, saida, 30_000)).toBe(false);
    expect(registrarNoMaximoUmaVez(chave, 60_000, 'RATE_LIMIT_FAIL_OPEN', { motivo: 'portal' }, saida, 61_001)).toBe(true);
    expect(saida.error).toHaveBeenCalledTimes(2);
  });
});

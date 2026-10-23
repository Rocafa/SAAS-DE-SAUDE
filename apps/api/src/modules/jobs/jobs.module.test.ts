import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClinicasDoAgendador, TenantDatabase } from '../tenancy/tenancy.module';
import { AgendadorEmMemoria } from './agendador-memoria';
import { modoDosJobs } from './estado-dos-jobs';
import { criarInfraDosJobs, JobsService, type InfraDosJobs } from './jobs.module';

function servico(infra: InfraDosJobs): JobsService {
  // Os serviços de domínio só são chamados quando um job roda; aqui basta existir.
  const moduleRef = { get: () => ({}) } as unknown as ModuleRef;
  const clinicas = { listar: () => Promise.resolve([]) } as unknown as ClinicasDoAgendador;
  return new JobsService(infra, moduleRef, {} as TenantDatabase, clinicas);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('escolha do agendador pelo ambiente', () => {
  it('produção sem REDIS_URL: desligado, com o motivo', () => {
    const infra = criarInfraDosJobs({ NODE_ENV: 'production' });
    expect(infra.agendador).toBeNull();
    expect(infra.motivoDesligado).toBe('REDIS_URL ausente em produção');
  });

  it('R2: lista fechada — sem Redis, qualquer NODE_ENV fora de development/test fica DESLIGADO (nunca memória)', () => {
    for (const NODE_ENV of ['staging', 'prod', 'homologacao', 'Production', 'dev', 'TEST', '', ' ', undefined]) {
      const infra = criarInfraDosJobs(NODE_ENV === undefined ? {} : { NODE_ENV });
      expect(infra.agendador, `NODE_ENV=${String(NODE_ENV)}`).toBeNull();
      // Texto fixo: o valor lido do ambiente nunca vai para o log.
      expect(infra.motivoDesligado).toBe('REDIS_URL ausente fora de development/test');
    }
    expect(criarInfraDosJobs({ NODE_ENV: 'test' }).agendador?.modo).toBe('memoria');
  });

  it('teste nunca sobe BullMQ por acaso, mesmo com REDIS_URL (o CI tem para o rate limit)', () => {
    expect(criarInfraDosJobs({ NODE_ENV: 'test', REDIS_URL: 'redis://127.0.0.1:1' }).agendador?.modo).toBe('memoria');
  });

  it('desenvolvimento sem Redis: em memória (disparo manual)', () => {
    expect(criarInfraDosJobs({ NODE_ENV: 'development' }).agendador).toBeInstanceOf(AgendadorEmMemoria);
  });

  it('JOBS_HABILITADOS=false desliga de propósito; vazio vale true; valor estranho é erro de deploy', () => {
    expect(criarInfraDosJobs({ NODE_ENV: 'production', JOBS_HABILITADOS: 'false' })).toMatchObject({ agendador: null, motivoDesligado: 'JOBS_HABILITADOS=false' });
    expect(criarInfraDosJobs({ NODE_ENV: 'development', JOBS_HABILITADOS: '' }).agendador?.modo).toBe('memoria');
    expect(() => criarInfraDosJobs({ JOBS_HABILITADOS: 'sim' })).toThrow('JOBS_HABILITADOS inválida');
  });
});

describe('produção sem Redis: nada de falha silenciosa', () => {
  it('a API sobe, mas loga JOBS_DESLIGADOS (erro) com o motivo e o /health/ready mostra "desligado"', async () => {
    const erros: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void erros.push(String(m)));
    const s = servico(criarInfraDosJobs({ NODE_ENV: 'production' }));
    await s.onApplicationBootstrap();
    try {
      expect(s.modo).toBe('desligado');
      expect(modoDosJobs()).toBe('desligado');
      expect(erros).toEqual(['JOBS_DESLIGADOS motivo="REDIS_URL ausente em produção": nenhum job agendado (7 no registro)']);
      // O registro existe (o disparo manual pelas rotas do admin continua), só não há agendamento.
      expect(s.jobs).toHaveLength(7);
    } finally {
      await s.onApplicationShutdown();
    }
  });

  it('R2: NODE_ENV=staging sem Redis se comporta como produção (JOBS_DESLIGADOS e "desligado" no /health/ready)', async () => {
    const erros: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void erros.push(String(m)));
    const s = servico(criarInfraDosJobs({ NODE_ENV: 'staging' }));
    await s.onApplicationBootstrap();
    try {
      expect(s.modo).toBe('desligado');
      expect(modoDosJobs()).toBe('desligado');
      expect(erros).toEqual(['JOBS_DESLIGADOS motivo="REDIS_URL ausente fora de development/test": nenhum job agendado (7 no registro)']);
    } finally {
      await s.onApplicationShutdown();
    }
  });

  it('em memória: registra os jobs, nada dispara sozinho, executar roda pelo executor', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const ag = new AgendadorEmMemoria();
    const s = servico({ ...criarInfraDosJobs({ NODE_ENV: 'test' }), agendador: ag });
    await s.onApplicationBootstrap();
    expect(modoDosJobs()).toBe('memoria');
    expect(ag.registrados).toHaveLength(7);
    // Sem clínicas, o job termina ok sem tocar nenhum serviço.
    expect(await s.executar('responsaveis-descarte')).toEqual({ job: 'responsaveis-descarte', situacao: 'ok', clinicas: 0, clinicasComFalha: 0 });
    await s.onApplicationShutdown();
  });
});

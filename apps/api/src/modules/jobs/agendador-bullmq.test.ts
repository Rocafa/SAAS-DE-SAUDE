import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgendadorBullMQ,
  BACKOFF_DO_JOB_MS,
  FUSO_DOS_JOBS,
  processadorSeguro,
  TENTATIVAS_DO_JOB,
  type FabricasBullMQ,
  type FilaDeJobs,
  type TrabalhadorDeJobs,
} from './agendador-bullmq';
import { validarAposentados, type DefinicaoDeJob } from './agendador.port';
import { JOBS_APOSENTADOS } from './registro-de-jobs';

afterEach(() => vi.restoreAllMocks());

function job(nome: string, periodicidade: DefinicaoDeJob['periodicidade']): DefinicaoDeJob {
  return { nome, periodicidade, prazoMaximoMs: 26 * 3_600_000, travaMs: 60_000, critico: true, trilha: 'sempre', porClinica: () => Promise.resolve({}) };
}

function dubles(existentes: Array<{ key: string; id?: string | null; name: string }> = []) {
  const upserts: Array<{ id: string; repeat: unknown; template: unknown }> = [];
  const removidos: string[] = [];
  const eventos = new Map<string, (...args: never[]) => void>();
  let processar: ((job: { name: string }) => Promise<void>) | null = null;
  let fechados = 0;
  const fila: FilaDeJobs = {
    upsertJobScheduler: (id, repeat, template) => (upserts.push({ id, repeat, template }), Promise.resolve()),
    getJobSchedulers: () => Promise.resolve([...upserts.map((u) => ({ key: u.id, id: u.id, name: u.id })), ...existentes]),
    removeJobScheduler: (id) => (removidos.push(id), Promise.resolve(true)),
    close: () => (fechados++, Promise.resolve()),
  };
  const trabalhador: TrabalhadorDeJobs = {
    on: (evento: string, fn: (...args: never[]) => void) => eventos.set(evento, fn),
    close: () => (fechados++, Promise.resolve()),
  };
  const fabricas: FabricasBullMQ = {
    fila: () => fila,
    trabalhador: (p) => ((processar = p), trabalhador),
  };
  return { fabricas, upserts, removidos, eventos, fechados: () => fechados, processar: (nome: string) => processar?.({ name: nome }) };
}

describe('agendador BullMQ (dublê da fila)', () => {
  it('upsert de um job scheduler por job: cron no fuso de São Paulo ou intervalo, retry 3x com backoff exponencial', async () => {
    const d = dubles();
    const ag = new AgendadorBullMQ(d.fabricas);
    await ag.agendar([job('diario', { cron: '15 3 * * *', descricao: '' }), job('minutos', { aCadaMs: 300_000, descricao: '' })], () => Promise.resolve());
    expect(d.upserts).toEqual([
      { id: 'diario', repeat: { pattern: '15 3 * * *', tz: FUSO_DOS_JOBS }, template: expect.objectContaining({ name: 'diario', data: {} }) as unknown },
      { id: 'minutos', repeat: { every: 300_000 }, template: expect.objectContaining({ name: 'minutos' }) as unknown },
    ]);
    expect((d.upserts[0]?.template as { opts: unknown }).opts).toMatchObject({ attempts: TENTATIVAS_DO_JOB, backoff: { type: 'exponential', delay: BACKOFF_DO_JOB_MS } });
  });

  it('R5: remove só o agendamento de job APOSENTADO na lista versionada (job renomeado não continua disparando)', async () => {
    const d = dubles([{ key: 'antigo', id: 'antigo', name: 'antigo' }]);
    await new AgendadorBullMQ(d.fabricas).agendar([job('novo', { cron: '0 4 * * *', descricao: '' })], () => Promise.resolve(), [
      { nome: 'antigo', desde: '2026-10-23', motivo: 'renomeado para novo' },
    ]);
    expect(d.removidos).toEqual(['antigo']);
  });

  it('R5: agendamento desconhecido (fora do registro e da lista de aposentados) é MANTIDO, com aviso só do nome válido', async () => {
    const avisos: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void avisos.push(String(m)));
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const d = dubles([
      { key: 'job-da-versao-nova', id: 'job-da-versao-nova', name: 'job-da-versao-nova' },
      { key: 'X: valor estranho', id: null, name: 'x' },
    ]);
    await new AgendadorBullMQ(d.fabricas).agendar([job('a', { cron: '0 4 * * *', descricao: '' })], () => Promise.resolve());
    expect(d.removidos).toEqual([]);
    expect(avisos.filter((m) => m.startsWith('JOB_DESCONHECIDO'))).toEqual([
      'JOB_DESCONHECIDO job=job-da-versao-nova: fora do registro desta versão; mantido (só sai se aposentado)',
      'JOB_DESCONHECIDO job=nome_invalido: fora do registro desta versão; mantido (só sai se aposentado)',
    ]);
  });

  it('R5: deploy gradual — a instância VELHA que reinicia depois da nova não apaga o agendamento do job novo', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Uma fila só (o Redis), duas versões do registro convivendo.
    const agendados = new Map<string, unknown>();
    const removidos: string[] = [];
    const fila: FilaDeJobs = {
      upsertJobScheduler: (id, repeat) => (agendados.set(id, repeat), Promise.resolve()),
      getJobSchedulers: () => Promise.resolve([...agendados.keys()].map((id) => ({ key: id, id, name: id }))),
      removeJobScheduler: (id) => (removidos.push(id), Promise.resolve(agendados.delete(id))),
      close: () => Promise.resolve(),
    };
    const trabalhador: TrabalhadorDeJobs = { on: () => undefined, close: () => Promise.resolve() };
    const fabricas: FabricasBullMQ = { fila: () => fila, trabalhador: () => trabalhador };
    const v1 = [job('comum', { cron: '0 4 * * *', descricao: '' })];
    const v2 = [...v1, job('novo-da-v2', { cron: '0 5 * * *', descricao: '' })];
    await new AgendadorBullMQ(fabricas).agendar(v2, () => Promise.resolve()); // v2 sobe primeiro
    await new AgendadorBullMQ(fabricas).agendar(v1, () => Promise.resolve()); // v1 reinicia durante o rollout
    expect([...agendados.keys()].sort()).toEqual(['comum', 'novo-da-v2']);
    expect(removidos).toEqual([]);
    // A v3 aposenta o job pela lista versionada: aí, e só aí, o agendamento sai (de qualquer versão que suba).
    await new AgendadorBullMQ(fabricas).agendar(v1, () => Promise.resolve(), [{ nome: 'novo-da-v2', desde: '2026-10-23', motivo: 'teste' }]);
    expect([...agendados.keys()]).toEqual(['comum']);
  });

  it('R5: a lista de aposentados do registro é válida; nome aposentado não volta, sem data/motivo é recusado', () => {
    const ativos = [job('ativo', { cron: '0 4 * * *', descricao: '' })];
    expect(() => validarAposentados(ativos, JOBS_APOSENTADOS)).not.toThrow();
    expect(() => validarAposentados(ativos, [{ nome: 'ativo', desde: '2026-10-23', motivo: 'x' }])).toThrow('nome aposentado não volta');
    expect(() => validarAposentados(ativos, [{ nome: 'Ruim!', desde: '2026-10-23', motivo: 'x' }])).toThrow('nome inválido');
    expect(() => validarAposentados(ativos, [{ nome: 'velho', desde: 'ontem', motivo: 'x' }])).toThrow('AAAA-MM-DD');
    expect(() => validarAposentados(ativos, [{ nome: 'velho', desde: '2026-10-23', motivo: ' ' }])).toThrow('motivo');
    const dup = { nome: 'velho', desde: '2026-10-23', motivo: 'x' };
    expect(() => validarAposentados(ativos, [dup, dup])).toThrow('duplicado');
  });

  it('N1: o processador do Worker relança só o código do erro (a mensagem não vai para o failedReason no Redis)', async () => {
    const segredo = 'valor de linha ficticio QZX-91';
    const falhaPg = Object.assign(new Error(segredo), { code: '23505' });
    await expect(processadorSeguro(() => Promise.reject(falhaPg))({ name: 'a' })).rejects.toThrow(/^pg_23505$/);
    const err = (await processadorSeguro(() => Promise.reject(new TypeError(segredo)))({ name: 'a' }).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toBe('TypeError');
    expect(String(err.stack)).not.toContain(segredo);
    const rodados: string[] = [];
    await processadorSeguro((j) => (rodados.push(j.name), Promise.resolve()))({ name: 'a' });
    expect(rodados).toEqual(['a']);
  });

  it('o trabalhador entrega o nome do job ao executor; falha sai no log só com código', async () => {
    const d = dubles();
    const rodados: string[] = [];
    await new AgendadorBullMQ(d.fabricas).agendar([job('a', { cron: '0 4 * * *', descricao: '' })], (n) => (rodados.push(n), Promise.resolve()));
    await d.processar('a');
    expect(rodados).toEqual(['a']);
    expect([...d.eventos.keys()].sort()).toEqual(['error', 'failed']);
  });

  it('parar fecha trabalhador, fila e conexões', async () => {
    const d = dubles();
    let conexoes = 0;
    const ag = new AgendadorBullMQ(d.fabricas, () => (conexoes++, Promise.resolve()));
    await ag.agendar([], () => Promise.resolve());
    await ag.parar();
    expect(d.fechados()).toBe(2);
    expect(conexoes).toBe(1);
  });
});

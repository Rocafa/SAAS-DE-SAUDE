import { describe, expect, it } from 'vitest';
import { AgendadorBullMQ, BACKOFF_DO_JOB_MS, FUSO_DOS_JOBS, TENTATIVAS_DO_JOB, type FabricasBullMQ, type FilaDeJobs, type TrabalhadorDeJobs } from './agendador-bullmq';
import type { DefinicaoDeJob } from './agendador.port';

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

  it('remove agendamento que saiu do registro (job renomeado não continua disparando)', async () => {
    const d = dubles([{ key: 'antigo', id: 'antigo', name: 'antigo' }]);
    await new AgendadorBullMQ(d.fabricas).agendar([job('novo', { cron: '0 4 * * *', descricao: '' })], () => Promise.resolve());
    expect(d.removidos).toEqual(['antigo']);
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

import { describe, expect, it } from 'vitest';
import type { DefinicaoDeJob, RegistroDeExecucoes } from './agendador.port';
import { RegistroEmMemoria } from './agendador-memoria';
import { verificarAtrasos } from './sinal-de-vida';

const HORA = 3_600_000;

function job(nome: string, critico: boolean, prazoMaximoMs = 26 * HORA): DefinicaoDeJob {
  return { nome, critico, prazoMaximoMs, travaMs: 60_000, trilha: 'sempre', periodicidade: { cron: '0 3 * * *', descricao: 'diário' }, porClinica: () => Promise.resolve({}) };
}

function logger() {
  const linhas: string[] = [];
  return { linhas, log: (m: string) => linhas.push(`log ${m}`), warn: (m: string) => linhas.push(`warn ${m}`), error: (m: string) => linhas.push(`error ${m}`) };
}

describe('sinal de vida (JOB_ATRASADO)', () => {
  const subida = 1_000_000_000_000;

  it('job crítico sem sucesso dentro do prazo alarma; dentro do prazo, não', async () => {
    const registro = new RegistroEmMemoria();
    await registro.marcarSucesso('a', subida);
    await registro.marcarSucesso('b', subida + 10 * HORA);
    const log = logger();
    const atrasados = await verificarAtrasos([job('a', true), job('b', true)], registro, subida + 30 * HORA, subida, log);
    expect(atrasados).toEqual([{ job: 'a', atrasoMin: 240, nuncaRodou: false }]);
    expect(log.linhas).toEqual(['error JOB_ATRASADO job=a atraso_min=240 nunca_rodou=false']);
  });

  it('job que nunca rodou conta desde a subida do processo (não alarma no primeiro minuto, alarma depois do prazo)', async () => {
    const registro = new RegistroEmMemoria();
    expect(await verificarAtrasos([job('a', true)], registro, subida + 60_000, subida, logger())).toEqual([]);
    const atrasados = await verificarAtrasos([job('a', true)], registro, subida + 27 * HORA, subida, logger());
    expect(atrasados).toEqual([{ job: 'a', atrasoMin: 60, nuncaRodou: true }]);
  });

  it('job não crítico nunca alarma', async () => {
    expect(await verificarAtrasos([job('a', false)], new RegistroEmMemoria(), subida + 999 * HORA, subida, logger())).toEqual([]);
  });

  it('registro indisponível (Redis fora) também alarma: falha silenciosa não', async () => {
    const quebrado: RegistroDeExecucoes = { marcarSucesso: () => Promise.resolve(), ultimoSucesso: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1')) };
    const log = logger();
    const atrasados = await verificarAtrasos([job('a', true)], quebrado, subida, subida, log);
    expect(atrasados).toHaveLength(1);
    expect(log.linhas).toEqual(['error JOB_ATRASADO job=a atraso_min=desconhecido motivo=registro_indisponivel']);
    expect(log.linhas.join(' ')).not.toContain('10.0.0.1');
  });
});

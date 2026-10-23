import type { TenantId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { codigoDoErro, FalhaDeJobError, validarDefinicoes, type DefinicaoDeJob, type ResultadoDeJob } from './agendador.port';
import { AgendadorEmMemoria, RegistroEmMemoria, TravaEmMemoria } from './agendador-memoria';
import { contagensParaTrilha, ExecutorDeJobs, type LinhaDeTrilhaDoJob } from './executor-de-jobs';

const A = '00000000-0000-4000-8000-00000000000a' as TenantId;
const B = '00000000-0000-4000-8000-00000000000b' as TenantId;

function job(porClinica: (t: TenantId) => Promise<ResultadoDeJob>, extra: Partial<DefinicaoDeJob> = {}): DefinicaoDeJob {
  return { nome: 'teste', periodicidade: { cron: '0 3 * * *', descricao: 'diário' }, prazoMaximoMs: 26 * 3_600_000, travaMs: 60_000, critico: true, trilha: 'sempre', porClinica, ...extra };
}

function montar(jobs: DefinicaoDeJob[], clinicas: TenantId[] = [A, B]) {
  const trilha: Array<{ t: TenantId; linha: LinhaDeTrilhaDoJob }> = [];
  const logs: string[] = [];
  const esperas: number[] = [];
  const registro = new RegistroEmMemoria();
  const trava = new TravaEmMemoria();
  const executor = new ExecutorDeJobs({
    jobs,
    trava,
    registro,
    listarClinicas: () => Promise.resolve(clinicas),
    registrarTrilha: (t, linha) => {
      trilha.push({ t, linha });
      return Promise.resolve();
    },
    logger: { log: (m) => logs.push(`log ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    dormir: (ms) => {
      esperas.push(ms);
      return Promise.resolve();
    },
    agora: () => 42,
  });
  return { executor, trilha, logs, esperas, registro, trava };
}

describe('executor de jobs', () => {
  it('roda o job em cada clínica separadamente, deixa trilha em cada uma e registra o sucesso', async () => {
    const vistas: TenantId[] = [];
    const m = montar([job((t) => (vistas.push(t), Promise.resolve({ descartados: t === A ? 2 : 0 })))]);
    expect(await m.executor.executar('teste')).toEqual({ job: 'teste', situacao: 'ok', clinicas: 2, clinicasComFalha: 0 });
    expect(vistas).toEqual([A, B]);
    expect(m.trilha).toEqual([
      { t: A, linha: { job: 'teste', situacao: 'ok', tentativas: 1, resultado: { descartados: 2 } } },
      { t: B, linha: { job: 'teste', situacao: 'ok', tentativas: 1, resultado: { descartados: 0 } } },
    ]);
    expect(await m.registro.ultimoSucesso('teste')).toBe(42);
  });

  it('trava: com outra execução em andamento, pula sem rodar nada', async () => {
    let rodou = 0;
    const m = montar([job(() => (rodou++, Promise.resolve({})))]);
    const token = await m.trava.adquirir('teste', 60_000);
    expect(token).not.toBeNull();
    expect((await m.executor.executar('teste')).situacao).toBe('em_andamento');
    expect(rodou).toBe(0);
    expect(m.logs).toContain('warn JOB_EM_ANDAMENTO job=teste: outra execução tem a trava; esta foi pulada');
    // Solta ao fim: a próxima execução consegue a trava.
    await m.trava.liberar('teste', token as string);
    expect((await m.executor.executar('teste')).situacao).toBe('ok');
    expect(await m.trava.adquirir('teste', 60_000)).not.toBeNull();
  });

  it('duas execuções simultâneas do mesmo job: só uma roda', async () => {
    let soltar: () => void = () => undefined;
    const pendente = new Promise<void>((r) => (soltar = r));
    let rodou = 0;
    const m = montar([job(async () => (rodou++, await pendente, {}))], [A]);
    const primeira = m.executor.executar('teste');
    const segunda = await m.executor.executar('teste');
    soltar();
    expect(segunda.situacao).toBe('em_andamento');
    expect((await primeira).situacao).toBe('ok');
    expect(rodou).toBe(1);
  });

  it('retry com backoff exponencial por clínica; sucesso na 2ª tentativa fica na trilha', async () => {
    let n = 0;
    const m = montar([job(() => (++n === 1 ? Promise.reject(new Error('falha transitória')) : Promise.resolve({ x: 1 })))], [A]);
    await m.executor.executar('teste');
    expect(m.esperas).toEqual([2_000]);
    expect(m.trilha[0]?.linha).toMatchObject({ situacao: 'ok', tentativas: 2 });
  });

  it('esgotadas as tentativas: erro só como código (sem mensagem) no log e na trilha da clínica; as outras seguem; o job falha para o BullMQ refazer', async () => {
    const erroComDado = Object.assign(new Error('violação na linha de Maria Ficticia, CPF 000.000.001-91'), { code: '23505' });
    const m = montar([job((t) => (t === A ? Promise.reject(erroComDado) : Promise.resolve({ ok: 1 })))]);
    await expect(m.executor.executar('teste')).rejects.toBeInstanceOf(FalhaDeJobError);
    expect(m.esperas).toEqual([2_000, 4_000]);
    expect(m.trilha).toEqual([
      { t: A, linha: { job: 'teste', situacao: 'erro', tentativas: 3, erro: 'pg_23505', resultado: {} } },
      { t: B, linha: { job: 'teste', situacao: 'ok', tentativas: 1, resultado: { ok: 1 } } },
    ]);
    const tudo = JSON.stringify([m.logs, m.trilha]);
    expect(tudo).not.toContain('Maria');
    expect(tudo).not.toContain('000.000.001-91');
    expect(m.logs.some((l) => l.startsWith(`error JOB_CLINICA_FALHOU job=teste clinica=${A} posicao=0 tentativas=3 erro=pg_23505`))).toBe(true);
    expect(await m.registro.ultimoSucesso('teste')).toBeNull();
    // A trava foi solta mesmo com a falha.
    expect(await m.trava.adquirir('teste', 1)).not.toBeNull();
  });

  it('trilha `com_efeito`: só quando algum número > 0; alarme = true vira JOB_ALARME', async () => {
    const m = montar([job((t) => Promise.resolve(t === A ? { enviados: 0 } : { atrasados: 3, alarme: true }), { trilha: 'com_efeito' })]);
    await m.executor.executar('teste');
    expect(m.trilha.map((x) => x.t)).toEqual([B]);
    expect(m.logs.some((l) => l.startsWith(`error JOB_ALARME job=teste clinica=${B}`))).toBe(true);
  });

  it('job desconhecido é erro de programação', async () => {
    await expect(montar([]).executor.executar('nao-existe')).rejects.toThrow('job desconhecido');
  });
});

describe('contrato da trilha e do erro', () => {
  it('contagensParaTrilha: só números/booleanos, chaves válidas, sem colidir com as do executor, no máximo 12', () => {
    const muitos = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(contagensParaTrilha(muitos))).toHaveLength(12);
    expect(contagensParaTrilha({ a: 1, b: true, c: Number.NaN, d: 10_000_000, job: 1, status: 2, 'x-y': 3 })).toEqual({ a: 1, b: true });
  });

  it('codigoDoErro: SQLSTATE (também dentro de cause), nome da classe ou desconhecido; nunca a mensagem', () => {
    expect(codigoDoErro(Object.assign(new Error('x'), { code: '42501' }))).toBe('pg_42501');
    expect(codigoDoErro(Object.assign(new Error('falhou'), { cause: { code: '55000' } }))).toBe('pg_55000');
    expect(codigoDoErro(new TypeError('Maria'))).toBe('TypeError');
    expect(codigoDoErro('texto com dado')).toBe('erro_desconhecido');
    expect(codigoDoErro({ name: 'nome com espaço 123' })).toBe('erro_desconhecido');
  });

  it('validarDefinicoes recusa nome inválido, duplicado, periodicidade dupla e prazo menor que o intervalo', () => {
    const base = job(() => Promise.resolve({}));
    expect(() => validarDefinicoes([{ ...base, nome: 'Com Espaco' }])).toThrow('nome inválido');
    expect(() => validarDefinicoes([base, base])).toThrow('duplicado');
    expect(() => validarDefinicoes([{ ...base, periodicidade: { cron: '* * * * *', aCadaMs: 60_000, descricao: '' } }])).toThrow('cron OU');
    expect(() => validarDefinicoes([{ ...base, periodicidade: { aCadaMs: 600_000, descricao: '' }, prazoMaximoMs: 300_000 }])).toThrow('prazo');
    expect(() => validarDefinicoes([{ ...base, periodicidade: { aCadaMs: 1_000, descricao: '' } }])).toThrow('mínimo');
  });
});

describe('agendador em memória', () => {
  it('nada dispara sozinho; disparar roda o job registrado e recusa o desconhecido', async () => {
    const ag = new AgendadorEmMemoria();
    const rodados: string[] = [];
    await ag.agendar([job(() => Promise.resolve({}))], (nome) => (rodados.push(nome), Promise.resolve()));
    expect(rodados).toEqual([]);
    await ag.disparar('teste');
    expect(rodados).toEqual(['teste']);
    await expect(ag.disparar('outro')).rejects.toThrow('desconhecido');
    await ag.parar();
    await expect(ag.disparar('teste')).rejects.toThrow('nenhum job');
  });

  it('a trava em memória vence sozinha', async () => {
    let agora = 0;
    const trava = new TravaEmMemoria(() => agora);
    expect(await trava.adquirir('j', 100)).not.toBeNull();
    expect(await trava.adquirir('j', 100)).toBeNull();
    agora = 101;
    expect(await trava.adquirir('j', 100)).not.toBeNull();
  });
});

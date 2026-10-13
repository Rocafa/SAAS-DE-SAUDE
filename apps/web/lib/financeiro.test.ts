import { describe, expect, it } from 'vitest';
import { criarApiFake } from './api/fake';
import type { Agendamento, Guia, Recibo } from './api/tipos';
import { aReceber, alertasGuia, periodo, resumoPeriodo, totalPorForma } from './financeiro';

const hoje = new Date(2026, 9, 12, 10);
const ag = (id: string, data: string, status: Agendamento['status']): Agendamento => ({
  id,
  pacienteId: 'p01',
  profissionalId: 'pr1',
  tipoId: 't1',
  data,
  hora: '10:00',
  minutos: 50,
  status,
  encaixe: false,
});
const rec = (agendamentoId: string, data: string, valor: number, forma: Recibo['forma']): Recibo => ({ id: `r-${agendamentoId}`, agendamentoId, pacienteId: 'p01', data, valor, forma });

describe('financeiro', () => {
  it('total por forma', () => {
    expect(totalPorForma([rec('a', '2026-10-12', 150, 'pix'), rec('b', '2026-10-12', 200, 'pix'), rec('c', '2026-10-12', 100, 'dinheiro')])).toEqual({
      dinheiro: 100,
      cartao: 0,
      pix: 350,
      total: 450,
    });
  });
  it('a receber: só atendido sem pagamento', () => {
    const ags = [ag('a', '2026-10-10', 'atendido'), ag('b', '2026-10-11', 'atendido'), ag('c', '2026-10-11', 'faltou')];
    expect(aReceber(ags, [rec('a', '2026-10-10', 150, 'pix')]).map((x) => x.id)).toEqual(['b']);
  });
});

describe('guias', () => {
  const g = (sessoesUsadas: number, validade: string): Guia => ({ id: 'g', pacienteId: 'p01', convenio: 'X', numero: '1', sessoesAutorizadas: 10, sessoesUsadas, validade });
  it('tudo certo: sem aviso', () => expect(alertasGuia(g(3, '2026-12-01'), hoje)).toEqual([]));
  it('vencendo e vencida', () => {
    expect(alertasGuia(g(3, '2026-10-17'), hoje)).toEqual(['Vence em 5 dias. Peça a renovação.']);
    expect(alertasGuia(g(3, '2026-10-12'), hoje)).toEqual(['Vence hoje. Peça a renovação.']);
    expect(alertasGuia(g(3, '2026-10-11'), hoje)[0]).toMatch(/vencida/);
  });
  it('sessões acabando e acabadas', () => {
    expect(alertasGuia(g(9, '2026-12-01'), hoje)).toEqual(['Só resta 1 sessão. Peça mais ao convênio.']);
    expect(alertasGuia(g(8, '2026-12-01'), hoje)).toEqual(['Só restam 2 sessões. Peça mais ao convênio.']);
    expect(alertasGuia(g(10, '2026-12-01'), hoje)[0]).toMatch(/já foram usadas/);
  });
});

describe('relatórios', () => {
  it('resumo do período com taxa de faltas', () => {
    const ags = [ag('a', '2026-10-10', 'atendido'), ag('b', '2026-10-10', 'faltou'), ag('c', '2026-10-11', 'atendido'), ag('d', '2026-10-11', 'atendido')];
    const r = resumoPeriodo(ags, [rec('a', '2026-10-10', 150, 'pix')], '2026-10-10', '2026-10-12');
    expect(r).toMatchObject({ atendimentos: 3, faltas: 1, taxaFaltas: 25, recebido: 150 });
    expect(r.porDia).toHaveLength(3);
  });
  it('períodos', () => {
    expect(periodo('7dias', hoje)).toEqual({ de: '2026-10-06', ate: '2026-10-12' });
    expect(periodo('mes', hoje)).toEqual({ de: '2026-10-01', ate: '2026-10-12' });
  });
});

describe('fake: pagamento e guia', () => {
  it('receber cria recibo; não paga duas vezes; desfazer remove', async () => {
    const api = criarApiFake({ agora: hoje });
    const [pendente] = aReceber(await api.listarAgendamentos(), await api.listarRecibos());
    expect(pendente).toBeDefined();
    const r = await api.registrarPagamento(pendente!.id, 'pix');
    await expect(api.registrarPagamento(pendente!.id, 'pix')).rejects.toThrow(/já está pago/);
    await api.removerRecibo(r.id);
    expect((await api.listarRecibos()).some((x) => x.id === r.id)).toBe(false);
  });
  it('guia: erros dizem o que fazer', async () => {
    const api = criarApiFake({ agora: hoje });
    await expect(api.criarGuia({ pacienteId: 'p01', convenio: 'X', numero: '', sessoesAutorizadas: 10, validade: '2026-12-01' })).rejects.toThrow(/número da guia/);
    const g = await api.criarGuia({ pacienteId: 'p01', convenio: 'X', numero: '9', sessoesAutorizadas: 10, validade: '2026-12-01' });
    expect(g.sessoesUsadas).toBe(0);
  });
});

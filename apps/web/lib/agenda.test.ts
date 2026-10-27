import { describe, expect, it } from 'vitest';
import { conflito, datasDaSerie, diasDaSemana, formatarCpf, formatarTelefone, idade, porHorario, simultaneos, validarCpf, validarNome, validarTelefone } from './agenda';
import { criarApiFake } from './api/fake';
import type { Agendamento, Profissional } from './api/tipos';

const ag = (id: string, hora: string, profissionalId = 'pr1', status: Agendamento['status'] = 'agendado'): Agendamento => ({
  id,
  pacienteId: 'p01',
  profissionalId,
  tipoId: 't1',
  data: '2026-10-15',
  hora,
  minutos: 50,
  status,
  encaixe: false,
});

describe('semana e séries', () => {
  it('semana começa na segunda', () => {
    expect(diasDaSemana('2026-10-15')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(diasDaSemana('2026-10-18')[0]).toBe('2026-10-12');
  });
  it('série semanal e quinzenal, atravessando o mês', () => {
    expect(datasDaSerie('2026-10-29', 7, 3)).toEqual(['2026-10-29', '2026-11-05', '2026-11-12']);
    expect(datasDaSerie('2026-10-15', 14, 2)).toEqual(['2026-10-15', '2026-10-29']);
  });
  it('série recusa quantidade e intervalo fora do combinado', () => {
    expect(() => datasDaSerie('2026-10-15', 7, 0)).toThrow(/1 a 52/);
    expect(() => datasDaSerie('2026-10-15', 3, 2)).toThrow(/semana/);
  });
});

describe('horário ocupado e atendimento simultâneo', () => {
  const psico: Profissional = { id: 'pr2', nome: 'Psi', especialidade: 'Psicologia' };
  const fisio: Profissional = { id: 'pr1', nome: 'Fisio', especialidade: 'Fisioterapia', limiteSimultaneo: 3 };

  it('psicólogo: um por horário', () => {
    const ex = [ag('a', '10:00', 'pr2')];
    expect(conflito(ex, { profissionalId: 'pr2', data: '2026-10-15', hora: '10:00' }, psico)?.id).toBe('a');
    expect(conflito(ex, { profissionalId: 'pr2', data: '2026-10-15', hora: '11:00' }, psico)).toBeNull();
  });
  it('fisio no ginásio: até 3 ao mesmo tempo', () => {
    const dois = [ag('a', '09:00'), ag('b', '09:00')];
    expect(conflito(dois, { profissionalId: 'pr1', data: '2026-10-15', hora: '09:00' }, fisio)).toBeNull();
    expect(conflito([...dois, ag('c', '09:00')], { profissionalId: 'pr1', data: '2026-10-15', hora: '09:00' }, fisio)).not.toBeNull();
  });
  it('consulta cancelada não ocupa; remarcar ignora a própria consulta', () => {
    expect(conflito([ag('a', '10:00', 'pr2', 'cancelado')], { profissionalId: 'pr2', data: '2026-10-15', hora: '10:00' }, psico)).toBeNull();
    expect(conflito([ag('a', '10:00', 'pr2')], { profissionalId: 'pr2', data: '2026-10-15', hora: '10:00', ignorarId: 'a' }, psico)).toBeNull();
  });
  it('agrupa por horário e conta simultâneos', () => {
    const lista = [ag('b', '10:00'), ag('a', '09:00'), ag('c', '09:00')];
    expect(porHorario(lista).map((g) => [g.hora, g.itens.length])).toEqual([
      ['09:00', 2],
      ['10:00', 1],
    ]);
    expect(simultaneos(lista, lista[1]!)).toBe(2);
  });
});

describe('cadastro: erros dizem o que fazer', () => {
  it('nome', () => {
    expect(validarNome('')).toMatch(/Falta o nome/);
    expect(validarNome('Maria')).toMatch(/sobrenome/);
    expect(validarNome('Maria Silva')).toBeNull();
  });
  it('telefone', () => {
    expect(validarTelefone('')).toBe('Falta o telefone. Digite com DDD.');
    expect(validarTelefone('91234-5678')).toMatch(/DDD/);
    expect(validarTelefone('(11) 91234-5678')).toBeNull();
    expect(formatarTelefone('11912345678')).toBe('(11) 91234-5678');
    expect(formatarTelefone('1132345678')).toBe('(11) 3234-5678');
  });
  it('CPF opcional, mas com dígito verificador certo', () => {
    expect(validarCpf('')).toBeNull();
    expect(validarCpf('123')).toMatch(/11 números/);
    expect(validarCpf('111.111.111-11')).toMatch(/errado/);
    expect(validarCpf('529.982.247-25')).toBeNull(); // CPF de exemplo público, não pertence a paciente
    expect(validarCpf('529.982.247-26')).toMatch(/errado/);
    expect(formatarCpf('52998224725')).toBe('529.982.247-25');
  });
  it('idade para pedir responsável', () => {
    expect(idade('2010-10-13', new Date(2026, 9, 12))).toBe(15);
    expect(idade('2008-10-12', new Date(2026, 9, 12))).toBe(18);
  });
});

describe('adaptador fake: agenda e pacientes', () => {
  const agora = new Date(2026, 9, 12, 10);

  it('série com pacote cria as sessões e o pacote; desfazer remove tudo', async () => {
    const api = criarApiFake({ agora });
    const serie = await api.criarSerie({ pacienteId: 'p05', data: '2026-10-14', hora: '08:00' }, { intervaloDias: 7, vezes: 4, pacote: true });
    expect(serie.map((a) => a.data)).toEqual(['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04']);
    expect(await api.listarPacotes('p05')).toMatchObject([{ total: 4, usadas: 0 }]);
    await api.removerSerie(serie[0]!.serieId!);
    expect(await api.listarAgendamentos({ pacienteId: 'p05', de: '2026-10-14' })).toHaveLength(0);
    expect(await api.listarPacotes('p05')).toHaveLength(0);
  });

  it('lista de espera: entra, sai e volta (desfazer)', async () => {
    const api = criarApiFake({ agora });
    const item = await api.adicionarEspera('p02', 'manhã');
    expect((await api.listarEspera()).map((e) => e.id)).toContain(item.id);
    const tirado = await api.removerEspera(item.id);
    expect((await api.listarEspera()).map((e) => e.id)).not.toContain(item.id);
    await api.devolverEspera(tirado!);
    expect((await api.listarEspera()).map((e) => e.id)).toContain(item.id);
  });

  it('inativar não apaga o histórico e cancela só as consultas futuras', async () => {
    const api = criarApiFake({ agora });
    const antes = await api.linhaDoTempo('p01');
    await api.inativarPaciente('p01', 'Terminou o tratamento');
    const p = await api.obterPaciente('p01');
    expect(p).toMatchObject({ ativo: false, inativacao: { motivo: 'Terminou o tratamento' } });
    const futuras = await api.listarAgendamentos({ pacienteId: 'p01', de: '2026-10-13' });
    expect(futuras.every((a) => a.status === 'cancelado')).toBe(true);
    expect((await api.linhaDoTempo('p01')).length).toBeGreaterThanOrEqual(antes.length);
    expect(await api.listarRecibos('p01')).not.toHaveLength(0);
    await api.reativarPaciente('p01');
    expect((await api.obterPaciente('p01'))?.ativo).toBe(true);
  });

  it('cadastro guarda nome social e responsável', async () => {
    const api = criarApiFake({ agora });
    const p = await api.criarPaciente({
      nome: 'Teste Fictício',
      nomeSocial: 'Tess',
      telefone: '(11) 90000-7777',
      responsavel: { nome: 'Resp Fictício', parentesco: 'Mãe', telefone: '(11) 90000-8888' },
    });
    expect(p).toMatchObject({ nomeSocial: 'Tess', ficticio: true, responsaveis: [{ parentesco: 'Mãe' }] });
    await api.removerPaciente(p.id);
    expect(await api.obterPaciente(p.id)).toBeNull();
  });

  it('linha do tempo vem do mais novo para o mais antigo', async () => {
    const api = criarApiFake({ agora });
    const linha = await api.linhaDoTempo('p01');
    const chaves = linha.map((e) => e.data + (e.hora ?? ''));
    expect(chaves).toEqual([...chaves].sort().reverse());
  });
});

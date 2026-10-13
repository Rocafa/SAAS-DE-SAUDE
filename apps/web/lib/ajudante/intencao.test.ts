import { describe, expect, it } from 'vitest';
import { InterpretadorPorRegras, type Intencao } from './intencao';

// Segunda-feira, 12/10/2026, 10h.
const agora = new Date(2026, 9, 12, 10, 0);
const parser = new InterpretadorPorRegras();
const ler = (t: string) => parser.interpretar(t, { agora });

// 60+ frases reais de recepção e profissional, escritas do jeito que as pessoas digitam.
const CASOS: [string, Record<string, unknown> & { tipo: Intencao['tipo'] }][] = [
  ['marcar consulta para João quinta às 14h', { tipo: 'marcar_consulta', paciente: 'joao', data: '2026-10-15', hora: '14:00' }],
  ['marcar consulta pra joao quinta as 14h', { tipo: 'marcar_consulta', paciente: 'joao', data: '2026-10-15', hora: '14:00' }],
  ['agendar Maria Silva amanhã 9h', { tipo: 'marcar_consulta', paciente: 'maria silva', data: '2026-10-13', hora: '09:00' }],
  ['marca a ana pra sexta às duas da tarde', { tipo: 'marcar_consulta', paciente: 'ana', data: '2026-10-16', hora: '14:00' }],
  ['marcar pedro dia 15 às 10h30', { tipo: 'marcar_consulta', paciente: 'pedro', data: '2026-10-15', hora: '10:30' }],
  ['agendar José 20/10 14:30', { tipo: 'marcar_consulta', paciente: 'jose', data: '2026-10-20', hora: '14:30' }],
  ['marcar consulta para Joana depois de amanhã às 8', { tipo: 'marcar_consulta', paciente: 'joana', data: '2026-10-14', hora: '08:00' }],
  ['nova consulta Carlos Rodrigues segunda que vem 11h', { tipo: 'marcar_consulta', paciente: 'carlos rodrigues', data: '2026-10-19', hora: '11:00' }],
  ['marcar sessão da Fernanda na quarta-feira às 3 da tarde', { tipo: 'marcar_consulta', paciente: 'fernanda', data: '2026-10-14', hora: '15:00' }],
  ['agenda pra Lucas amanhã meio-dia', { tipo: 'marcar_consulta', paciente: 'lucas', data: '2026-10-13', hora: '12:00' }],
  ['marcar Juliana às 10 e meia de sexta', { tipo: 'marcar_consulta', paciente: 'juliana', data: '2026-10-16', hora: '10:30' }],
  ['marque o Rafael pra hoje 17h', { tipo: 'marcar_consulta', paciente: 'rafael', data: '2026-10-12', hora: '17:00' }],
  ['marcar consulta', { tipo: 'marcar_consulta' }],
  ['agendar', { tipo: 'marcar_consulta' }],
  ['marcar Beatriz dia 5 de novembro às 9', { tipo: 'marcar_consulta', paciente: 'beatriz', data: '2026-11-05', hora: '09:00' }],
  ['marcar Mateus daqui a 3 dias às 16h', { tipo: 'marcar_consulta', paciente: 'mateus', data: '2026-10-15', hora: '16:00' }],
  ['marcar Larissa às oito da manhã de quinta', { tipo: 'marcar_consulta', paciente: 'larissa', data: '2026-10-15', hora: '08:00' }],
  ['encaixar Thiago hoje às 15h', { tipo: 'marcar_consulta', paciente: 'thiago', data: '2026-10-12', hora: '15:00', encaixe: true }],
  ['encaixe para a Camila amanhã', { tipo: 'marcar_consulta', paciente: 'camila', data: '2026-10-13', encaixe: true }],
  ['marcar consulta para o Sr. Antônio sábado 9h', { tipo: 'marcar_consulta', paciente: 'antonio', data: '2026-10-17', hora: '09:00' }],
  ['remarcar a Ana para sexta', { tipo: 'remarcar_consulta', paciente: 'ana', data: '2026-10-16' }],
  ['remarca o pedro pra amanha 15h', { tipo: 'remarcar_consulta', paciente: 'pedro', data: '2026-10-13', hora: '15:00' }],
  ['mudar o horário da Maria para quinta 10h', { tipo: 'remarcar_consulta', paciente: 'maria', data: '2026-10-15', hora: '10:00' }],
  ['passar a consulta do João pra semana que vem', { tipo: 'remarcar_consulta', paciente: 'joao', data: '2026-10-19' }],
  ['adiar a sessão da Joana para dia 20', { tipo: 'remarcar_consulta', paciente: 'joana', data: '2026-10-20' }],
  ['trocar dia do Bruno para terça às 9', { tipo: 'remarcar_consulta', paciente: 'bruno', data: '2026-10-13', hora: '09:00' }],
  ['reagendar Patrícia 22/10 às 16:00', { tipo: 'remarcar_consulta', paciente: 'patricia', data: '2026-10-22', hora: '16:00' }],
  ['cancelar a consulta da Maria', { tipo: 'cancelar_consulta', paciente: 'maria' }],
  ['desmarcar Pedro amanhã', { tipo: 'cancelar_consulta', paciente: 'pedro', data: '2026-10-13' }],
  ['cancela o horário do Ricardo', { tipo: 'cancelar_consulta', paciente: 'ricardo' }],
  ['abrir prontuário do Pedro', { tipo: 'abrir_prontuario', paciente: 'pedro' }],
  ['prontuario maria silva', { tipo: 'abrir_prontuario', paciente: 'maria silva' }],
  ['evolução da Aline', { tipo: 'abrir_prontuario', paciente: 'aline' }],
  ['atender Felipe', { tipo: 'abrir_prontuario', paciente: 'felipe' }],
  ['histórico clínico do Davi', { tipo: 'abrir_prontuario', paciente: 'davi' }],
  ['imprimir recibo da última consulta da Maria', { tipo: 'imprimir_recibo', paciente: 'maria' }],
  ['recibo do joão', { tipo: 'imprimir_recibo', paciente: 'joao' }],
  ['segunda via do recibo da Renata', { tipo: 'imprimir_recibo', paciente: 'renata' }],
  ['recibo', { tipo: 'imprimir_recibo' }],
  ['atestado para Helena', { tipo: 'emitir_documento', documento: 'atestado', paciente: 'helena' }],
  ['declaração de comparecimento do Miguel', { tipo: 'emitir_documento', documento: 'declaracao', paciente: 'miguel' }],
  ['a Sofia chegou', { tipo: 'registrar_chegada', paciente: 'sofia' }],
  ['check in da Ana Paula', { tipo: 'registrar_chegada', paciente: 'ana paula' }],
  ['ficha da Maria Silva', { tipo: 'abrir_ficha', paciente: 'maria silva' }],
  ['telefone do João Pereira', { tipo: 'abrir_ficha', paciente: 'joao pereira' }],
  ['abrir cadastro do Carlos', { tipo: 'abrir_ficha', paciente: 'carlos' }],
  ['cadastrar paciente novo', { tipo: 'cadastrar_paciente' }],
  ['agenda de amanhã', { tipo: 'ver_agenda', data: '2026-10-13' }],
  ['agenda', { tipo: 'ver_agenda' }],
  ['ver agenda de sexta', { tipo: 'ver_agenda', data: '2026-10-16' }],
  ['agenda de hoje', { tipo: 'ver_agenda', data: '2026-10-12' }],
  ['agenda dia 20', { tipo: 'ver_agenda', data: '2026-10-20' }],
  ['quem falta confirmar', { tipo: 'listar', lista: 'falta_confirmar' }],
  ['quem não confirmou', { tipo: 'listar', lista: 'falta_confirmar' }],
  ['o que falta confirmar?', { tipo: 'listar', lista: 'falta_confirmar' }],
  ['quem já chegou', { tipo: 'listar', lista: 'chegaram' }],
  ['sala de espera', { tipo: 'listar', lista: 'chegaram' }],
  ['quem faltou hoje', { tipo: 'listar', lista: 'faltas' }],
  ['como cancelo uma consulta', { tipo: 'ajuda' }],
  ['como faço para imprimir recibo', { tipo: 'ajuda' }],
  ['onde fica o financeiro?', { tipo: 'ajuda' }],
  ['não consigo marcar consulta', { tipo: 'ajuda' }],
  ['posso cancelar o sistema?', { tipo: 'ajuda' }],
  ['MARCAR CONSULTA PARA JOÃO QUINTA ÀS 14H', { tipo: 'marcar_consulta', paciente: 'joao', data: '2026-10-15', hora: '14:00' }],
];

describe('interpretador do Ajudante (regras, pt-BR)', () => {
  it('tem pelo menos 60 frases reais', () => {
    expect(CASOS.length).toBeGreaterThanOrEqual(60);
  });

  for (const [frase, esperado] of CASOS) {
    it(`"${frase}"`, () => {
      const r = ler(frase);
      expect(r).not.toBeNull();
      expect(r).toMatchObject(esperado);
      // Sem paciente esperado, nenhum nome inventado.
      if (!('paciente' in esperado) && r && 'paciente' in r) expect(r.paciente).toBeUndefined();
    });
  }

  it('texto sem pedido reconhecível volta null (vira busca simples)', () => {
    expect(ler('maria silva')).toBeNull();
    expect(ler('11 90000')).toBeNull();
    expect(ler('')).toBeNull();
  });

  it('é determinístico', () => {
    const f = 'remarcar a Ana para sexta às 15h';
    expect(ler(f)).toEqual(ler(f));
  });

  it('"quinta" numa quinta vai para a semana seguinte', () => {
    const quinta = new Date(2026, 9, 15, 9);
    expect(parser.interpretar('marcar joao quinta', { agora: quinta })).toMatchObject({ data: '2026-10-22' });
  });

  it('dia que já passou no mês vai para o mês seguinte', () => {
    expect(ler('agenda dia 3')).toMatchObject({ data: '2026-11-03' });
  });
});

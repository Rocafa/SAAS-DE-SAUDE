import { describe, expect, it } from 'vitest';
import { errosDoMapeamento, hashDoPlano, lerData, lerHora, sugerirMapeamento, validarAgenda, validarPacientes, valorParaRelatorio } from './importacao-regras';
import { decodificarUtf8, IMPORT_MAX_COLUNAS, lerCsv, neutralizarFormula, pareceZip, PlanilhaInvalidaError } from './planilha-csv';

/** CPF fictício com DV válido e prefixo 000 (faixa não emitida). */
function cpf(n: number): string {
  const base = `000${String(n).padStart(6, '0')}`;
  const dv = (s: string, peso: number) => {
    let soma = 0;
    for (let i = 0; i < s.length; i++) soma += Number(s[i]) * (peso - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base, 10);
  return `${base}${d1}${dv(`${base}${d1}`, 11)}`;
}

const codigo = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof PlanilhaInvalidaError ? e.codigo : 'outro';
  }
  return undefined;
};

describe('leitura do CSV', () => {
  it('detecta ; (Excel pt-BR), , e TAB; aceita CRLF, aspas, aspas escapadas e quebra de linha dentro de aspas', () => {
    const p = lerCsv('Nome;Telefone\r\n"Ana ""Fic"" Silva";11900000001\r\n"Bia\nTeste";11900000002\r\n\r\n');
    expect(p.separador).toBe(';');
    expect(p.cabecalho).toEqual(['Nome', 'Telefone']);
    expect(p.linhas).toEqual([
      { numero: 2, celulas: ['Ana "Fic" Silva', '11900000001'] },
      { numero: 3, celulas: ['Bia\nTeste', '11900000002'] },
    ]);
    expect(lerCsv('a,b\n1,2').separador).toBe(',');
    expect(lerCsv('a\tb\n1\t2').separador).toBe('\t');
  });

  it('recusa arquivo vazio, aspas abertas, texto colado depois de aspas e excesso de colunas', () => {
    expect(codigo(() => lerCsv('  \n '))).toBe('arquivo_vazio');
    expect(codigo(() => lerCsv('a;b\n"x;1'))).toBe('arquivo_malformado');
    expect(codigo(() => lerCsv('a;b\n"x"y;1'))).toBe('arquivo_malformado');
    // Aspas no meio de célula sem aspas ficam como texto.
    expect(lerCsv('a;b\nx"y;1').linhas[0]?.celulas).toEqual(['x"y', '1']);
    expect(codigo(() => lerCsv(Array.from({ length: IMPORT_MAX_COLUNAS + 1 }, (_, i) => `c${i}`).join(';')))).toBe('colunas_demais');
  });

  it('UTF-8 estrito (Latin-1 e UTF-16 recusados) e BOM removido', () => {
    expect(codigo(() => decodificarUtf8(Uint8Array.from([0x4e, 0xe3, 0x6f])))).toBe('codificacao_invalida');
    expect(codigo(() => decodificarUtf8(Uint8Array.from([0xff, 0xfe, 0x41, 0x00])))).toBe('codificacao_invalida');
    expect(decodificarUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
  });

  it('reconhece ZIP (XLSX/ODS) pela assinatura', () => {
    expect(pareceZip(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(pareceZip(new TextEncoder().encode('nome;cpf'))).toBe(false);
  });

  it('neutraliza fórmula no relatório (= + - @ TAB, espaços antes e fullwidth)', () => {
    for (const f of ['=1+1', '+SOMA(A1)', '-2', '@x', '\tx', '  =x', '＝x']) expect(neutralizarFormula(f)).toBe(`'${f}`);
    expect(neutralizarFormula('Maria')).toBe('Maria');
  });
});

describe('regras do lote de pacientes', () => {
  const mapa = { nome: 0, cpf: 1, telefone: 2, nascimento: 3 };

  it('sugere o mapeamento pelos cabeçalhos usuais (sem acento e caixa)', () => {
    expect(sugerirMapeamento('pacientes', ['Nome Completo', 'CPF', 'Celular', 'Data de Nascimento'])).toEqual(mapa);
    expect(errosDoMapeamento('pacientes', { nome: 0 }, 4)).toEqual(['telefone']);
    expect(errosDoMapeamento('pacientes', { nome: 0, telefone: 9 }, 4)).toEqual(['telefone']);
    expect(errosDoMapeamento('pacientes', { nome: 0, telefone: 0 }, 4)).toEqual(['telefone']);
    expect(errosDoMapeamento('agenda', { data: 0, hora: 1, profissional: 2, tipo: 3 }, 4)).toEqual(['paciente']);
  });

  it('valida CPF (DV), telefone, nascimento (DD/MM/AAAA), obrigatórios, fórmula e duplicado no arquivo', () => {
    const p = lerCsv(
      [
        'nome;cpf;telefone;nascimento',
        `Ana Ficticia;${cpf(1)};(11) 90000-0001;02/01/2001`,
        'Bia Ficticia;12345678900;11900000002;',
        '=HYPERLINK("x");;11900000003;',
        `Caio Ficticio;${cpf(1)};11900000004;`,
        'Dani Ficticia;;123;31/02/2000',
        ';;;',
        'Eva Ficticia;;11900000006;1990-05-05',
        'Eva Ficticia;;11900000007;05/05/1990',
      ].join('\n'),
    );
    const v = validarPacientes(p, mapa, new Date('2026-10-16T12:00:00Z'));
    expect(v.validas.map((x) => x.linha)).toEqual([2, 8, 9]);
    expect(v.validas[0]).toEqual({ linha: 2, nome: 'Ana Ficticia', cpf: cpf(1), telefone: '11900000001', nascimento: '2001-01-02' });
    expect(v.linhasComErro).toBe(5);
    const cod = v.divergencias.map((d) => `${d.linha}:${d.campo}:${d.codigo}:${d.gravidade}`);
    expect(cod).toEqual(
      expect.arrayContaining([
        '3:cpf:cpf_invalido:erro',
        '4:nome:formula_na_celula:erro',
        '5:cpf:cpf_duplicado_no_arquivo:erro',
        '6:telefone:telefone_invalido:erro',
        '6:nascimento:data_invalida:erro',
        '7:nome:obrigatorio:erro',
        '9:nome:possivel_duplicado:aviso',
      ]),
    );
    // O relatório devolve o valor neutralizado.
    expect(valorParaRelatorio(p, mapa, 4, 'nome')).toBe(`'=HYPERLINK("x")`);
  });

  it('linha com número de colunas diferente do cabeçalho é erro', () => {
    const v = validarPacientes(lerCsv('nome;telefone\nAna;11900000001;extra'), { nome: 0, telefone: 1 });
    expect(v.divergencias).toEqual([{ linha: 2, campo: 'linha', codigo: 'numero_de_colunas', gravidade: 'erro' }]);
  });
});

describe('regras do lote de agenda e hash do plano', () => {
  it('data e hora da planilha', () => {
    expect(lerData('5/3/2031')).toBe('2031-03-05');
    expect(lerData('2031-02-30')).toBeUndefined();
    expect(lerHora('8:30')).toBe('08:30');
    expect(lerHora('08:30:00')).toBe('08:30');
    expect(lerHora('24:00')).toBeUndefined();
  });

  it('agenda exige paciente (CPF ou nome), data, hora, profissional e tipo', () => {
    const p = lerCsv(`cpf;paciente;data;hora;profissional;tipo\n${cpf(2)};;10/10/2031;09:00;Prof X;Sessao\n;;10/10/2031;25:00;;Sessao`);
    const v = validarAgenda(p, { cpf: 0, paciente: 1, data: 2, hora: 3, profissional: 4, tipo: 5 });
    expect(v.validas).toEqual([{ linha: 2, cpf: cpf(2), data: '2031-10-10', hora: '09:00', profissional: 'Prof X', tipo: 'Sessao' }]);
    expect(v.divergencias.map((d) => `${d.campo}:${d.codigo}`).sort()).toEqual(['hora:hora_invalida', 'paciente:obrigatorio', 'profissional:obrigatorio']);
  });

  it('o hash muda com qualquer ação e não leva valor de campo', () => {
    const a = hashDoPlano('pacientes', [{ linha: 2, acao: 'criar' }]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoPlano('pacientes', [{ linha: 2, acao: 'ignorar' }])).not.toBe(a);
    expect(hashDoPlano('agenda', [{ linha: 2, acao: 'criar' }])).not.toBe(a);
  });
});

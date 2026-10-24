import { describe, expect, it } from 'vitest';
import { ehMenorDeIdade, errosDoMapeamento, hashDoPlano, lerData, lerHora, sugerirMapeamento, validarAgenda, validarPacientes, valorParaRelatorio } from './importacao-regras';
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

  it('menor de 18 anos pelo nascimento entra com aviso menor_sem_responsavel (R5), só código', () => {
    const mapa = { nome: 0, telefone: 1, nascimento: 2 };
    const p = lerCsv(
      ['nome;telefone;nascimento', 'Lia Ficticia;11900000011;17/10/2008', 'Rui Ficticio;11900000012;16/10/2008', 'Teo Ficticio;11900000013;'].join('\n'),
    );
    const hoje = new Date('2026-10-16T12:00:00Z');
    const v = validarPacientes(p, mapa, hoje);
    expect(v.validas.map((x) => x.linha)).toEqual([2, 3, 4]);
    expect(v.divergencias).toEqual([{ linha: 2, campo: 'nascimento', codigo: 'menor_sem_responsavel', gravidade: 'aviso' }]);
    expect(ehMenorDeIdade('2008-10-17', hoje)).toBe(true);
    expect(ehMenorDeIdade('2008-10-16', hoje)).toBe(false);
  });

  it('R5 (0048): responsável vira vínculo só para menor ou curatela com decisão; o resto é aviso e a linha entra', () => {
    const mapa = {
      nome: 0,
      telefone: 1,
      nascimento: 2,
      cpf: 3,
      responsavelNome: 4,
      responsavelCpf: 5,
      responsavelTelefone: 6,
      responsavelTipo: 7,
      responsavelPagador: 8,
      responsavelCuratelaReferencia: 9,
      responsavelCuratelaEscopo: 10,
    };
    const hoje = new Date('2026-10-16T12:00:00Z');
    const linhas = [
      'nome;tel;nasc;cpf;rnome;rcpf;rtel;rtipo;rpag;rref;resc',
      `Menor Um;11900000021;01/01/2015;;Mae Ficticia;${cpf(901)};11900000091;Mãe;sim;;`, // 2: vínculo + pagador
      `Menor Dois;11900000022;01/01/2016;;Mae Ficticia;${cpf(901)};;mae;nao;;`, // 3: irmão, mesma pessoa
      `Adulto Tres;11900000023;01/01/1990;;Pai Ficticio;${cpf(902)};;pai;;;`, // 4: adulto sem curatela
      `Adulto Quatro;11900000024;01/01/1980;;Curadora Ficticia;${cpf(903)};;curadora;sim;Proc 0001;Atos patrimoniais`, // 5: curatela; pagador cai
      `Adulto Cinco;11900000025;01/01/1980;;Curador Sem Ref;${cpf(904)};;curador;;;`, // 6: curatela sem decisão
      `Menor Seis;11900000026;01/01/2017;;Tia Ficticia;12345678900;;tutora;talvez;;`, // 7: CPF e pagador inválidos
      `Sem Nasc;11900000027;;;Avo Ficticio;;;tutor;;;`, // 8: sem data de nascimento
      `Menor Oito;11900000028;01/01/2018;;Mae Ficticia;${cpf(901)};;mae;;;`, // 9: mesma mãe de novo
      `Menor Nove;11900000029;01/01/2019;${cpf(905)};Ele Mesmo;${cpf(905)};;pai;;;`, // 10: CPF do próprio paciente
      `Menor Dez;11900000030;01/01/2019;;Sem Cpf Ficticio;;;tutor;;;`, // 11: sem CPF
      `Menor Onze;11900000031;01/01/2019;;Curador Menor;${cpf(906)};;curador;;Proc 2;Tudo`, // 12: curatela de menor
    ];
    const v = validarPacientes(lerCsv(linhas.join('\n')), mapa, hoje);
    expect(v.linhasComErro).toBe(0);
    expect(v.validas).toHaveLength(11);
    const resp = new Map(v.validas.map((x) => [x.linha, x.responsavel]));
    expect(resp.get(2)).toEqual({ nome: 'Mae Ficticia', cpf: cpf(901), telefone: '11900000091', tipo: 'pai_mae', pagador: true });
    expect(resp.get(3)).toMatchObject({ tipo: 'pai_mae', pagador: false });
    expect(resp.get(5)).toEqual({ nome: 'Curadora Ficticia', cpf: cpf(903), tipo: 'curador', pagador: false, curatela: { referencia: 'Proc 0001', escopo: 'Atos patrimoniais' } });
    expect(resp.get(11)).toMatchObject({ tipo: 'tutor' });
    for (const l of [4, 6, 7, 8, 10, 12]) expect(resp.get(l), `linha ${l}`).toBeUndefined();
    // A marca clínica não existe no tipo do responsável importado.
    expect(JSON.stringify([...resp.values()])).not.toContain('Clinic');
    const cod = v.divergencias.map((d) => `${d.linha}:${d.campo}:${d.codigo}`);
    expect(cod).toEqual(
      expect.arrayContaining([
        '4:responsavelTipo:vinculo_exige_menor_ou_curatela',
        '4:responsavelNome:responsavel_nao_importado',
        '5:responsavelPagador:pagador_exige_ciencia_do_paciente',
        '6:responsavelCuratelaReferencia:curatela_sem_decisao',
        '7:responsavelCpf:cpf_invalido',
        '7:responsavelPagador:valor_invalido',
        '7:nascimento:menor_sem_responsavel',
        '8:responsavelTipo:vinculo_sem_data_de_nascimento',
        '10:responsavelCpf:cpf_do_proprio_paciente',
        '11:responsavelCpf:responsavel_sem_cpf',
        '12:responsavelTipo:curatela_de_menor',
      ]),
    );
    // Menor com responsável válido não recebe menor_sem_responsavel; todos os problemas do responsável são aviso.
    expect(cod.filter((c) => c.endsWith('menor_sem_responsavel')).map((c) => c.split(':')[0])).toEqual(['7', '10', '12']);
    expect(v.divergencias.every((d) => d.gravidade === 'aviso')).toBe(true);
  });

  it('R5: mapear uma coluna do responsável exige nome e tipo; o mesmo CPF com outro nome no arquivo é aviso', () => {
    expect(errosDoMapeamento('pacientes', { nome: 0, telefone: 1, responsavelCpf: 2 }, 3).sort()).toEqual(['responsavelNome', 'responsavelTipo']);
    expect(errosDoMapeamento('pacientes', { nome: 0, telefone: 1, responsavelNome: 2, responsavelTipo: 3 }, 4)).toEqual([]);
    expect(sugerirMapeamento('pacientes', ['Nome', 'Celular', 'Nome do Responsável', 'CPF do responsável', 'Parentesco'])).toMatchObject({
      responsavelNome: 2,
      responsavelCpf: 3,
      responsavelTipo: 4,
    });
    const p = lerCsv(['n;t;d;rn;rc;rt', `A Fic;11900000001;01/01/2015;Mae Um;${cpf(907)};mae`, `B Fic;11900000002;01/01/2016;Mae Outra;${cpf(907)};mae`].join('\n'));
    const v = validarPacientes(p, { nome: 0, telefone: 1, nascimento: 2, responsavelNome: 3, responsavelCpf: 4, responsavelTipo: 5 }, new Date('2026-10-16T12:00:00Z'));
    expect(v.divergencias).toEqual([{ linha: 3, campo: 'responsavelNome', codigo: 'responsavel_nome_divergente_no_arquivo', gravidade: 'aviso' }]);
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
    const mapa = { nome: 0, nomeSocial: 1, telefone: 2 };
    const sha = 'a'.repeat(64);
    const a = hashDoPlano('pacientes', [{ linha: 2, acao: 'criar' }], mapa, sha);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoPlano('pacientes', [{ linha: 2, acao: 'ignorar' }], mapa, sha)).not.toBe(a);
    expect(hashDoPlano('agenda', [{ linha: 2, acao: 'criar' }], mapa, sha)).not.toBe(a);
  });

  it('R1: o hash amarra o mapeamento (canônico) e a versão do arquivo', () => {
    const sha = 'a'.repeat(64);
    const a = hashDoPlano('pacientes', [{ linha: 2, acao: 'criar' }], { nome: 0, nomeSocial: 1, telefone: 2 }, sha);
    // Mesma coisa em outra ordem de chaves: mesmo hash.
    expect(hashDoPlano('pacientes', [{ linha: 2, acao: 'criar' }], { telefone: 2, nomeSocial: 1, nome: 0 }, sha)).toBe(a);
    // nome <-> nomeSocial trocados: outro hash, mesmo com as mesmas ações.
    expect(hashDoPlano('pacientes', [{ linha: 2, acao: 'criar' }], { nome: 1, nomeSocial: 0, telefone: 2 }, sha)).not.toBe(a);
    // Outro arquivo: outro hash.
    expect(hashDoPlano('pacientes', [{ linha: 2, acao: 'criar' }], { nome: 0, nomeSocial: 1, telefone: 2 }, 'b'.repeat(64))).not.toBe(a);
  });
});

/**
 * Cobertura de auditoria das rotas de escrita (#105, S6). No lugar de um interceptor global (que gravaria fora da
 * transação de quem age), a cobertura é garantida por declaração: toda rota de escrita está em `AUDITADAS` ou em
 * `EXCECOES` (lista.ts), e a análise estática (analise.ts) confere a declaração. Sem banco.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analisarRotasDeEscrita, analisarRotasDeLeitura, type RotaAnalisada } from './analise';
import { AUDITADAS, AUDITADAS_LEITURA, EXCECOES, LEITURA_SEM_DADO_DE_PACIENTE } from './lista';

let rotas: RotaAnalisada[];
const porRota = new Map<string, RotaAnalisada>();

beforeAll(() => {
  rotas = analisarRotasDeEscrita();
  for (const r of rotas) {
    expect(porRota.has(r.rota), `rota duplicada: ${r.rota}`).toBe(false);
    porRota.set(r.rota, r);
  }
}, 120_000);

/**
 * Última definição da função SQL nas migrações (CREATE ou CREATE OR REPLACE), até o fim do corpo `$$`. Um
 * `DROP FUNCTION` depois da última definição devolve `undefined` (R4).
 */
function ultimaDefinicao(funcao: string): string | undefined {
  const dir = path.resolve(__dirname, '../../db/migrations');
  let achada: string | undefined;
  for (const arq of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sqlTexto = readFileSync(path.join(dir, arq), 'utf8');
    const re = new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION (?:public\\.)?${funcao}\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$|DROP FUNCTION (?:IF EXISTS )?(?:public\\.)?${funcao}\\b`,
      'gi',
    );
    for (const m of sqlTexto.matchAll(re)) achada = m[1];
  }
  return achada;
}

describe('#105: cobertura de auditoria das rotas de escrita', () => {
  it('a análise acha as rotas (sanidade: não pode passar com zero)', () => {
    expect(rotas.length).toBeGreaterThanOrEqual(90);
    expect(porRota.get('POST /pacientes')?.alcancaTrilha).toBe(true);
  });

  it('toda rota de escrita está declarada em exatamente uma lista', () => {
    const auditadas = new Set(AUDITADAS);
    expect(auditadas.size, 'rota repetida em AUDITADAS').toBe(AUDITADAS.length);
    const semDeclaracao = rotas.filter((r) => !auditadas.has(r.rota) && !(r.rota in EXCECOES)).map((r) => `${r.rota} (${r.handler}, ${r.arquivo})`);
    expect(semDeclaracao, 'rota de escrita nova sem declaração de auditoria: inclua em AUDITADAS ou em EXCECOES (lista.ts)').toEqual([]);
    const nasDuas = AUDITADAS.filter((r) => r in EXCECOES);
    expect(nasDuas, 'rota nas duas listas').toEqual([]);
  });

  it('não há declaração de rota que não existe mais', () => {
    const velhas = [...AUDITADAS, ...Object.keys(EXCECOES)].filter((r) => !porRota.has(r));
    expect(velhas, 'rota declarada que não existe (removida ou renomeada): atualize lista.ts').toEqual([]);
  });

  it('toda rota em AUDITADAS tem caminho de chamada até insertAudit', () => {
    const semTrilha = AUDITADAS.filter((r) => porRota.get(r)?.alcancaTrilha === false).map((r) => `${r} (${porRota.get(r)?.handler})`);
    expect(semTrilha, 'rota declarada como auditada não chega a insertAudit').toEqual([]);
  });

  it('exceção que passou a gravar pelo código vai para AUDITADAS', () => {
    const gravam = Object.keys(EXCECOES).filter((r) => porRota.get(r)?.alcancaTrilha === true);
    expect(gravam, 'a rota já grava a trilha pelo código: mova para AUDITADAS').toEqual([]);
  });

  it('toda exceção tem motivo e é provada: banco (handler chama a função, que grava em audit_log) ou sem_efeito (só lança)', () => {
    for (const [rota, e] of Object.entries(EXCECOES)) {
      expect(e.motivo.trim().length, `${rota}: motivo vazio`).toBeGreaterThan(20);
      const r = porRota.get(rota);
      if (e.tipo === 'banco') {
        // R4: a função citada é chamada a partir do handler, e a última definição dela grava a trilha.
        const chamada = new RegExp(`\\b${e.funcaoSql}\\s*\\(`);
        expect(r?.sqlAlcancado.some((t) => chamada.test(t)), `${rota}: o handler não chama ${e.funcaoSql}`).toBe(true);
        const corpo = ultimaDefinicao(e.funcaoSql);
        expect(corpo, `${rota}: função ${e.funcaoSql} não achada nas migrações (ou apagada depois)`).toBeDefined();
        expect(corpo ?? '', `${rota}: ${e.funcaoSql} não grava em audit_log`).toMatch(/INSERT INTO (?:public\.)?audit_log\b/i);
      } else {
        // R2: rota declarada sem efeito só lança; se ganhar implementação, sai das exceções.
        expect(r?.soLanca, `${rota}: declarada sem_efeito, mas o handler faz mais do que lançar erro`).toBe(true);
      }
    }
  });
});

/**
 * Rota de leitura sob caminho de dado de paciente ou clínico nunca é exceção (tem de gravar a trilha). Lista por
 * PREFIXO, do lado seguro (R2 do parecer de 03/11 sobre o #119): o portal inteiro e o financeiro inteiro, salvo as
 * configurações listadas.
 */
const PREFIXOS_CLINICOS = [
  'pacientes', 'prontuario', 'atendimentos', 'notas-privadas', 'custodias', 'agendamentos', 'guias', 'pacotes', 'convenios',
  'financeiro', 'importacoes', 'responsaveis', 'portal', 'clinica/portal', 'whatsapp/envios', 'suporte',
];
const FORA_DO_CAMINHO_CLINICO = new Set([
  'GET /financeiro/retencao-fiscal',
  'GET /financeiro/configuracao',
  'GET /financeiro/profissionais/:id/perfil-fiscal',
  'GET /importacoes/termo',
]);
function ehCaminhoClinico(rota: string): boolean {
  if (FORA_DO_CAMINHO_CLINICO.has(rota)) return false;
  const caminho = rota.replace(/^GET \//, '');
  return PREFIXOS_CLINICOS.some((p) => caminho === p || caminho.startsWith(`${p}/`));
}

describe('R5: cobertura de auditoria das rotas de leitura (GET)', () => {
  let leituras: Map<string, RotaAnalisada>;

  beforeAll(() => {
    leituras = new Map(analisarRotasDeLeitura().map((r) => [r.rota, r]));
  }, 120_000);

  it('a análise acha as rotas de leitura (sanidade)', () => {
    expect(leituras.size).toBeGreaterThanOrEqual(55);
    expect(leituras.get('GET /pacientes/:id')?.alcancaTrilha).toBe(true);
  });

  it('toda rota GET está declarada em exatamente uma lista, e nenhuma declaração sobra', () => {
    const auditadas = new Set(AUDITADAS_LEITURA);
    expect(auditadas.size, 'rota repetida em AUDITADAS_LEITURA').toBe(AUDITADAS_LEITURA.length);
    const semDeclaracao = [...leituras.values()]
      .filter((r) => !auditadas.has(r.rota) && !(r.rota in LEITURA_SEM_DADO_DE_PACIENTE))
      .map((r) => `${r.rota} (${r.handler}, ${r.arquivo})`);
    expect(semDeclaracao, 'rota de leitura nova sem declaração: inclua em AUDITADAS_LEITURA ou em LEITURA_SEM_DADO_DE_PACIENTE (lista.ts)').toEqual([]);
    expect(AUDITADAS_LEITURA.filter((r) => r in LEITURA_SEM_DADO_DE_PACIENTE), 'rota nas duas listas').toEqual([]);
    const velhas = [...AUDITADAS_LEITURA, ...Object.keys(LEITURA_SEM_DADO_DE_PACIENTE)].filter((r) => !leituras.has(r));
    expect(velhas, 'rota de leitura declarada que não existe mais: atualize lista.ts').toEqual([]);
  });

  it('toda rota em AUDITADAS_LEITURA tem caminho de chamada até insertAudit', () => {
    const semTrilha = AUDITADAS_LEITURA.filter((r) => leituras.get(r)?.alcancaTrilha === false);
    expect(semTrilha, 'rota de leitura declarada como auditada não chega a insertAudit').toEqual([]);
  });

  it('exceção de leitura: tem motivo, não está sob caminho clínico e, se passou a gravar, vai para AUDITADAS_LEITURA', () => {
    for (const [rota, motivo] of Object.entries(LEITURA_SEM_DADO_DE_PACIENTE)) {
      expect(motivo.trim().length, `${rota}: motivo vazio`).toBeGreaterThan(20);
      expect(ehCaminhoClinico(rota), `${rota}: rota sob caminho clínico não pode ficar sem trilha`).toBe(false);
      expect(leituras.get(rota)?.alcancaTrilha, `${rota}: já grava a trilha, mova para AUDITADAS_LEITURA`).toBe(false);
    }
  });

  it('a trava de caminho clínico pega as rotas que importam (sanidade da expressão)', () => {
    for (const r of ['GET /pacientes', 'GET /pacientes/:id/prontuario', 'GET /portal/meus-dados', 'GET /portal/sessao', 'GET /portal/vinculos', 'GET /financeiro/recibos/:id', 'GET /financeiro/caixas', 'GET /clinica/portal/solicitacoes', 'GET /agendamentos', 'GET /importacoes/:id', 'GET /whatsapp/envios', 'GET /suporte/autorizacoes']) {
      expect(ehCaminhoClinico(r), r).toBe(true);
    }
    for (const r of ['GET /health', 'GET /sessao', 'GET /financeiro/retencao-fiscal', 'GET /importacoes/termo', 'GET /whatsapp/modelos', 'GET /portalx']) {
      expect(ehCaminhoClinico(r), r).toBe(false);
    }
  });
});

describe('#105: sanidade da análise (fixtures fictícios, parecer de 03/11/2026)', () => {
  const fixture = (nome: string) => path.join(__dirname, 'fixtures', nome);
  let ficticias: Map<string, RotaAnalisada>;

  beforeAll(() => {
    ficticias = new Map(analisarRotasDeEscrita([fixture('rotas-ficticias.ts')]).map((r) => [r.rota, r]));
  }, 120_000);

  it('só vê as rotas do fixture, com o decorator renomeado no import (R3)', () => {
    expect([...ficticias.keys()].sort()).toEqual(
      ['POST /ficticio/apelido', 'POST /ficticio/banco', 'POST /ficticio/negacao-com-trilha', 'POST /ficticio/so-lanca', 'POST /ficticio/so-negacao', 'POST /ficticio/so-vigilancia'].sort(),
    );
    expect(ficticias.get('POST /ficticio/apelido')?.alcancaTrilha).toBe(true);
  });

  it('gravador incidental não conta como trilha; o callback da negação é seguido (R1)', () => {
    expect(ficticias.get('POST /ficticio/so-negacao')?.alcancaTrilha).toBe(false);
    expect(ficticias.get('POST /ficticio/so-vigilancia')?.alcancaTrilha).toBe(false);
    expect(ficticias.get('POST /ficticio/negacao-com-trilha')?.alcancaTrilha).toBe(true);
  });

  it('prova de só lançar (R2) e SQL alcançado (R4)', () => {
    expect(ficticias.get('POST /ficticio/so-lanca')?.soLanca).toBe(true);
    expect(ficticias.get('POST /ficticio/banco')?.soLanca).toBe(false);
    expect(ficticias.get('POST /ficticio/banco')?.sqlAlcancado.join(' ')).toMatch(/app_ficticia_grava_trilha\(/);
  });

  it('leitura: vigilância não conta, a trilha da própria leitura conta (R5)', () => {
    const l = new Map(analisarRotasDeLeitura([fixture('rotas-ficticias.ts')]).map((r) => [r.rota, r]));
    expect([...l.keys()].sort()).toEqual(['GET /ficticio/leitura-auditada', 'GET /ficticio/leitura-so-vigilancia']);
    expect(l.get('GET /ficticio/leitura-so-vigilancia')?.alcancaTrilha).toBe(false);
    expect(l.get('GET /ficticio/leitura-auditada')?.alcancaTrilha).toBe(true);
  }, 120_000);

  it('decorator de rota não tratado ou composto faz a análise falhar com o nome (R3)', () => {
    expect(() => analisarRotasDeEscrita([fixture('decorator-nao-tratado.ts')])).toThrow(/@Head/);
    expect(() => analisarRotasDeEscrita([fixture('decorator-composto.ts')])).toThrow(/@RotaComposta/);
  }, 240_000);
});

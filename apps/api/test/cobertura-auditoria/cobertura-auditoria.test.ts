/**
 * Cobertura de auditoria das rotas de escrita (#105, S6). No lugar de um interceptor global (que gravaria fora da
 * transação de quem age), a cobertura é garantida por declaração: toda rota de escrita está em `AUDITADAS` ou em
 * `EXCECOES` (lista.ts), e a análise estática (analise.ts) confere a declaração. Sem banco.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analisarRotasDeEscrita, type RotaDeEscrita } from './analise';
import { AUDITADAS, EXCECOES } from './lista';

let rotas: RotaDeEscrita[];
const porRota = new Map<string, RotaDeEscrita>();

beforeAll(() => {
  rotas = analisarRotasDeEscrita();
  for (const r of rotas) {
    expect(porRota.has(r.rota), `rota duplicada: ${r.rota}`).toBe(false);
    porRota.set(r.rota, r);
  }
}, 120_000);

/** Última definição da função SQL nas migrações (CREATE ou CREATE OR REPLACE), até o fim do corpo `$$`. */
function ultimaDefinicao(funcao: string): string | undefined {
  const dir = path.resolve(__dirname, '../../db/migrations');
  let achada: string | undefined;
  for (const arq of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sqlTexto = readFileSync(path.join(dir, arq), 'utf8');
    const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION (?:public\\.)?${funcao}\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'g');
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

  it('toda exceção tem motivo; a do tipo banco grava em audit_log na última definição da função', () => {
    for (const [rota, e] of Object.entries(EXCECOES)) {
      expect(e.motivo.trim().length, `${rota}: motivo vazio`).toBeGreaterThan(20);
      if (e.tipo === 'banco') {
        const corpo = ultimaDefinicao(e.funcaoSql);
        expect(corpo, `${rota}: função ${e.funcaoSql} não achada nas migrações`).toBeDefined();
        expect(corpo ?? '', `${rota}: ${e.funcaoSql} não grava em audit_log`).toMatch(/INSERT INTO (?:public\.)?audit_log\b/i);
      }
    }
  });
});

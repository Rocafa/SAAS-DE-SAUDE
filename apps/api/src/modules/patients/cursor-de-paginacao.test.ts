/** Cursor opaco e assinado da lista de pacientes (R5 do parecer #76). Ids 100% fictícios. */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CursorDePaginacao, CursorInvalidoError, loadPaginationCursorKey, VALIDADE_DO_CURSOR_MS } from './cursor-de-paginacao';

const ctxA = { tenantId: '00000000-0000-4000-8000-00000000000a' as TenantId, userId: '00000000-0000-4000-8000-0000000000a1' as UserId, roles: [] } as unknown as RequestContext;
const ctxB = { ...ctxA, tenantId: '00000000-0000-4000-8000-00000000000b' as TenantId } as RequestContext;
const outroUsuario = { ...ctxA, userId: '00000000-0000-4000-8000-0000000000a2' as UserId } as RequestContext;
const filtro = { situacao: 'todos', limite: 10 };
const pos = { pagina: 2, depoisDe: '00000000-0000-4000-8000-000000000123' };

function relogio(inicio = 1_800_000_000_000) {
  let t = inicio;
  return { agora: () => t, avancar: (ms: number) => (t += ms) };
}

function recusa(fn: () => unknown) {
  let erro: unknown;
  try {
    fn();
  } catch (e) {
    erro = e;
  }
  expect(erro).toBeInstanceOf(CursorInvalidoError);
  expect((erro as CursorInvalidoError).getStatus()).toBe(409);
  expect((erro as CursorInvalidoError).getResponse()).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'cursor_invalido' });
}

describe('CursorDePaginacao', () => {
  const chave = randomBytes(32);

  it('caminho feliz: mesma sessão e mesmo filtro devolvem a posição', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, filtro, pos);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(c.ler(ctxA, filtro, token)).toEqual(pos);
  });

  it('nenhum dado pessoal no cursor: payload só com ids técnicos, página e validade; termo de busca fica fora', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, { ...filtro, busca: 'maria ficticia' }, pos);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['c', 'e', 'k', 'p', 'u']);
    expect(token).not.toContain('maria');
    expect(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).not.toContain('maria');
  });

  it('cursor de outra clínica ou de outro usuário: 409 cursor_invalido', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, filtro, pos);
    recusa(() => c.ler(ctxB, filtro, token));
    recusa(() => c.ler(outroUsuario, filtro, token));
  });

  it('cursor de outro filtro (situação, limite, termo) ou de outra lista: 409', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, { ...filtro, busca: 'ana' }, pos);
    recusa(() => c.ler(ctxA, { ...filtro, busca: 'bia' }, token));
    recusa(() => c.ler(ctxA, filtro, token));
    recusa(() => c.ler(ctxA, { situacao: 'ativos', limite: 10, busca: 'ana' }, token));
    recusa(() => c.ler(ctxA, { situacao: 'todos', limite: 11, busca: 'ana' }, token));
    recusa(() => new CursorDePaginacao(chave, 'guias').ler(ctxA, { ...filtro, busca: 'ana' }, token));
  });

  it('adulterado: payload trocado (outra clínica/página), assinatura trocada, chave de outro processo, lixo', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, filtro, pos);
    const [v, corpo, mac] = token.split('.') as [string, string, string];
    const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forjado = Buffer.from(JSON.stringify({ ...p, c: ctxB.tenantId, p: 9 })).toString('base64url');
    recusa(() => c.ler(ctxB, filtro, `${v}.${forjado}.${mac}`));
    recusa(() => c.ler(ctxA, filtro, `${v}.${corpo}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`));
    recusa(() => c.ler(ctxA, filtro, `v2.${corpo}.${mac}`));
    recusa(() => new CursorDePaginacao(randomBytes(32), 'pacientes').ler(ctxA, filtro, token));
    for (const lixo of ['', 'v1', 'v1..', 'v1.a.b.c', 'v1.$$.%%', '2']) recusa(() => c.ler(ctxA, filtro, lixo));
  });

  it('vencido: vale por 10 minutos a partir da emissão', () => {
    const r = relogio();
    const c = new CursorDePaginacao(chave, 'pacientes', r.agora);
    const token = c.assinar(ctxA, filtro, pos);
    r.avancar(VALIDADE_DO_CURSOR_MS - 1000);
    expect(c.ler(ctxA, filtro, token)).toEqual(pos);
    r.avancar(1000);
    recusa(() => c.ler(ctxA, filtro, token));
  });

  it('segredo: obrigatório em produção, mínimo de 32 bytes, aleatório por processo fora de produção', () => {
    expect(() => loadPaginationCursorKey({ NODE_ENV: 'production' })).toThrow(/obrigatória em produção/);
    expect(() => loadPaginationCursorKey({ PAGINATION_CURSOR_KEY: 'curta' })).toThrow(/32 bytes/);
    expect(loadPaginationCursorKey({ PAGINATION_CURSOR_KEY: 'k'.repeat(32) }).length).toBe(32);
    expect(loadPaginationCursorKey({})).toBe(loadPaginationCursorKey({}));
    expect(() => new CursorDePaginacao(randomBytes(8), 'pacientes')).toThrow();
  });
});

/** Cursor opaco, cifrado e assinado da lista de pacientes (R5 do parecer #76; R7–R9). Ids e nomes 100% fictícios. */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CursorDePaginacao, CursorInvalidoError, loadPaginationCursorKey, VALIDADE_DO_CURSOR_MS } from './cursor-de-paginacao';

const ctxA = { tenantId: '00000000-0000-4000-8000-00000000000a' as TenantId, userId: '00000000-0000-4000-8000-0000000000a1' as UserId, roles: [] } as unknown as RequestContext;
const ctxB = { ...ctxA, tenantId: '00000000-0000-4000-8000-00000000000b' as TenantId } as RequestContext;
const outroUsuario = { ...ctxA, userId: '00000000-0000-4000-8000-0000000000a2' as UserId } as RequestContext;
const filtro = { situacao: 'todos', limite: 10 };
const pos = { pagina: 2, depoisDe: '00000000-0000-4000-8000-000000000123', nomeDaAncora: 'paciente ficticio ancora' };
const lida = { pagina: pos.pagina, depoisDe: pos.depoisDe };

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

/** Segredo de teste gerado na hora (nunca valor fixo). */
const base64Aleatorio = (n = 32) => randomBytes(n).toString('base64');

describe('CursorDePaginacao', () => {
  const chave = randomBytes(32);

  it('caminho feliz: mesma sessão e mesmo filtro devolvem a posição', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, filtro, pos);
    expect(token).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(512);
    expect(c.ler(ctxA, filtro, token)).toMatchObject(lida);
  });

  it('R7: cifrado — nenhum UUID, nome ou termo legível no cursor (o log do ALB só vê bytes opacos)', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, { ...filtro, busca: 'maria ficticia' }, pos);
    const decodificado = token
      .split('.')
      .slice(1)
      .map((p) => Buffer.from(p, 'base64url').toString('latin1'))
      .join('|');
    for (const visivel of [token, decodificado]) {
      for (const segredo of [ctxA.tenantId, ctxA.userId, pos.depoisDe, '000000000123', 'maria', 'ficticio', 'ancora', '"c"', '"k"']) {
        expect(visivel).not.toContain(segredo);
      }
    }
    // Mesmo conteúdo, cursores diferentes (IV aleatório): não dá para correlacionar no log.
    expect(c.assinar(ctxA, filtro, pos)).not.toBe(c.assinar(ctxA, filtro, pos));
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

  it('adulterado: cifra trocada, IV trocado, assinatura trocada, versão antiga, chave de outro processo, lixo', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const token = c.assinar(ctxA, filtro, pos);
    const [v, iv, ct, mac] = token.split('.') as [string, string, string, string];
    const troca = (s: string) => `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`;
    recusa(() => c.ler(ctxA, filtro, `${v}.${iv}.${troca(ct)}.${mac}`));
    recusa(() => c.ler(ctxA, filtro, `${v}.${troca(iv)}.${ct}.${mac}`));
    recusa(() => c.ler(ctxA, filtro, `${v}.${iv}.${ct}.${troca(mac)}`));
    // Cursor de outro token colado (partes de dois cursores válidos): recusado.
    const [, iv2, ct2] = c.assinar(ctxA, filtro, pos).split('.') as [string, string, string];
    recusa(() => c.ler(ctxA, filtro, `${v}.${iv2}.${ct2}.${mac}`));
    // Formato v1 (só assinado, payload legível) não é mais aceito.
    recusa(() => c.ler(ctxA, filtro, `v1.${ct}.${mac}`));
    recusa(() => new CursorDePaginacao(randomBytes(32), 'pacientes').ler(ctxA, filtro, token));
    for (const lixo of ['', 'v2', 'v2...', 'v2.a.b.c.d', 'v2.$$.%%.&&', '2']) recusa(() => c.ler(ctxA, filtro, lixo));
  });

  it('vencido: vale por 10 minutos a partir da emissão', () => {
    const r = relogio();
    const c = new CursorDePaginacao(chave, 'pacientes', r.agora);
    const token = c.assinar(ctxA, filtro, pos);
    r.avancar(VALIDADE_DO_CURSOR_MS - 1000);
    expect(c.ler(ctxA, filtro, token)).toMatchObject(lida);
    r.avancar(1000);
    recusa(() => c.ler(ctxA, filtro, token));
  });

  it('R9: âncora sumida ou com outro nome de busca = 409; mesma âncora segue', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const posicao = c.ler(ctxA, filtro, c.assinar(ctxA, filtro, pos));
    expect(() => c.conferirAncora(posicao, pos.nomeDaAncora)).not.toThrow();
    recusa(() => c.conferirAncora(posicao, undefined));
    recusa(() => c.conferirAncora(posicao, 'paciente ficticio renomeado'));
    // A marca não é o nome: só 16 bytes de HMAC.
    expect(posicao.marcaDaAncora).not.toContain('ficticio');
    expect(Buffer.from(posicao.marcaDaAncora, 'base64url')).toHaveLength(16);
  });

  it('V2-b: a marca muda entre clínicas e entre ids da âncora (mesmo nome); é estável para o mesmo registro', () => {
    const c = new CursorDePaginacao(chave, 'pacientes');
    const marca = (ctx: RequestContext, depoisDe: string) => c.ler(ctx, filtro, c.assinar(ctx, filtro, { ...pos, depoisDe })).marcaDaAncora;
    const outroId = '00000000-0000-4000-8000-000000000456';
    const base = marca(ctxA, pos.depoisDe);
    expect(marca(ctxA, pos.depoisDe)).toBe(base);
    expect(marca(ctxB, pos.depoisDe)).not.toBe(base);
    expect(marca(ctxA, outroId)).not.toBe(base);
    // A marca de um registro não confere outro: homônimo de outra clínica ou outro id = 409.
    const posicao = c.ler(ctxA, filtro, c.assinar(ctxA, filtro, pos));
    recusa(() => c.conferirAncora({ ...posicao, clinica: ctxB.tenantId }, pos.nomeDaAncora));
    recusa(() => c.conferirAncora({ ...posicao, depoisDe: outroId }, pos.nomeDaAncora));
  });

  it('V2-a: cursor v2 emitido antes da mudança (marca com a chave de HMAC, sem clínica nem id) dá 409', () => {
    // Reproduz o emissor anterior: mesmas chaves de cifra/assinatura, marca = HMAC(chave de assinatura, ancora|escopo|nome).
    const derivar = (uso: string) => Buffer.from(hkdfSync('sha256', chave, 'plataforma-saude/cursor-de-paginacao', uso, 32));
    const chaveCifra = derivar('cifra-v2');
    const chaveMac = derivar('assinatura-v2');
    const sep = '\u001f';
    const amarra = [filtro.situacao, String(filtro.limite), '-'];
    const hAntigo = createHmac('sha256', chaveMac).update(['ancora', 'pacientes', pos.nomeDaAncora].join(sep)).digest().subarray(0, 16).toString('base64url');
    const payload = { c: ctxA.tenantId, u: ctxA.userId, e: Math.floor((Date.now() + 60_000) / 1000), p: pos.pagina, k: pos.depoisDe, h: hAntigo };
    const iv = randomBytes(12);
    const cifra = createCipheriv('aes-256-gcm', chaveCifra, iv);
    cifra.setAAD(Buffer.from(['v2', 'pacientes', ...amarra].join(sep), 'utf8'));
    const ct = Buffer.concat([cifra.update(JSON.stringify(payload), 'utf8'), cifra.final(), cifra.getAuthTag()]);
    const ivB = iv.toString('base64url');
    const ctB = ct.toString('base64url');
    const mac = createHmac('sha256', chaveMac).update(['v2', 'pacientes', ivB, ctB, ...amarra].join(sep)).digest('base64url');
    const antigo = `v2.${ivB}.${ctB}.${mac}`;

    const c = new CursorDePaginacao(chave, 'pacientes');
    // Assinatura e cifra continuam válidas (controle), mas a marca antiga não confere com a âncora intacta.
    const posicao = c.ler(ctxA, filtro, antigo);
    expect(posicao).toMatchObject(lida);
    recusa(() => c.conferirAncora(posicao, pos.nomeDaAncora));
    // A marca nova não é a antiga (chave própria + clínica + id).
    expect(c.ler(ctxA, filtro, c.assinar(ctxA, filtro, pos)).marcaDaAncora).not.toBe(hAntigo);
  });

  it('segredo: obrigatório em produção, mínimo de 32 bytes, aleatório por processo fora de produção', () => {
    expect(() => loadPaginationCursorKey({ NODE_ENV: 'production' })).toThrow(/obrigatória em produção/);
    expect(() => loadPaginationCursorKey({ PAGINATION_CURSOR_KEY: 'curta' })).toThrow(/32 bytes/);
    expect(loadPaginationCursorKey({ PAGINATION_CURSOR_KEY: 'k'.repeat(32) }).length).toBe(32);
    expect(loadPaginationCursorKey({})).toBe(loadPaginationCursorKey({}));
    expect(() => new CursorDePaginacao(randomBytes(8), 'pacientes')).toThrow();
  });

  describe('R8: entropia mínima do segredo em produção', () => {
    const prod = (PAGINATION_CURSOR_KEY: string, extra: Record<string, string> = {}) => () =>
      loadPaginationCursorKey({ NODE_ENV: 'production', PAGINATION_CURSOR_KEY, ...extra });

    it('aceita bytes aleatórios em base64, base64url ou hex (≥ 32 bytes decodificados) e usa os bytes', () => {
      const bytes = randomBytes(32);
      expect(prod(bytes.toString('base64'))()).toEqual(bytes);
      expect(prod(bytes.toString('base64url'))()).toEqual(bytes);
      expect(prod(bytes.toString('hex'))()).toEqual(bytes);
      expect(prod(base64Aleatorio(48))()).toHaveLength(48);
    });

    it('recusa frase, texto com ≥ 32 caracteres mas sem codificação, ou poucos bytes decodificados', () => {
      expect(prod('uma frase longa qualquer com mais de trinta e dois bytes')).toThrow(/base64 ou hex/);
      expect(prod('k'.repeat(32))).toThrow(/32 bytes decodificados/); // 32 caracteres base64 = 24 bytes
      expect(prod(base64Aleatorio(24))).toThrow(/32 bytes decodificados/);
      expect(prod(randomBytes(31).toString('hex'))).toThrow(/32 bytes decodificados/);
    });

    it('recusa repetição e baixa variedade de bytes', () => {
      expect(prod('Q'.repeat(44))).toThrow(/fraca ou de exemplo/);
      expect(prod('0'.repeat(64))).toThrow(/fraca ou de exemplo/);
      expect(prod(Buffer.alloc(48, 'ab').toString('base64'))).toThrow(/fraca ou de exemplo/);
      expect(prod('ab'.repeat(32))).toThrow(/fraca ou de exemplo/);
    });

    it('recusa valores com cara de exemplo/placeholder', () => {
      for (const sinal of ['exemplo', 'CHANGEME', 'troque', 'placeholder', 'secret']) {
        const valor = `${sinal}${randomBytes(48).toString('base64url')}`.slice(0, 64);
        expect(prod(valor), sinal).toThrow(/fraca ou de exemplo/);
      }
    });

    it('recusa o mesmo valor de RATE_LIMIT_HASH_KEY (C1: dois segredos distintos)', () => {
      const valor = base64Aleatorio();
      expect(prod(valor, { RATE_LIMIT_HASH_KEY: valor })).toThrow(/RATE_LIMIT_HASH_KEY/);
      expect(prod(valor, { RATE_LIMIT_HASH_KEY: base64Aleatorio() })).not.toThrow();
    });

    it('compara pelos BYTES decodificados: os mesmos bytes em outra codificação também são recusados', () => {
      const bytes = randomBytes(32);
      for (const [cursor, rl] of [
        [bytes.toString('base64'), bytes.toString('hex')],
        [bytes.toString('hex'), bytes.toString('base64url')],
        [bytes.toString('base64url'), bytes.toString('base64')],
        [bytes.toString('base64'), ` ${bytes.toString('base64')} `],
      ] as const) {
        expect(prod(cursor, { RATE_LIMIT_HASH_KEY: rl }), `${cursor.length}/${rl.length}`).toThrow(/RATE_LIMIT_HASH_KEY/);
      }
      // O rate limit usa o texto como chave (UTF-8): se esse texto é exatamente os bytes do cursor, também é o mesmo segredo.
      const imprimivel = Buffer.from(base64Aleatorio(48), 'utf8').subarray(0, 48);
      expect(prod(imprimivel.toString('base64'), { RATE_LIMIT_HASH_KEY: imprimivel.toString('utf8') })).toThrow(/RATE_LIMIT_HASH_KEY/);
    });
  });
});

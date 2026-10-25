/**
 * Cursor opaco e assinado da lista de pacientes (R5 do parecer PR #76) contra Postgres REAL.
 *
 * O caso que o front não fecha sozinho: a sessão troca A→B→A durante a paginação e páginas de B se
 * misturariam à lista de A. Com o cursor amarrado a clínica + usuário + filtro + validade, a página
 * seguinte pedida com outra sessão é recusada (409 `cursor_invalido`, sem dados).
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import { AuditAction, type TenantId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { CursorDePaginacao, loadPaginationCursorKey, VALIDADE_DO_CURSOR_MS } from '../src/modules/patients/cursor-de-paginacao';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const TOTAL = 5;
const RECUSA = { statusCode: 409, message: 'Conflito', codigo: 'cursor_invalido' };

interface Pagina {
  itens: { id: string; nome: string }[];
  pagina: number;
  limite: number;
  temMais: boolean;
  proximoCursor: string | null;
}

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let recepA: { Authorization: string; userId: string };
const idsA: string[] = [];

async function leiturasAuditadas(tenantId: TenantId, userId: string): Promise<number> {
  const linhas = await withTenant(api.db.db, tenantId, (tx) =>
    tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.Read), eq(auditLog.scope, 'patients'), eq(auditLog.actorId, userId))),
  );
  return linhas.length;
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  recepA = api.sessao(clinicaA, 'recepcao');
  const adminA = api.sessao(clinicaA, 'admin');
  const adminB = api.sessao(clinicaB, 'admin');
  for (let i = 0; i < TOTAL; i++) {
    const a = await api.http().post('/pacientes').set(cab(adminA)).send({ nome: `Paciente Ficticio Cursor A${i}`, telefone: '11900000020' });
    expect(a.status).toBe(201);
    idsA.push((a.body as { id: string }).id);
    const b = await api.http().post('/pacientes').set(cab(adminB)).send({ nome: `Paciente Ficticio Cursor B${i}`, telefone: '11900000021' });
    expect(b.status).toBe(201);
  }
});

afterAll(async () => {
  await api?.fechar();
});

describe('cursor de paginação (R5 do parecer #76)', () => {
  it('caminho feliz: percorre todas as páginas pelo cursor, sem repetir nem pular', async () => {
    const vistos: string[] = [];
    let r = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos' }).set(cab(recepA)).expect(200);
    let pag = r.body as Pagina;
    expect(pag).toMatchObject({ pagina: 1, limite: 2, temMais: true });
    expect(typeof pag.proximoCursor).toBe('string');
    vistos.push(...pag.itens.map((i) => i.id));
    while (pag.proximoCursor) {
      r = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor: pag.proximoCursor }).set(cab(recepA)).expect(200);
      pag = r.body as Pagina;
      vistos.push(...pag.itens.map((i) => i.id));
    }
    expect(pag).toMatchObject({ pagina: 3, temMais: false, proximoCursor: null });
    expect(vistos).toHaveLength(TOTAL);
    expect([...vistos].sort()).toEqual([...idsA].sort());
  });

  it('busca no corpo também pagina por cursor, amarrado ao termo', async () => {
    const p1 = await api.http().post('/pacientes/busca').set(cab(recepA)).send({ busca: 'cursor a', limite: 3 }).expect(200);
    const pag1 = p1.body as Pagina;
    expect(pag1.temMais).toBe(true);
    const p2 = await api.http().post('/pacientes/busca').set(cab(recepA)).send({ busca: 'cursor a', limite: 3, cursor: pag1.proximoCursor }).expect(200);
    expect((p2.body as Pagina).itens).toHaveLength(TOTAL - 3);
    // Mesmo cursor com outro termo: recusado.
    const outro = await api.http().post('/pacientes/busca').set(cab(recepA)).send({ busca: 'cursor b', limite: 3, cursor: pag1.proximoCursor });
    expect(outro.status).toBe(409);
    expect(outro.body).toEqual(RECUSA);
  });

  it('nenhum dado pessoal no cursor (só ids técnicos, página e validade)', async () => {
    const r = await api.http().post('/pacientes/busca').set(cab(recepA)).send({ busca: 'cursor a', limite: 1 }).expect(200);
    const cursor = (r.body as Pagina).proximoCursor!;
    const payload = Buffer.from(cursor.split('.')[1]!, 'base64url').toString('utf8');
    expect(payload).not.toMatch(/ficticio|cursor a/i);
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(['c', 'e', 'k', 'p', 'u']);
  });

  it('A→B→A: o mesmo usuário troca de clínica no meio; a página com o cursor de A sob B é recusada sem dados', async () => {
    const userId = recepA.userId;
    const sobB = { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinicaB, userId, perfis: ['recepcao'] })}`, userId };
    const p1 = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos' }).set(cab(recepA)).expect(200);
    const cursorA = (p1.body as Pagina).proximoCursor!;
    const antes = await leiturasAuditadas(clinicaB, userId);
    const r = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor: cursorA }).set(cab(sobB));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(RECUSA);
    expect(JSON.stringify(r.body)).not.toMatch(/Ficticio/);
    // Recusa sem leitura: nenhum registro de leitura novo na trilha de B.
    expect(await leiturasAuditadas(clinicaB, userId)).toBe(antes);
    // Cursor emitido sob B não serve de volta em A.
    const pB = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos' }).set(cab(sobB)).expect(200);
    const voltaA = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor: (pB.body as Pagina).proximoCursor! }).set(cab(recepA));
    expect(voltaA.status).toBe(409);
    expect(voltaA.body).toEqual(RECUSA);
  });

  it('cursor de outro usuário da mesma clínica ou de outro filtro: 409', async () => {
    const p1 = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos' }).set(cab(recepA)).expect(200);
    const cursor = (p1.body as Pagina).proximoCursor!;
    const colega = api.sessao(clinicaA, 'recepcao');
    const r = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor }).set(cab(colega));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(RECUSA);
    expect((await api.http().get('/pacientes').query({ limite: '3', situacao: 'todos', cursor }).set(cab(recepA))).status).toBe(409);
    expect((await api.http().get('/pacientes').query({ limite: '2', cursor }).set(cab(recepA))).status).toBe(409);
  });

  it('adulterado: payload com outra página ou outra âncora, assinatura trocada: 409', async () => {
    const p1 = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos' }).set(cab(recepA)).expect(200);
    const [v, corpo, mac] = (p1.body as Pagina).proximoCursor!.split('.') as [string, string, string];
    const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forjado = Buffer.from(JSON.stringify({ ...p, p: 4, k: idsA[0] })).toString('base64url');
    for (const cursor of [`${v}.${forjado}.${mac}`, `${v}.${corpo}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`, 'qualquer-coisa']) {
      const r = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor }).set(cab(recepA));
      expect(r.status, cursor).toBe(409);
      expect(r.body).toEqual(RECUSA);
    }
  });

  it('vencido (mais de 10 minutos): 409', async () => {
    // Mesmo segredo do processo e mesmo escopo, com o relógio 10 min + 1 s atrás: assinatura válida, validade vencida.
    const velho = new CursorDePaginacao(loadPaginationCursorKey(process.env), 'pacientes', () => Date.now() - VALIDADE_DO_CURSOR_MS - 1000);
    const ctx = { tenantId: clinicaA, userId: recepA.userId, roles: ['recepcao'] } as never;
    const cursor = velho.assinar(ctx, { situacao: 'todos', limite: 2 }, { pagina: 2, depoisDe: idsA[0]! });
    const r = await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor }).set(cab(recepA));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(RECUSA);
    // O mesmo cursor ainda dentro da validade passa (controle: só a validade mudou).
    const novo = new CursorDePaginacao(loadPaginationCursorKey(process.env), 'pacientes');
    const ok = novo.assinar(ctx, { situacao: 'todos', limite: 2 }, { pagina: 2, depoisDe: idsA[0]! });
    await api.http().get('/pacientes').query({ limite: '2', situacao: 'todos', cursor: ok }).set(cab(recepA)).expect(200);
  });

  it('página 2 em diante sem cursor: 400 `pagina`', async () => {
    const r = await api.http().get('/pacientes').query({ pagina: '2' }).set(cab(recepA));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ statusCode: 400, message: 'Dados inválidos', campos: ['pagina'] });
    await api.http().post('/pacientes/busca').set(cab(recepA)).send({ busca: 'cursor', pagina: 2 }).expect(400);
  });
});

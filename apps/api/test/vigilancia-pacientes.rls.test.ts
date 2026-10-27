/**
 * Limite por usuário e alerta de anomalia na leitura de pacientes (R5 do parecer PR #57) contra
 * Postgres REAL, com limiares baixos para o teste. Pré-requisitos: migrações aplicadas (inclusive a
 * 0010) e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import { AuditAction, type TenantId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const LIMITE = 5;
const PAGINAS = 3;
const FICHAS = 3;

let api: ApiDeTeste;
let clinica: TenantId;
let outraClinica: TenantId;
let adminA: { Authorization: string; userId: string };
const pacientes: string[] = [];

async function alertas(tenantId: TenantId, userId: string) {
  return withTenant(api.db.db, tenantId, (tx) =>
    tx
      .select({ actorId: auditLog.actorId, actorKind: auditLog.actorKind, scope: auditLog.scope, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.AnomalyAlert), eq(auditLog.actorId, userId))),
  );
}

beforeAll(async () => {
  api = await subirApi({
    vigilancia: { listaMax: LIMITE, listaJanelaMs: 60_000, anomaliaJanelaMs: 600_000, anomaliaPaginas: PAGINAS, anomaliaFichas: FICHAS },
  });
  clinica = await api.novaClinica();
  outraClinica = await api.novaClinica();
  adminA = api.sessao(clinica, 'admin');
  for (let i = 0; i < FICHAS + 2; i++) {
    const res = await api.http().post('/pacientes').set(cab(adminA)).send({ nome: `Paciente Ficticio ${i}`, telefone: '11900000010' });
    expect(res.status).toBe(201);
    pacientes.push((res.body as { id: string }).id);
  }
});

afterAll(async () => {
  await api?.fechar();
});

describe('R5 — limite por usuário na lista/busca de pacientes', () => {
  it('acima do limite dá 429 com Retry-After, sem afetar outro usuário do mesmo IP', async () => {
    const recep = api.sessao(clinica, 'recepcao');
    for (let i = 0; i < LIMITE; i++) {
      const rota = i % 2 === 0 ? api.http().get('/pacientes').set(cab(recep)) : api.http().post('/pacientes/busca').set(cab(recep)).send({ busca: 'ficticio' });
      expect((await rota).status).toBe(200);
    }
    const bloqueado = await api.http().post('/pacientes/busca').set(cab(recep)).send({ busca: 'ficticio' });
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body).toMatchObject({ statusCode: 429, codigo: 'limite_por_usuario' });
    expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.stringify(bloqueado.body)).not.toContain('ficticio');
    // Outro usuário (mesmo IP do supertest) continua lendo: o limite é por usuário.
    const outro = api.sessao(clinica, 'recepcao');
    expect((await api.http().get('/pacientes').set(cab(outro))).status).toBe(200);
  });

  it('o mesmo usuário em outra clínica não compartilha o contador (chave por clínica + usuário)', async () => {
    const userIdQualquer = api.sessao(outraClinica, 'recepcao');
    for (let i = 0; i < LIMITE; i++) expect((await api.http().get('/pacientes').set(cab(userIdQualquer))).status).toBe(200);
    expect((await api.http().get('/pacientes').set(cab(userIdQualquer))).status).toBe(429);
  });
});

describe('R5 — alerta de anomalia auditado e sem dado pessoal', () => {
  it('páginas demais: um alerta por janela, na trilha da clínica, com o usuário como ator', async () => {
    const fin = api.sessao(clinica, 'financeiro');
    for (let i = 0; i < PAGINAS + 2; i++) await api.http().get('/pacientes').set(cab(fin));
    const linhas = await alertas(clinica, fin.userId);
    const paginas = linhas.filter((l) => l.metadata.rule === 'paginas_de_pacientes');
    expect(paginas).toHaveLength(1);
    expect(paginas[0]).toMatchObject({
      actorKind: 'usuario_clinica',
      scope: 'patients',
      metadata: { rule: 'paginas_de_pacientes', window_s: 600, threshold: PAGINAS, count: PAGINAS + 1 },
    });
    // Nada da outra clínica.
    expect(await alertas(outraClinica, fin.userId)).toEqual([]);
  });

  it('limite estourado também gera alerta (uma vez por janela)', async () => {
    const recep = api.sessao(clinica, 'recepcao');
    for (let i = 0; i < LIMITE + 3; i++) await api.http().post('/pacientes/busca').set(cab(recep)).send({ busca: 'ficticio' });
    const regras = (await alertas(clinica, recep.userId)).map((l) => l.metadata.rule);
    expect(regras.filter((r) => r === 'limite_por_usuario')).toHaveLength(1);
  });

  it('fichas DISTINTAS demais: abrir a mesma ficha várias vezes não conta; a metadata não leva paciente', async () => {
    const prof = api.sessao(clinica, 'profissional');
    // A mesma ficha 5 vezes: uma ficha distinta só.
    for (let i = 0; i < 5; i++) expect((await api.http().get(`/pacientes/${pacientes[0]}`).set(cab(prof))).status).toBe(200);
    expect(await alertas(clinica, prof.userId)).toEqual([]);
    for (const id of pacientes.slice(1)) await api.http().get(`/pacientes/${id}`).set(cab(prof));
    const linhas = await alertas(clinica, prof.userId);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.metadata).toEqual({ rule: 'fichas_distintas', window_s: 600, threshold: FICHAS, count: FICHAS + 1 });
    const texto = JSON.stringify(linhas);
    for (const id of pacientes) expect(texto).not.toContain(id);
    expect(texto).not.toMatch(/ficticio/i);
  });
});

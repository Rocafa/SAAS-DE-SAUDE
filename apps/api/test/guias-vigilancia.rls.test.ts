/**
 * Guias e pacotes sob a vigilância de leitura (R5 do parecer PR #57): listas de guias, alertas,
 * pacotes e relatório contam no MESMO limite por usuário das listas de pacientes; o detalhe da guia
 * (senha e carteirinha) conta como ficha distinta e dispara `anomaly_alert`. Postgres real,
 * limites baixos só neste teste. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, insuranceGuides } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const LIMITE = 4;
const FICHAS = 2;

let api: ApiDeTeste;
let clinica: TenantId;
let guias: string[] = [];
let convenio: string;

beforeAll(async () => {
  api = await subirApi({
    vigilancia: { listaMax: LIMITE, listaJanelaMs: 60_000, anomaliaJanelaMs: 600_000, anomaliaPaginas: 100, anomaliaFichas: FICHAS },
  });
  clinica = await api.novaClinica();
  const admin = api.sessao(clinica, 'admin');
  const recep = api.sessao(clinica, 'recepcao');
  convenio = ((await api.http().post('/convenios').set(cab(admin)).send({ nome: 'Operadora Ficticia V' })).body as { id: string }).id;
  const paciente = ((await api.http().post('/pacientes').set(cab(recep)).send({ nome: 'Paciente Ficticio V', telefone: '11900000301' })).body as { id: string }).id;
  guias = [];
  for (let i = 0; i < FICHAS + 1; i++) {
    const r = await api
      .http()
      .post('/guias')
      .set(cab(recep))
      .send({ pacienteId: paciente, convenioId: convenio, numero: `FIC-V-${i}`, sessoesAutorizadas: 2, validade: '2099-01-01' });
    expect(r.status).toBe(201);
    guias.push((r.body as { id: string }).id);
  }
});

afterAll(async () => {
  await api?.fechar();
});

describe('vigilância de leitura nas rotas de guias e pacotes', () => {
  it('listas de guias, alertas, pacotes e relatório somam no limite por usuário das listas de pacientes', async () => {
    const fin = api.sessao(clinica, 'financeiro');
    const chamadas = [
      () => api.http().get('/guias').set(cab(fin)),
      () => api.http().get('/guias/alertas').set(cab(fin)),
      () => api.http().get('/pacotes').set(cab(fin)),
      () => api.http().get(`/convenios/${convenio}/relatorio`).query({ de: '2030-01-01', ate: '2030-01-31' }).set(cab(fin)),
    ];
    for (const c of chamadas) expect((await c()).status).toBe(200);
    // Mesmo contador: a próxima lista de PACIENTES já passa do limite.
    const bloqueada = await api.http().get('/pacientes').set(cab(fin));
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body).toMatchObject({ codigo: 'limite_por_usuario' });
    expect((await api.http().get('/guias').set(cab(fin))).status).toBe(429);
    // Outro usuário segue livre.
    expect((await api.http().get('/guias').set(cab(api.sessao(clinica, 'recepcao')))).status).toBe(200);
    const alertas = await withTenant(api.db.db, clinica, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'anomaly_alert'), eq(auditLog.actorId, fin.userId), sql`${auditLog.metadata}->>'rule' = 'limite_por_usuario'`)),
    );
    expect(alertas).toHaveLength(1);
  });

  it('abrir o detalhe de muitas guias distintas dispara o alerta de fichas distintas (sem id na trilha)', async () => {
    const recep = api.sessao(clinica, 'recepcao');
    for (const g of guias) expect((await api.http().get(`/guias/${g}`).set(cab(recep))).status).toBe(200);
    const alertas = await withTenant(api.db.db, clinica, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.action, 'anomaly_alert'), eq(auditLog.actorId, recep.userId))).orderBy(sql`seq`),
    );
    expect(alertas.map((a) => a.metadata.rule)).toEqual(['fichas_distintas']);
    const serial = JSON.stringify(alertas);
    for (const g of guias) expect(serial).not.toContain(g);
    // Sanidade: as guias existem na clínica (insurance_guides sob RLS).
    const n = await withTenant(api.db.db, clinica, (tx) => tx.select().from(insuranceGuides));
    expect(n).toHaveLength(guias.length);
  });
});

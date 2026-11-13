/**
 * R8 do parecer do #63 e R2 do parecer de 13/11/2026 (#192): ler o registro clínico conta como ficha aberta na
 * vigilância de leitura, nas TRÊS rotas de leitura do atendimento (por id, versões e pelo agendamento). Limiar de
 * fichas distintas = 1: cada profissional lê os atendimentos de DOIS pacientes por UMA rota, e o alerta tem de
 * disparar uma vez. Se a rota não contar, o alerta daquele profissional não sai. Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import { AuditAction, type TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const FICHAS = 1;

type Sessao = { Authorization: string; userId: string };
interface Cenario {
  readonly prof: Sessao;
  readonly agendamentos: string[];
  readonly atendimentos: string[];
}

let api: ApiDeTeste;
let clinica: TenantId;
let admin: Sessao;
let tipo: string;

async function alertas(userId: string) {
  return withTenant(api.db.db, clinica, (tx) =>
    tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.AnomalyAlert), eq(auditLog.actorId, userId)))
      .orderBy(sql`seq`),
  );
}

/** Um profissional de fisioterapia com atendimento aberto para dois pacientes distintos. */
async function cenario(): Promise<Cenario> {
  const prof = api.sessao(clinica, 'profissional');
  const p = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticio Vigilancia', especialidade: 'Fisioterapia', usuarioId: prof.userId });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const profissionalId = (p.body as { id: string }).id;
  const agendamentos: string[] = [];
  const atendimentos: string[] = [];
  for (let i = 0; i < FICHAS + 1; i++) {
    const pac = await api.http().post('/pacientes').set(cab(admin)).send({ nome: `Paciente Ficticio Vigilancia ${i}`, telefone: '11900000077' });
    const ag = randomUUID();
    const recepcao = randomUUID();
    await withTenant(
      api.db.db,
      clinica,
      (tx) =>
        tx.insert(appointments).values({
          createdBy: recepcao,
          id: ag,
          tenantId: clinica,
          patientId: (pac.body as { id: string }).id,
          professionalId: profissionalId,
          appointmentTypeId: tipo,
          startsAt: new Date(Date.now() - 10 * 60_000),
          endsAt: new Date(Date.now() + 40 * 60_000),
          status: 'checked_in',
          checkedInAt: new Date(),
        }),
      recepcao,
    );
    const at = await api.http().post('/atendimentos').set(cab(prof)).send({ agendamentoId: ag });
    expect(at.status, JSON.stringify(at.body)).toBe(200);
    agendamentos.push(ag);
    atendimentos.push((at.body as { id: string }).id);
  }
  return { prof, agendamentos, atendimentos };
}

beforeAll(async () => {
  api = await subirApi({
    vigilancia: { listaMax: 1000, listaJanelaMs: 60_000, anomaliaJanelaMs: 600_000, anomaliaPaginas: 1000, anomaliaFichas: FICHAS },
  });
  clinica = await api.novaClinica();
  admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  const t = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao', minutos: 50 });
  tipo = (t.body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('vigilância de leitura nas rotas do atendimento (R8 do #63)', () => {
  const casos: [string, (c: Cenario, i: number) => string][] = [
    ['GET /atendimentos/:id', (c, i) => `/atendimentos/${c.atendimentos[i] ?? ''}`],
    ['GET /atendimentos/:id/versoes', (c, i) => `/atendimentos/${c.atendimentos[i] ?? ''}/versoes`],
    ['GET /atendimentos/do-agendamento/:agendamentoId', (c, i) => `/atendimentos/do-agendamento/${c.agendamentos[i] ?? ''}`],
  ];
  for (const [rota, url] of casos) {
    it(`${rota}: ler ${FICHAS + 1} fichas distintas dispara um alerta fichas_distintas, só com regra e números`, async () => {
      const c = await cenario();
      // A mesma ficha duas vezes não conta como duas.
      for (let k = 0; k < 2; k++) expect((await api.http().get(url(c, 0)).set(cab(c.prof))).status).toBe(200);
      expect(await alertas(c.prof.userId)).toEqual([]);
      expect((await api.http().get(url(c, 1)).set(cab(c.prof))).status).toBe(200);
      const linhas = await alertas(c.prof.userId);
      expect(linhas.map((l) => l.metadata)).toEqual([{ rule: 'fichas_distintas', window_s: 600, threshold: FICHAS, count: FICHAS + 1 }]);
      expect(JSON.stringify(linhas)).not.toMatch(/ficticio/i);
    });
  }
});

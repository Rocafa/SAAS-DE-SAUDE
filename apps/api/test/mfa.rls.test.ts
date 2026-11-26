/**
 * Política de MFA na API real (issue #106, S3; parecer de 03/11): obrigatório para todo perfil e recente nas rotas
 * sensíveis, com a recusa nessas rotas na trilha. A sessão é fictícia (DevSessionProvider) e aqui passa `mfaEm`
 * explícito (R7); o provedor real (D4) só vai informar `mfaEm`. Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { SCOPE_MFA_RECUSADO, TETO_RECUSAS_MFA } from '../src/modules/auth/sessao.guard';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let pacienteId: string;

function sessao(perfis: string[], mfaEm: Date | null, userId: string = randomUUID()) {
  return { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId, perfis, mfaEm })}`, userId };
}

async function recusasDe(userId: string) {
  return withTenant(api.db.db, clinica, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.actorId, userId), eq(auditLog.scope, SCOPE_MFA_RECUSADO))),
  );
}

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const r = await api.http().post('/pacientes').set(cab(sessao(['recepcao'], new Date()))).send({ nome: 'Paciente Ficticia MFA', telefone: '11900000031' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  pacienteId = (r.body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('issue #106: MFA obrigatório e recente nas rotas sensíveis', () => {
  it('B1: todo perfil sem MFA recebe 403 mfa_obrigatorio, inclusive a recepção; MFA de horas atrás basta na rota comum', async () => {
    for (const perfil of ['admin', 'profissional', 'recepcao', 'financeiro']) {
      const r = await api.http().get('/pacientes').set(cab(sessao([perfil], null)));
      expect(r.status, perfil).toBe(403);
      expect(r.body, perfil).toMatchObject({ codigo: 'mfa_obrigatorio' });
    }
    expect((await api.http().get('/pacientes').set(cab(sessao(['recepcao'], new Date(Date.now() - 8 * 3_600_000))))).status).toBe(200);
  });

  it('notas privadas e custódia exigem MFA dos últimos 15 minutos', async () => {
    const userId = randomUUID();
    const antigo = sessao(['profissional'], new Date(Date.now() - MFA_RECENTE_MS - 60_000), userId);
    for (const url of [`/pacientes/${pacienteId}/notas-privadas`, `/notas-privadas/${randomUUID()}`, `/custodias/${randomUUID()}/notas`]) {
      const r = await api.http().get(url).set(cab(antigo));
      expect(r.status, url).toBe(403);
      expect(r.body, url).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
    }
    // Com MFA recente o guard deixa passar (o que vem depois é regra do serviço, não do MFA).
    const recente = await api.http().get(`/pacientes/${pacienteId}/notas-privadas`).set(cab(sessao(['profissional'], new Date(), userId)));
    expect((recente.body as { codigo?: string }).codigo ?? '').not.toMatch(/^mfa_/);
  });

  it('B2: a recusa por MFA numa rota sensível vai para a trilha, só com ids; na rota comum, agregada (1 linha por janela, R5 do #123)', async () => {
    const userId = randomUUID();
    const notaQualquer = randomUUID();
    const antigo = sessao(['profissional'], new Date(Date.now() - MFA_RECENTE_MS - 60_000), userId);
    await api.http().get(`/notas-privadas/${notaQualquer}`).set(cab(antigo)).expect(403);
    const linhas = await recusasDe(userId);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ action: 'read', actorKind: 'usuario_clinica' });
    expect(linhas[0]?.metadata).toEqual({ op: 'NotasPrivadasController.obter', reason: 'mfa_recente_obrigatorio', target_id: notaQualquer });
    // Rota comum sem MFA: 1 linha por janela de 60 s, com o handler da primeira recusa, mesmo em rotas diferentes.
    const semMfa = randomUUID();
    const s = cab(sessao(['recepcao'], null, semMfa));
    await api.http().get('/pacientes').set(s).expect(403);
    await api.http().get('/pacientes').set(s).expect(403);
    await api.http().get(`/pacientes/${pacienteId}`).set(s).expect(403);
    const comuns = await recusasDe(semMfa);
    expect(comuns).toHaveLength(1);
    expect(comuns[0]?.metadata).toEqual({ op: 'PatientsController.listar', reason: 'mfa_obrigatorio' });
  });

  it('R9: recusas repetidas não inundam a trilha; acima do teto, 429 e um único alerta', async () => {
    const userId = randomUUID();
    const antigo = sessao(['profissional'], new Date(Date.now() - MFA_RECENTE_MS - 60_000), userId);
    const codigos: number[] = [];
    for (let i = 0; i < TETO_RECUSAS_MFA + 3; i++) codigos.push((await api.http().get(`/notas-privadas/${randomUUID()}`).set(cab(antigo))).status);
    expect(codigos.slice(0, TETO_RECUSAS_MFA)).toEqual(Array<number>(TETO_RECUSAS_MFA).fill(403));
    expect(codigos.slice(TETO_RECUSAS_MFA)).toEqual([429, 429, 429]);
    const linhas = await recusasDe(userId);
    // 1 linha por ALVO distinto na janela (nota (a) da R9) até o teto; depois do teto, nenhuma linha a mais, só 1 alerta.
    expect(linhas.filter((l) => l.action === 'read')).toHaveLength(TETO_RECUSAS_MFA);
    const alertas = linhas.filter((l) => l.action === 'anomaly_alert');
    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.metadata).toEqual({
      rule: 'mfa_recusas_por_usuario',
      window_s: 60,
      threshold: TETO_RECUSAS_MFA,
      count: TETO_RECUSAS_MFA + 1,
      distinct_targets: TETO_RECUSAS_MFA,
    });
  });

  it('R9 (nota a): a MESMA tentativa repetida na janela grava 1 linha só', async () => {
    const userId = randomUUID();
    const antigo = sessao(['profissional'], new Date(Date.now() - MFA_RECENTE_MS - 60_000), userId);
    const alvo = randomUUID();
    for (let i = 0; i < 3; i++) await api.http().get(`/notas-privadas/${alvo}`).set(cab(antigo)).expect(403);
    const linhas = await recusasDe(userId);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.metadata).toMatchObject({ target_id: alvo });
  });

  it('o alvo sai de QUALQUER parâmetro de rota, não só de um chamado `id`', async () => {
    const userId = randomUUID();
    const antigo = sessao(['admin'], new Date(Date.now() - MFA_RECENTE_MS - 60_000), userId);
    // `DELETE /clinica/membros/:usuarioId/:perfil` é rota de poder e NÃO tem parâmetro chamado `id`:
    // sem tirar o alvo de todos os params, 20 usuários diferentes colapsam numa linha por janela.
    const alvos = [randomUUID(), randomUUID(), randomUUID()];
    for (const alvo of alvos) await api.http().delete(`/clinica/membros/${alvo}/profissional`).set(cab(antigo)).expect(403);
    const linhas = (await recusasDe(userId)).filter((l) => l.action === 'read');
    const vistos = linhas.map((l) => (l.metadata as { target_id?: string }).target_id);
    expect(new Set(vistos).size, `uma linha por alvo distinto: ${JSON.stringify(vistos)}`).toBe(alvos.length);
    for (const alvo of alvos) expect(vistos.some((v) => v?.includes(alvo))).toBe(true);
  });

  it('R8: GET /sessao devolve só até quando o MFA conta como recente', async () => {
    const quando = new Date(Date.now() - 60_000);
    const r = await api.http().get('/sessao').set(cab(sessao(['recepcao'], quando)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mfaRecenteAte: new Date(quando.getTime() + MFA_RECENTE_MS).toISOString() });
    expect(r.body).not.toHaveProperty('mfaEm');
  });
});

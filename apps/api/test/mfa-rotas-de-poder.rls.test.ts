/**
 * E8 da revisão interna de 04/11 (lado da equipe): as 9 rotas de poder exigem MFA recente (6 do E8 e 3 do parecer do #131). Sessão roubada com MFA
 * antigo não amplia o vínculo de cuidado, não desvia o WhatsApp, não amarra usuário a profissional, não desmarca
 * área sensível e não mexe no emitente nem no perfil fiscal. Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { SCOPE_MFA_RECUSADO } from '../src/modules/auth/sessao.guard';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let adminId: string;

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  adminId = (await api.membro(clinica, api.sessao(clinica, 'admin', 'financeiro', 'profissional'), 'admin', 'financeiro', 'profissional')).userId;
});

afterAll(async () => {
  await api?.fechar();
});

const sessao = (mfaEm: Date) => ({ Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId: adminId, perfis: ['admin', 'financeiro', 'profissional'], mfaEm })}` });

const ROTAS: readonly (readonly ['put' | 'post', string, unknown])[] = [
  ['put', '/clinica/vinculo-de-cuidado', { dias: 30 }],
  ['put', '/whatsapp/configuracao', {}],
  ['post', '/profissionais', { nome: 'Prof Ficticio E8', especialidade: 'Fisioterapia' }],
  ['post', `/profissionais/${randomUUID()}/area-sensivel`, { sensivel: false }],
  ['put', '/financeiro/configuracao', { atendimentoPadrao: 'pf', emitenteNome: 'Clinica Ficticia E8' }],
  ['put', `/financeiro/profissionais/${randomUUID()}/perfil-fiscal`, {}],
  // Parecer do #131 (R3): mais três rotas de poder.
  ['post', `/pacientes/${randomUUID()}/responsaveis/sigilo/${randomUUID()}/revogar`, {}],
  ['post', '/financeiro/retencao-fiscal/execucao', {}],
  ['post', '/clinica/portal/convites', {}],
];

describe('E8: rotas de poder exigem MFA recente', () => {
  it('com MFA antigo, as 9 rotas recusam com 403 mfa_recente_obrigatorio antes de qualquer validação', async () => {
    const velho = sessao(new Date(Date.now() - MFA_RECENTE_MS - 60_000));
    for (const [metodo, url, corpo] of ROTAS) {
      const r = await (metodo === 'put' ? api.http().put(url) : api.http().post(url)).set(cab(velho)).send(corpo as object);
      expect(r.status, `${metodo} ${url}`).toBe(403);
      expect(r.body, `${metodo} ${url}`).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
    }
    // R2 do parecer do #131: cada recusa foi para a trilha (escopo mfa_denied), só com ids e motivo.
    const linhas = await withTenant(api.db.db, clinica, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.actorId, adminId), eq(auditLog.scope, SCOPE_MFA_RECUSADO))),
    );
    expect(linhas.filter((l) => (l.metadata as { reason?: string }).reason === 'mfa_recente_obrigatorio').length).toBeGreaterThanOrEqual(ROTAS.length);
  });

  it('com MFA recente, nenhuma delas recusa por MFA (a resposta é a da regra de negócio)', async () => {
    const novo = sessao(new Date());
    for (const [metodo, url, corpo] of ROTAS) {
      const r = await (metodo === 'put' ? api.http().put(url) : api.http().post(url)).set(cab(novo)).send(corpo as object);
      expect((r.body as { codigo?: string }).codigo ?? '', `${metodo} ${url}`).not.toMatch(/^mfa_/);
    }
  });
});

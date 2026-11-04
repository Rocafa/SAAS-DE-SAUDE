/**
 * E8 da revisão interna de 04/11 (lado da equipe): as 6 rotas de poder exigem MFA recente. Sessão roubada com MFA
 * antigo não amplia o vínculo de cuidado, não desvia o WhatsApp, não amarra usuário a profissional, não desmarca
 * área sensível e não mexe no emitente nem no perfil fiscal. Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinica: TenantId;
let adminId: string;

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  adminId = (await api.membro(clinica, api.sessao(clinica, 'admin', 'financeiro'), 'admin', 'financeiro')).userId;
});

afterAll(async () => {
  await api?.fechar();
});

const sessao = (mfaEm: Date) => ({ Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId: adminId, perfis: ['admin', 'financeiro'], mfaEm })}` });

const ROTAS: readonly (readonly ['put' | 'post', string, unknown])[] = [
  ['put', '/clinica/vinculo-de-cuidado', { dias: 30 }],
  ['put', '/whatsapp/configuracao', {}],
  ['post', '/profissionais', { nome: 'Prof Ficticio E8', especialidade: 'Fisioterapia' }],
  ['post', `/profissionais/${randomUUID()}/area-sensivel`, { sensivel: false }],
  ['put', '/financeiro/configuracao', { atendimentoPadrao: 'pf', emitenteNome: 'Clinica Ficticia E8' }],
  ['put', `/financeiro/profissionais/${randomUUID()}/perfil-fiscal`, {}],
];

describe('E8: rotas de poder exigem MFA recente', () => {
  it('com MFA antigo, as 6 rotas recusam com 403 mfa_recente_obrigatorio antes de qualquer validação', async () => {
    const velho = sessao(new Date(Date.now() - MFA_RECENTE_MS - 60_000));
    for (const [metodo, url, corpo] of ROTAS) {
      const r = await (metodo === 'put' ? api.http().put(url) : api.http().post(url)).set(cab(velho)).send(corpo as object);
      expect(r.status, `${metodo} ${url}`).toBe(403);
      expect(r.body, `${metodo} ${url}`).toMatchObject({ codigo: 'mfa_recente_obrigatorio' });
    }
  });

  it('com MFA recente, nenhuma delas recusa por MFA (a resposta é a da regra de negócio)', async () => {
    const novo = sessao(new Date());
    for (const [metodo, url, corpo] of ROTAS) {
      const r = await (metodo === 'put' ? api.http().put(url) : api.http().post(url)).set(cab(novo)).send(corpo as object);
      expect((r.body as { codigo?: string }).codigo ?? '', `${metodo} ${url}`).not.toMatch(/^mfa_/);
    }
  });
});

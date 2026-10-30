/**
 * Autorização de acesso do suporte pela clínica (migração 0059, S9 do checklist da rodada 7), com Postgres real:
 * só o dono da clínica autoriza e revoga, o prazo é limitado a 72 h, o banco confere quem e quando, e a trilha
 * recusa linha de suporte `pedido_da_clinica` sem autorização vigente para o chamado nesta clínica.
 */
import type { TenantId } from '@plataforma/shared';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supportAccessGrants } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { LocalPseudonymSigner, recordSupportAudit } from '../src/modules/audit/ator-suporte';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
type Autorizacao = { id: string; chamado: string; autorizadoPor: string; autorizadoEm: string; expiraEm: string; revogadoEm: string | null; vigente: boolean };

const CHAVE = Buffer.alloc(32, 7);
const ROTA = '/suporte/autorizacoes';

let api: ApiDeTeste;
let clinica: TenantId;
let outra: TenantId;
let dono: Sessao;
let dono2: Sessao;
let recepcao: Sessao;
let donoOutra: Sessao;

function post(s: Sessao, rota: string, corpo: object = {}) {
  return api.http().post(rota).set(cab(s)).send(corpo);
}

async function sqlstate(p: Promise<unknown>): Promise<unknown[]> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado erro do banco').toBeDefined();
  const codigos: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) codigos.push((e as { code?: unknown }).code);
  return codigos;
}

/**
 * Faz a autorização vencer, recuando as duas datas (o runtime não consegue: gatilho e CHECK). Superusuário do
 * container efêmero, só no teste.
 */
async function envelhecer(id: string, horas: number): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL é obrigatória para o teste da autorização vencida');
  const adm = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await adm.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await t`update support_access_grants set granted_at = granted_at - make_interval(hours => ${horas}), expires_at = expires_at - make_interval(hours => ${horas}) where id = ${id}::uuid`;
    });
  } finally {
    await adm.end();
  }
}

/** Grava uma linha de suporte na trilha da clínica, como faria o fluxo do operador. */
function acessoDeSuporte(tenantId: TenantId, chamado: string, motivo: 'pedido_da_clinica' | 'break_glass') {
  return withTenant(api.db.db, tenantId, (tx) =>
    recordSupportAudit(tx, new LocalPseudonymSigner(CHAVE, 'test'), { tenantId, atendenteId: 'atendente-ficticio-01', chamado, motivo }, {
      action: 'read',
      scope: 'patients',
      metadata: { count: 1 },
    }),
  );
}

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  outra = await api.novaClinica();
  dono = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  dono2 = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  recepcao = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
  donoOutra = await api.membro(outra, api.sessao(outra, 'admin'), 'admin');
});

afterAll(async () => {
  await api?.fechar();
});

describe('0059: autorização de acesso do suporte', () => {
  it('só o dono autoriza; prazo de 1 a 72 h (padrão 24); chamado no formato SUP-n', async () => {
    expect((await post(recepcao, ROTA, { chamado: 'SUP-100' })).status).toBe(403);
    // Admin só na sessão, sem perfil no banco: recusado.
    expect((await post(api.sessao(clinica, 'admin'), ROTA, { chamado: 'SUP-100' })).status).toBe(403);
    for (const corpo of [{ chamado: '100' }, { chamado: 'SUP-12345678' }, { chamado: 'SUP-1', horas: 0 }, { chamado: 'SUP-1', horas: 73 }, { chamado: 'SUP-1', extra: 1 }]) {
      expect((await post(dono, ROTA, corpo)).status, JSON.stringify(corpo)).toBe(400);
    }
    const r = await post(dono, ROTA, { chamado: 'SUP-100' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = r.body as Autorizacao;
    expect(a).toMatchObject({ chamado: 'SUP-100', autorizadoPor: dono.userId, revogadoEm: null, vigente: true });
    const horas = (Date.parse(a.expiraEm) - Date.parse(a.autorizadoEm)) / 3_600_000;
    expect(horas).toBeCloseTo(24, 5);
    // Mesmo chamado já vigente: 409.
    expect((await post(dono2, ROTA, { chamado: 'SUP-100' })).body).toMatchObject({ codigo: 'autorizacao_ja_vigente' });
    // Recepção não lista.
    expect((await api.http().get(ROTA).set(cab(recepcao))).status).toBe(403);
    const lista = (await api.http().get(ROTA).set(cab(dono2))).body as Autorizacao[];
    expect(lista.map((l) => l.id)).toContain(a.id);
    // Outra clínica não vê.
    expect(((await api.http().get(ROTA).set(cab(donoOutra))).body as Autorizacao[]).map((l) => l.id)).not.toContain(a.id);
  });

  it('a trilha recusa suporte "pedido_da_clinica" sem autorização vigente; break-glass passa e fica na trilha', async () => {
    // Sem autorização: recusado pelo banco.
    expect(await sqlstate(acessoDeSuporte(clinica, 'SUP-200', 'pedido_da_clinica'))).toContain('42501');
    const r = await post(dono, ROTA, { chamado: 'SUP-200', horas: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = r.body as Autorizacao;
    // Com autorização vigente: aceito.
    await acessoDeSuporte(clinica, 'SUP-200', 'pedido_da_clinica');
    // A autorização de uma clínica não vale na outra.
    expect(await sqlstate(acessoDeSuporte(outra, 'SUP-200', 'pedido_da_clinica'))).toContain('42501');
    // Revogada (por outro dono): volta a ser recusado; revogar de novo é 409; outra clínica não revoga (404).
    expect((await post(donoOutra, `${ROTA}/${a.id}/revogar`)).status).toBe(404);
    expect((await post(recepcao, `${ROTA}/${a.id}/revogar`)).status).toBe(403);
    const rev = await post(dono2, `${ROTA}/${a.id}/revogar`);
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body).toMatchObject({ vigente: false, revogadoPor: dono2.userId });
    expect((await post(dono, `${ROTA}/${a.id}/revogar`)).body).toMatchObject({ codigo: 'autorizacao_nao_vigente' });
    expect(await sqlstate(acessoDeSuporte(clinica, 'SUP-200', 'pedido_da_clinica'))).toContain('42501');
    // R1 do parecer: break-glass desligado no banco até a aprovação dupla do operador (D4), com ou sem autorização.
    expect(await sqlstate(acessoDeSuporte(clinica, 'SUP-201', 'break_glass'))).toContain('42501');
    await post(dono, ROTA, { chamado: 'SUP-202', horas: 1 }).expect(201);
    expect(await sqlstate(acessoDeSuporte(clinica, 'SUP-202', 'break_glass'))).toContain('42501');
  });

  it('autorização vencida não vale e não se revoga (R6 do parecer)', async () => {
    const r = await post(dono, ROTA, { chamado: 'SUP-400', horas: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = r.body as Autorizacao;
    await acessoDeSuporte(clinica, 'SUP-400', 'pedido_da_clinica');
    await envelhecer(a.id, 2);
    expect(await sqlstate(acessoDeSuporte(clinica, 'SUP-400', 'pedido_da_clinica'))).toContain('42501');
    expect((await post(dono, `${ROTA}/${a.id}/revogar`)).body).toMatchObject({ codigo: 'autorizacao_nao_vigente' });
    const lista = (await api.http().get(ROTA).set(cab(dono))).body as Autorizacao[];
    expect(lista.find((l) => l.id === a.id)?.vigente).toBe(false);
    // Vencida, o mesmo chamado pode ser autorizado de novo.
    expect((await post(dono, ROTA, { chamado: 'SUP-400', horas: 1 })).status).toBe(201);
  });

  it('o banco confere autor, perfil, prazo máximo e imutabilidade; não apaga', async () => {
    const r = await post(dono, ROTA, { chamado: 'SUP-300', horas: 72 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = r.body as Autorizacao;
    const comoDono = (fn: (tx: TenantTx) => Promise<unknown>) => withTenant(api.db.db, clinica, fn, dono.userId);
    // Prazo acima de 72 h: CHECK.
    expect(
      await sqlstate(
        comoDono((tx) => tx.insert(supportAccessGrants).values({ tenantId: clinica, ticket: 'SUP-301', grantedBy: dono.userId, grantedAt: new Date(), expiresAt: new Date(Date.now() + 73 * 3_600_000) })),
      ),
    ).toContain('23514');
    // Autor diferente da sessão; e recepção no banco.
    expect(
      await sqlstate(
        comoDono((tx) => tx.insert(supportAccessGrants).values({ tenantId: clinica, ticket: 'SUP-302', grantedBy: dono2.userId, expiresAt: new Date(Date.now() + 3_600_000) })),
      ),
    ).toContain('42501');
    expect(
      await sqlstate(
        withTenant(api.db.db, clinica, (tx) => tx.insert(supportAccessGrants).values({ tenantId: clinica, ticket: 'SUP-303', grantedBy: recepcao.userId, expiresAt: new Date(Date.now() + 3_600_000) }), recepcao.userId),
      ),
    ).toContain('42501');
    // Estender o prazo ou trocar o chamado: recusado. Apagar: recusado.
    expect(await sqlstate(comoDono((tx) => tx.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() + 80 * 3_600_000) }).where(eq(supportAccessGrants.id, a.id))))).toContain('42501');
    expect(await sqlstate(comoDono((tx) => tx.update(supportAccessGrants).set({ ticket: 'SUP-999' }).where(eq(supportAccessGrants.id, a.id))))).toContain('42501');
    expect(await sqlstate(comoDono((tx) => tx.delete(supportAccessGrants).where(eq(supportAccessGrants.id, a.id))))).not.toEqual([]);
  });
});

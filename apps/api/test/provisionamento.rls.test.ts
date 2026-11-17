/**
 * Provisionamento da clínica e emissão da ativação do fundador (B11, PR 1; R1, R3, R8 e R9 do parecer do Guardião de
 * 16/11/2026), contra o banco: `app_auth` para o schema identidade e `app_user` (RLS) para a clínica. Dados fictícios.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ativacaoDoFundador, usuario } from '../src/db/identidade';
import { auditLog, clinicMembers, tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { hmacDoEmail } from '../src/modules/auth/convites';
import {
  clinicaDoPedido,
  provisionarClinica,
  ProvisionamentoRecusado,
  type BancosDoProvisionamento,
  type PedidoDeProvisionamento,
} from '../src/modules/auth/better-auth/provisionamento';
import { BetterAuthProvider } from '../src/modules/auth/better-auth/provedor';
import { subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let dbAuth: DatabaseHandle;
let bancos: BancosDoProvisionamento;
const CHAVE = randomBytes(32);

beforeAll(async () => {
  api = await subirApi();
  const urlAuth = process.env.DATABASE_AUTH_URL;
  if (!urlAuth) throw new Error('DATABASE_AUTH_URL (papel app_auth) é obrigatória neste teste');
  dbAuth = createDatabase(urlAuth, { max: 2 });
  bancos = { dbAuth: dbAuth.db, dbClinica: api.db.db };
});

afterAll(async () => {
  await dbAuth?.close();
  await api?.fechar();
});

let seq = 0;
function pedidoFicticio(over: Partial<PedidoDeProvisionamento> = {}): PedidoDeProvisionamento {
  seq += 1;
  return { pedido: randomUUID(), contrato: `CTR-${seq}`, email: `fundador.ficticio.${randomUUID().slice(0, 8)}@exemplo.test`, nomeDaClinica: `Clinica Ficticia ${seq}`, ...over };
}

/** Guarda o token como o parâmetro de entrega guardaria. */
function guarda(): { tokens: string[]; guardar: (t: string) => Promise<void> } {
  const tokens: string[] = [];
  return { tokens, guardar: (t) => Promise.resolve(void tokens.push(t)) };
}

const provisionar = (p: PedidoDeProvisionamento, guardar: (t: string) => Promise<void>) => provisionarClinica(bancos, p, guardar, { chaveDoEmail: CHAVE });

async function contarClinicas(clinicaId: TenantId): Promise<number> {
  const linhas = await withTenant(api.db.db, clinicaId, (tx) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, clinicaId)));
  return linhas.length;
}

describe('B11 PR 1: provisionamento da clínica (R1, R3, R8, R9)', () => {
  it('cria a clínica com o fundador admin e a ativação de 72 h com só o hash do token e o HMAC do e-mail', async () => {
    const p = pedidoFicticio();
    const g = guarda();
    const r = await provisionar(p, g.guardar);
    expect(r).toEqual({ clinicaId: clinicaDoPedido(p.pedido), pedido: p.pedido, contaExistente: false });
    expect(g.tokens).toHaveLength(1);
    const token = g.tokens[0]!;
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const [linha] = await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido));
    expect(linha).toMatchObject({
      clinicaId: r.clinicaId,
      contaExistente: false,
      contrato: p.contrato,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      emailHmac: hmacDoEmail(p.email, CHAVE),
      usadoEm: null,
      falhas: 0,
    });
    expect(linha!.expiraEm.getTime() - linha!.criadoEm.getTime()).toBe(72 * 3600_000);
    // Token e e-mail nunca em claro em nenhuma coluna (R1, R3).
    const texto = JSON.stringify(linha);
    expect(texto).not.toContain(token);
    expect(texto).not.toContain(p.email);
    expect(texto).not.toContain(p.nomeDaClinica);
    // A conta nova NÃO nasce no provisionamento (R2): só o uuid reservado.
    expect(await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.id, linha!.usuarioId))).toHaveLength(0);

    await withTenant(api.db.db, r.clinicaId, async (tx) => {
      const [t] = await tx.select().from(tenants).where(eq(tenants.id, r.clinicaId));
      expect(t?.founderUserId).toBe(linha!.usuarioId);
      const admins = await tx.select().from(clinicMembers).where(and(eq(clinicMembers.tenantId, r.clinicaId), eq(clinicMembers.role, 'admin')));
      expect(admins.map((m) => m.userId)).toEqual([linha!.usuarioId]);
      const trilha = await tx.select({ metadata: auditLog.metadata }).from(auditLog).where(eq(auditLog.tenantId, r.clinicaId));
      expect(JSON.stringify(trilha)).not.toContain(p.email);
    });
  });

  it('idempotente: repetir o pedido não cria segunda clínica nem segundo token', async () => {
    const p = pedidoFicticio();
    const g = guarda();
    const r = await provisionar(p, g.guardar);
    await expect(provisionar(p, g.guardar)).rejects.toMatchObject({ codigo: 'ja_provisionado' });
    expect(g.tokens).toHaveLength(1);
    expect(await contarClinicas(r.clinicaId)).toBe(1);
    expect(await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.clinicaId, r.clinicaId))).toHaveLength(1);
  });

  it('falha ao guardar o token: a linha não fica, e a nova rodada completa sem duplicar a clínica', async () => {
    const p = pedidoFicticio();
    await expect(provisionar(p, () => Promise.reject(new Error('ssm fora')))).rejects.toThrow('ssm fora');
    const clinicaId = clinicaDoPedido(p.pedido);
    expect(await contarClinicas(clinicaId)).toBe(1);
    expect(await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido))).toHaveLength(0);

    const g = guarda();
    const r = await provisionar(p, g.guardar);
    expect(r.clinicaId).toBe(clinicaId);
    expect(g.tokens).toHaveLength(1);
    expect(await contarClinicas(clinicaId)).toBe(1);
    const [linha] = await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido));
    const [t] = await withTenant(api.db.db, clinicaId, (tx) => tx.select().from(tenants).where(eq(tenants.id, clinicaId)));
    expect(linha?.usuarioId).toBe(t?.founderUserId);
  });

  it('fundador com conta ativa: reconhecida pelo e-mail (sem diferenciar maiúsculas), sem conta nova', async () => {
    const id = randomUUID();
    const email = `ja.tem.conta.${id.slice(0, 8)}@exemplo.test`;
    await dbAuth.db.insert(usuario).values({ id, name: 'Pessoa Ficticia', email, emailVerified: true });
    const p = pedidoFicticio({ email: email.toUpperCase() });
    const r = await provisionar(p, guarda().guardar);
    expect(r.contaExistente).toBe(true);
    const [linha] = await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido));
    expect(linha).toMatchObject({ usuarioId: id, contaExistente: true, emailHmac: hmacDoEmail(email, CHAVE) });

    // C1 do parecer do #195: já é admin, mas a clínica fica fora da lista e da escolha até ativar.
    const provedor = new BetterAuthProvider({ auth: null as never, dbAuth: dbAuth.db, dbClinica: api.db.db });
    expect((await provedor.clinicasDaPessoa(id)).map((c) => c.id)).not.toContain(r.clinicaId);
    // Sobra da C1 (17/11): a clínica pendente também não conta para a escolha automática.
    expect(await provedor.clinicasDoUsuario(id)).not.toContain(r.clinicaId);
    await dbAuth.db.update(ativacaoDoFundador).set({ usadoEm: new Date() }).where(eq(ativacaoDoFundador.id, p.pedido));
    expect((await provedor.clinicasDaPessoa(id)).map((c) => c.id)).toContain(r.clinicaId);
    expect(await provedor.clinicasDoUsuario(id)).toContain(r.clinicaId);
  });

  it('A2: repetir depois de falha parcial com outro e-mail no parâmetro recriado é recusado (parametro_invalido)', async () => {
    const id = randomUUID();
    const email = `repetir.${id.slice(0, 8)}@exemplo.test`;
    await dbAuth.db.insert(usuario).values({ id, name: 'Pessoa Ficticia', email, emailVerified: true });
    const p = pedidoFicticio({ email });
    // 1ª rodada: a clínica nasce, mas guardar o token falha (a linha de ativação não fica).
    await expect(provisionar(p, () => Promise.reject(new Error('ssm fora')))).rejects.toThrow();
    // 2ª rodada com o parâmetro recriado com OUTRO e-mail: recusada antes de gravar o HMAC errado.
    await expect(provisionar({ ...p, email: `outra.${id.slice(0, 8)}@exemplo.test` }, guarda().guardar)).rejects.toMatchObject({ codigo: 'parametro_invalido' });
    expect(await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido))).toEqual([]);
  });

  it('conta inativa com o e-mail não é reaproveitada: conta_inativa, sem clínica', async () => {
    const id = randomUUID();
    const email = `desligada.${id.slice(0, 8)}@exemplo.test`;
    await dbAuth.db.insert(usuario).values({ id, name: 'Pessoa Ficticia', email, emailVerified: true, ativo: false, inativaPor: 'sem_vinculo' });
    const p = pedidoFicticio({ email });
    await expect(provisionar(p, guarda().guardar)).rejects.toMatchObject({ codigo: 'conta_inativa' });
    expect(await contarClinicas(clinicaDoPedido(p.pedido))).toBe(0);
  });

  it('contrato inválido: recusado antes de qualquer escrita, e o banco também recusa (CHECK)', async () => {
    for (const contrato of ['CTR-', 'CTR-12345678', 'ctr-1', 'CTR-1; drop', 'LGPD-1']) {
      const p = pedidoFicticio({ contrato });
      const g = guarda();
      await expect(provisionar(p, g.guardar)).rejects.toEqual(new ProvisionamentoRecusado('contrato_invalido'));
      expect(g.tokens).toHaveLength(0);
      expect(await contarClinicas(clinicaDoPedido(p.pedido))).toBe(0);
    }
    await expect(
      dbAuth.db.insert(ativacaoDoFundador).values({
        id: randomUUID(),
        clinicaId: randomUUID(),
        usuarioId: randomUUID(),
        emailHmac: '0'.repeat(32),
        contaExistente: false,
        tokenHash: 'a'.repeat(64),
        contrato: 'CTR-x',
        expiraEm: sql`now() + interval '1 hour'`,
      }),
    ).rejects.toThrow();
  });

  it('o banco recusa token em claro, validade acima de 72 h e segunda ativação pendente da clínica', async () => {
    const base = { clinicaId: randomUUID(), usuarioId: randomUUID(), emailHmac: '0'.repeat(32), contaExistente: false, contrato: 'CTR-1' };
    await expect(
      dbAuth.db.insert(ativacaoDoFundador).values({ ...base, id: randomUUID(), tokenHash: 'token-em-claro', expiraEm: sql`now() + interval '1 hour'` }),
    ).rejects.toThrow();
    await expect(
      dbAuth.db.insert(ativacaoDoFundador).values({ ...base, id: randomUUID(), tokenHash: 'b'.repeat(64), expiraEm: sql`now() + interval '73 hours'` }),
    ).rejects.toThrow();
    // Hashes aleatórios: um fixo fica no banco e a 2ª rodada da suíte falharia pelo UNIQUE do token, não pela regra.
    const hash = () => randomBytes(32).toString('hex');
    await dbAuth.db.insert(ativacaoDoFundador).values({ ...base, id: randomUUID(), tokenHash: hash(), expiraEm: sql`now() + interval '1 hour'` });
    await expect(
      dbAuth.db.insert(ativacaoDoFundador).values({ ...base, id: randomUUID(), tokenHash: hash(), expiraEm: sql`now() + interval '1 hour'` }),
    ).rejects.toThrow();
  });

  it('app_user (rotas de negócio) não lê nem escreve a tabela (R1)', async () => {
    await expect(api.db.db.execute(sql`select token_hash from identidade.ativacao_do_fundador limit 1`)).rejects.toThrow();
    await expect(api.db.db.execute(sql`update identidade.ativacao_do_fundador set falhas = 0`)).rejects.toThrow();
  });
});

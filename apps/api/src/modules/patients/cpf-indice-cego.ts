import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import { guardians, patientCpfIndexKeys, patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';
import { guardianFieldRef } from './guardian-fields';
import { patientFieldRef } from './patient-fields';

/** Tabela cujo CPF é indexado. A chave da clínica é a mesma; o domínio do HMAC muda. */
export type TabelaDoIndice = 'patients' | 'guardians';

/**
 * Rótulo de domínio do HMAC: o mesmo CPF em outro uso (outra coluna/finalidade) dá outro valor. O dos
 * pacientes é o da 0046 e não muda (os índices gravados continuam válidos); o dos responsáveis é da 0054.
 */
export const DOMINIO_DO_INDICE: Readonly<Record<TabelaDoIndice, string>> = {
  patients: 'patients.cpf:v1:',
  guardians: 'guardians.cpf:v1:',
};
const KEY_BYTES = 32;

/** Índice cego pronto para gravar em `patients`/`guardians` (cpf_bidx + cpf_bidx_version). */
export interface IndiceDoCpf {
  readonly cpfBidx: string;
  readonly cpfBidxVersion: number;
}

interface ChaveViva {
  readonly versao: number;
  readonly bytes: Buffer;
}

/** HMAC-SHA256(chave, domínio da tabela + 11 dígitos) em base64url (43 caracteres). Puro, para teste. */
export function hmacDoCpf(chave: Uint8Array, cpf: string, tabela: TabelaDoIndice = 'patients'): string {
  return createHmac('sha256', chave).update(DOMINIO_DO_INDICE[tabela] + cpf.replace(/\D/g, ''), 'utf8').digest('base64url');
}

function refDoCpf(tabela: TabelaDoIndice, tenantId: TenantId, id: string): FieldRef {
  return tabela === 'patients' ? patientFieldRef(tenantId, id, 'cpf') : guardianFieldRef(tenantId, id, 'cpf');
}

const tabelaDe = (tabela: TabelaDoIndice) => (tabela === 'patients' ? patients : guardians);

function refDaChave(tenantId: TenantId, versao: number): FieldRef {
  return { tenantId, table: 'patient_cpf_index_keys', column: 'key', rowId: String(versao) };
}

/**
 * Índice cego do CPF por clínica (R9 do parecer do importador, migração 0046).
 *
 * A chave de índice é aleatória, por clínica, e só existe cifrada pela chave da clínica (FieldCipher: DEK
 * embrulhada pela chave mestra da clínica no KMS). O índice permite achar o paciente pelo CPF sem decifrar
 * o cadastro inteiro. Nunca compara entre clínicas: a chave é outra e o RLS limita a busca à clínica.
 *
 * Troca da chave (documentada em api-dominio.md §12d): `girarChave` → `reindexar` em lotes até `pendentes = 0`
 * → `descartarChavesAntigas`. Enquanto a reindexação não termina, a busca casa por todas as chaves vivas
 * (ativa + aposentadas) e decifra só os pacientes ainda sem índice.
 *
 * 0054: os responsáveis (`guardians`) usam a MESMA chave e a mesma tabela de chaves, com o domínio
 * `guardians.cpf:v1:`; reindexação, pendentes e descarte de versão cobrem as duas tabelas.
 */
export class IndiceCegoCpf {
  constructor(private readonly cipher: FieldCipher<TenantTx>) {}

  /** Índice do CPF com a chave ATIVA da clínica (cria a versão 1 na primeira vez), no domínio da tabela. */
  async indexar(tx: TenantTx, ctx: RequestContext, cpf: string, tabela: TabelaDoIndice = 'patients'): Promise<IndiceDoCpf> {
    const chave = (await this.chaveAtiva(tx, ctx.tenantId)) ?? (await this.criarChave(tx, ctx));
    return { cpfBidx: hmacDoCpf(chave.bytes, cpf, tabela), cpfBidxVersion: chave.versao };
  }

  /**
   * 0054: pessoas responsáveis da clínica por CPF (deduplicação do importador, 0048). Como `procurar`: casa
   * pelo índice com todas as chaves vivas e confirma decifrando só os casados mais os pendentes sem índice
   * válido. Pessoa descartada não entra; duas pessoas com o mesmo CPF (cadastro antigo) = fica a mais antiga.
   * Nenhum CPF sai daqui para log ou trilha.
   */
  async procurarResponsaveis(tx: TenantTx, tenantId: TenantId, cpfs: readonly string[]): Promise<Map<string, string>> {
    const achados = new Map<string, string>();
    if (cpfs.length === 0) return achados;
    const procurados = new Set(cpfs);
    const chaves = await this.chavesVivas(tx, tenantId);
    const porIndice = new Set<string>();
    for (const k of chaves) for (const cpf of procurados) porIndice.add(`${k.versao}|${hmacDoCpf(k.bytes, cpf, 'guardians')}`);
    const vivos = and(eq(guardians.tenantId, tenantId), isNotNull(guardians.cpfEnc), isNull(guardians.discardedAt));
    const colunas = { id: guardians.id, cpfEnc: guardians.cpfEnc, criado: guardians.createdAt, bidx: guardians.cpfBidx, versao: guardians.cpfBidxVersion };
    const candidatos =
      porIndice.size === 0
        ? []
        : await tx
            .select(colunas)
            .from(guardians)
            .where(and(vivos, inArray(guardians.cpfBidx, [...porIndice].map((k) => k.split('|')[1] as string))));
    const vivas = chaves.map((k) => k.versao);
    const pendentes = await tx
      .select(colunas)
      .from(guardians)
      .where(and(vivos, vivas.length === 0 ? sql`true` : or(isNull(guardians.cpfBidxVersion), notInArray(guardians.cpfBidxVersion, vivas))));
    // Só os casados (versão viva + índice) e os pendentes; a mais antiga primeiro, para ficar com ela.
    const confirmar = [...candidatos.filter((l) => porIndice.has(`${l.versao}|${l.bidx}`)), ...pendentes].sort(
      (a, b) => a.criado.getTime() - b.criado.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const l of confirmar) {
      const cpf = await this.cipher.decryptString(tx, guardianFieldRef(tenantId, l.id, 'cpf'), l.cpfEnc as string);
      if (procurados.has(cpf) && !achados.has(cpf)) achados.set(cpf, l.id);
    }
    return achados;
  }

  /**
   * Pacientes da clínica por CPF, para a deduplicação. Casa pelo índice (todas as chaves vivas) e CONFIRMA
   * decifrando só os casados; os pacientes com CPF ainda sem índice válido (anteriores à 0046, CPF reescrito
   * por um caminho sem índice, versão já descartada) são decifrados um a um, como antes. Nenhum CPF sai daqui
   * para log ou trilha.
   */
  async procurar(tx: TenantTx, tenantId: TenantId, cpfs: readonly string[]): Promise<Map<string, { id: string; ativo: boolean }>> {
    const achados = new Map<string, { id: string; ativo: boolean }>();
    if (cpfs.length === 0) return achados;
    const procurados = new Set(cpfs);
    const chaves = await this.chavesVivas(tx, tenantId);
    const porIndice = new Map<string, string>();
    for (const k of chaves) for (const cpf of procurados) porIndice.set(`${k.versao}|${hmacDoCpf(k.bytes, cpf)}`, cpf);
    const candidatos =
      porIndice.size === 0
        ? []
        : await tx
            .select({ id: patients.id, cpfEnc: patients.cpfEnc, ativo: patients.active, bidx: patients.cpfBidx, versao: patients.cpfBidxVersion })
            .from(patients)
            .where(and(eq(patients.tenantId, tenantId), inArray(patients.cpfBidx, [...porIndice.keys()].map((k) => k.split('|')[1] as string))));
    const confirmar = async (l: { id: string; cpfEnc: string | null; ativo: boolean }) => {
      if (!l.cpfEnc) return;
      const cpf = await this.cipher.decryptString(tx, patientFieldRef(tenantId, l.id, 'cpf'), l.cpfEnc);
      if (procurados.has(cpf) && !achados.has(cpf)) achados.set(cpf, { id: l.id, ativo: l.ativo });
    };
    for (const l of candidatos) if (porIndice.has(`${l.versao}|${l.bidx}`)) await confirmar(l);
    // Pendentes de reindexação: sem índice, ou com versão que não está mais viva.
    const vivas = chaves.map((k) => k.versao);
    const pendentes = await tx
      .select({ id: patients.id, cpfEnc: patients.cpfEnc, ativo: patients.active })
      .from(patients)
      .where(
        and(
          eq(patients.tenantId, tenantId),
          isNotNull(patients.cpfEnc),
          vivas.length === 0 ? sql`true` : or(isNull(patients.cpfBidxVersion), notInArray(patients.cpfBidxVersion, vivas)),
        ),
      );
    for (const l of pendentes) await confirmar(l);
    return achados;
  }

  /** Troca a chave: a ativa vira `retired` (continua casando até a reindexação) e nasce a próxima versão. */
  async girarChave(tx: TenantTx, ctx: RequestContext): Promise<number> {
    await this.travar(tx, ctx.tenantId);
    const atual = await this.chaveAtiva(tx, ctx.tenantId);
    if (atual) {
      await tx
        .update(patientCpfIndexKeys)
        .set({ status: 'retired', retiredAt: sql`now()` })
        .where(and(eq(patientCpfIndexKeys.tenantId, ctx.tenantId), eq(patientCpfIndexKeys.version, atual.versao)));
    }
    const nova = await this.criarChave(tx, ctx, true);
    await recordAudit(tx, ctx, { action: AuditAction.KeyRotate, scope: 'crypto.key.cpf_index', metadata: { version: nova.versao } });
    return nova.versao;
  }

  /**
   * Reindexa até `limite` pessoas com CPF cujo índice não é da chave ativa (lote; chamar até `pendentes = 0`):
   * primeiro pacientes, e o que sobrar do lote vai para os responsáveis (0054). Só grava
   * cpf_bidx/cpf_bidx_version: não toca o CPF cifrado nem `updated_at`; no responsável, o banco também não
   * gera histórico nem exige usuário (exceção do índice no guardians_guard, 0054), então a reindexação não
   * conta como `alterado_depois` no desfazer do lote. Trilha só com contagens; a dos responsáveis só quando
   * há responsável a reindexar, com `table: 'guardians'`. `pendentes` soma as duas tabelas.
   */
  async reindexar(tx: TenantTx, ctx: RequestContext, limite = 500): Promise<{ reindexados: number; pendentes: number }> {
    const chave = (await this.chaveAtiva(tx, ctx.tenantId)) ?? (await this.criarChave(tx, ctx));
    const p = await this.reindexarTabela(tx, ctx, chave, 'patients', limite);
    await recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'patients', metadata: { op: 'cpf_reindex', version: chave.versao, count: p.reindexados, pending: p.pendentes } });
    const g = await this.reindexarTabela(tx, ctx, chave, 'guardians', limite - p.reindexados);
    if (g.reindexados > 0 || g.pendentes > 0) {
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'patient_guardians',
        metadata: { op: 'cpf_reindex', table: 'guardians', version: chave.versao, count: g.reindexados, pending: g.pendentes },
      });
    }
    return { reindexados: p.reindexados + g.reindexados, pendentes: p.pendentes + g.pendentes };
  }

  private async reindexarTabela(
    tx: TenantTx,
    ctx: RequestContext,
    chave: ChaveViva,
    tabela: TabelaDoIndice,
    limite: number,
  ): Promise<{ reindexados: number; pendentes: number }> {
    const t = tabelaDe(tabela);
    const foraDaAtiva = and(eq(t.tenantId, ctx.tenantId), isNotNull(t.cpfEnc), or(isNull(t.cpfBidxVersion), ne(t.cpfBidxVersion, chave.versao)));
    const lote = limite <= 0 ? [] : await tx.select({ id: t.id, cpfEnc: t.cpfEnc }).from(t).where(foraDaAtiva).orderBy(t.id).limit(limite).for('update');
    for (const l of lote) {
      const cpf = await this.cipher.decryptString(tx, refDoCpf(tabela, ctx.tenantId, l.id), l.cpfEnc as string);
      const indice = { cpfBidx: hmacDoCpf(chave.bytes, cpf, tabela), cpfBidxVersion: chave.versao };
      // Só as colunas do índice (no responsável, é o que a exceção do guardians_guard aceita sem usuário).
      if (tabela === 'patients') await tx.update(patients).set(indice).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, l.id)));
      else await tx.update(guardians).set(indice).where(and(eq(guardians.tenantId, ctx.tenantId), eq(guardians.id, l.id)));
    }
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(t).where(foraDaAtiva);
    return { reindexados: lote.length, pendentes: Number(r?.n ?? 0) };
  }

  /**
   * Quantos pacientes e responsáveis com CPF ainda estão fora da chave ativa (sem índice ou em versão
   * antiga). Não decifra nada e não cria chave: é a conferência barata que o job faz antes de abrir a chave
   * da clínica.
   */
  async pendentes(tx: TenantTx, tenantId: TenantId): Promise<number> {
    const [k] = await tx
      .select({ versao: patientCpfIndexKeys.version })
      .from(patientCpfIndexKeys)
      .where(and(eq(patientCpfIndexKeys.tenantId, tenantId), eq(patientCpfIndexKeys.status, 'active')));
    let total = 0;
    for (const tabela of ['patients', 'guardians'] as const) {
      const t = tabelaDe(tabela);
      const [r] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), isNotNull(t.cpfEnc), k ? or(isNull(t.cpfBidxVersion), ne(t.cpfBidxVersion, k.versao)) : sql`true`));
      total += Number(r?.n ?? 0);
    }
    return total;
  }

  /** Há versão aposentada ainda não destruída? (sem decifrar; evita a trava da clínica quando não há) */
  async temChaveAposentada(tx: TenantTx, tenantId: TenantId): Promise<boolean> {
    const [k] = await tx
      .select({ versao: patientCpfIndexKeys.version })
      .from(patientCpfIndexKeys)
      .where(and(eq(patientCpfIndexKeys.tenantId, tenantId), eq(patientCpfIndexKeys.status, 'retired')))
      .limit(1);
    return k !== undefined;
  }

  /**
   * Depois da reindexação: chaves aposentadas sem paciente nem responsável indexado viram `destroyed`
   * (key_enc apagada). O banco recusa destruir versão em uso (patient_cpf_index_keys_guard, 0054).
   */
  async descartarChavesAntigas(tx: TenantTx, ctx: RequestContext): Promise<number> {
    await this.travar(tx, ctx.tenantId);
    const r = await tx
      .update(patientCpfIndexKeys)
      .set({ status: 'destroyed', keyEnc: null, destroyedAt: sql`now()` })
      .where(
        and(
          eq(patientCpfIndexKeys.tenantId, ctx.tenantId),
          eq(patientCpfIndexKeys.status, 'retired'),
          sql`not exists (select 1 from patients p where p.tenant_id = ${patientCpfIndexKeys.tenantId} and p.cpf_bidx_version = ${patientCpfIndexKeys.version})`,
          sql`not exists (select 1 from guardians g where g.tenant_id = ${patientCpfIndexKeys.tenantId} and g.cpf_bidx_version = ${patientCpfIndexKeys.version})`,
        ),
      )
      .returning({ versao: patientCpfIndexKeys.version });
    if (r.length > 0) {
      await recordAudit(tx, ctx, { action: AuditAction.KeyDestroy, scope: 'crypto.key.cpf_index', metadata: { versions: r.map((x) => x.versao).sort().join(',') } });
    }
    return r.length;
  }

  /** Ordem global das travas da clínica (field-cipher.ts): audit_chain ANTES; depois esta; tenant_keys depois. */
  private async travar(tx: TenantTx, tenantId: TenantId): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`audit_chain:${tenantId}`}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cpf_index_keys:${tenantId}`}, 0))`);
  }

  private async chaveAtiva(tx: TenantTx, tenantId: TenantId): Promise<ChaveViva | undefined> {
    const [k] = await tx
      .select({ versao: patientCpfIndexKeys.version, keyEnc: patientCpfIndexKeys.keyEnc })
      .from(patientCpfIndexKeys)
      .where(and(eq(patientCpfIndexKeys.tenantId, tenantId), eq(patientCpfIndexKeys.status, 'active')));
    if (!k?.keyEnc) return undefined;
    return { versao: k.versao, bytes: await this.cipher.decrypt(tx, refDaChave(tenantId, k.versao), k.keyEnc) };
  }

  private async chavesVivas(tx: TenantTx, tenantId: TenantId): Promise<ChaveViva[]> {
    const ks = await tx
      .select({ versao: patientCpfIndexKeys.version, keyEnc: patientCpfIndexKeys.keyEnc })
      .from(patientCpfIndexKeys)
      .where(and(eq(patientCpfIndexKeys.tenantId, tenantId), inArray(patientCpfIndexKeys.status, ['active', 'retired'])));
    const vivas: ChaveViva[] = [];
    for (const k of ks) if (k.keyEnc) vivas.push({ versao: k.versao, bytes: await this.cipher.decrypt(tx, refDaChave(tenantId, k.versao), k.keyEnc) });
    return vivas;
  }

  /** Cria a próxima versão (sob a trava da clínica; concorrente que chegou antes vence e é reaproveitado). */
  private async criarChave(tx: TenantTx, ctx: RequestContext, jaTravado = false): Promise<ChaveViva> {
    if (!jaTravado) {
      await this.travar(tx, ctx.tenantId);
      const outra = await this.chaveAtiva(tx, ctx.tenantId);
      if (outra) return outra;
    }
    const [m] = await tx
      .select({ v: sql<number>`coalesce(max(${patientCpfIndexKeys.version}), 0)::int` })
      .from(patientCpfIndexKeys)
      .where(eq(patientCpfIndexKeys.tenantId, ctx.tenantId));
    const versao = Number(m?.v ?? 0) + 1;
    const bytes = randomBytes(KEY_BYTES);
    const keyEnc = await this.cifrar(tx, ctx, refDaChave(ctx.tenantId, versao), bytes);
    await tx.insert(patientCpfIndexKeys).values({ tenantId: ctx.tenantId, version: versao, keyEnc });
    return { versao, bytes };
  }

  private async cifrar(tx: TenantTx, ctx: RequestContext, ref: FieldRef, valor: Uint8Array): Promise<string> {
    try {
      return await this.cipher.encrypt(tx, ref, valor);
    } catch (e) {
      if (!(e instanceof TenantKeyMissingError)) throw e;
      await this.cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
      return this.cipher.encrypt(tx, ref, valor);
    }
  }
}

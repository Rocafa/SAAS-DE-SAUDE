import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import { patientCpfIndexKeys, patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';
import { patientFieldRef } from './patient-fields';

/** Rótulo de domínio do HMAC: o mesmo CPF em outro uso (outra coluna/finalidade) dá outro valor. */
const DOMINIO = 'patients.cpf:v1:';
const KEY_BYTES = 32;

/** Índice cego pronto para gravar em `patients` (cpf_bidx + cpf_bidx_version). */
export interface IndiceDoCpf {
  readonly cpfBidx: string;
  readonly cpfBidxVersion: number;
}

interface ChaveViva {
  readonly versao: number;
  readonly bytes: Buffer;
}

/** HMAC-SHA256(chave, domínio + 11 dígitos) em base64url (43 caracteres). Puro, para teste. */
export function hmacDoCpf(chave: Uint8Array, cpf: string): string {
  return createHmac('sha256', chave).update(DOMINIO + cpf.replace(/\D/g, ''), 'utf8').digest('base64url');
}

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
 */
export class IndiceCegoCpf {
  constructor(private readonly cipher: FieldCipher<TenantTx>) {}

  /** Índice do CPF com a chave ATIVA da clínica (cria a versão 1 na primeira vez). */
  async indexar(tx: TenantTx, ctx: RequestContext, cpf: string): Promise<IndiceDoCpf> {
    const chave = (await this.chaveAtiva(tx, ctx.tenantId)) ?? (await this.criarChave(tx, ctx));
    return { cpfBidx: hmacDoCpf(chave.bytes, cpf), cpfBidxVersion: chave.versao };
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
   * Reindexa até `limite` pacientes com CPF cujo índice não é da chave ativa (lote; chamar até `pendentes = 0`).
   * Só grava cpf_bidx/cpf_bidx_version (não toca o CPF cifrado nem `updated_at`). Trilha só com contagens.
   */
  async reindexar(tx: TenantTx, ctx: RequestContext, limite = 500): Promise<{ reindexados: number; pendentes: number }> {
    const chave = (await this.chaveAtiva(tx, ctx.tenantId)) ?? (await this.criarChave(tx, ctx));
    const foraDaAtiva = and(
      eq(patients.tenantId, ctx.tenantId),
      isNotNull(patients.cpfEnc),
      or(isNull(patients.cpfBidxVersion), ne(patients.cpfBidxVersion, chave.versao)),
    );
    const lote = await tx.select({ id: patients.id, cpfEnc: patients.cpfEnc }).from(patients).where(foraDaAtiva).orderBy(patients.id).limit(limite).for('update');
    for (const l of lote) {
      const cpf = await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, l.id, 'cpf'), l.cpfEnc as string);
      await tx
        .update(patients)
        .set({ cpfBidx: hmacDoCpf(chave.bytes, cpf), cpfBidxVersion: chave.versao })
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, l.id)));
    }
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(patients).where(foraDaAtiva);
    const pendentes = Number(r?.n ?? 0);
    await recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'patients', metadata: { op: 'cpf_reindex', version: chave.versao, count: lote.length, pending: pendentes } });
    return { reindexados: lote.length, pendentes };
  }

  /**
   * Quantos pacientes com CPF ainda estão fora da chave ativa (sem índice ou em versão antiga). Não decifra
   * nada e não cria chave: é a conferência barata que o job faz antes de abrir a chave da clínica.
   */
  async pendentes(tx: TenantTx, tenantId: TenantId): Promise<number> {
    const [k] = await tx
      .select({ versao: patientCpfIndexKeys.version })
      .from(patientCpfIndexKeys)
      .where(and(eq(patientCpfIndexKeys.tenantId, tenantId), eq(patientCpfIndexKeys.status, 'active')));
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(patients)
      .where(
        and(
          eq(patients.tenantId, tenantId),
          isNotNull(patients.cpfEnc),
          k ? or(isNull(patients.cpfBidxVersion), ne(patients.cpfBidxVersion, k.versao)) : sql`true`,
        ),
      );
    return Number(r?.n ?? 0);
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

  /** Depois da reindexação: chaves aposentadas sem paciente indexado viram `destroyed` (key_enc apagada). */
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

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { EntradaInvalidaError } from '../../common/validacao';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { dbErrorCode } from '../../db/db-errors';
import {
  appointments,
  appointmentTypes,
  importBatches,
  importBatchRecords,
  importIssues,
  importRawFiles,
  patients,
  professionals,
  type ImportKind,
  type ImportStatus,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';
import { patientFieldRef } from '../patients/patient-fields';
import { PatientsService } from '../patients/patients.service';
import { normalizarBusca } from '../patients/patients.validation';
import { capacidadeDoHorario, paraInstante } from '../scheduling/agenda-regras';
import { SchedulingService } from '../scheduling/scheduling.service';
import { TenantDatabase } from '../tenancy/tenancy.module';
import {
  errosDoMapeamento,
  hashDoPlano,
  sugerirMapeamento,
  TERMO_MIGRACAO_VERSAO,
  validarAgenda,
  validarPacientes,
  valorParaRelatorio,
  type AcaoPlanejada,
  type Divergencia,
  type Mapeamento,
  type PacienteDaLinha,
} from './importacao-regras';
import { decodificarUtf8, lerCsv, type Planilha } from './planilha-csv';
import { TERMO_MIGRACAO_SHA256 } from './termo-migracao';

/** Configuração do importador (ambiente). */
export interface ImportacaoConfig {
  /** Vida máxima do arquivo bruto, em horas (1..168; padrão 168 = 7 dias, teto do plano do piloto). */
  readonly horasDoArquivoBruto: number;
  /**
   * R2 do parecer do importador: em PRODUÇÃO o importador nasce DESLIGADO (novos lotes: 409
   * `importador_desligado`) até a rotina diária de descarte estar agendada e com alarme; liga com
   * `IMPORTADOR_HABILITADO=true`. Fora de produção, ligado salvo `IMPORTADOR_HABILITADO=false`.
   */
  readonly habilitado: boolean;
}
export const IMPORTACAO_CONFIG = Symbol('IMPORTACAO_CONFIG');

export function loadImportacaoConfig(env: NodeJS.ProcessEnv = process.env): ImportacaoConfig {
  const flag = env.IMPORTADOR_HABILITADO?.trim();
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false') throw new Error('IMPORTADOR_HABILITADO inválida (true ou false)');
  const habilitado = flag === 'true' || (env.NODE_ENV !== 'production' && flag !== 'false');
  const bruto = env.IMPORT_RAW_TTL_HOURS?.trim();
  if (!bruto) return { horasDoArquivoBruto: 168, habilitado };
  const n = Number(bruto);
  if (!/^\d{1,3}$/.test(bruto) || n < 1 || n > 168) throw new Error('IMPORT_RAW_TTL_HOURS inválida (1 a 168 horas)');
  return { horasDoArquivoBruto: n, habilitado };
}

export interface LoteDto {
  readonly id: string;
  readonly tipo: ImportKind;
  readonly status: ImportStatus;
  readonly termo: { readonly versao: string; readonly textoSha256: string | null; readonly aceitoPor: string; readonly aceitoEm: string };
  readonly linhas: number;
  readonly colunas: number;
  readonly mapeamento: Mapeamento | null;
  readonly validas: number | null;
  readonly comErro: number | null;
  readonly avisos: number | null;
  readonly criar: number | null;
  readonly ignorar: number | null;
  readonly resumoHash: string | null;
  readonly criados: number | null;
  readonly arquivoExpiraEm: string;
  readonly arquivoDescartadoEm: string | null;
  readonly criadoEm: string;
  readonly aplicadoEm: string | null;
  readonly desfeitoEm: string | null;
}

export interface RecebidoDto extends LoteDto {
  /** Cabeçalho lido do arquivo (índice + texto), para o admin mapear. Só na resposta, nunca gravado. */
  readonly cabecalho: readonly { readonly indice: number; readonly texto: string }[];
  readonly mapeamentoSugerido: Mapeamento;
}

export interface DivergenciaDto extends Divergencia {
  /** Valor da célula (neutralizado contra fórmula); null se o arquivo bruto já foi descartado. */
  readonly valor: string | null;
}

export interface RelatorioDto {
  readonly lote: LoteDto;
  readonly divergencias: readonly DivergenciaDto[];
  readonly truncado: boolean;
}

/** Resultado da rotina diária de descarte (R2): só contagens; `clinicasComAtraso` = posições na lista recebida. */
export interface ResultadoExpurgoDiario {
  readonly clinicas: number;
  readonly arquivosDescartados: number;
  readonly atrasados: number;
  readonly alarme: boolean;
  readonly clinicasComAtraso: readonly number[];
}

/** 409 do desfazer bloqueado, com os motivos SÓ em contagens (nenhum id nem dado de paciente). */
export class ImportacaoEmUsoError extends ConflictException {
  constructor(readonly motivos: Readonly<Record<string, number>>) {
    super({ statusCode: 409, message: 'Conflito', codigo: 'importacao_em_uso', motivos });
  }
}

const SCOPE = 'import_batches';
const LOTE_DE_INSERCAO = 500;
const MAX_DIVERGENCIAS_NA_RESPOSTA = 500;
const ESTADOS_EDITAVEIS: readonly ImportStatus[] = ['recebido', 'validado', 'simulado'];

type Lote = typeof importBatches.$inferSelect;

function paraDto(b: Lote): LoteDto {
  return {
    id: b.id,
    tipo: b.kind,
    status: b.status,
    termo: { versao: b.termVersion, textoSha256: b.termSha256, aceitoPor: b.termAcceptedBy, aceitoEm: b.termAcceptedAt.toISOString() },
    linhas: b.rowCount,
    colunas: b.columnCount,
    mapeamento: b.columnMapping ?? null,
    validas: b.validRows,
    comErro: b.errorRows,
    avisos: b.warningCount,
    criar: b.plannedCreates,
    ignorar: b.plannedSkips,
    resumoHash: b.simulationHash,
    criados: b.createdRecords,
    arquivoExpiraEm: b.rawExpiresAt.toISOString(),
    arquivoDescartadoEm: b.rawDiscardedAt?.toISOString() ?? null,
    criadoEm: b.createdAt.toISOString(),
    aplicadoEm: b.appliedAt?.toISOString() ?? null,
    desfeitoEm: b.undoneAt?.toISOString() ?? null,
  };
}

/** Referência do arquivo bruto cifrado: AAD = clínica + tabela + coluna + lote. */
function refDoArquivo(ctx: RequestContext, loteId: string): FieldRef {
  return { tenantId: ctx.tenantId, table: 'import_raw_files', column: 'content', rowId: loteId };
}

interface Plano {
  readonly acoes: readonly AcaoPlanejada[];
  readonly divergencias: readonly Divergencia[];
  readonly linhasComErro: number;
  readonly pacientes: ReadonlyMap<number, PacienteDaLinha>;
  readonly agendamentos: ReadonlyMap<number, { pacienteId: string; profissionalId: string; tipoId: string; data: string; hora: string }>;
}

/**
 * Importador de planilha (MIG-01.1/01.2, MIG-02.1/02.2, G8). Toda operação roda na transação da clínica
 * da sessão (RLS), sob a política de assinatura, e audita SEM conteúdo (só ids, códigos e contagens). O
 * arquivo bruto só existe cifrado e só é aberto dentro da transação que o usa. Nada de dado pessoal em
 * log: este serviço não tem logger.
 */
@Injectable()
export class ImportacaoService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(PatientsService) private readonly pacientes: PatientsService,
    @Inject(SchedulingService) private readonly agenda: SchedulingService,
    @Inject(IMPORTACAO_CONFIG) private readonly config: ImportacaoConfig,
  ) {}

  /** Recebe o arquivo (já lido e limitado no controller), com o aceite do termo de migração. */
  async receber(ctx: RequestContext, tipo: ImportKind, termo: string, bytes: Uint8Array): Promise<RecebidoDto> {
    if (!this.config.habilitado) throw new ConflitoError('importador_desligado');
    if (termo !== TERMO_MIGRACAO_VERSAO) throw new ConflitoError('termo_desatualizado');
    // Lê ANTES de abrir a transação: arquivo inválido não grava nada (nem o bruto).
    const planilha = lerCsv(decodificarUtf8(bytes));
    const sha = createHash('sha256').update(bytes).digest('hex');
    try {
      return await escreverNaClinica(this.db, ctx, async (tx) => {
        await this.expurgarNaTransacao(tx, ctx);
        const id = randomUUID();
        const [lote] = await tx
          .insert(importBatches)
          .values({
            id,
            tenantId: ctx.tenantId,
            kind: tipo,
            termVersion: termo,
            termSha256: TERMO_MIGRACAO_SHA256,
            termAcceptedBy: ctx.userId,
            byteSize: bytes.length,
            rowCount: planilha.linhas.length,
            columnCount: planilha.cabecalho.length,
            // Relógio do banco (o mesmo dos CHECKs): agora + vida do arquivo bruto (≤ 7 dias).
            rawExpiresAt: sql`now() + make_interval(hours => ${this.config.horasDoArquivoBruto})`,
            createdBy: ctx.userId,
          })
          .returning();
        if (!lote) throw new Error('falha ao criar lote');
        await tx.insert(importRawFiles).values({
          batchId: id,
          tenantId: ctx.tenantId,
          contentEnc: await this.cifrar(tx, ctx, refDoArquivo(ctx, id), bytes),
          sha256: sha,
          expiresAt: sql`(select raw_expires_at from import_batches where id = ${id}::uuid)`,
        });
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE,
          metadata: { import_batch_id: id, kind: tipo, term_version: termo, rows: planilha.linhas.length, bytes: bytes.length },
        });
        return {
          ...paraDto(lote),
          cabecalho: planilha.cabecalho.map((texto, indice) => ({ indice, texto })),
          mapeamentoSugerido: sugerirMapeamento(tipo, planilha.cabecalho),
        };
      });
    } catch (e) {
      // O banco confere o perfil admin em clinic_members (0020): sem ele, 42501.
      if (dbErrorCode(e) === '42501') throw new ProibidoError('perfil_admin_nao_registrado');
      throw e;
    }
  }

  listar(ctx: RequestContext): Promise<LoteDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const lotes = await tx
        .select()
        .from(importBatches)
        .where(eq(importBatches.tenantId, ctx.tenantId))
        .orderBy(desc(importBatches.createdAt), asc(importBatches.id))
        .limit(100);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { count: lotes.length } });
      return lotes.map(paraDto);
    });
  }

  obter(ctx: RequestContext, id: string): Promise<LoteDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const lote = await this.carregar(tx, ctx, id, false);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { import_batch_id: id } });
      return paraDto(lote);
    });
  }

  /** Mapeamento campo -> índice de coluna. Volta o lote para "recebido" (é preciso validar de novo). */
  mapear(ctx: RequestContext, id: string, mapa: Mapeamento): Promise<LoteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.expurgarNaTransacao(tx, ctx);
      const lote = await this.carregarEditavel(tx, ctx, id);
      const erros = errosDoMapeamento(lote.kind, mapa, lote.columnCount);
      if (erros.length > 0) throw new EntradaInvalidaError(erros.map((c) => `mapeamento.${c}`));
      const [novo] = await tx
        .update(importBatches)
        .set({ columnMapping: { ...mapa }, status: 'recebido', simulationHash: null, plannedCreates: null, plannedSkips: null, updatedAt: new Date() })
        .where(and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.id, id)))
        .returning();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { import_batch_id: id, op: 'map', fields: Object.keys(mapa).sort().join(',') },
      });
      return paraDto(novo as Lote);
    });
  }

  /** Validação de formato (sem consultar cadastro): CPF, telefone, datas, obrigatórios, duplicados no arquivo. */
  validar(ctx: RequestContext, id: string): Promise<RelatorioDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.expurgarNaTransacao(tx, ctx);
      const lote = await this.carregarEditavel(tx, ctx, id);
      const mapa = this.exigirMapeamento(lote);
      const planilha = await this.abrirArquivo(tx, ctx, lote);
      const v = lote.kind === 'pacientes' ? validarPacientes(planilha, mapa) : validarAgenda(planilha, mapa);
      const run = lote.currentRun + 1;
      const [novo] = await tx
        .update(importBatches)
        .set({
          status: 'validado',
          currentRun: run,
          validRows: v.validas.length,
          errorRows: v.linhasComErro,
          warningCount: v.divergencias.filter((d) => d.gravidade === 'aviso').length,
          simulationHash: null,
          plannedCreates: null,
          plannedSkips: null,
          validatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.id, id)))
        .returning();
      await this.gravarDivergencias(tx, ctx, id, run, v.divergencias);
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { import_batch_id: id, op: 'validate', valid: v.validas.length, errors: v.linhasComErro, issues: v.divergencias.length },
      });
      return this.relatorio(novo as Lote, planilha, mapa, v.divergencias);
    });
  }

  /**
   * DRY-RUN (MIG-02.1): resolve tudo contra o cadastro da clínica (duplicados por CPF, paciente,
   * profissional, tipo, capacidade) e mostra o que SERIA criado ou ignorado. Não cria paciente nem
   * agendamento; grava só o estado do lote, o hash do plano e as divergências (códigos).
   */
  simular(ctx: RequestContext, id: string): Promise<RelatorioDto & { readonly resumoHash: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.expurgarNaTransacao(tx, ctx);
      const lote = await this.carregarEditavel(tx, ctx, id);
      if (lote.status === 'recebido') throw new ConflitoError('validar_antes');
      const mapa = this.exigirMapeamento(lote);
      const { planilha, sha256 } = await this.abrirArquivoComVersao(tx, ctx, lote);
      const plano = await this.planejar(tx, ctx, lote.kind, planilha, mapa);
      const hash = hashDoPlano(lote.kind, plano.acoes, mapa, sha256);
      const run = lote.currentRun + 1;
      const criar = plano.acoes.filter((a) => a.acao === 'criar').length;
      const [novo] = await tx
        .update(importBatches)
        .set({
          status: 'simulado',
          currentRun: run,
          errorRows: plano.linhasComErro,
          warningCount: plano.divergencias.filter((d) => d.gravidade === 'aviso').length,
          plannedCreates: criar,
          plannedSkips: plano.acoes.length - criar,
          simulationHash: hash,
          simulatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.id, id)))
        .returning();
      await this.gravarDivergencias(tx, ctx, id, run, plano.divergencias);
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { import_batch_id: id, op: 'dry_run', create: criar, skip: plano.acoes.length - criar, errors: plano.linhasComErro },
      });
      return { ...this.relatorio(novo as Lote, planilha, mapa, plano.divergencias), resumoHash: hash };
    });
  }

  /** Relatório de divergências da rodada corrente (valores relidos do arquivo bruto, neutralizados). */
  divergencias(ctx: RequestContext, id: string): Promise<RelatorioDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const lote = await this.carregar(tx, ctx, id, false);
      const linhas = await tx
        .select()
        .from(importIssues)
        .where(and(eq(importIssues.tenantId, ctx.tenantId), eq(importIssues.batchId, id), eq(importIssues.run, lote.currentRun)))
        .orderBy(asc(importIssues.lineNumber), asc(importIssues.field), asc(importIssues.code));
      const lista: Divergencia[] = linhas.map((l) => ({ linha: l.lineNumber, campo: l.field, codigo: l.code, gravidade: l.severity }));
      const [bruto] = await tx
        .select({ id: importRawFiles.batchId })
        .from(importRawFiles)
        .where(and(eq(importRawFiles.tenantId, ctx.tenantId), eq(importRawFiles.batchId, id), sql`${importRawFiles.expiresAt} > now()`));
      const planilha = bruto ? await this.abrirArquivo(tx, ctx, lote) : null;
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { import_batch_id: id, op: 'report', count: lista.length } });
      return this.relatorio(lote, planilha, lote.columnMapping ?? {}, lista, Number.MAX_SAFE_INTEGER);
    });
  }

  /**
   * APLICAR (G8): só a simulação que o admin aprovou (mesmo hash). Recalcula o plano na transação, sob as
   * travas da agenda; se o cadastro mudou desde a simulação, 409 `simulacao_desatualizada` e nada é gravado.
   * Tudo numa transação: pacientes em lotes de 500 (mesma cifra do cadastro), agendamentos pela regra da
   * agenda, livro do lote, auditoria por bloco e descarte do arquivo bruto no mesmo commit.
   */
  async aplicar(ctx: RequestContext, id: string, resumoHash: string): Promise<LoteDto> {
    try {
      return await escreverNaClinica(this.db, ctx, async (tx) => {
        await this.expurgarNaTransacao(tx, ctx);
        const lote = await this.carregar(tx, ctx, id, true);
        if (lote.status !== 'simulado') throw new ConflitoError(lote.status === 'expirado' ? 'lote_expirado' : 'simular_antes');
        if (lote.simulationHash !== resumoHash) throw new ConflitoError('simulacao_nao_aprovada');
        const mapa = this.exigirMapeamento(lote);
        const { planilha, sha256 } = await this.abrirArquivoComVersao(tx, ctx, lote);
        if (lote.kind === 'agenda') await this.travarProfissionais(tx, ctx);
        const plano = await this.planejar(tx, ctx, lote.kind, planilha, mapa);
        if (hashDoPlano(lote.kind, plano.acoes, mapa, sha256) !== resumoHash) throw new ConflitoError('simulacao_desatualizada');
        const criar = plano.acoes.filter((a) => a.acao === 'criar');
        const criados = lote.kind === 'pacientes' ? await this.criarPacientes(tx, ctx, id, criar, plano) : await this.criarAgendamentos(tx, ctx, id, criar, plano);
        const [novo] = await tx
          .update(importBatches)
          .set({ status: 'aplicado', appliedAt: sql`now()`, appliedBy: ctx.userId, createdRecords: criados, updatedAt: sql`now()` })
          .where(and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.id, id)))
          .returning();
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE,
          metadata: { import_batch_id: id, op: 'apply', kind: lote.kind, created: criados, skipped: plano.acoes.length - criar.length },
        });
        // Descarte do arquivo bruto no MESMO commit (lote aplicado não precisa mais dele).
        await this.expurgarNaTransacao(tx, ctx);
        const [final] = await tx.select().from(importBatches).where(and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.id, id)));
        return paraDto(final ?? (novo as Lote));
      });
    } catch (e) {
      if (dbErrorCode(e) === '42501') throw new ProibidoError('perfil_admin_nao_registrado');
      throw e;
    }
  }

  /**
   * DESFAZER (MIG-02.2): apaga o que o lote criou, pela função dedicada do banco, enquanto NADA dele foi
   * usado (atendimento, prontuário, financeiro, guia/pacote, agenda nova, alteração, retenção legal).
   * Senão, 409 `importacao_em_uso` com os motivos em contagens.
   */
  async desfazer(ctx: RequestContext, id: string): Promise<LoteDto> {
    try {
      return await escreverNaClinica(this.db, ctx, async (tx) => {
        const lote = await this.carregar(tx, ctx, id, true);
        if (lote.status !== 'aplicado') throw new ConflitoError('status_nao_permite');
        const [b] = await tx.execute<{ motivos: Record<string, number | string> }>(sql`select app_import_batch_blockers(${id}::uuid) as motivos`);
        const motivos = Object.fromEntries(Object.entries(b?.motivos ?? {}).map(([k, v]) => [k, Number(v)]));
        if (Object.values(motivos).some((n) => n > 0)) throw new ImportacaoEmUsoError(motivos);
        const [r] = await tx.execute<{ r: { patients: number; appointments: number } }>(sql`select app_undo_import_batch(${id}::uuid) as r`);
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE,
          metadata: { import_batch_id: id, op: 'undo', patients: r?.r.patients ?? 0, appointments: r?.r.appointments ?? 0 },
        });
        await this.expurgarNaTransacao(tx, ctx);
        return paraDto(await this.carregar(tx, ctx, id, false));
      });
    } catch (e) {
      const codigo = dbErrorCode(e);
      if (codigo === '55006') throw new ConflitoError('importacao_em_uso');
      if (codigo === '42501') throw new ProibidoError('perfil_admin_nao_registrado');
      throw e;
    }
  }

  /**
   * Rotina de descarte (job diário por clínica, e oportunista em toda operação do importador): apaga o
   * arquivo bruto vencido ou de lote encerrado e registra a evidência. Idempotente.
   */
  expurgar(ctx: RequestContext): Promise<number> {
    return this.db.run(ctx.tenantId, (tx) => this.expurgarNaTransacao(tx, ctx));
  }

  /**
   * R2 do parecer do importador: ROTINA DIÁRIA de descarte, como job do sistema (sem usuário: slot
   * travado com o sentinela da 0019). Uma transação por clínica (RLS), idempotente: rodar de novo no
   * mesmo dia apaga 0. Devolve, além do que apagou, quantos arquivos brutos estão VENCIDOS HÁ MAIS DE 24 h
   * depois do expurgo (`atrasados`); `alarme` = atrasados > 0, para o agendador disparar o alerta.
   * Trilha da clínica só com contagens (ator `sistema`). Como agendar: api-dominio.md §10c (R2).
   */
  async expurgoDiario(clinicas: readonly TenantId[]): Promise<ResultadoExpurgoDiario> {
    let arquivosDescartados = 0;
    let atrasados = 0;
    const clinicasComAtraso: number[] = [];
    for (const [i, tenantId] of clinicas.entries()) {
      const r = await this.db.run(tenantId, async (tx) => {
        const ctx: RequestContext = { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] };
        const n = await this.expurgarNaTransacao(tx, ctx);
        const [a] = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from import_raw_files where tenant_id = ${tenantId}::uuid and expires_at < now() - interval '24 hours'`,
        );
        return { n, atrasados: Number(a?.n ?? 0) };
      });
      arquivosDescartados += r.n;
      atrasados += r.atrasados;
      if (r.atrasados > 0) clinicasComAtraso.push(i);
    }
    return { clinicas: clinicas.length, arquivosDescartados, atrasados, alarme: atrasados > 0, clinicasComAtraso };
  }

  // ---------------------------------------------------------------- internos

  private async expurgarNaTransacao(tx: TenantTx, ctxAuditoria?: RequestContext): Promise<number> {
    const [r] = await tx.execute<{ n: number }>(sql`select app_purge_import_raw_files() as n`);
    const n = Number(r?.n ?? 0);
    if (ctxAuditoria && n > 0) {
      await recordAudit(tx, ctxAuditoria, { action: AuditAction.Update, scope: SCOPE, metadata: { op: 'raw_discarded', count: n } });
    }
    return n;
  }

  private async carregar(tx: TenantTx, ctx: RequestContext, id: string, travar: boolean): Promise<Lote> {
    const q = tx.select().from(importBatches).where(and(eq(importBatches.tenantId, ctx.tenantId), eq(importBatches.id, id)));
    const [lote] = travar ? await q.for('update') : await q;
    if (!lote) throw new NaoEncontradoError();
    return lote;
  }

  private async carregarEditavel(tx: TenantTx, ctx: RequestContext, id: string): Promise<Lote> {
    const lote = await this.carregar(tx, ctx, id, true);
    if (lote.status === 'expirado') throw new ConflitoError('lote_expirado');
    if (!ESTADOS_EDITAVEIS.includes(lote.status)) throw new ConflitoError('status_nao_permite');
    return lote;
  }

  private exigirMapeamento(lote: Lote): Mapeamento {
    if (!lote.columnMapping) throw new ConflitoError('mapear_antes');
    return lote.columnMapping;
  }

  private async abrirArquivo(tx: TenantTx, ctx: RequestContext, lote: Lote): Promise<Planilha> {
    return (await this.abrirArquivoComVersao(tx, ctx, lote)).planilha;
  }

  /** Planilha e a VERSÃO do arquivo (SHA-256 do bruto, conferido contra o conteúdo decifrado), R1. */
  private async abrirArquivoComVersao(tx: TenantTx, ctx: RequestContext, lote: Lote): Promise<{ planilha: Planilha; sha256: string }> {
    const [bruto] = await tx
      .select()
      .from(importRawFiles)
      .where(and(eq(importRawFiles.tenantId, ctx.tenantId), eq(importRawFiles.batchId, lote.id)));
    if (!bruto || bruto.expiresAt.getTime() <= Date.now()) throw new ConflitoError('arquivo_descartado');
    const bytes = await this.cipher.decrypt(tx, refDoArquivo(ctx, lote.id), bruto.contentEnc);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== bruto.sha256) throw new ConflitoError('arquivo_divergente');
    return { planilha: lerCsv(decodificarUtf8(bytes)), sha256 };
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

  private async gravarDivergencias(tx: TenantTx, ctx: RequestContext, id: string, run: number, lista: readonly Divergencia[]): Promise<void> {
    // Chave primária (linha, campo, código): a mesma divergência não se repete.
    const unicas = new Map(lista.map((d) => [`${d.linha}|${d.campo}|${d.codigo}`, d]));
    const linhas = [...unicas.values()].map((d) => ({
      tenantId: ctx.tenantId,
      batchId: id,
      run,
      lineNumber: d.linha,
      field: d.campo,
      code: d.codigo,
      severity: d.gravidade,
    }));
    for (let i = 0; i < linhas.length; i += LOTE_DE_INSERCAO) await tx.insert(importIssues).values(linhas.slice(i, i + LOTE_DE_INSERCAO));
  }

  private relatorio(lote: Lote, planilha: Planilha | null, mapa: Mapeamento, lista: readonly Divergencia[], max = MAX_DIVERGENCIAS_NA_RESPOSTA): RelatorioDto {
    const divergencias = lista.slice(0, max).map((d) => ({ ...d, valor: planilha ? valorParaRelatorio(planilha, mapa, d.linha, d.campo) : null }));
    return { lote: paraDto(lote), divergencias, truncado: lista.length > max };
  }

  /** Serializa com marcações concorrentes: trava a agenda de TODOS os profissionais da clínica, em ordem. */
  private async travarProfissionais(tx: TenantTx, ctx: RequestContext): Promise<void> {
    const ps = await tx.select({ id: professionals.id }).from(professionals).where(eq(professionals.tenantId, ctx.tenantId)).orderBy(asc(professionals.id));
    for (const p of ps) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agenda:${ctx.tenantId}:${p.id}`}, 0))`);
  }

  /** CPF (decifrado) -> paciente, de toda a clínica. Substituível por índice cego quando houver HMAC no KMS. */
  private async cpfsDaClinica(tx: TenantTx, ctx: RequestContext): Promise<Map<string, { id: string; ativo: boolean }>> {
    const linhas = await tx
      .select({ id: patients.id, cpfEnc: patients.cpfEnc, ativo: patients.active })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), isNotNull(patients.cpfEnc)));
    const mapa = new Map<string, { id: string; ativo: boolean }>();
    for (const l of linhas) {
      const cpf = await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, l.id, 'cpf'), l.cpfEnc as string);
      mapa.set(cpf, { id: l.id, ativo: l.ativo });
    }
    return mapa;
  }

  private async planejar(tx: TenantTx, ctx: RequestContext, kind: ImportKind, planilha: Planilha, mapa: Mapeamento): Promise<Plano> {
    return kind === 'pacientes' ? this.planejarPacientes(tx, ctx, planilha, mapa) : this.planejarAgenda(tx, ctx, planilha, mapa);
  }

  private async planejarPacientes(tx: TenantTx, ctx: RequestContext, planilha: Planilha, mapa: Mapeamento): Promise<Plano> {
    const v = validarPacientes(planilha, mapa);
    const divergencias: Divergencia[] = [...v.divergencias];
    const cpfs = v.validas.some((p) => p.cpf) ? await this.cpfsDaClinica(tx, ctx) : new Map<string, { id: string; ativo: boolean }>();
    // Sem CPF: mesmo nome já cadastrado vira aviso (cria mesmo assim; o admin vê antes de aplicar).
    const semCpf = v.validas.filter((p) => !p.cpf);
    const nomes = new Set<string>();
    if (semCpf.length > 0) {
      const existentes = await tx.select({ nome: patients.displayName }).from(patients).where(eq(patients.tenantId, ctx.tenantId));
      for (const e of existentes) nomes.add(normalizarBusca(e.nome));
    }
    const acoes: AcaoPlanejada[] = [];
    const porLinha = new Map<number, PacienteDaLinha>();
    for (const p of v.validas) {
      if (p.cpf && cpfs.has(p.cpf)) {
        acoes.push({ linha: p.linha, acao: 'ignorar' });
        divergencias.push({ linha: p.linha, campo: 'cpf', codigo: 'ja_cadastrado', gravidade: 'aviso' });
        continue;
      }
      if (!p.cpf && nomes.has(normalizarBusca(p.nome))) {
        divergencias.push({ linha: p.linha, campo: 'nome', codigo: 'possivel_duplicado', gravidade: 'aviso' });
      }
      acoes.push({ linha: p.linha, acao: 'criar' });
      porLinha.set(p.linha, p);
    }
    return { acoes, divergencias, linhasComErro: v.linhasComErro, pacientes: porLinha, agendamentos: new Map() };
  }

  private async planejarAgenda(tx: TenantTx, ctx: RequestContext, planilha: Planilha, mapa: Mapeamento): Promise<Plano> {
    const v = validarAgenda(planilha, mapa);
    const divergencias: Divergencia[] = [...v.divergencias];
    let linhasComErro = v.linhasComErro;
    const agrupar = <T extends { nome: string }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(normalizarBusca(x.nome), [...(m.get(normalizarBusca(x.nome)) ?? []), x]);
      return m;
    };
    const profs = agrupar(
      await tx
        .select({ id: professionals.id, nome: professionals.displayName, capacidade: professionals.capacity })
        .from(professionals)
        .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.active, true))),
    );
    const tipos = agrupar(
      await tx
        .select({ id: appointmentTypes.id, nome: appointmentTypes.name, minutos: appointmentTypes.durationMinutes, capacidade: appointmentTypes.capacity })
        .from(appointmentTypes)
        .where(and(eq(appointmentTypes.tenantId, ctx.tenantId), eq(appointmentTypes.active, true))),
    );
    const cpfs = v.validas.some((a) => a.cpf) ? await this.cpfsDaClinica(tx, ctx) : new Map<string, { id: string; ativo: boolean }>();
    const porNome = v.validas.some((a) => !a.cpf)
      ? agrupar(await tx.select({ id: patients.id, nome: patients.displayName, ativo: patients.active }).from(patients).where(eq(patients.tenantId, ctx.tenantId)))
      : new Map<string, { id: string; nome: string; ativo: boolean }[]>();

    const agora = Date.now();
    const acoes: AcaoPlanejada[] = [];
    const porLinha = new Map<number, { pacienteId: string; profissionalId: string; tipoId: string; data: string; hora: string }>();
    const noArquivo = new Set<string>();
    const planejados = new Map<string, { inicio: number; fim: number }[]>();
    for (const a of v.validas) {
      const erro = (campo: string, codigo: string) => divergencias.push({ linha: a.linha, campo, codigo, gravidade: 'erro' });
      let paciente: { id: string; ativo: boolean } | undefined;
      let codigoPaciente: string | undefined;
      if (a.cpf) {
        paciente = cpfs.get(a.cpf);
        if (!paciente) codigoPaciente = 'paciente_nao_encontrado';
      } else {
        const achados = porNome.get(normalizarBusca(a.paciente ?? '')) ?? [];
        if (achados.length === 1) paciente = achados[0];
        else codigoPaciente = achados.length === 0 ? 'paciente_nao_encontrado' : 'paciente_ambiguo';
      }
      if (paciente && !paciente.ativo) codigoPaciente = 'paciente_inativo';
      const ps = profs.get(normalizarBusca(a.profissional)) ?? [];
      const ts = tipos.get(normalizarBusca(a.tipo)) ?? [];
      const inicio = paraInstante(a.data, a.hora);
      const antes = divergencias.length;
      if (codigoPaciente) erro(a.cpf ? 'cpf' : 'paciente', codigoPaciente);
      if (ps.length !== 1) erro('profissional', ps.length === 0 ? 'profissional_nao_encontrado' : 'profissional_ambiguo');
      if (ts.length !== 1) erro('tipo', ts.length === 0 ? 'tipo_nao_encontrado' : 'tipo_ambiguo');
      // Agenda FUTURA: o passado fica no sistema antigo (e não gera vínculo de cuidado aqui).
      if (inicio.getTime() <= agora) erro('data', 'horario_no_passado');
      if (divergencias.length > antes) {
        linhasComErro++;
        continue;
      }
      const prof = ps[0] as { id: string; capacidade: number };
      const tipo = ts[0] as { id: string; minutos: number; capacidade: number };
      const pacienteId = (paciente as { id: string }).id;
      const fim = new Date(inicio.getTime() + tipo.minutos * 60_000);
      const chave = `${pacienteId}|${prof.id}|${inicio.toISOString()}`;
      if (noArquivo.has(chave)) {
        erro('linha', 'agendamento_duplicado_no_arquivo');
        linhasComErro++;
        continue;
      }
      noArquivo.add(chave);
      const ref = `${pacienteId}|${prof.id}|${tipo.id}|${inicio.toISOString()}`;
      const [existente] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.tenantId, ctx.tenantId),
            eq(appointments.patientId, pacienteId),
            eq(appointments.professionalId, prof.id),
            eq(appointments.startsAt, inicio),
            ne(appointments.status, 'cancelled'),
          ),
        )
        .limit(1);
      if (existente) {
        acoes.push({ linha: a.linha, acao: 'ignorar', ref });
        divergencias.push({ linha: a.linha, campo: 'linha', codigo: 'ja_agendado', gravidade: 'aviso' });
        continue;
      }
      const intervalos = planejados.get(prof.id) ?? [];
      const sobrepostos = intervalos.filter((x) => x.inicio < fim.getTime() && x.fim > inicio.getTime()).length;
      const ocupados = (await this.agenda.vagasOcupadas(tx, ctx, prof.id, inicio, fim)) + sobrepostos;
      if (ocupados >= capacidadeDoHorario(prof.capacidade, tipo.capacidade)) {
        acoes.push({ linha: a.linha, acao: 'ignorar', ref });
        divergencias.push({ linha: a.linha, campo: 'hora', codigo: 'horario_lotado', gravidade: 'aviso' });
        continue;
      }
      planejados.set(prof.id, [...intervalos, { inicio: inicio.getTime(), fim: fim.getTime() }]);
      acoes.push({ linha: a.linha, acao: 'criar', ref });
      porLinha.set(a.linha, { pacienteId, profissionalId: prof.id, tipoId: tipo.id, data: a.data, hora: a.hora });
    }
    return { acoes, divergencias, linhasComErro, pacientes: new Map(), agendamentos: porLinha };
  }

  private async criarPacientes(tx: TenantTx, ctx: RequestContext, loteId: string, criar: readonly AcaoPlanejada[], plano: Plano): Promise<number> {
    let total = 0;
    for (let i = 0; i < criar.length; i += LOTE_DE_INSERCAO) {
      const bloco = criar.slice(i, i + LOTE_DE_INSERCAO);
      const linhas: (typeof patients.$inferInsert)[] = [];
      const livro: (typeof importBatchRecords.$inferInsert)[] = [];
      for (const acao of bloco) {
        const p = plano.pacientes.get(acao.linha) as PacienteDaLinha;
        const id = randomUUID();
        const dados = {
          nome: p.nome,
          telefone: p.telefone,
          ...(p.nomeSocial ? { nomeSocial: p.nomeSocial } : {}),
          ...(p.cpf ? { cpf: p.cpf } : {}),
          ...(p.nascimento ? { nascimento: p.nascimento } : {}),
        };
        // 0026 (V1): a marca imutável do lote é o que o desfazer usa (nunca o livro).
        linhas.push({ ...(await this.pacientes.prepararInsercao(tx, ctx, id, dados)), importBatchId: loteId });
        livro.push({ tenantId: ctx.tenantId, batchId: loteId, entity: 'patient', recordId: id, lineNumber: acao.linha });
      }
      await tx.insert(patients).values(linhas);
      await tx.insert(importBatchRecords).values(livro);
      total += linhas.length;
      // Auditoria por bloco (10 mil linhas por evento seria lento): o livro do lote tem cada id.
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: 'patients',
        metadata: { import_batch_id: loteId, op: 'import', created: linhas.length, block: i / LOTE_DE_INSERCAO + 1 },
      });
    }
    return total;
  }

  private async criarAgendamentos(tx: TenantTx, ctx: RequestContext, loteId: string, criar: readonly AcaoPlanejada[], plano: Plano): Promise<number> {
    let total = 0;
    for (const acao of criar) {
      const a = plano.agendamentos.get(acao.linha) as { pacienteId: string; profissionalId: string; tipoId: string; data: string; hora: string };
      const criado = await this.agenda.criarNaTransacao(tx, ctx, { ...a, encaixe: false }, loteId);
      await tx.insert(importBatchRecords).values({ tenantId: ctx.tenantId, batchId: loteId, entity: 'appointment', recordId: criado.id, lineNumber: acao.linha });
      total++;
    }
    return total;
  }
}


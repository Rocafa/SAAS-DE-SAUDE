import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { EntradaInvalidaError } from '../../common/validacao';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { dbErrorCode } from '../../db/db-errors';
import {
  appointments,
  appointmentTypes,
  financeSettings,
  guardians,
  importBatches,
  importBatchKeys,
  importBatchRecords,
  importIssues,
  importRawFiles,
  patientGuardians,
  patients,
  professionals,
  tenants,
  type ImportKind,
  type ImportStatus,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import { DISPOSABLE_KEYS, FIELD_CIPHER } from '../crypto/crypto.module';
import type { DisposableKeys } from '../crypto/disposable-keys';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';
import { cifrarCampoResponsavel, cifrarCampoVinculo, decifrarCampoResponsavel } from '../patients/guardian-fields';
import { SCOPE_RESPONSAVEIS } from '../patients/responsaveis.service';
import { PatientsService } from '../patients/patients.service';
import { normalizarBusca } from '../patients/patients.validation';
import { capacidadeDoHorario, noFusoDaClinica, paraInstante } from '../scheduling/agenda-regras';
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
  /** R6: quando o admin confirmou, ao aplicar, a clínica de origem dos dados; null antes. */
  readonly origemConfirmadaEm: string | null;
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
  /** R3-a: chaves de lote em `destroying` há mais de 24 h (o KMS falhou e a retomada ainda não fechou). */
  readonly chavesPendentes: number;
  readonly alarme: boolean;
  readonly clinicasComAtraso: readonly number[];
}

/** R3-a: chave de lote presa em `destroying` além deste prazo acende o alarme `CHAVE_LOTE_PRESA`. */
export const PRAZO_CHAVE_LOTE_PRESA_HORAS = 24;
/** Teto de chaves que uma operação do usuário tenta destruir no KMS depois do commit (o job pega o resto). */
const MAX_DESTRUICOES_POR_OPERACAO = 20;

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
    origemConfirmadaEm: b.originConfirmedAt?.toISOString() ?? null,
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
  /**
   * R5 (0048): para cada linha a CRIAR com responsável, de onde vem a pessoa: já cadastrada na clínica
   * (mesmo CPF, `existenteId`: não é tocada nem apagada pelo desfazer) ou nova, com a `chave` que junta as
   * linhas da mesma pessoa no arquivo (CPF; sem CPF, a própria linha).
   */
  readonly responsaveis: ReadonlyMap<number, DestinoDoResponsavel>;
}

type DestinoDoResponsavel = { readonly existenteId: string } | { readonly chave: string };

/** Contagens do responsável no plano (só números; vão na resposta do dry-run e na trilha). */
export interface ResumoDeResponsaveis {
  readonly vinculos: number;
  readonly pessoasNovas: number;
  readonly pessoasJaCadastradas: number;
  readonly pagadores: number;
}

function resumoDeResponsaveis(plano: Plano): ResumoDeResponsaveis {
  const novas = new Set<string>();
  const existentes = new Set<string>();
  let pagadores = 0;
  for (const [linha, d] of plano.responsaveis) {
    if ('existenteId' in d) existentes.add(d.existenteId);
    else novas.add(d.chave);
    if (plano.pacientes.get(linha)?.responsavel?.pagador) pagadores++;
  }
  return { vinculos: plano.responsaveis.size, pessoasNovas: novas.size, pessoasJaCadastradas: existentes.size, pagadores };
}

/**
 * Importador de planilha (MIG-01.1/01.2, MIG-02.1/02.2, G8). Toda operação roda na transação da clínica
 * da sessão (RLS), sob a política de assinatura, e audita SEM conteúdo (só ids, códigos e contagens). O
 * arquivo bruto só existe cifrado e só é aberto dentro da transação que o usa. Nada de dado pessoal em
 * log: este serviço não tem logger.
 */
@Injectable()
export class ImportacaoService {
  private readonly logger = new Logger('importador');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(PatientsService) private readonly pacientes: PatientsService,
    @Inject(SchedulingService) private readonly agenda: SchedulingService,
    @Inject(IMPORTACAO_CONFIG) private readonly config: ImportacaoConfig,
    @Inject(DISPOSABLE_KEYS) private readonly chavesDeLote: DisposableKeys,
  ) {}

  /** Recebe o arquivo (já lido e limitado no controller), com o aceite do termo de migração. */
  async receber(ctx: RequestContext, tipo: ImportKind, termo: string, bytes: Uint8Array): Promise<RecebidoDto> {
    if (!this.config.habilitado) throw new ConflitoError('importador_desligado');
    if (termo !== TERMO_MIGRACAO_VERSAO) throw new ConflitoError('termo_desatualizado');
    // Lê ANTES de abrir a transação: arquivo inválido não grava nada (nem o bruto).
    const planilha = lerCsv(decodificarUtf8(bytes));
    const sha = createHash('sha256').update(bytes).digest('hex');
    // R3: chave mestra do lote criada no provedor; se a transação falhar, ela é destruída (sem órfã).
    const criadas: string[] = [];
    try {
      return await this.escrever(ctx, async (tx) => {
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
          contentEnc: await this.selarBrutoDoLote(tx, ctx.tenantId, id, bytes, criadas),
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
      for (const m of criadas) await this.chavesDeLote.destroy(ctx.tenantId, m).catch(() => undefined);
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
    return this.escrever(ctx, async (tx) => {
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
        // Texto da trilha tem teto de 64: as colunas do responsável (0048) vão só em contagem.
        metadata: {
          import_batch_id: id,
          op: 'map',
          fields: Object.keys(mapa)
            .filter((c) => !c.startsWith('responsavel'))
            .sort()
            .join(','),
          guardian_fields: Object.keys(mapa).filter((c) => c.startsWith('responsavel')).length,
        },
      });
      return paraDto(novo as Lote);
    });
  }

  /** Validação de formato (sem consultar cadastro): CPF, telefone, datas, obrigatórios, duplicados no arquivo. */
  validar(ctx: RequestContext, id: string): Promise<RelatorioDto> {
    return this.escrever(ctx, async (tx) => {
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
  simular(ctx: RequestContext, id: string): Promise<RelatorioDto & { readonly resumoHash: string; readonly responsaveis: ResumoDeResponsaveis }> {
    return this.escrever(ctx, async (tx) => {
      await this.expurgarNaTransacao(tx, ctx);
      const lote = await this.carregarEditavel(tx, ctx, id);
      if (lote.status === 'recebido') throw new ConflitoError('validar_antes');
      const mapa = this.exigirMapeamento(lote);
      const { planilha, sha256 } = await this.abrirArquivoComVersao(tx, ctx, lote);
      const plano = await this.planejar(tx, ctx, lote.kind, planilha, mapa);
      const hash = hashDoPlano(lote.kind, plano.acoes, mapa, sha256);
      const run = lote.currentRun + 1;
      const criar = plano.acoes.filter((a) => a.acao === 'criar').length;
      const resp = resumoDeResponsaveis(plano);
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
        metadata: {
          import_batch_id: id,
          op: 'dry_run',
          create: criar,
          skip: plano.acoes.length - criar,
          errors: plano.linhasComErro,
          guardian_links: resp.vinculos,
          guardians_new: resp.pessoasNovas,
          guardians_existing: resp.pessoasJaCadastradas,
        },
      });
      return { ...this.relatorio(novo as Lote, planilha, mapa, plano.divergencias), resumoHash: hash, responsaveis: resp };
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
  async aplicar(ctx: RequestContext, id: string, resumoHash: string, clinicaConfirmada: string): Promise<LoteDto> {
    try {
      return await this.escrever(ctx, async (tx) => {
        await this.expurgarNaTransacao(tx, ctx);
        const lote = await this.carregar(tx, ctx, id, true);
        if (lote.status !== 'simulado') throw new ConflitoError(lote.status === 'expirado' ? 'lote_expirado' : 'simular_antes');
        if (lote.simulationHash !== resumoHash) throw new ConflitoError('simulacao_nao_aprovada');
        // R6: o admin confirma a clínica de origem dos dados (nome ou CNPJ da clínica de destino).
        if (!(await this.confirmaClinica(tx, ctx, clinicaConfirmada))) throw new ConflitoError('clinica_nao_confirmada');
        const mapa = this.exigirMapeamento(lote);
        const { planilha, sha256 } = await this.abrirArquivoComVersao(tx, ctx, lote);
        if (lote.kind === 'agenda') await this.travarProfissionais(tx, ctx);
        const plano = await this.planejar(tx, ctx, lote.kind, planilha, mapa);
        if (hashDoPlano(lote.kind, plano.acoes, mapa, sha256) !== resumoHash) throw new ConflitoError('simulacao_desatualizada');
        const criar = plano.acoes.filter((a) => a.acao === 'criar');
        const criados = lote.kind === 'pacientes' ? await this.criarPacientes(tx, ctx, id, criar, plano) : await this.criarAgendamentos(tx, ctx, id, criar, plano);
        const [novo] = await tx
          .update(importBatches)
          .set({
            status: 'aplicado',
            appliedAt: sql`now()`,
            appliedBy: ctx.userId,
            createdRecords: criados,
            originConfirmedAt: sql`now()`,
            originConfirmedBy: ctx.userId,
            updatedAt: sql`now()`,
          })
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
      return await this.escrever(ctx, async (tx) => {
        const lote = await this.carregar(tx, ctx, id, true);
        if (lote.status !== 'aplicado') throw new ConflitoError('status_nao_permite');
        const [b] = await tx.execute<{ motivos: Record<string, number | string> }>(sql`select app_import_batch_blockers(${id}::uuid) as motivos`);
        const motivos = Object.fromEntries(Object.entries(b?.motivos ?? {}).map(([k, v]) => [k, Number(v)]));
        if (Object.values(motivos).some((n) => n > 0)) throw new ImportacaoEmUsoError(motivos);
        const [r] = await tx.execute<{ r: { patients: number; appointments: number; guardian_links?: number; guardians?: number } }>(
          sql`select app_undo_import_batch(${id}::uuid) as r`,
        );
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE,
          metadata: {
            import_batch_id: id,
            op: 'undo',
            patients: r?.r.patients ?? 0,
            appointments: r?.r.appointments ?? 0,
            // 0048: vínculos e pessoas criados pelo lote (pessoa que já existia não é apagada).
            guardian_links: r?.r.guardian_links ?? 0,
            guardians: r?.r.guardians ?? 0,
          },
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
   * arquivo bruto vencido ou de lote encerrado e registra a evidência. Idempotente. A destruição da chave
   * do lote no KMS vem DEPOIS do commit (R3-a) e nunca derruba a chamada.
   */
  async expurgar(ctx: RequestContext): Promise<number> {
    const n = await this.db.run(ctx.tenantId, (tx) => this.expurgarNaTransacao(tx, ctx));
    await this.destruirChavesPendentes(ctx);
    return n;
  }

  /**
   * R2 do parecer do importador: ROTINA DIÁRIA de descarte, como job do sistema (sem usuário: slot
   * travado com o sentinela da 0019). Uma transação por clínica (RLS), idempotente: rodar de novo no
   * mesmo dia apaga 0. Devolve, além do que apagou, quantos arquivos brutos estão VENCIDOS HÁ MAIS DE 24 h
   * depois do expurgo (`atrasados`) e quantas chaves de lote seguem em `destroying` há mais de 24 h
   * (`chavesPendentes`, R3-a: o KMS falhou nas tentativas anteriores e nesta). `alarme` = qualquer um > 0,
   * para o agendador disparar o alerta; chave presa também gera o log `CHAVE_LOTE_PRESA` (só contagens).
   * O KMS é chamado FORA da transação do expurgo: falha dele não desfaz o descarte do bruto nem da DEK.
   * Trilha da clínica só com contagens (ator `sistema`). Como agendar: api-dominio.md §12c (R2) e §14.
   */
  async expurgoDiario(clinicas: readonly TenantId[]): Promise<ResultadoExpurgoDiario> {
    let arquivosDescartados = 0;
    let atrasados = 0;
    let chavesPendentes = 0;
    const clinicasComAtraso: number[] = [];
    for (const [i, tenantId] of clinicas.entries()) {
      const ctx: RequestContext = { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] };
      const r = await this.db.run(tenantId, async (tx) => {
        const n = await this.expurgarNaTransacao(tx, ctx);
        const [a] = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from import_raw_files where tenant_id = ${tenantId}::uuid and expires_at < now() - interval '24 hours'`,
        );
        return { n, atrasados: Number(a?.n ?? 0) };
      });
      // Todas as pendentes da clínica (em blocos), não só o teto de uma operação do usuário.
      for (;;) {
        const d = await this.destruirChavesPendentes(ctx);
        if (d.destruidas === 0 || d.falhas > 0) break;
      }
      const presas = await this.contarChavesPresas(tenantId);
      if (presas > 0) {
        this.logger.error(
          `CHAVE_LOTE_PRESA clinica=${tenantId} chaves=${presas}: chave de lote em destroying há mais de ${PRAZO_CHAVE_LOTE_PRESA_HORAS} h (KMS); bruto e DEK já descartados, conferir IAM/KMS`,
        );
      }
      arquivosDescartados += r.n;
      atrasados += r.atrasados;
      chavesPendentes += presas;
      if (r.atrasados > 0 || presas > 0) clinicasComAtraso.push(i);
    }
    return { clinicas: clinicas.length, arquivosDescartados, atrasados, chavesPendentes, alarme: atrasados > 0 || chavesPendentes > 0, clinicasComAtraso };
  }

  // ---------------------------------------------------------------- internos

  /**
   * Transação de escrita do importador + destruição das chaves de lote DEPOIS do commit (R3-a). O expurgo
   * dentro da transação só marca `destroying`; o KMS fica fora dela e não derruba a operação do usuário.
   */
  private async escrever<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const r = await escreverNaClinica(this.db, ctx, fn);
    await this.destruirChavesPendentes(ctx);
    return r;
  }

  /**
   * R3-a: dentro da transação, o expurgo apaga o bruto e a DEK embrulhada e marca a chave do lote como
   * `destroying` (`app_purge_import_raw_files`). NÃO chama o KMS aqui: uma falha dele desfaria o descarte
   * (bruto vencido além do TTL) e travaria todas as operações do importador da clínica.
   */
  private async expurgarNaTransacao(tx: TenantTx, ctxAuditoria?: RequestContext): Promise<number> {
    const [r] = await tx.execute<{ n: number }>(sql`select app_purge_import_raw_files() as n`);
    const n = Number(r?.n ?? 0);
    if (ctxAuditoria && n > 0) {
      await recordAudit(tx, ctxAuditoria, { action: AuditAction.Update, scope: SCOPE, metadata: { op: 'raw_discarded', count: n } });
    }
    return n;
  }

  /**
   * R3-a: FORA de qualquer transação. Para cada chave de lote em `destroying` da clínica, agenda a
   * destruição da chave mestra no provedor (KMS: exclusão agendada, para de abrir na hora; idempotente) e
   * fecha as que deram certo como `destroyed`, numa transação curta com a trilha (só contagens). Falha do
   * KMS deixa a chave em `destroying` para a próxima rodada (operação seguinte ou job diário). Nunca lança.
   */
  private async destruirChavesPendentes(ctx: RequestContext): Promise<{ destruidas: number; falhas: number }> {
    const usuario = ctx.userId === SYSTEM_ACTOR_ID ? undefined : ctx.userId;
    try {
      const pendentes = await this.db.run(
        ctx.tenantId,
        (tx) =>
          tx
            .select({ batchId: importBatchKeys.batchId, masterKeyId: importBatchKeys.masterKeyId })
            .from(importBatchKeys)
            .where(and(eq(importBatchKeys.status, 'destroying'), sql`${importBatchKeys.tenantId} = app_current_tenant()`))
            .orderBy(asc(importBatchKeys.discardedAt), asc(importBatchKeys.batchId))
            .limit(MAX_DESTRUICOES_POR_OPERACAO),
        usuario,
      );
      if (pendentes.length === 0) return { destruidas: 0, falhas: 0 };
      const feitas: string[] = [];
      let falhas = 0;
      for (const p of pendentes) {
        try {
          await this.chavesDeLote.destroy(ctx.tenantId, p.masterKeyId);
          feitas.push(p.batchId);
        } catch {
          falhas += 1;
        }
      }
      if (falhas > 0) this.logger.warn(`CHAVE_LOTE_KMS_FALHOU clinica=${ctx.tenantId} chaves=${falhas}: fica em destroying e é retomada`);
      if (feitas.length === 0) return { destruidas: 0, falhas };
      const destruidas = await this.db.run(
        ctx.tenantId,
        async (tx) => {
          let n = 0;
          for (const id of feitas) {
            const [f] = await tx.execute<{ ok: boolean }>(sql`select app_finish_import_batch_key_destroy(${id}::uuid) as ok`);
            if (f?.ok) n += 1;
          }
          if (n > 0) await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { op: 'batch_keys_destroyed', count: n } });
          return n;
        },
        usuario,
      );
      return { destruidas, falhas };
    } catch {
      // Banco indisponível depois do commit: a chave segue `destroying` (ilegível desde o expurgo).
      this.logger.warn(`CHAVE_LOTE_KMS_FALHOU clinica=${ctx.tenantId}: retomada adiada`);
      return { destruidas: 0, falhas: 1 };
    }
  }

  /** R3-a: chaves em `destroying` há mais que o prazo (índice `import_batch_keys_pending_idx`). */
  private async contarChavesPresas(tenantId: TenantId): Promise<number> {
    const [r] = await this.db.run(tenantId, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from import_batch_keys where tenant_id = ${tenantId}::uuid and status = 'destroying'
              and discarded_at < now() - make_interval(hours => ${PRAZO_CHAVE_LOTE_PRESA_HORAS})`,
      ),
    );
    return Number(r?.n ?? 0);
  }

  /**
   * R3: cria a chave PRÓPRIA do lote (chave mestra no provedor + DEK embrulhada em `import_batch_keys`) e
   * devolve o bruto cifrado com ela (v1, keyId = lote, AAD = clínica + import_raw_files + content + lote).
   * `criadas` recebe o id da chave mestra, para o chamador destruí-la se a transação falhar.
   */
  async selarBrutoDoLote(tx: TenantTx, tenantId: TenantId, loteId: string, bytes: Uint8Array, criadas: string[] = []): Promise<string> {
    const ref: FieldRef = { tenantId, table: 'import_raw_files', column: 'content', rowId: loteId };
    const { key, sealed } = await this.chavesDeLote.createAndSeal(tenantId, loteId, ref, bytes);
    criadas.push(key.masterKeyId);
    await tx.insert(importBatchKeys).values({ batchId: loteId, tenantId, masterKeyId: key.masterKeyId, wrappedKey: key.wrapped });
    return sealed;
  }

  /** Abre o bruto: chave do lote (R3); bruto anterior à 0046 (sem chave de lote) ainda abre pela chave da clínica até vencer. */
  private async abrirBruto(tx: TenantTx, ctx: RequestContext, loteId: string, contentEnc: string): Promise<Buffer> {
    const ref = refDoArquivo(ctx, loteId);
    const [chave] = await tx
      .select()
      .from(importBatchKeys)
      .where(and(eq(importBatchKeys.tenantId, ctx.tenantId), eq(importBatchKeys.batchId, loteId)));
    if (!chave) return this.cipher.decrypt(tx, ref, contentEnc);
    if (chave.status !== 'active' || !chave.wrappedKey) throw new ConflitoError('arquivo_descartado');
    return this.chavesDeLote.open(ctx.tenantId, { scopeId: loteId, masterKeyId: chave.masterKeyId, wrapped: Buffer.from(chave.wrappedKey) }, ref, contentEnc);
  }

  /** R6 (a): o texto digitado bate com o nome (normalizado) ou com o CNPJ (só dígitos) da clínica da sessão. */
  private async confirmaClinica(tx: TenantTx, ctx: RequestContext, digitado: string): Promise<boolean> {
    const [t] = await tx.select({ nome: tenants.displayName }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const [f] = await tx.select({ cnpj: financeSettings.issuerCnpj }).from(financeSettings).where(eq(financeSettings.tenantId, ctx.tenantId));
    const nome = normalizarBusca(digitado).replace(/\s+/g, ' ').trim();
    if (t && nome.length > 0 && nome === normalizarBusca(t.nome).replace(/\s+/g, ' ').trim()) return true;
    const digitos = digitado.replace(/\D/g, '');
    return Boolean(f?.cnpj && digitos.length === 14 && digitos === f.cnpj.replace(/\D/g, ''));
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
    const bytes = await this.abrirBruto(tx, ctx, lote.id, bruto.contentEnc);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== bruto.sha256) throw new ConflitoError('arquivo_divergente');
    return { planilha: lerCsv(decodificarUtf8(bytes)), sha256 };
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

  /**
   * CPF do arquivo -> paciente da clínica, pelo índice cego por clínica (R9, 0046): decifra só os pacientes
   * que casaram (para confirmar) e os ainda sem índice, nunca o cadastro inteiro. Só dentro da clínica.
   */
  private cpfsDaClinica(tx: TenantTx, ctx: RequestContext, cpfs: readonly string[]): Promise<Map<string, { id: string; ativo: boolean }>> {
    return this.pacientes.indiceCpf.procurar(tx, ctx.tenantId, [...new Set(cpfs)]);
  }

  /**
   * R5 (0048): CPF (decifrado) -> pessoa responsável da clínica, pela MESMA busca que o importador usa para
   * pacientes (`cpfsDaClinica`: decifra na transação da clínica, nada sai dela). Pessoa descartada (sem CPF)
   * não entra. Duas pessoas com o mesmo CPF (cadastro antigo): fica a mais antiga.
   */
  private async cpfsDeResponsaveisDaClinica(tx: TenantTx, ctx: RequestContext): Promise<Map<string, string>> {
    const linhas = await tx
      .select({ id: guardians.id, cpfEnc: guardians.cpfEnc })
      .from(guardians)
      .where(and(eq(guardians.tenantId, ctx.tenantId), isNotNull(guardians.cpfEnc), isNull(guardians.discardedAt)))
      .orderBy(asc(guardians.createdAt), asc(guardians.id));
    const mapa = new Map<string, string>();
    for (const l of linhas) {
      const cpf = await decifrarCampoResponsavel(this.cipher, tx, ctx.tenantId, l.id, 'cpf', l.cpfEnc);
      if (cpf && !mapa.has(cpf)) mapa.set(cpf, l.id);
    }
    return mapa;
  }

  private async planejar(tx: TenantTx, ctx: RequestContext, kind: ImportKind, planilha: Planilha, mapa: Mapeamento): Promise<Plano> {
    return kind === 'pacientes' ? this.planejarPacientes(tx, ctx, planilha, mapa) : this.planejarAgenda(tx, ctx, planilha, mapa);
  }

  private async planejarPacientes(tx: TenantTx, ctx: RequestContext, planilha: Planilha, mapa: Mapeamento): Promise<Plano> {
    const v = validarPacientes(planilha, mapa);
    const divergencias: Divergencia[] = [...v.divergencias];
    const cpfs = v.validas.some((p) => p.cpf) ? await this.cpfsDaClinica(tx, ctx, v.validas.flatMap((p) => (p.cpf ? [p.cpf] : []))) : new Map<string, { id: string; ativo: boolean }>();
    // Sem CPF: mesmo nome já cadastrado vira aviso (cria mesmo assim; o admin vê antes de aplicar).
    const semCpf = v.validas.filter((p) => !p.cpf);
    const nomes = new Set<string>();
    if (semCpf.length > 0) {
      const existentes = await tx.select({ nome: patients.displayName }).from(patients).where(eq(patients.tenantId, ctx.tenantId));
      for (const e of existentes) nomes.add(normalizarBusca(e.nome));
    }
    // R5 (0048): pessoa responsável já cadastrada na clínica, pelo CPF (mesma busca do paciente acima).
    const cpfsResp = v.validas.some((p) => p.responsavel?.cpf) ? await this.cpfsDeResponsaveisDaClinica(tx, ctx) : new Map<string, string>();
    const acoes: AcaoPlanejada[] = [];
    const porLinha = new Map<number, PacienteDaLinha>();
    const responsaveis = new Map<number, DestinoDoResponsavel>();
    for (const p of v.validas) {
      if (p.cpf && cpfs.has(p.cpf)) {
        acoes.push({ linha: p.linha, acao: 'ignorar' });
        divergencias.push({ linha: p.linha, campo: 'cpf', codigo: 'ja_cadastrado', gravidade: 'aviso' });
        // O paciente já existe: o responsável da linha não entra (completa-se no cadastro).
        if (p.responsavel) divergencias.push({ linha: p.linha, campo: 'responsavelNome', codigo: 'responsavel_nao_importado', gravidade: 'aviso' });
        continue;
      }
      if (!p.cpf && nomes.has(normalizarBusca(p.nome))) {
        divergencias.push({ linha: p.linha, campo: 'nome', codigo: 'possivel_duplicado', gravidade: 'aviso' });
      }
      let ref: string | undefined;
      const r = p.responsavel;
      if (r) {
        const existente = r.cpf ? cpfsResp.get(r.cpf) : undefined;
        const destino: DestinoDoResponsavel = existente ? { existenteId: existente } : { chave: r.cpf ? `cpf:${r.cpf}` : `linha:${p.linha}` };
        if (existente) divergencias.push({ linha: p.linha, campo: 'responsavelCpf', codigo: 'responsavel_ja_cadastrado', gravidade: 'aviso' });
        responsaveis.set(p.linha, destino);
        // No hash: de onde vem a pessoa (id já cadastrado ou "nova") e o vínculo; nunca o CPF nem o nome.
        ref = `resp:${existente ?? 'nova'}|${r.tipo}|${r.pagador ? 'pagador' : '-'}`;
      }
      acoes.push({ linha: p.linha, acao: 'criar', ...(ref ? { ref } : {}) });
      porLinha.set(p.linha, p);
    }
    return { acoes, divergencias, linhasComErro: v.linhasComErro, pacientes: porLinha, agendamentos: new Map(), responsaveis };
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
    const cpfs = v.validas.some((a) => a.cpf) ? await this.cpfsDaClinica(tx, ctx, v.validas.flatMap((a) => (a.cpf ? [a.cpf] : []))) : new Map<string, { id: string; ativo: boolean }>();
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
    return { acoes, divergencias, linhasComErro, pacientes: new Map(), agendamentos: porLinha, responsaveis: new Map() };
  }

  private async criarPacientes(tx: TenantTx, ctx: RequestContext, loteId: string, criar: readonly AcaoPlanejada[], plano: Plano): Promise<number> {
    let total = 0;
    // R5 (0048): pessoa nova criada UMA vez por chave (irmãos no arquivo), em qualquer bloco.
    const pessoasCriadas = new Map<string, string>();
    const hoje = noFusoDaClinica(new Date()).data;
    for (let i = 0; i < criar.length; i += LOTE_DE_INSERCAO) {
      const bloco = criar.slice(i, i + LOTE_DE_INSERCAO);
      const linhas: (typeof patients.$inferInsert)[] = [];
      const livro: (typeof importBatchRecords.$inferInsert)[] = [];
      const pessoas: (typeof guardians.$inferInsert)[] = [];
      const vinculos: (typeof patientGuardians.$inferInsert)[] = [];
      let reaproveitadas = 0;
      for (const acao of bloco) {
        const p = plano.pacientes.get(acao.linha) as PacienteDaLinha;
        const id = randomUUID();
        const destino = plano.responsaveis.get(acao.linha);
        const r = p.responsavel;
        if (destino && r) {
          let guardianId: string;
          if ('existenteId' in destino) {
            // Pessoa que já existia: não é tocada (nem a marca do lote); só o vínculo novo é do lote.
            guardianId = destino.existenteId;
            reaproveitadas++;
          } else if (pessoasCriadas.has(destino.chave)) {
            guardianId = pessoasCriadas.get(destino.chave) as string;
          } else {
            guardianId = randomUUID();
            pessoasCriadas.set(destino.chave, guardianId);
            pessoas.push({
              id: guardianId,
              tenantId: ctx.tenantId,
              nameEnc: await cifrarCampoResponsavel(this.cipher, tx, ctx, guardianId, 'name', r.nome),
              cpfEnc: r.cpf ? await cifrarCampoResponsavel(this.cipher, tx, ctx, guardianId, 'cpf', r.cpf) : null,
              phoneEnc: r.telefone ? await cifrarCampoResponsavel(this.cipher, tx, ctx, guardianId, 'phone', r.telefone) : null,
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
              importBatchId: loteId,
            });
          }
          const vinculoId = randomUUID();
          vinculos.push({
            id: vinculoId,
            tenantId: ctx.tenantId,
            patientId: id,
            guardianId,
            kind: r.tipo,
            // Pagador só de menor; vale para recebimentos FUTUROS (o recebimento congela o pagador, 0031).
            isPayer: r.pagador,
            // Marca clínica NUNCA pela importação (o banco também recusa, 0048).
            receivesClinicalInfo: false,
            validFrom: hoje,
            ...(r.curatela
              ? {
                  courtDecisionRefEnc: await cifrarCampoVinculo(this.cipher, tx, ctx, vinculoId, 'court_decision_ref', r.curatela.referencia),
                  curatorshipScopeEnc: await cifrarCampoVinculo(this.cipher, tx, ctx, vinculoId, 'curatorship_scope', r.curatela.escopo),
                }
              : {}),
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
            importBatchId: loteId,
          });
        }
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
      if (vinculos.length > 0) {
        if (pessoas.length > 0) await tx.insert(guardians).values(pessoas);
        await tx.insert(patientGuardians).values(vinculos);
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE_RESPONSAVEIS,
          metadata: {
            import_batch_id: loteId,
            op: 'import',
            links_created: vinculos.length,
            guardians_created: pessoas.length,
            existing_guardians: reaproveitadas,
            payers: vinculos.filter((v) => v.isPayer).length,
            block: i / LOTE_DE_INSERCAO + 1,
          },
        });
      }
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


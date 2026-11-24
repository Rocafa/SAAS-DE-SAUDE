import { AuditAction, type RequestContext } from '@plataforma/shared';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { escreverNaClinica } from '../../common/transacao-clinica';
import { ConflitoError, NaoEncontradoError, ProibidoError, RegraNaoAtendidaError } from '../../common/erros-dominio';
import { auditLog } from '../../db/schema';
import type { AiTask, LlmResponse, ModelRef } from '../ai/llm-provider';
import type { RoutingDenialReason } from '../ai/routing-policy';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { PSEUDONYM_SIGNER, type MacDeConteudo, type PseudonymSigner, type UsoDoMac } from './ator-suporte';
import { recordAudit, SYSTEM_ACTOR_ID } from './audit-log';

/**
 * Eventos append-only de um uso de IA (item 3 do veto do Guardião no #227):
 * - `ai_attempt`: gravado e COMMITADO antes de qualquer envio ao provedor;
 * - `ai_result`: gravado depois, noutra transação curta, com o mesmo `use_id`;
 * - `ai_review`: a revisão humana, só sobre resultado com status `sucesso`;
 * - `ai_refusal`: a política recusou e nada foi enviado.
 */
export const SCOPE_IA_TENTATIVA = 'ai_attempt';
export const SCOPE_IA_RESULTADO = 'ai_result';
export const SCOPE_IA_REVISAO = 'ai_review';
export const SCOPE_IA_RECUSA = 'ai_refusal';
export const DECISOES_IA = ['aceita', 'editada', 'rejeitada'] as const;
export type DecisaoRevisaoIa = (typeof DECISOES_IA)[number];
export const STATUS_RESULTADO_IA = ['sucesso', 'erro', 'timeout'] as const;
export type StatusResultadoIa = (typeof STATUS_RESULTADO_IA)[number];

/** Erro separado: o gateway NÃO pode tentar outra rota como se a chamada sem trilha tivesse sido só indisponibilidade. */
export class FalhaAuditoriaIaError extends Error {
  override readonly name = 'FalhaAuditoriaIaError';
  constructor(options: { cause: unknown }) {
    super('Não foi possível registrar o uso de IA na trilha de auditoria', options);
  }
}

export interface DadosChamadaIa {
  readonly task: AiTask;
  readonly patientId?: string;
  readonly professionalId?: string;
  readonly system: string;
  readonly input: string;
  readonly model: ModelRef;
}

export interface ResultadoChamadaIa {
  readonly response: LlmResponse;
  readonly auditId: string;
  readonly generatedAt: string;
  readonly latencyMs: number;
}

/**
 * Só o que o revisor decide. Tarefa, paciente e profissional NÃO vêm daqui: são herdados da
 * tentativa do mesmo `useId` na clínica (veto do Guardião no #227, bloqueante 2).
 */
export interface RevisaoIaInput {
  readonly useId: string;
  readonly decisao: DecisaoRevisaoIa;
  /** Obrigatório só em `editada`; nunca é persistido, só o HMAC da clínica. */
  readonly textoFinal?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textoDaMetadata(m: Record<string, unknown>, chave: string): string | undefined {
  const v = m[chave];
  return typeof v === 'string' && v ? v : undefined;
}

function modeloParaTrilha(model: ModelRef): string {
  return `${model.provider}/${model.name}`;
}

/** Aborto pelo prazo do gateway (AbortController) ou timeout do próprio cliente do provedor. */
function ehTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Tokens opcionais dos relógios: em produção nenhum provider os registra e valem os defaults;
 * testes podem instanciar a classe direto ou registrar `{ provide: RELOGIO_IA, useValue }`.
 * Sem token, o Nest tentaria resolver o tipo `Function` do parâmetro e o boot falharia.
 */
export const RELOGIO_IA = Symbol('RELOGIO_IA');
export const RELOGIO_MONOTONICO_IA = Symbol('RELOGIO_MONOTONICO_IA');

const agoraPadrao = (): Date => new Date();
const monotonicoPadrao = (): number => performance.now();

@Injectable()
export class AuditoriaIaService {
  private readonly clock: () => Date;
  private readonly monotonico: () => number;

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(PSEUDONYM_SIGNER) private readonly signer: PseudonymSigner,
    @Optional() @Inject(RELOGIO_IA) clock?: () => Date,
    @Optional() @Inject(RELOGIO_MONOTONICO_IA) monotonico?: () => number,
  ) {
    this.clock = clock ?? agoraPadrao;
    this.monotonico = monotonico ?? monotonicoPadrao;
  }

  /**
   * Hash de conteúdo da trilha = HMAC-SHA256 com a chave do operador (KMS fora de dev/test), por
   * clínica e por uso, pela porta do `PSEUDONYM_SIGNER` (veto do Guardião no #227, bloqueante 1).
   * SHA-256 puro deixava confirmar por dicionário saídas curtas (CID, rótulos) e correlacionar o
   * mesmo texto entre clínicas. Cada linha grava `hash_key_id` para saber com que chave conferir.
   */
  private async mac(ctx: RequestContext, uso: UsoDoMac, conteudo: string): Promise<MacDeConteudo> {
    try {
      return await this.signer.macDeConteudo(ctx.tenantId, uso, conteudo);
    } catch (error) {
      throw new FalhaAuditoriaIaError({ cause: error });
    }
  }

  /**
   * Três passos, nenhum deles com a conexão presa durante a chamada ao modelo (item 3 do veto):
   * 1. TENTATIVA: MAC do prompt e, numa transação curta com a política de assinatura, a linha
   *    `ai_attempt`, com COMMIT. Se o MAC ou a gravação falharem, nada vai ao provedor.
   * 2. CHAMADA ao provedor FORA de qualquer transação (o prazo de até 30 s não segura o pool).
   * 3. RESULTADO: noutra transação curta, a linha `ai_result` com o mesmo `use_id`, status
   *    (`sucesso`, `erro`, `timeout`), HMAC da saída, tokens e latência. Se o MAC da saída falhar,
   *    o resultado é gravado como `erro` (motivo `mac_indisponivel`), sem hash e sem rascunho: a
   *    tentativa nunca fica órfã em silêncio. Se nem o resultado puder ser gravado, não há rascunho
   *    e a tentativa aparece na consulta como `sem_resultado`.
   * Nenhum texto clínico entra no log: somente HMACs, ids e contagens.
   */
  async chamar(
    ctx: RequestContext,
    dados: DadosChamadaIa,
    executar: () => Promise<LlmResponse>,
  ): Promise<ResultadoChamadaIa> {
    const useId = randomUUID();
    const promptMac = await this.mac(ctx, 'ia_prompt', `${dados.system}\0${dados.input}`);
    try {
      await escreverNaClinica(this.db, ctx, (tx) =>
        recordAudit(tx, ctx, {
          action: AuditAction.AiUse,
          scope: SCOPE_IA_TENTATIVA,
          metadata: {
            use_id: useId,
            task: dados.task,
            model: modeloParaTrilha(dados.model),
            model_version: dados.model.version,
            ...(dados.patientId ? { patient_id: dados.patientId } : {}),
            ...(dados.professionalId ? { professional_id: dados.professionalId } : {}),
            prompt_hash: promptMac.mac,
            hash_key_id: promptMac.chave,
            human_reviewed: false,
          },
        }),
      );
    } catch (error) {
      if (error instanceof ProibidoError) throw error;
      throw new FalhaAuditoriaIaError({ cause: error });
    }

    const inicio = this.monotonico();
    let response: LlmResponse | undefined;
    let erroProvedor: unknown;
    let falhouProvedor = false;
    try {
      response = await executar();
    } catch (error) {
      falhouProvedor = true;
      erroProvedor = error;
    }
    const latencyMs = Math.max(0, Math.round(this.monotonico() - inicio));
    const utilizavel = response?.finishReason === 'stop' || response?.finishReason === 'length';
    let saidaMac: MacDeConteudo | null = null;
    let macFalhou = false;
    if (utilizavel && response) {
      try {
        saidaMac = await this.signer.macDeConteudo(ctx.tenantId, 'ia_saida', response.text);
      } catch {
        macFalhou = true;
      }
    }
    const status: StatusResultadoIa = falhouProvedor
      ? ehTimeout(erroProvedor)
        ? 'timeout'
        : 'erro'
      : saidaMac
        ? 'sucesso'
        : 'erro';
    const model = response?.model ?? dados.model;
    try {
      // Sem a política de assinatura de propósito: o envio já aconteceu e o resultado TEM de ficar
      // registrado, mesmo que a assinatura tenha mudado durante a chamada. RLS e usuário continuam.
      await this.db.run(
        ctx.tenantId,
        (tx) =>
          recordAudit(tx, ctx, {
            action: AuditAction.AiUse,
            scope: SCOPE_IA_RESULTADO,
            metadata: {
              use_id: useId,
              status,
              model: modeloParaTrilha(model),
              model_version: model.version,
              finish_reason: response?.finishReason ?? null,
              output_hash: saidaMac?.mac ?? null,
              ...(saidaMac ? { hash_key_id: saidaMac.chave } : {}),
              ...(macFalhou ? { motivo: 'mac_indisponivel' } : {}),
              input_tokens: response?.usage.inputTokens ?? null,
              cached_input_tokens: response?.usage.cachedInputTokens ?? null,
              output_tokens: response?.usage.outputTokens ?? null,
              latency_ms: latencyMs,
              human_reviewed: false,
              decision: status === 'sucesso' ? 'pendente' : 'nao_aplicavel',
            },
          }),
        ctx.userId,
      );
    } catch (error) {
      throw new FalhaAuditoriaIaError({ cause: error });
    }
    // Só agora, depois do COMMIT do resultado, o gateway pode aplicar fallback.
    if (falhouProvedor) throw erroProvedor;
    if (macFalhou) throw new FalhaAuditoriaIaError({ cause: new Error('MAC da saída indisponível') });
    if (!response) throw new FalhaAuditoriaIaError({ cause: new Error('provedor sem resposta') });
    return { response, auditId: useId, generatedAt: this.clock().toISOString(), latencyMs };
  }

  async registrarRecusa(
    ctx: RequestContext,
    dados: Pick<DadosChamadaIa, 'task' | 'patientId' | 'professionalId'> & { reason: RoutingDenialReason },
  ): Promise<void> {
    await escreverNaClinica(this.db, ctx, async (tx) => {
      await recordAudit(tx, ctx, {
        action: AuditAction.AiRefusal,
        scope: SCOPE_IA_RECUSA,
        metadata: {
          use_id: randomUUID(),
          task: dados.task,
          reason: dados.reason,
          ...(dados.patientId ? { patient_id: dados.patientId } : {}),
          ...(dados.professionalId ? { professional_id: dados.professionalId } : {}),
          human_reviewed: false,
          decision: 'nao_aplicavel',
        },
      });
    });
  }

  /**
   * Revisão é outro evento, nunca UPDATE: a trilha permanece append-only e encadeada. Tentativa,
   * resultado e revisões do `useId` são lidos NA CLÍNICA DA SESSÃO (RLS + filtro de tenant), na mesma
   * transação da gravação. Da tentativa vêm tarefa, paciente e profissional; só há revisão sobre
   * resultado com status `sucesso`. Só o profissional responsável revisa, uma vez só. Uso inexistente
   * e de outra clínica dão o mesmo 404, sem revelar se existe.
   */
  async registrarRevisao(ctx: RequestContext, input: RevisaoIaInput): Promise<void> {
    if (ctx.userId === SYSTEM_ACTOR_ID || !ctx.roles.includes('profissional')) {
      throw new ProibidoError('revisao_exige_profissional');
    }
    if (typeof input.useId !== 'string' || !UUID_RE.test(input.useId)) {
      throw new RegraNaoAtendidaError('use_id_invalido', ['useId']);
    }
    if (!DECISOES_IA.includes(input.decisao)) throw new RegraNaoAtendidaError('decisao_invalida', ['decisao']);
    if (input.decisao === 'editada' && !input.textoFinal?.trim()) {
      throw new RegraNaoAtendidaError('texto_final_obrigatorio', ['textoFinal']);
    }
    const useId = input.useId.toLowerCase();
    const finalMac =
      input.decisao === 'editada' && input.textoFinal ? await this.mac(ctx, 'ia_saida_final', input.textoFinal) : null;
    await escreverNaClinica(this.db, ctx, async (tx) => {
      // Serializa revisões do mesmo uso: duas abas não gravam duas revisões em corrida.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai_review:${ctx.tenantId}:${useId}`}, 0))`);
      const linhas = await tx
        .select({ tenantId: auditLog.tenantId, actorId: auditLog.actorId, scope: auditLog.scope, metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, ctx.tenantId),
            inArray(auditLog.scope, [SCOPE_IA_TENTATIVA, SCOPE_IA_RESULTADO, SCOPE_IA_REVISAO]),
            sql`${auditLog.metadata}->>'use_id' = ${useId}`,
          ),
        );
      // Confere de novo em memória (defesa em profundidade se o filtro do banco mudar).
      const doUso = linhas.filter(
        (l) => l.tenantId === ctx.tenantId && textoDaMetadata(l.metadata as Record<string, unknown>, 'use_id') === useId,
      );
      const tentativa = doUso.find((l) => l.scope === SCOPE_IA_TENTATIVA);
      if (!tentativa) throw new NaoEncontradoError();
      const m = tentativa.metadata as Record<string, unknown>;
      const responsavel = textoDaMetadata(m, 'professional_id') ?? tentativa.actorId;
      if (responsavel === SYSTEM_ACTOR_ID || responsavel !== ctx.userId) throw new ProibidoError('revisor_nao_responsavel');
      const sucesso = doUso.some(
        (l) => l.scope === SCOPE_IA_RESULTADO && (l.metadata as Record<string, unknown>)['status'] === 'sucesso',
      );
      if (!sucesso) throw new ConflitoError('uso_sem_rascunho_para_revisar');
      if (doUso.some((l) => l.scope === SCOPE_IA_REVISAO)) throw new ConflitoError('revisao_ja_registrada');
      const task = textoDaMetadata(m, 'task');
      const patientId = textoDaMetadata(m, 'patient_id');
      const professionalId = textoDaMetadata(m, 'professional_id');
      await recordAudit(tx, ctx, {
        action: AuditAction.AiUse,
        scope: SCOPE_IA_REVISAO,
        metadata: {
          use_id: useId,
          ...(task ? { task } : {}),
          ...(patientId ? { patient_id: patientId } : {}),
          ...(professionalId ? { professional_id: professionalId } : {}),
          reviewer_id: ctx.userId,
          human_reviewed: true,
          decision: input.decisao,
          ...(finalMac ? { final_output_hash: finalMac.mac, hash_key_id: finalMac.chave } : {}),
        },
      });
    });
  }
}

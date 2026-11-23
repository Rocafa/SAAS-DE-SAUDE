import { AuditAction, type RequestContext } from '@plataforma/shared';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { escreverNaClinica } from '../../common/transacao-clinica';
import { ProibidoError, RegraNaoAtendidaError } from '../../common/erros-dominio';
import type { AiTask, LlmResponse, ModelRef } from '../ai/llm-provider';
import type { RoutingDenialReason } from '../ai/routing-policy';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { recordAudit, SYSTEM_ACTOR_ID } from './audit-log';

export const SCOPE_IA_GERACAO = 'ai_generation';
export const SCOPE_IA_REVISAO = 'ai_review';
export const SCOPE_IA_RECUSA = 'ai_refusal';
export const DECISOES_IA = ['aceita', 'editada', 'rejeitada'] as const;
export type DecisaoRevisaoIa = (typeof DECISOES_IA)[number];

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

export interface RevisaoIaInput {
  readonly useId: string;
  readonly task: AiTask;
  readonly patientId?: string;
  readonly professionalId?: string;
  readonly decisao: DecisaoRevisaoIa;
  /** Obrigatório só em `editada`; nunca é persistido, só o SHA-256. */
  readonly textoFinal?: string;
}

function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

function modeloParaTrilha(model: ModelRef): string {
  return `${model.provider}/${model.name}`;
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
    @Optional() @Inject(RELOGIO_IA) clock?: () => Date,
    @Optional() @Inject(RELOGIO_MONOTONICO_IA) monotonico?: () => number,
  ) {
    this.clock = clock ?? agoraPadrao;
    this.monotonico = monotonico ?? monotonicoPadrao;
  }

  /**
   * Uma tentativa de provedor e sua linha de trilha vivem na MESMA transação. Erro do provedor é
   * capturado só para permitir o COMMIT da linha e relançado depois; erro da trilha/commit aborta
   * sem entregar rascunho. Nenhum texto clínico entra no log: somente hashes, ids e contagens.
   */
  async chamar(
    ctx: RequestContext,
    dados: DadosChamadaIa,
    executar: () => Promise<LlmResponse>,
  ): Promise<ResultadoChamadaIa> {
    const inicio = this.monotonico();
    const useId = randomUUID();
    let response: LlmResponse | undefined;
    let erroProvedor: unknown;
    let falhouProvedor = false;
    let resultado: ResultadoChamadaIa | null;
    try {
      resultado = await escreverNaClinica(this.db, ctx, async (tx) => {
        try {
          response = await executar();
        } catch (error) {
          falhouProvedor = true;
          erroProvedor = error;
        }
        const latencyMs = Math.max(0, Math.round(this.monotonico() - inicio));
        const utilizavel = response?.finishReason === 'stop' || response?.finishReason === 'length';
        const model = response?.model ?? dados.model;
        await recordAudit(tx, ctx, {
          action: AuditAction.AiUse,
          scope: SCOPE_IA_GERACAO,
          metadata: {
            use_id: useId,
            task: dados.task,
            model: modeloParaTrilha(model),
            model_version: model.version,
            ...(dados.patientId ? { patient_id: dados.patientId } : {}),
            ...(dados.professionalId ? { professional_id: dados.professionalId } : {}),
            prompt_hash: sha256(`${dados.system}\0${dados.input}`),
            output_hash: utilizavel && response ? sha256(response.text) : null,
            input_tokens: response?.usage.inputTokens ?? null,
            cached_input_tokens: response?.usage.cachedInputTokens ?? null,
            output_tokens: response?.usage.outputTokens ?? null,
            latency_ms: latencyMs,
            human_reviewed: false,
            decision: utilizavel ? 'pendente' : 'nao_aplicavel',
          },
        });
        return response ? { response, auditId: useId, generatedAt: this.clock().toISOString(), latencyMs } : null;
      });
    } catch (error) {
      if (error instanceof ProibidoError || error instanceof FalhaAuditoriaIaError) throw error;
      throw new FalhaAuditoriaIaError({ cause: error });
    }
    // Só agora, depois do COMMIT da tentativa falha, o gateway pode aplicar fallback.
    if (falhouProvedor) throw erroProvedor;
    if (!resultado) throw new FalhaAuditoriaIaError({ cause: new Error('provedor sem resposta') });
    return resultado;
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

  /** Revisão é outro evento, nunca UPDATE da geração: a trilha permanece append-only e encadeada. */
  async registrarRevisao(ctx: RequestContext, input: RevisaoIaInput): Promise<void> {
    if (ctx.userId === SYSTEM_ACTOR_ID || !ctx.roles.includes('profissional')) {
      throw new ProibidoError('revisao_exige_profissional');
    }
    if (!DECISOES_IA.includes(input.decisao)) throw new RegraNaoAtendidaError('decisao_invalida', ['decisao']);
    if (input.decisao === 'editada' && !input.textoFinal?.trim()) {
      throw new RegraNaoAtendidaError('texto_final_obrigatorio', ['textoFinal']);
    }
    await escreverNaClinica(this.db, ctx, async (tx) => {
      await recordAudit(tx, ctx, {
        action: AuditAction.AiUse,
        scope: SCOPE_IA_REVISAO,
        metadata: {
          use_id: input.useId,
          task: input.task,
          ...(input.patientId ? { patient_id: input.patientId } : {}),
          ...(input.professionalId ? { professional_id: input.professionalId } : {}),
          reviewer_id: ctx.userId,
          human_reviewed: true,
          decision: input.decisao,
          ...(input.decisao === 'editada' && input.textoFinal ? { final_output_hash: sha256(input.textoFinal) } : {}),
        },
      });
    });
  }
}

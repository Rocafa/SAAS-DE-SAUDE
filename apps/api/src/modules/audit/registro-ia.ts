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

/**
 * Só o que o revisor decide. Tarefa, paciente e profissional NÃO vêm daqui: são herdados da linha
 * `ai_generation` do mesmo `useId` na clínica (veto do Guardião no #227, bloqueante 2).
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

/**
 * Tokens opcionais dos relógios: em produção nenhum provider os registra e valem os defaults;
 * testes podem instanciar a classe direto ou registrar `{ provide: RELOGIO_IA, useValue }`.
 * Sem token, o Nest tentaria resolver o tipo `Function` do parâmetro e o boot falharia.
 */
export const RELOGIO_IA = Symbol('RELOGIO_IA');
export const RELOGIO_MONOTONICO_IA = Symbol('RELOGIO_MONOTONICO_IA');

/**
 * Verdadeiro enquanto `chamar` envia ao modelo dentro da transação da trilha (item 3 do veto do
 * Guardião no #227). Só vira `false` no PR que separar os eventos "tentativa" e "resultado".
 */
export const CHAMADA_IA_DENTRO_DA_TRANSACAO = true;

/**
 * TRAVA de boot: com a chamada dentro da transação, provedor real não pode ser ligado. Uma falha do
 * KMS no MAC da saída, depois do envio, deixaria texto enviado sem linha na trilha (e a conexão fica
 * presa durante a chamada). `AI_PROVIDER` ausente ou `fake` passa; qualquer outro valor derruba o boot.
 */
export function assertTravaDaChamadaIa(
  env: NodeJS.ProcessEnv = process.env,
  dentroDaTransacao: boolean = CHAMADA_IA_DENTRO_DA_TRANSACAO,
): void {
  const id = env.AI_PROVIDER?.trim();
  if (dentroDaTransacao && id && id !== 'fake') {
    throw new Error(
      `AI_PROVIDER="${id}" bloqueado: a chamada ao modelo ainda roda dentro da transação da trilha de IA ` +
        '(item 3 do veto do Guardião no #227). Separe os eventos tentativa/resultado antes de ligar provedor real.',
    );
  }
}

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
   * mesmo texto entre clínicas. A linha grava `hash_key_id` para saber com que chave conferir.
   */
  private async mac(ctx: RequestContext, uso: UsoDoMac, conteudo: string): Promise<MacDeConteudo> {
    try {
      return await this.signer.macDeConteudo(ctx.tenantId, uso, conteudo);
    } catch (error) {
      throw new FalhaAuditoriaIaError({ cause: error });
    }
  }

  /**
   * Uma tentativa de provedor e sua linha de trilha vivem na MESMA transação. Erro do provedor é
   * capturado só para permitir o COMMIT da linha e relançado depois; erro da trilha/commit aborta
   * sem entregar rascunho. Nenhum texto clínico entra no log: somente HMACs, ids e contagens.
   */
  async chamar(
    ctx: RequestContext,
    dados: DadosChamadaIa,
    executar: () => Promise<LlmResponse>,
  ): Promise<ResultadoChamadaIa> {
    // Item 3 do veto do Guardião no #227: a chamada ao modelo ainda roda DENTRO desta transação.
    // Por isso a TRAVA `assertTravaDaChamadaIa` impede a API de subir com provedor real. Com o desenho
    // atual, uma falha do KMS no MAC da saída (abaixo), DEPOIS do envio, aborta a transação: o texto
    // já saiu para o provedor e nenhuma linha fica gravada. Para tirar a trava, separar "tentativa"
    // (gravada, com assertCanWrite, ANTES do envio) e "resultado" em outra transação.
    // MAC do prompt antes do provedor: se a chave falhar, nada é enviado.
    const promptMac = await this.mac(ctx, 'ia_prompt', `${dados.system}\0${dados.input}`);
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
        const saidaMac = utilizavel && response ? await this.mac(ctx, 'ia_saida', response.text) : null;
        if (saidaMac && saidaMac.chave !== promptMac.chave) {
          throw new FalhaAuditoriaIaError({ cause: new Error('chave do MAC mudou no meio da chamada') });
        }
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
            prompt_hash: promptMac.mac,
            output_hash: saidaMac?.mac ?? null,
            hash_key_id: promptMac.chave,
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

  /**
   * Revisão é outro evento, nunca UPDATE da geração: a trilha permanece append-only e encadeada.
   * A geração é lida por `useId` NA CLÍNICA DA SESSÃO (RLS + filtro de tenant), na mesma transação
   * da gravação; dela vêm tarefa, paciente e profissional. Só o profissional responsável revisa, só
   * uma vez, e só uso que gerou rascunho (`pendente`). Uso inexistente e de outra clínica dão o
   * mesmo 404, sem revelar se existe.
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
            inArray(auditLog.scope, [SCOPE_IA_GERACAO, SCOPE_IA_REVISAO]),
            sql`${auditLog.metadata}->>'use_id' = ${useId}`,
          ),
        );
      // Confere de novo em memória (defesa em profundidade se o filtro do banco mudar).
      const doUso = linhas.filter(
        (l) => l.tenantId === ctx.tenantId && textoDaMetadata(l.metadata as Record<string, unknown>, 'use_id') === useId,
      );
      const geracao = doUso.find((l) => l.scope === SCOPE_IA_GERACAO);
      if (!geracao) throw new NaoEncontradoError();
      const m = geracao.metadata as Record<string, unknown>;
      const responsavel = textoDaMetadata(m, 'professional_id') ?? geracao.actorId;
      if (responsavel === SYSTEM_ACTOR_ID || responsavel !== ctx.userId) throw new ProibidoError('revisor_nao_responsavel');
      if (m['decision'] !== 'pendente') throw new ConflitoError('uso_sem_rascunho_para_revisar');
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

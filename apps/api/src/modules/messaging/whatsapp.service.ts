import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId, type UserId } from '@plataforma/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notExists, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  appointments,
  patients,
  whatsappInbound,
  whatsappOptIns,
  whatsappOutbox,
  whatsappSettings,
  whatsappTemplates,
  type WhatsappOutboxStatus,
  type WhatsappOutcome,
} from '../../db/schema';
import type { DatabaseHandle, TenantTx } from '../../db/tenant-transaction';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import { menorDeIdadeEm } from '../finance/financeiro-regras';
import { patientFieldRef } from '../patients/patient-fields';
import { janelaDeDias, noFusoDaClinica } from '../scheduling/agenda-regras';
import { SchedulingService } from '../scheduling/scheduling.service';
import { DATABASE_HANDLE, TenantDatabase } from '../tenancy/tenancy.module';
import {
  codigoDeFalha,
  corpoDeModeloValido,
  dentroDoHorarioDeEnvio,
  interpretarResposta,
  lembreteDevido,
  MAX_RESPOSTAS_POR_ENVIO,
  MAX_TENTATIVAS,
  mesmoTelefone,
  MODELO_PADRAO,
  renderizarLembrete,
  respostaNaJanela,
  telefoneParaWhatsapp,
  ANTECEDENCIA_MINIMA_H,
} from './lembretes-regras';
import type { EventoDeResposta, EventoDeStatus, EventoDoWebhook, MensageiroWhatsApp } from './mensageiro-whatsapp';
import { FONTE_DE_RESPONSAVEIS, type FonteDeResponsaveis } from './responsaveis.port';
import {
  CAMPO_EVIDENCIA,
  CAMPO_TELEFONE_ENVIO,
  CAMPO_TELEFONE_RESPOSTA,
  CAMPO_TEXTO_ENVIO,
  CAMPO_TEXTO_RESPOSTA,
  campoWhatsappRef,
  type CampoWhatsapp,
} from './whatsapp-fields';
import type { ConfiguracaoWhatsapp, FiltroEnvios, NovoModelo, NovoOptIn } from './whatsapp.validation';

export const MENSAGEIRO_WHATSAPP = Symbol('MENSAGEIRO_WHATSAPP');

const HORA_MS = 3_600_000;
/** Teto por execução (o job roda de novo a cada poucos minutos). */
const LOTE = 200;

export interface ConfiguracaoDto {
  readonly ativo: boolean;
  readonly nomeRemetente: string | null;
  readonly numeroDeNegocio: string | null;
  readonly horasAntes: number;
  readonly enviarDe: number;
  readonly enviarAte: number;
  readonly janelaRespostaHoras: number;
  /** Canal do servidor (WHATSAPP_PROVEDOR); `null` = desligado na plataforma. */
  readonly provedor: 'falso' | 'cloud_api' | null;
}

export interface ResultadoDosLembretes {
  readonly motivo: 'ok' | 'canal_desligado' | 'fora_do_horario';
  readonly programados: number;
  readonly semOptIn: number;
  readonly semDestinatario: number;
  readonly enviados: number;
  readonly falharam: number;
  readonly cancelados: number;
}

const ZERO: Omit<ResultadoDosLembretes, 'motivo'> = { programados: 0, semOptIn: 0, semDestinatario: 0, enviados: 0, falharam: 0, cancelados: 0 };

const RANK: Readonly<Record<WhatsappOutboxStatus, number>> = { agendado: 0, enviando: 1, enviado: 2, entregue: 3, lido: 4, falhou: 9, cancelado: 9 };

/** Contexto do sistema (job e webhook): sem usuário; a trilha grava `actor_kind = sistema`. */
function ctxDoSistema(tenantId: TenantId): RequestContext {
  return { tenantId, userId: SYSTEM_ACTOR_ID as UserId, roles: ['sistema'] };
}

/**
 * Lembretes e confirmação por WhatsApp (rodada 18.3). Garantias:
 * - nada sai sem opt-in VIGENTE do destinatário (conferido aqui e pelo banco no INSERT da fila);
 * - o texto é o modelo neutro renderizado só com nome neutro, data e hora (sem profissional, especialidade
 *   ou tipo de atendimento);
 * - paciente menor recebe pelo responsável (porta FonteDeResponsaveis); sem responsável, não sai;
 * - fora do horário configurado, nada sai;
 * - "1"/"2" mudam SÓ a consulta daquele envio, pelas regras da agenda, dentro da janela;
 * - trilha só com ids, contagens e códigos (nunca número, texto ou nome).
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger('whatsapp');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(SchedulingService) private readonly agenda: SchedulingService,
    @Inject(FONTE_DE_RESPONSAVEIS) private readonly responsaveis: FonteDeResponsaveis,
    @Inject(MENSAGEIRO_WHATSAPP) private readonly mensageiro: MensageiroWhatsApp | null,
  ) {}

  get canalLigado(): boolean {
    return this.mensageiro !== null;
  }

  get adaptador(): MensageiroWhatsApp | null {
    return this.mensageiro;
  }

  // -------------------------------------------------------------------------------------------------
  // Configuração e modelos
  // -------------------------------------------------------------------------------------------------

  obterConfiguracao(ctx: RequestContext): Promise<ConfiguracaoDto> {
    return lerNaClinica(this.db, ctx, async (tx) => this.paraConfiguracaoDto(await this.configuracao(tx, ctx.tenantId)));
  }

  salvarConfiguracao(ctx: RequestContext, dados: ConfiguracaoWhatsapp): Promise<ConfiguracaoDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.configuracao(tx, ctx.tenantId);
      const nova = {
        enabled: dados.ativo ?? atual.enabled,
        senderName: dados.nomeRemetente !== undefined ? dados.nomeRemetente : atual.senderName,
        businessNumberId: dados.numeroDeNegocio !== undefined ? dados.numeroDeNegocio : atual.businessNumberId,
        reminderHoursBefore: dados.horasAntes ?? atual.reminderHoursBefore,
        sendFromHour: dados.enviarDe ?? atual.sendFromHour,
        sendUntilHour: dados.enviarAte ?? atual.sendUntilHour,
        replyWindowHours: dados.janelaRespostaHoras ?? atual.replyWindowHours,
      };
      if (nova.sendUntilHour <= nova.sendFromHour) throw new ConflitoError('horario_de_envio_invalido');
      if (nova.enabled && (!nova.senderName || !nova.businessNumberId)) throw new ConflitoError('configuracao_incompleta');
      const [dono] = nova.businessNumberId
        ? await this.handle.db.execute<{ t: string | null }>(sql`select app_whatsapp_tenant_for_number(${nova.businessNumberId}) as t`)
        : [];
      if (dono?.t && dono.t !== ctx.tenantId) throw new ConflitoError('numero_ja_registrado');
      await tx
        .insert(whatsappSettings)
        .values({ tenantId: ctx.tenantId, ...nova, updatedBy: ctx.userId })
        .onConflictDoUpdate({ target: whatsappSettings.tenantId, set: { ...nova, updatedBy: ctx.userId } });
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'whatsapp_settings',
        metadata: { enabled: nova.enabled, has_sender: nova.senderName !== null, has_number: nova.businessNumberId !== null, hours_before: nova.reminderHoursBefore },
      });
      return this.paraConfiguracaoDto({ ...atual, ...nova });
    });
  }

  listarModelos(ctx: RequestContext): Promise<{ vigente: { id: string | null; texto: string; padrao: boolean }; retirados: number }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const vivo = await this.modeloVigente(tx, ctx.tenantId);
      const [r] = await tx
        .select({ n: count() })
        .from(whatsappTemplates)
        .where(and(eq(whatsappTemplates.tenantId, ctx.tenantId), isNotNull(whatsappTemplates.retiredAt)));
      return { vigente: vivo ? { id: vivo.id, texto: vivo.body, padrao: false } : { id: null, texto: MODELO_PADRAO.corpo, padrao: true }, retirados: r?.n ?? 0 };
    });
  }

  /** Novo modelo substitui o vigente (o anterior é retirado na mesma transação). */
  criarModelo(ctx: RequestContext, dados: NovoModelo): Promise<{ id: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      if (!corpoDeModeloValido(dados.texto)) throw new ConflitoError('modelo_nao_neutro');
      const vivo = await this.modeloVigente(tx, ctx.tenantId);
      if (vivo) {
        await tx.update(whatsappTemplates).set({ retiredAt: new Date(), retiredBy: ctx.userId }).where(and(eq(whatsappTemplates.tenantId, ctx.tenantId), eq(whatsappTemplates.id, vivo.id)));
      }
      const [t] = await tx
        .insert(whatsappTemplates)
        .values({ tenantId: ctx.tenantId, body: dados.texto, providerTemplateName: dados.nomeNoProvedor, createdBy: ctx.userId })
        .returning({ id: whatsappTemplates.id });
      if (!t) throw new Error('falha ao criar modelo');
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'whatsapp_templates', metadata: { template_id: t.id, replaced: vivo?.id ?? null } });
      return { id: t.id };
    });
  }

  retirarModelo(ctx: RequestContext, id: string): Promise<{ padrao: true }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const r = await tx
        .update(whatsappTemplates)
        .set({ retiredAt: new Date(), retiredBy: ctx.userId })
        .where(and(eq(whatsappTemplates.tenantId, ctx.tenantId), eq(whatsappTemplates.id, id), isNull(whatsappTemplates.retiredAt)))
        .returning({ id: whatsappTemplates.id });
      if (r.length === 0) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'whatsapp_templates', metadata: { template_id: id, op: 'retire' } });
      return { padrao: true };
    });
  }

  // -------------------------------------------------------------------------------------------------
  // Opt-in
  // -------------------------------------------------------------------------------------------------

  obterOptIn(ctx: RequestContext, pacienteId: string) {
    return lerNaClinica(this.db, ctx, async (tx) => {
      await this.pacienteDaClinica(tx, ctx, pacienteId);
      const linhas = await tx
        .select()
        .from(whatsappOptIns)
        .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.patientId, pacienteId)))
        .orderBy(desc(whatsappOptIns.grantedAt), desc(whatsappOptIns.id));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'whatsapp_opt_ins', metadata: { patient_id: pacienteId, count: linhas.length } });
      const dto = (o: (typeof linhas)[number]) => ({
        id: o.id,
        destinatario: o.recipientKind,
        responsavelId: o.guardianId,
        meio: o.method,
        temComprovante: o.evidenceEnc !== null,
        registradoEm: o.grantedAt.toISOString(),
        registradoPor: o.grantedBy,
        revogadoEm: o.revokedAt?.toISOString() ?? null,
        meioDaRevogacao: o.revokeMethod,
      });
      const vigente = linhas.find((o) => o.revokedAt === null);
      return { vigente: vigente ? dto(vigente) : null, historico: linhas.map(dto) };
    });
  }

  /** Registra o opt-in com a prova; havendo um vigente, ele é revogado (`troca_de_destinatario`) antes. */
  registrarOptIn(ctx: RequestContext, pacienteId: string, dados: NovoOptIn): Promise<{ id: string; substituiu: string | null }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.pacienteDaClinica(tx, ctx, pacienteId, true);
      if (dados.destinatario === 'responsavel') {
        const r = await this.responsaveis.responsavelVigente(tx, ctx.tenantId, pacienteId, dados.responsavelId ?? '');
        if (!r) throw new ConflitoError('responsavel_nao_vinculado');
        if (!telefoneParaWhatsapp(r.telefone)) throw new ConflitoError('responsavel_sem_telefone');
      }
      const anterior = await this.optInVigente(tx, ctx.tenantId, pacienteId, true);
      if (anterior) {
        await tx
          .update(whatsappOptIns)
          .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeMethod: 'troca_de_destinatario' })
          .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.id, anterior.id)));
        await this.cancelarPendentes(tx, ctx, anterior.id);
      }
      const id = randomUUID();
      await tx.insert(whatsappOptIns).values({
        id,
        tenantId: ctx.tenantId,
        patientId: pacienteId,
        recipientKind: dados.destinatario,
        guardianId: dados.destinatario === 'responsavel' ? (dados.responsavelId ?? null) : null,
        method: dados.meio,
        evidenceEnc: dados.comprovante ? await this.cifrar(tx, ctx, id, CAMPO_EVIDENCIA, dados.comprovante) : null,
        grantedBy: ctx.userId,
      });
      await recordAudit(tx, ctx, {
        action: AuditAction.ConsentChange,
        scope: 'whatsapp_opt_ins',
        metadata: { op: 'grant', opt_in_id: id, patient_id: pacienteId, recipient: dados.destinatario, method: dados.meio, replaced: anterior?.id ?? null },
      });
      return { id, substituiu: anterior?.id ?? null };
    });
  }

  revogarOptIn(ctx: RequestContext, pacienteId: string, meio: 'pedido_na_recepcao' | 'portal_do_paciente'): Promise<{ id: string; enviosCancelados: number }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.pacienteDaClinica(tx, ctx, pacienteId);
      const vivo = await this.optInVigente(tx, ctx.tenantId, pacienteId, true);
      if (!vivo) throw new NaoEncontradoError();
      await tx
        .update(whatsappOptIns)
        .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeMethod: meio })
        .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.id, vivo.id)));
      const cancelados = await this.cancelarPendentes(tx, ctx, vivo.id);
      await recordAudit(tx, ctx, {
        action: AuditAction.ConsentChange,
        scope: 'whatsapp_opt_ins',
        metadata: { op: 'revoke', opt_in_id: vivo.id, patient_id: pacienteId, method: meio, outbox_cancelled: cancelados },
      });
      return { id: vivo.id, enviosCancelados: cancelados };
    });
  }

  // -------------------------------------------------------------------------------------------------
  // Fila (consulta da recepção: status e fallback; sem número nem texto)
  // -------------------------------------------------------------------------------------------------

  listarEnvios(ctx: RequestContext, filtro: FiltroEnvios) {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const { inicio, fim } = janelaDeDias(filtro.de, filtro.ate);
      const condicoes = [eq(whatsappOutbox.tenantId, ctx.tenantId), gte(whatsappOutbox.createdAt, inicio), lt(whatsappOutbox.createdAt, fim)];
      if (filtro.situacao === 'falhou') condicoes.push(eq(whatsappOutbox.needsFallback, true));
      const linhas = await tx
        .select({
          id: whatsappOutbox.id,
          agendamentoId: whatsappOutbox.appointmentId,
          pacienteId: whatsappOutbox.patientId,
          destinatario: whatsappOutbox.recipientKind,
          status: whatsappOutbox.status,
          tentativas: whatsappOutbox.attempts,
          enviadoEm: whatsappOutbox.sentAt,
          entregueEm: whatsappOutbox.deliveredAt,
          lidoEm: whatsappOutbox.readAt,
          falhouEm: whatsappOutbox.failedAt,
          codigoFalha: whatsappOutbox.failureCode,
          precisaFallback: whatsappOutbox.needsFallback,
          resposta: sql<WhatsappOutcome | null>`(select i.outcome from whatsapp_inbound i where i.tenant_id = ${whatsappOutbox.tenantId} and i.outbox_id = ${whatsappOutbox.id} order by i.received_at desc limit 1)`,
        })
        .from(whatsappOutbox)
        .where(and(...condicoes))
        .orderBy(asc(whatsappOutbox.createdAt), asc(whatsappOutbox.id))
        .limit(1001);
      const truncado = linhas.length > 1000;
      const itens = linhas.slice(0, 1000).map((l) => ({
        ...l,
        enviadoEm: l.enviadoEm?.toISOString() ?? null,
        entregueEm: l.entregueEm?.toISOString() ?? null,
        lidoEm: l.lidoEm?.toISOString() ?? null,
        falhouEm: l.falhouEm?.toISOString() ?? null,
      }));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'whatsapp_outbox', metadata: { count: itens.length, only_failed: filtro.situacao === 'falhou' } });
      return { itens, truncado };
    });
  }

  // -------------------------------------------------------------------------------------------------
  // Lembretes (job)
  // -------------------------------------------------------------------------------------------------

  /** Job do sistema, por clínica (sem usuário: a trilha grava `sistema`). */
  executarLembretesComoSistema(tenantId: TenantId, agora: Date = new Date()): Promise<ResultadoDosLembretes> {
    return this.executarLembretes(ctxDoSistema(tenantId), agora, true);
  }

  /**
   * Programa os lembretes devidos e despacha a fila. `agora` existe para o teste fixar o relógio da
   * REGRA (janela D-1 e horário de envio); os carimbos gravados vêm sempre do relógio do banco.
   */
  async executarLembretes(ctx: RequestContext, agora: Date = new Date(), sistema = false): Promise<ResultadoDosLembretes> {
    if (!this.mensageiro) return { motivo: 'canal_desligado', ...ZERO };
    const run = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => (sistema ? this.db.run(ctx.tenantId, fn) : escreverNaClinica(this.db, ctx, fn));
    const programacao = await run((tx) => this.programar(tx, ctx, agora));
    if (programacao.motivo !== 'ok') return { ...ZERO, ...programacao };
    const despacho = await this.despachar(ctx, run);
    return { ...programacao, ...despacho, motivo: 'ok' };
  }

  private async programar(
    tx: TenantTx,
    ctx: RequestContext,
    agora: Date,
  ): Promise<Pick<ResultadoDosLembretes, 'motivo' | 'programados' | 'semOptIn' | 'semDestinatario'>> {
    const cfg = await this.configuracao(tx, ctx.tenantId);
    if (!cfg.enabled || !cfg.senderName || !cfg.businessNumberId) return { motivo: 'canal_desligado', programados: 0, semOptIn: 0, semDestinatario: 0 };
    if (!dentroDoHorarioDeEnvio(agora, cfg.sendFromHour, cfg.sendUntilHour)) return { motivo: 'fora_do_horario', programados: 0, semOptIn: 0, semDestinatario: 0 };
    const devidos = await tx
      .select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, ctx.tenantId),
          eq(appointments.status, 'scheduled'),
          gt(appointments.startsAt, new Date(agora.getTime() + ANTECEDENCIA_MINIMA_H * HORA_MS)),
          lte(appointments.startsAt, new Date(agora.getTime() + cfg.reminderHoursBefore * HORA_MS)),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(whatsappOutbox)
              .where(
                and(
                  eq(whatsappOutbox.tenantId, appointments.tenantId),
                  eq(whatsappOutbox.appointmentId, appointments.id),
                  eq(whatsappOutbox.appointmentStartsAt, appointments.startsAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(appointments.startsAt), asc(appointments.id))
      .limit(LOTE);
    const modelo = await this.modeloVigente(tx, ctx.tenantId);
    let programados = 0;
    let semOptIn = 0;
    let semDestinatario = 0;
    for (const a of devidos) {
      if (!lembreteDevido(a.startsAt, agora, cfg.reminderHoursBefore)) continue;
      const optIn = await this.optInVigente(tx, ctx.tenantId, a.patientId, false);
      if (!optIn) {
        semOptIn++;
        continue;
      }
      const telefone = await this.telefoneDoDestinatario(tx, ctx.tenantId, a.patientId, optIn, agora);
      if (!telefone) {
        semDestinatario++;
        continue;
      }
      const { texto } = renderizarLembrete(modelo?.body ?? MODELO_PADRAO.corpo, cfg.senderName, a.startsAt);
      const id = randomUUID();
      const inseridos = await tx
        .insert(whatsappOutbox)
        .values({
          id,
          tenantId: ctx.tenantId,
          appointmentId: a.id,
          appointmentStartsAt: a.startsAt,
          patientId: a.patientId,
          optInId: optIn.id,
          templateId: modelo?.id ?? null,
          recipientKind: optIn.recipientKind,
          guardianId: optIn.guardianId,
          recipientPhoneEnc: await this.cifrar(tx, ctx, id, CAMPO_TELEFONE_ENVIO, telefone),
          bodyEnc: await this.cifrar(tx, ctx, id, CAMPO_TEXTO_ENVIO, texto),
          createdBy: ctx.userId === SYSTEM_ACTOR_ID ? null : ctx.userId,
        })
        .onConflictDoNothing()
        .returning({ id: whatsappOutbox.id });
      programados += inseridos.length;
    }
    await recordAudit(tx, ctx, {
      action: AuditAction.Create,
      scope: 'whatsapp_outbox',
      metadata: { op: 'schedule', count: programados, skipped_no_opt_in: semOptIn, skipped_no_recipient: semDestinatario },
    });
    return { motivo: 'ok', programados, semOptIn, semDestinatario };
  }

  /**
   * Despacho em três passos, para nunca segurar transação durante a chamada de rede e nunca mandar duas
   * vezes: (1) reserva (agendado -> enviando, conferindo de novo opt-in e consulta); (2) chama o
   * provedor fora da transação; (3) grava o resultado. Linha que ficar em "enviando" por queda do
   * processo não é reenviada (no máximo uma vez).
   */
  private async despachar(
    ctx: RequestContext,
    run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  ): Promise<Pick<ResultadoDosLembretes, 'enviados' | 'falharam' | 'cancelados'>> {
    const mensageiro = this.mensageiro;
    if (!mensageiro) return { enviados: 0, falharam: 0, cancelados: 0 };
    const reservados = await run(async (tx) => {
      const cfg = await this.configuracao(tx, ctx.tenantId);
      const fila = await tx
        .select()
        .from(whatsappOutbox)
        .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.status, 'agendado')))
        .orderBy(asc(whatsappOutbox.createdAt))
        .limit(LOTE)
        .for('update', { skipLocked: true });
      const prontos: { id: string; para: string; texto: string; parametros: string[]; modelo: string }[] = [];
      let cancelados = 0;
      for (const e of fila) {
        const [ag] = await tx
          .select({ status: appointments.status, startsAt: appointments.startsAt })
          .from(appointments)
          .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, e.appointmentId)));
        const [opt] = await tx
          .select({ vivo: isNull(whatsappOptIns.revokedAt) })
          .from(whatsappOptIns)
          .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.id, e.optInId)));
        const valido =
          cfg.enabled && cfg.senderName && cfg.businessNumberId && opt?.vivo && ag && ag.status === 'scheduled' && ag.startsAt.getTime() === e.appointmentStartsAt.getTime();
        if (!valido || !e.recipientPhoneEnc || !e.bodyEnc || !cfg.senderName) {
          await tx.update(whatsappOutbox).set({ status: 'cancelado' }).where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, e.id)));
          cancelados++;
          continue;
        }
        await tx.update(whatsappOutbox).set({ status: 'enviando' }).where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, e.id)));
        const modelo = e.templateId ? await this.modeloPorId(tx, ctx.tenantId, e.templateId) : null;
        const { parametros } = renderizarLembrete(modelo?.body ?? MODELO_PADRAO.corpo, cfg.senderName, e.appointmentStartsAt);
        prontos.push({
          id: e.id,
          para: await this.decifrar(tx, ctx.tenantId, e.id, CAMPO_TELEFONE_ENVIO, e.recipientPhoneEnc),
          texto: await this.decifrar(tx, ctx.tenantId, e.id, CAMPO_TEXTO_ENVIO, e.bodyEnc),
          parametros,
          modelo: modelo?.providerTemplateName ?? MODELO_PADRAO.nomeNoProvedor,
        });
      }
      return { prontos, cancelados, remetente: cfg.businessNumberId ?? '' };
    });

    const resultados = [];
    for (const p of reservados.prontos) {
      const r = await mensageiro.enviar({
        para: p.para,
        remetente: reservados.remetente,
        modelo: { nomeNoProvedor: p.modelo, idioma: 'pt_BR', parametros: p.parametros },
        texto: p.texto,
        idempotencia: p.id,
      });
      resultados.push({ id: p.id, r });
    }

    return run(async (tx) => {
      let enviados = 0;
      let falharam = 0;
      for (const { id, r } of resultados) {
        const [e] = await tx
          .select({ attempts: whatsappOutbox.attempts })
          .from(whatsappOutbox)
          .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, id)));
        if (r.ok) {
          await tx
            .update(whatsappOutbox)
            .set({ status: 'enviado', providerMessageId: r.idProvedor })
            .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, id)));
          enviados++;
        } else if (r.definitivo || (e?.attempts ?? MAX_TENTATIVAS) >= MAX_TENTATIVAS) {
          await tx
            .update(whatsappOutbox)
            .set({ status: 'falhou', failureCode: codigoDeFalha(r.codigo) })
            .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, id)));
          falharam++;
          this.logger.warn('WHATSAPP_ENVIO_FALHOU fallback=fila_da_recepcao');
        } else {
          await tx.update(whatsappOutbox).set({ status: 'agendado' }).where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, id)));
        }
      }
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'whatsapp_outbox',
        metadata: { op: 'dispatch', sent: enviados, failed: falharam, cancelled: reservados.cancelados, retry: resultados.length - enviados - falharam },
      });
      return { enviados, falharam, cancelados: reservados.cancelados };
    });
  }

  // -------------------------------------------------------------------------------------------------
  // Webhook (sem sessão: chega da Meta; a clínica sai do número de negócio)
  // -------------------------------------------------------------------------------------------------

  /** Processa eventos JÁ autenticados (assinatura conferida no controller). Um evento por transação. */
  async processarEventos(eventos: readonly EventoDoWebhook[], agora: Date = new Date()): Promise<{ processados: number; ignorados: number }> {
    let processados = 0;
    let ignorados = 0;
    const clinicas = new Map<string, TenantId | null>();
    for (const ev of eventos) {
      if (!clinicas.has(ev.numeroDaClinica)) {
        const [r] = await this.handle.db.execute<{ t: string | null }>(sql`select app_whatsapp_tenant_for_number(${ev.numeroDaClinica}) as t`);
        clinicas.set(ev.numeroDaClinica, (r?.t ?? null) as TenantId | null);
      }
      const tenantId = clinicas.get(ev.numeroDaClinica);
      if (!tenantId) {
        ignorados++;
        continue;
      }
      const ok = await this.db.run(tenantId, async (tx) => {
        const cfg = await this.configuracao(tx, tenantId);
        if (!cfg.enabled) return false;
        const ctx = ctxDoSistema(tenantId);
        return ev.tipo === 'status' ? this.aplicarStatus(tx, ctx, ev) : this.aplicarResposta(tx, ctx, ev, cfg.replyWindowHours, agora);
      });
      if (ok) processados++;
      else ignorados++;
    }
    return { processados, ignorados };
  }

  private async aplicarStatus(tx: TenantTx, ctx: RequestContext, ev: EventoDeStatus): Promise<boolean> {
    const [e] = await tx
      .select({ id: whatsappOutbox.id, status: whatsappOutbox.status })
      .from(whatsappOutbox)
      .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.providerMessageId, ev.idProvedor)))
      .for('update');
    if (!e) return false;
    const para: WhatsappOutboxStatus | null = ev.status === 'delivered' ? 'entregue' : ev.status === 'read' ? 'lido' : ev.status === 'failed' ? 'falhou' : null;
    // Idempotente e só para a frente: reentrega, evento fora de ordem e "sent" (já gravado) não mudam nada.
    if (!para) return false;
    const pode = para === 'falhou' ? e.status === 'enviado' || e.status === 'entregue' : RANK[para] > RANK[e.status] && RANK[e.status] >= RANK.enviado;
    if (!pode) return false;
    await tx
      .update(whatsappOutbox)
      .set({ status: para, ...(para === 'falhou' ? { failureCode: codigoDeFalha(ev.codigoErro ?? 'provedor') } : {}) })
      .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, e.id)));
    await recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'whatsapp_outbox', metadata: { op: 'status', outbox_id: e.id, from: e.status, to: para } });
    return true;
  }

  private async aplicarResposta(tx: TenantTx, ctx: RequestContext, ev: EventoDeResposta, janelaHoras: number, agora: Date): Promise<boolean> {
    // Idempotência: a Meta reentrega o mesmo id.
    const [ja] = await tx
      .select({ id: whatsappInbound.id })
      .from(whatsappInbound)
      .where(and(eq(whatsappInbound.tenantId, ctx.tenantId), eq(whatsappInbound.providerMessageId, ev.idProvedor)));
    if (ja) return false;
    const envio = await this.envioDaResposta(tx, ctx.tenantId, ev, janelaHoras, agora);
    // Mensagem que não responde a envio nosso não é guardada (minimização; o inbox é outra microparte).
    if (!envio) {
      this.logger.log('WHATSAPP_RESPOSTA_SEM_ENVIO');
      return false;
    }
    const [n] = await tx
      .select({ n: count() })
      .from(whatsappInbound)
      .where(and(eq(whatsappInbound.tenantId, ctx.tenantId), eq(whatsappInbound.outboxId, envio.id)));
    if ((n?.n ?? 0) >= MAX_RESPOSTAS_POR_ENVIO) {
      this.logger.warn('WHATSAPP_LIMITE_DE_RESPOSTAS');
      return false;
    }
    const interpretacao = interpretarResposta(ev.texto);
    let resultado: WhatsappOutcome = 'sem_acao';
    if (interpretacao === 'sair') {
      const r = await tx
        .update(whatsappOptIns)
        .set({ revokedAt: new Date(), revokedBy: null, revokeMethod: 'resposta_sair' })
        .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.id, envio.optInId), isNull(whatsappOptIns.revokedAt)))
        .returning({ id: whatsappOptIns.id });
      const cancelados = await this.cancelarPendentes(tx, ctx, envio.optInId);
      if (r.length > 0) {
        await recordAudit(tx, ctx, {
          action: AuditAction.ConsentChange,
          scope: 'whatsapp_opt_ins',
          metadata: { op: 'revoke', opt_in_id: envio.optInId, patient_id: envio.patientId, method: 'resposta_sair', outbox_cancelled: cancelados },
        });
      }
      resultado = 'opt_out';
    } else if (interpretacao === 'confirmar' || interpretacao === 'cancelar') {
      const [ag] = await tx
        .select({ startsAt: appointments.startsAt })
        .from(appointments)
        .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, envio.appointmentId)));
      if (!respostaNaJanela(envio.sentAt, envio.appointmentStartsAt, agora, janelaHoras)) resultado = 'fora_da_janela';
      else if (!ag || ag.startsAt.getTime() !== envio.appointmentStartsAt.getTime()) resultado = 'consulta_alterada';
      // A consulta DESTE envio, e só ela, pelas regras da agenda (nunca pela transição genérica).
      else resultado = await this.agenda.respostaDoPaciente(tx, ctx, envio.appointmentId, interpretacao, agora);
    }
    const id = randomUUID();
    await tx.insert(whatsappInbound).values({
      id,
      tenantId: ctx.tenantId,
      providerMessageId: ev.idProvedor,
      outboxId: envio.id,
      senderPhoneEnc: await this.cifrar(tx, ctx, id, CAMPO_TELEFONE_RESPOSTA, ev.de),
      bodyEnc: ev.texto ? await this.cifrar(tx, ctx, id, CAMPO_TEXTO_RESPOSTA, ev.texto) : null,
      interpretation: interpretacao,
      outcome: resultado,
    });
    await recordAudit(tx, ctx, {
      action: AuditAction.Create,
      scope: 'whatsapp_inbound',
      metadata: { inbound_id: id, outbox_id: envio.id, appointment_id: envio.appointmentId, interpretation: interpretacao, outcome: resultado },
    });
    return true;
  }

  /**
   * Envio a que a resposta se refere: pelo id da nossa mensagem (context.id), quando o aplicativo manda;
   * senão, o envio MAIS RECENTE ao mesmo número dentro da janela de resposta.
   */
  private async envioDaResposta(tx: TenantTx, tenantId: TenantId, ev: EventoDeResposta, janelaHoras: number, agora: Date) {
    const ESTADOS: WhatsappOutboxStatus[] = ['enviado', 'entregue', 'lido'];
    if (ev.emRespostaA) {
      const [e] = await tx
        .select()
        .from(whatsappOutbox)
        .where(and(eq(whatsappOutbox.tenantId, tenantId), eq(whatsappOutbox.providerMessageId, ev.emRespostaA), inArray(whatsappOutbox.status, ESTADOS)));
      if (!e?.recipientPhoneEnc) return null;
      // O id citado tem de ser de mensagem enviada a ESTE número (não se responde pela consulta de outro).
      const para = await this.decifrar(tx, tenantId, e.id, CAMPO_TELEFONE_ENVIO, e.recipientPhoneEnc);
      return mesmoTelefone(para, ev.de) ? e : null;
    }
    const candidatos = await tx
      .select()
      .from(whatsappOutbox)
      .where(
        and(
          eq(whatsappOutbox.tenantId, tenantId),
          inArray(whatsappOutbox.status, ESTADOS),
          isNotNull(whatsappOutbox.recipientPhoneEnc),
          gte(whatsappOutbox.sentAt, new Date(agora.getTime() - janelaHoras * HORA_MS)),
        ),
      )
      .orderBy(desc(whatsappOutbox.sentAt), desc(whatsappOutbox.id))
      .limit(LOTE);
    for (const e of candidatos) {
      if (!e.recipientPhoneEnc) continue;
      if (mesmoTelefone(await this.decifrar(tx, tenantId, e.id, CAMPO_TELEFONE_ENVIO, e.recipientPhoneEnc), ev.de)) return e;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------------
  // Retenção do conteúdo (30 dias)
  // -------------------------------------------------------------------------------------------------

  executarRetencao(ctx: RequestContext): Promise<{ enviosLimpos: number; respostasLimpas: number }> {
    return escreverNaClinica(this.db, ctx, (tx) => this.retencao(tx, ctx));
  }

  executarRetencaoComoSistema(tenantId: TenantId): Promise<{ enviosLimpos: number; respostasLimpas: number }> {
    return this.db.run(tenantId, (tx) => this.retencao(tx, ctxDoSistema(tenantId)));
  }

  private async retencao(tx: TenantTx, ctx: RequestContext): Promise<{ enviosLimpos: number; respostasLimpas: number }> {
    const [r] = await tx.execute<{ outbox_purged: number; inbound_purged: number }>(sql`select * from app_whatsapp_content_retention_run()`);
    const enviosLimpos = Number(r?.outbox_purged ?? 0);
    const respostasLimpas = Number(r?.inbound_purged ?? 0);
    await recordAudit(tx, ctx, {
      action: AuditAction.Update,
      scope: 'whatsapp_outbox',
      metadata: { op: 'content_retention', outbox_purged: enviosLimpos, inbound_purged: respostasLimpas, days: 30 },
    });
    return { enviosLimpos, respostasLimpas };
  }

  // -------------------------------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------------------------------

  private async configuracao(tx: TenantTx, tenantId: TenantId) {
    const [c] = await tx.select().from(whatsappSettings).where(eq(whatsappSettings.tenantId, tenantId));
    return (
      c ?? {
        tenantId,
        enabled: false,
        senderName: null,
        businessNumberId: null,
        reminderHoursBefore: 24,
        sendFromHour: 8,
        sendUntilHour: 20,
        replyWindowHours: 48,
        updatedAt: new Date(0),
        updatedBy: SYSTEM_ACTOR_ID as string,
      }
    );
  }

  private paraConfiguracaoDto(c: Awaited<ReturnType<WhatsappService['configuracao']>>): ConfiguracaoDto {
    return {
      ativo: c.enabled,
      nomeRemetente: c.senderName,
      numeroDeNegocio: c.businessNumberId,
      horasAntes: c.reminderHoursBefore,
      enviarDe: c.sendFromHour,
      enviarAte: c.sendUntilHour,
      janelaRespostaHoras: c.replyWindowHours,
      provedor: this.mensageiro?.nome ?? null,
    };
  }

  private async modeloVigente(tx: TenantTx, tenantId: TenantId) {
    const [t] = await tx
      .select()
      .from(whatsappTemplates)
      .where(and(eq(whatsappTemplates.tenantId, tenantId), eq(whatsappTemplates.purpose, 'lembrete_consulta'), isNull(whatsappTemplates.retiredAt)));
    return t ?? null;
  }

  private async modeloPorId(tx: TenantTx, tenantId: TenantId, id: string) {
    const [t] = await tx.select().from(whatsappTemplates).where(and(eq(whatsappTemplates.tenantId, tenantId), eq(whatsappTemplates.id, id)));
    return t ?? null;
  }

  private async optInVigente(tx: TenantTx, tenantId: TenantId, pacienteId: string, travar: boolean) {
    const q = tx
      .select()
      .from(whatsappOptIns)
      .where(and(eq(whatsappOptIns.tenantId, tenantId), eq(whatsappOptIns.patientId, pacienteId), eq(whatsappOptIns.purpose, 'lembrete_consulta'), isNull(whatsappOptIns.revokedAt)));
    const [o] = travar ? await q.for('update') : await q;
    return o ?? null;
  }

  /**
   * Telefone de quem recebe: o do paciente (adulto) ou o do responsável do opt-in. Menor com opt-in em
   * nome próprio não recebe (R10 do RIPD); responsável sem vínculo vigente (ou sem a tabela, em outra
   * branch) também não.
   */
  private async telefoneDoDestinatario(
    tx: TenantTx,
    tenantId: TenantId,
    pacienteId: string,
    optIn: typeof whatsappOptIns.$inferSelect,
    agora: Date,
  ): Promise<string | null> {
    const [p] = await tx
      .select({ phoneEnc: patients.phoneEnc, birthDateEnc: patients.birthDateEnc, active: patients.active })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), eq(patients.id, pacienteId)));
    if (!p?.active) return null;
    if (optIn.recipientKind === 'responsavel') {
      if (!optIn.guardianId) return null;
      const r = await this.responsaveis.responsavelVigente(tx, tenantId, pacienteId, optIn.guardianId);
      return telefoneParaWhatsapp(r?.telefone ?? null);
    }
    const nascimento = p.birthDateEnc ? await this.cipher.decryptString(tx, patientFieldRef(tenantId, pacienteId, 'birth_date'), p.birthDateEnc) : null;
    if (menorDeIdadeEm(nascimento, noFusoDaClinica(agora).data)) return null;
    const telefone = p.phoneEnc ? await this.cipher.decryptString(tx, patientFieldRef(tenantId, pacienteId, 'phone'), p.phoneEnc) : null;
    return telefoneParaWhatsapp(telefone);
  }

  private async cancelarPendentes(tx: TenantTx, ctx: RequestContext, optInId: string): Promise<number> {
    const r = await tx
      .update(whatsappOutbox)
      .set({ status: 'cancelado' })
      .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.optInId, optInId), eq(whatsappOutbox.status, 'agendado')))
      .returning({ id: whatsappOutbox.id });
    return r.length;
  }

  private async pacienteDaClinica(tx: TenantTx, ctx: RequestContext, id: string, exigirAtivo = false): Promise<void> {
    const [p] = await tx.select({ ativo: patients.active }).from(patients).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)));
    if (!p) throw new NaoEncontradoError();
    if (exigirAtivo && !p.ativo) throw new ConflitoError('paciente_inativo');
  }

  private async cifrar(tx: TenantTx, ctx: RequestContext, rowId: string, campo: CampoWhatsapp, valor: string): Promise<string> {
    const ref = campoWhatsappRef(ctx.tenantId, rowId, campo);
    try {
      return await this.cipher.encrypt(tx, ref, valor);
    } catch (e) {
      if (!(e instanceof TenantKeyMissingError)) throw e;
      await this.cipher.provisionTenant(tx, ctx.tenantId, ctx.userId === SYSTEM_ACTOR_ID ? null : ctx.userId);
      return this.cipher.encrypt(tx, ref, valor);
    }
  }

  private decifrar(tx: TenantTx, tenantId: TenantId, rowId: string, campo: CampoWhatsapp, valor: string): Promise<string> {
    return this.cipher.decryptString(tx, campoWhatsappRef(tenantId, rowId, campo), valor);
  }
}


import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notExists, sql } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  appointments,
  patients,
  whatsappInbound,
  whatsappOptIns,
  whatsappOutbox,
  whatsappPhoneKeys,
  whatsappSettings,
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
  dentroDoHorarioDeEnvio,
  interpretarResposta,
  lembreteDevido,
  MAX_RESPOSTAS_POR_ENVIO,
  MAX_TENTATIVAS,
  mesmoTelefone,
  MODELO_PADRAO,
  MODELOS_DA_PLATAFORMA,
  modeloDaPlataforma,
  renderizarLembrete,
  RESPOSTA_FIXA_OUTRO,
  respostaNaJanela,
  RETENCAO_DO_CONTEUDO_DIAS,
  telefoneParaWhatsapp,
  ANTECEDENCIA_MINIMA_H,
} from './lembretes-regras';
import type { EventoDeResposta, EventoDeStatus, EventoDoWebhook, MensageiroWhatsApp, ResultadoDeEnvio } from './mensageiro-whatsapp';
import { FONTE_DE_RESPONSAVEIS, type FonteDeResponsaveis } from './responsaveis.port';
import {
  CAMPO_CHAVE_NUMERO,
  CAMPO_EVIDENCIA,
  CAMPO_TELEFONE_ENVIO,
  CAMPO_TELEFONE_OPTIN,
  CAMPO_TEXTO_ENVIO,
  campoWhatsappRef,
  type CampoWhatsapp,
} from './whatsapp-fields';
import type { ConfiguracaoWhatsapp, FiltroEnvios, NovoOptIn } from './whatsapp.validation';

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
  /** O número de agora não é o que consentiu: nada sai e o opt-in perde a validade (V1 do parecer #69). */
  readonly numeroMudou: number;
  readonly enviados: number;
  readonly falharam: number;
  readonly cancelados: number;
}

export interface ResultadoDaLimpeza {
  /** "agendado" de consulta que já começou: cancelado (expirado). */
  readonly agendadosExpirados: number;
  /** "enviando" há mais de 24 h: falhou (envio_interrompido), com fallback para a recepção. */
  readonly enviosInterrompidos: number;
  /** Envios com mais de 30 dias que perderam o conteúdo (texto e número). */
  readonly enviosLimpos: number;
}

const ZERO: Omit<ResultadoDosLembretes, 'motivo'> = { programados: 0, semOptIn: 0, semDestinatario: 0, numeroMudou: 0, enviados: 0, falharam: 0, cancelados: 0 };

/** HMAC-SHA256 do número normalizado (DDI 55) com a chave da clínica: compara sem decifrar (V1). */
function hashDoNumero(chave: Buffer, telefone: string): string {
  return createHmac('sha256', chave).update(telefone, 'utf8').digest('hex');
}

const RANK: Readonly<Record<WhatsappOutboxStatus, number>> = { agendado: 0, enviando: 1, enviado: 2, entregue: 3, lido: 4, falhou: 9, cancelado: 9 };

/** Contexto do sistema (job e webhook): sem usuário; a trilha grava `actor_kind = sistema`. */
function ctxDoSistema(tenantId: TenantId): RequestContext {
  return { tenantId, userId: SYSTEM_ACTOR_ID, roles: ['sistema'] };
}

/**
 * Lembretes e confirmação por WhatsApp (rodada 18.3). Garantias:
 * - nada sai sem opt-in VIGENTE do destinatário PARA O NÚMERO DE AGORA (V1 do parecer #69): o opt-in grava o
 *   número que consentiu (cifrado + HMAC da clínica); no programar e no despacho o número atual (cadastro ou
 *   responsável) tem de ter o mesmo HMAC, senão nada sai e o opt-in é revogado como `numero_mudou`. O banco
 *   confere o HMAC no INSERT da fila e na reserva para envio;
 * - o texto é o modelo neutro renderizado só com nome neutro, data e hora (sem profissional, especialidade
 *   ou tipo de atendimento);
 * - paciente menor recebe pelo responsável (porta FonteDeResponsaveis); sem responsável, não sai;
 * - fora do horário configurado, nada sai;
 * - "1"/"2" mudam SÓ a consulta daquele envio, pelas regras da agenda, dentro da janela;
 * - trilha só com ids, contagens e códigos (nunca número, texto ou nome).
 */
@Injectable()
export class WhatsappService implements OnApplicationBootstrap {
  private readonly logger = new Logger('whatsapp');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(SchedulingService) private readonly agenda: SchedulingService,
    @Inject(FONTE_DE_RESPONSAVEIS) private readonly responsaveis: FonteDeResponsaveis,
    @Inject(MENSAGEIRO_WHATSAPP) private readonly mensageiro: MensageiroWhatsApp | null,
  ) {}

  /** V3 do parecer #69: com o canal ligado, o texto dos modelos no provedor é conferido NA SUBIDA. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.mensageiro) await this.mensageiro.conferirModelos(MODELOS_DA_PLATAFORMA);
  }

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

  /**
   * Modelos: SÓ os da plataforma (V3 do parecer #69), lista fechada no código com o nome na Meta e o texto
   * aprovado. Não lê nada da clínica (não há modelo da clínica).
   */
  listarModelos(): { vigente: { nomeNoProvedor: string; texto: string }; disponiveis: { nomeNoProvedor: string; texto: string }[] } {
    const dto = (m: (typeof MODELOS_DA_PLATAFORMA)[number]) => ({ nomeNoProvedor: m.nomeNoProvedor, texto: m.corpo });
    return { vigente: dto(MODELO_PADRAO), disponiveis: MODELOS_DA_PLATAFORMA.map(dto) };
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
      // V1: o opt-in prova o consentimento DESTE número (o de agora, do cadastro ou do responsável).
      let telefone: string | null;
      if (dados.destinatario === 'responsavel') {
        const r = await this.responsaveis.responsavelVigente(tx, ctx.tenantId, pacienteId, dados.responsavelId ?? '');
        if (!r) throw new ConflitoError('responsavel_nao_vinculado');
        telefone = telefoneParaWhatsapp(r.telefone);
        if (!telefone) throw new ConflitoError('responsavel_sem_telefone');
      } else {
        // V2 do parecer #69: em nome próprio só ADULTO com data de nascimento conhecida (falha fechada).
        const nascimento = await this.nascimentoDoCadastro(tx, ctx.tenantId, pacienteId);
        if (!nascimento) throw new ConflitoError('data_de_nascimento_ausente');
        if (menorDeIdadeEm(nascimento, noFusoDaClinica(new Date()).data)) throw new ConflitoError('paciente_menor_de_idade');
        telefone = telefoneParaWhatsapp(await this.telefoneDoCadastro(tx, ctx.tenantId, pacienteId));
        if (!telefone) throw new ConflitoError('paciente_sem_telefone');
      }
      const chave = await this.chaveDoNumero(tx, ctx, true);
      if (!chave) throw new Error('chave de comparação de número ausente');
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
        recipientPhoneEnc: await this.cifrar(tx, ctx, id, CAMPO_TELEFONE_OPTIN, telefone),
        recipientPhoneHash: hashDoNumero(chave, telefone),
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
    const despacho = await this.despachar(ctx, run, agora);
    return { ...programacao, ...despacho, numeroMudou: programacao.numeroMudou + despacho.numeroMudou, motivo: 'ok' };
  }

  private async programar(
    tx: TenantTx,
    ctx: RequestContext,
    agora: Date,
  ): Promise<Pick<ResultadoDosLembretes, 'motivo' | 'programados' | 'semOptIn' | 'semDestinatario' | 'numeroMudou'>> {
    const nada = { programados: 0, semOptIn: 0, semDestinatario: 0, numeroMudou: 0 };
    const cfg = await this.configuracao(tx, ctx.tenantId);
    if (!cfg.enabled || !cfg.senderName || !cfg.businessNumberId) return { motivo: 'canal_desligado', ...nada };
    if (!dentroDoHorarioDeEnvio(agora, cfg.sendFromHour, cfg.sendUntilHour)) return { motivo: 'fora_do_horario', ...nada };
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
    const modelo = MODELO_PADRAO;
    const chave = await this.chaveDoNumero(tx, ctx, false);
    let programados = 0;
    let semOptIn = 0;
    let semDestinatario = 0;
    let numeroMudou = 0;
    for (const a of devidos) {
      if (!lembreteDevido(a.startsAt, agora, cfg.reminderHoursBefore)) continue;
      const optIn = await this.optInVigente(tx, ctx.tenantId, a.patientId, false);
      if (!optIn || !chave) {
        semOptIn++;
        continue;
      }
      const telefone = await this.telefoneDoDestinatario(tx, ctx.tenantId, a.patientId, optIn, agora);
      if (!telefone) {
        semDestinatario++;
        continue;
      }
      // V1: o número de agora tem de ser o que consentiu; se mudou, o opt-in perde a validade.
      const hash = hashDoNumero(chave, telefone);
      if (hash !== optIn.recipientPhoneHash) {
        numeroMudou++;
        await this.invalidarPorNumeroMudado(tx, ctx, optIn.id, optIn.patientId);
        continue;
      }
      const { texto } = renderizarLembrete(modelo.corpo, cfg.senderName, a.startsAt);
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
          templateName: modelo.nomeNoProvedor,
          recipientKind: optIn.recipientKind,
          guardianId: optIn.guardianId,
          recipientPhoneEnc: await this.cifrar(tx, ctx, id, CAMPO_TELEFONE_ENVIO, telefone),
          recipientPhoneHash: hash,
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
      metadata: { op: 'schedule', count: programados, skipped_no_opt_in: semOptIn, skipped_no_recipient: semDestinatario, skipped_number_changed: numeroMudou },
    });
    return { motivo: 'ok', programados, semOptIn, semDestinatario, numeroMudou };
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
    agora: Date,
  ): Promise<Pick<ResultadoDosLembretes, 'enviados' | 'falharam' | 'cancelados' | 'numeroMudou'>> {
    const mensageiro = this.mensageiro;
    if (!mensageiro) return { enviados: 0, falharam: 0, cancelados: 0, numeroMudou: 0 };
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
      let numeroMudou = 0;
      const chave = await this.chaveDoNumero(tx, ctx, false);
      // Linhas já canceladas nesta passada (número mudado cancela todas as do mesmo opt-in).
      const jaCancelados = new Set<string>();
      for (const e of fila) {
        if (jaCancelados.has(e.id)) continue;
        const [ag] = await tx
          .select({ status: appointments.status, startsAt: appointments.startsAt })
          .from(appointments)
          .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, e.appointmentId)));
        const [opt] = await tx
          .select()
          .from(whatsappOptIns)
          .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.id, e.optInId)));
        // Modelo fora da lista fechada da plataforma: não sai (falha fechada).
        const modelo = modeloDaPlataforma(e.templateName);
        const valido =
          modelo &&
          cfg.enabled && cfg.senderName && cfg.businessNumberId && opt && opt.revokedAt === null && ag && ag.status === 'scheduled' && ag.startsAt.getTime() === e.appointmentStartsAt.getTime();
        if (!valido || !opt || !modelo || !e.recipientPhoneEnc || !e.bodyEnc || !cfg.senderName) {
          await this.cancelarEnvio(tx, ctx, e.id, null);
          cancelados++;
          continue;
        }
        // V1, de novo no despacho: o número de AGORA (cadastro ou responsável) e o número gravado na fila têm
        // de ser o que consentiu. Mudou: não sai, e o opt-in perde a validade (a recepção pede outro).
        const atual = await this.telefoneDoDestinatario(tx, ctx.tenantId, e.patientId, opt, agora);
        if (!atual) {
          await this.cancelarEnvio(tx, ctx, e.id, 'sem_destinatario');
          cancelados++;
          continue;
        }
        const para = await this.decifrar(tx, ctx.tenantId, e.id, CAMPO_TELEFONE_ENVIO, e.recipientPhoneEnc);
        if (!chave || hashDoNumero(chave, atual) !== e.recipientPhoneHash || hashDoNumero(chave, para) !== e.recipientPhoneHash) {
          const ids = await this.invalidarPorNumeroMudado(tx, ctx, opt.id, opt.patientId);
          if (!ids.includes(e.id)) await this.cancelarEnvio(tx, ctx, e.id, 'numero_mudou');
          for (const id of [...ids, e.id]) jaCancelados.add(id);
          numeroMudou++;
          cancelados += Math.max(ids.length, 1);
          continue;
        }
        await tx.update(whatsappOutbox).set({ status: 'enviando' }).where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, e.id)));
        const { parametros } = renderizarLembrete(modelo.corpo, cfg.senderName, e.appointmentStartsAt);
        prontos.push({
          id: e.id,
          para,
          texto: await this.decifrar(tx, ctx.tenantId, e.id, CAMPO_TEXTO_ENVIO, e.bodyEnc),
          parametros,
          modelo: modelo.nomeNoProvedor,
        });
      }
      return { prontos, cancelados, numeroMudou, remetente: cfg.businessNumberId ?? '' };
    });

    const resultados: { id: string; r: ResultadoDeEnvio }[] = [];
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
      return { enviados, falharam, cancelados: reservados.cancelados, numeroMudou: reservados.numeroMudou };
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
    // Respostas de texto fixo a mandar DEPOIS de gravar (nunca rede dentro da transação).
    const respostasFixas: { para: string; remetente: string }[] = [];
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
        if (ev.tipo === 'status') return this.aplicarStatus(tx, ctx, ev);
        const r = await this.aplicarResposta(tx, ctx, ev, cfg.replyWindowHours, agora);
        if (r === 'responder_texto_fixo') respostasFixas.push({ para: ev.de, remetente: ev.numeroDaClinica });
        return r !== false;
      });
      if (ok) processados++;
      else ignorados++;
    }
    for (const r of respostasFixas) {
      const res = await this.mensageiro?.responderTextoFixo({ ...r, texto: RESPOSTA_FIXA_OUTRO });
      if (res && !res.ok) this.logger.warn('WHATSAPP_RESPOSTA_FIXA_FALHOU');
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

  /**
   * Grava SÓ o metadado da resposta (interpretação e resultado; R1 do parecer #69: nem texto nem número).
   * "outro" (qualquer coisa que não seja 1/2/SAIR, inclusive mídia) devolve `responder_texto_fixo`: o
   * paciente recebe a orientação fixa de ligar para a clínica e o que ele escreveu é descartado.
   */
  private async aplicarResposta(
    tx: TenantTx,
    ctx: RequestContext,
    ev: EventoDeResposta,
    janelaHoras: number,
    agora: Date,
  ): Promise<boolean | 'responder_texto_fixo'> {
    // Idempotência: a Meta reentrega o mesmo id.
    const [ja] = await tx
      .select({ id: whatsappInbound.id })
      .from(whatsappInbound)
      .where(and(eq(whatsappInbound.tenantId, ctx.tenantId), eq(whatsappInbound.providerMessageId, ev.idProvedor)));
    if (ja) return false;
    const achado = await this.envioDaResposta(tx, ctx.tenantId, ev, janelaHoras, agora);
    const envio = achado?.envio;
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
      // Sem citar a mensagem e com MAIS de um lembrete em aberto para o número, não se adivinha a consulta:
      // nada muda (a recepção resolve). Assim "1"/"2" nunca atinge consulta diferente da que o paciente leu.
      if (achado?.ambigua) resultado = 'sem_acao';
      else if (!respostaNaJanela(envio.sentAt, envio.appointmentStartsAt, agora, janelaHoras)) resultado = 'fora_da_janela';
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
      interpretation: interpretacao,
      outcome: resultado,
    });
    await recordAudit(tx, ctx, {
      action: AuditAction.Create,
      scope: 'whatsapp_inbound',
      metadata: { inbound_id: id, outbox_id: envio.id, appointment_id: envio.appointmentId, interpretation: interpretacao, outcome: resultado },
    });
    return interpretacao === 'outro' ? 'responder_texto_fixo' : true;
  }

  /**
   * Envio a que a resposta se refere: pelo id da nossa mensagem (context.id), quando o aplicativo manda;
   * senão, o ÚNICO envio ao mesmo número dentro da janela cuja consulta ainda não começou (havendo mais de
   * um, `ambigua`: o mais recente é associado só para o registro, sem ação na agenda).
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
      return mesmoTelefone(para, ev.de) ? { envio: e, ambigua: false } : null;
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
    const doNumero: (typeof candidatos)[number][] = [];
    for (const e of candidatos) {
      if (!e.recipientPhoneEnc) continue;
      if (mesmoTelefone(await this.decifrar(tx, tenantId, e.id, CAMPO_TELEFONE_ENVIO, e.recipientPhoneEnc), ev.de)) doNumero.push(e);
    }
    const [primeiro] = doNumero;
    if (!primeiro) return null;
    const emAberto = doNumero.filter((e) => e.appointmentStartsAt.getTime() > agora.getTime());
    return { envio: primeiro, ambigua: emAberto.length > 1 };
  }

  // -------------------------------------------------------------------------------------------------
  // Limpeza (R2/R3 do parecer #69): job da clínica, chamável pelo agendador e pela rota do admin
  // -------------------------------------------------------------------------------------------------

  /** Pela rota (admin): o ator da trilha é o usuário da sessão. */
  executarRetencao(ctx: RequestContext): Promise<ResultadoDaLimpeza> {
    return escreverNaClinica(this.db, ctx, (tx) => this.retencao(tx, ctx));
  }

  /**
   * JOB do sistema, por clínica (sem usuário: a trilha grava `sistema`). O agendador chama uma vez por dia
   * para cada clínica com o canal configurado (ver api-dominio.md §11). Idempotente.
   */
  executarRetencaoComoSistema(tenantId: TenantId): Promise<ResultadoDaLimpeza> {
    return this.db.run(tenantId, (tx) => this.retencao(tx, ctxDoSistema(tenantId)));
  }

  private async retencao(tx: TenantTx, ctx: RequestContext): Promise<ResultadoDaLimpeza> {
    const [r] = await tx.execute<{ scheduled_expired: number; sending_interrupted: number; outbox_purged: number }>(
      sql`select * from app_whatsapp_content_retention_run()`,
    );
    const agendadosExpirados = Number(r?.scheduled_expired ?? 0);
    const enviosInterrompidos = Number(r?.sending_interrupted ?? 0);
    const enviosLimpos = Number(r?.outbox_purged ?? 0);
    if (enviosInterrompidos > 0) this.logger.warn('WHATSAPP_ENVIO_INTERROMPIDO fallback=fila_da_recepcao');
    await recordAudit(tx, ctx, {
      action: AuditAction.Update,
      scope: 'whatsapp_outbox',
      metadata: {
        op: 'content_retention',
        scheduled_expired: agendadosExpirados,
        sending_interrupted: enviosInterrompidos,
        outbox_purged: enviosLimpos,
        days: RETENCAO_DO_CONTEUDO_DIAS,
      },
    });
    return { agendadosExpirados, enviosInterrompidos, enviosLimpos };
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
        updatedBy: SYSTEM_ACTOR_ID,
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

  private async optInVigente(tx: TenantTx, tenantId: TenantId, pacienteId: string, travar: boolean) {
    const q = tx
      .select()
      .from(whatsappOptIns)
      .where(and(eq(whatsappOptIns.tenantId, tenantId), eq(whatsappOptIns.patientId, pacienteId), eq(whatsappOptIns.purpose, 'lembrete_consulta'), isNull(whatsappOptIns.revokedAt)));
    const [o] = travar ? await q.for('update') : await q;
    return o ?? null;
  }

  /**
   * Telefone de quem recebe: o do paciente (adulto COM data de nascimento conhecida) ou o do responsável do
   * opt-in. Menor com opt-in em nome próprio não recebe (R10 do RIPD); sem data de nascimento também não
   * (V2 do parecer #69: falha fechada); responsável sem vínculo vigente (ou sem a tabela, em outra
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
    // V2 do parecer #69: sem data de nascimento NÃO se presume adulto. Falha fechada: nada sai.
    if (!nascimento || !/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return null;
    if (menorDeIdadeEm(nascimento, noFusoDaClinica(agora).data)) return null;
    const telefone = p.phoneEnc ? await this.cipher.decryptString(tx, patientFieldRef(tenantId, pacienteId, 'phone'), p.phoneEnc) : null;
    return telefoneParaWhatsapp(telefone);
  }

  private async cancelarPendentes(tx: TenantTx, ctx: RequestContext, optInId: string, codigo: string | null = null): Promise<number> {
    return (await this.cancelarPendentesIds(tx, ctx, optInId, codigo)).length;
  }

  private async cancelarPendentesIds(tx: TenantTx, ctx: RequestContext, optInId: string, codigo: string | null): Promise<string[]> {
    const r = await tx
      .update(whatsappOutbox)
      .set({ status: 'cancelado', ...(codigo ? { failureCode: codigo } : {}) })
      .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.optInId, optInId), eq(whatsappOutbox.status, 'agendado')))
      .returning({ id: whatsappOutbox.id });
    return r.map((x) => x.id);
  }

  private async cancelarEnvio(tx: TenantTx, ctx: RequestContext, id: string, codigo: string | null): Promise<void> {
    await tx
      .update(whatsappOutbox)
      .set({ status: 'cancelado', ...(codigo ? { failureCode: codigo } : {}) })
      .where(and(eq(whatsappOutbox.tenantId, ctx.tenantId), eq(whatsappOutbox.id, id)));
  }

  /**
   * V1: o número de agora não é o que consentiu. O opt-in perde a validade (revogado `numero_mudou`, pelo
   * sistema ou pelo usuário que rodou o job), os envios agendados dele são cancelados com o mesmo código
   * (a recepção vê na fila e pede um novo opt-in) e a trilha registra só ids e contagens.
   */
  private async invalidarPorNumeroMudado(tx: TenantTx, ctx: RequestContext, optInId: string, pacienteId: string): Promise<string[]> {
    const sistema = ctx.userId === SYSTEM_ACTOR_ID;
    const r = await tx
      .update(whatsappOptIns)
      .set({ revokedAt: new Date(), revokedBy: sistema ? null : ctx.userId, revokeMethod: 'numero_mudou' })
      .where(and(eq(whatsappOptIns.tenantId, ctx.tenantId), eq(whatsappOptIns.id, optInId), isNull(whatsappOptIns.revokedAt)))
      .returning({ id: whatsappOptIns.id });
    const ids = await this.cancelarPendentesIds(tx, ctx, optInId, 'numero_mudou');
    if (r.length > 0) {
      this.logger.warn('WHATSAPP_NUMERO_MUDOU opt_in_revogado novo_opt_in_necessario');
      await recordAudit(tx, ctx, {
        action: AuditAction.ConsentChange,
        scope: 'whatsapp_opt_ins',
        metadata: { op: 'revoke', opt_in_id: optInId, patient_id: pacienteId, method: 'numero_mudou', outbox_cancelled: ids.length },
      });
    }
    return ids;
  }

  /**
   * Chave da clínica para o HMAC de comparação de número (V1). Criada na primeira vez (32 bytes aleatórios,
   * cifrados com a chave da clínica); `criar = false` devolve null se ainda não existe (nenhum opt-in).
   */
  private async chaveDoNumero(tx: TenantTx, ctx: RequestContext, criar: boolean): Promise<Buffer | null> {
    const ref = campoWhatsappRef(ctx.tenantId, ctx.tenantId, CAMPO_CHAVE_NUMERO);
    const ler = async () => {
      const [k] = await tx.select({ keyEnc: whatsappPhoneKeys.keyEnc }).from(whatsappPhoneKeys).where(eq(whatsappPhoneKeys.tenantId, ctx.tenantId));
      return k ? this.cipher.decrypt(tx, ref, k.keyEnc) : null;
    };
    const atual = await ler();
    if (atual || !criar) return atual;
    const keyEnc = await this.cifrar(tx, ctx, ctx.tenantId, CAMPO_CHAVE_NUMERO, randomBytes(32));
    await tx.insert(whatsappPhoneKeys).values({ tenantId: ctx.tenantId, keyEnc }).onConflictDoNothing();
    return ler();
  }

  private async nascimentoDoCadastro(tx: TenantTx, tenantId: TenantId, pacienteId: string): Promise<string | null> {
    const [p] = await tx.select({ birthDateEnc: patients.birthDateEnc }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, pacienteId)));
    const n = p?.birthDateEnc ? await this.cipher.decryptString(tx, patientFieldRef(tenantId, pacienteId, 'birth_date'), p.birthDateEnc) : null;
    return n && /^\d{4}-\d{2}-\d{2}$/.test(n) ? n : null;
  }

  private async telefoneDoCadastro(tx: TenantTx, tenantId: TenantId, pacienteId: string): Promise<string | null> {
    const [p] = await tx.select({ phoneEnc: patients.phoneEnc }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, pacienteId)));
    return p?.phoneEnc ? this.cipher.decryptString(tx, patientFieldRef(tenantId, pacienteId, 'phone'), p.phoneEnc) : null;
  }

  private async pacienteDaClinica(tx: TenantTx, ctx: RequestContext, id: string, exigirAtivo = false): Promise<void> {
    const [p] = await tx.select({ ativo: patients.active }).from(patients).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)));
    if (!p) throw new NaoEncontradoError();
    if (exigirAtivo && !p.ativo) throw new ConflitoError('paciente_inativo');
  }

  private async cifrar(tx: TenantTx, ctx: RequestContext, rowId: string, campo: CampoWhatsapp, valor: string | Uint8Array): Promise<string> {
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


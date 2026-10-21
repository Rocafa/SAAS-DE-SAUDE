import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, type TenantId } from '@plataforma/shared';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { comPoliticaDeAssinatura, ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import {
  appointments,
  charges,
  patients,
  payments,
  portalConsents,
  portalLinks,
  portalRightsRequests,
  professionals,
  receiptCancellations,
  receipts,
  tenants,
  type PaymentMethod,
  type PortalActingAs,
  type PortalConsentPurpose,
  type PortalConsentResponse,
  type RightsRequestKind,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { RequisicaoParaSessao } from '../auth/auth-context';
import { insertAudit, type AuditEntry } from '../audit/audit-log';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { assertCanWrite, canRead, EXIT_WINDOW_DAYS, ExitWindowClosedError } from '../exports/access-policy';
import { loadTenantSubscription } from '../exports/tenant-subscription';
import { CAMPO_RECIBO, decifrarCampoFinanceiro } from '../finance/finance-fields';
import type { ConteudoDoRecibo } from '../finance/financeiro-regras';
import { hojeNaClinica } from '../insurance/guias-regras';
import { patientFieldRef } from '../patients/patient-fields';
import { noFusoDaClinica, statusParaFront, type StatusFront } from '../scheduling/agenda-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { PORTAL_AUTH_PROVIDER, type PortalAuthProvider, type SessaoDoPortal } from './portal-auth';
import { cifrarCampoPortal, decifrarCampoPortal } from './portal-fields';
import {
  CONSENTIMENTOS,
  consentimentoIa,
  estadoDoConsentimento,
  hashDoTexto,
  hashDoToken,
  IDADE_CONSENTIMENTO_PROPRIO,
  idadeEm,
  JANELA_CONSULTAS,
  mascararCpf,
  novoProtocolo,
  primeiroNome,
  situacaoParaOTitular,
  TOKEN_CONVITE_RE,
  transicaoDoPortal,
  VERSAO_TEXTOS_CONSENTIMENTO,
  type AcaoNaConsulta,
  type RespostaConsentimento,
} from './portal-regras';
import { PortalVigilanciaService } from './portal-vigilancia';

/** Contexto do titular, resolvido NO SERVIDOR (sessão + banco). Nada daqui vem do cliente. */
export interface ContextoPortal {
  readonly tenantId: TenantId;
  readonly pacienteId: string;
  readonly contaId: string;
  readonly vinculoId: string;
  readonly agindoComo: PortalActingAs;
}

export const ANTECEDENCIA_CANCELAMENTO = Symbol('ANTECEDENCIA_CANCELAMENTO');

export interface VinculoDaContaDto {
  readonly vinculoId: string;
  readonly clinica: string;
  readonly primeiroNome: string;
  readonly agindoComo: PortalActingAs;
}

export interface ConsultaPortalDto {
  readonly id: string;
  readonly data: string;
  readonly hora: string;
  readonly profissional: string;
  readonly status: StatusFront;
  readonly podeConfirmar: boolean;
  readonly podeCancelar: boolean;
}

export interface ReciboPortalResumoDto {
  readonly id: string;
  readonly numero: number;
  readonly data: string;
  readonly valorCentavos: number;
  readonly forma: PaymentMethod;
  readonly situacao: 'emitido' | 'cancelado';
}

export interface PedidoPortalDto {
  readonly id: string;
  readonly protocolo: string;
  readonly tipo: RightsRequestKind;
  readonly abertoEm: string;
  readonly prazo: string;
  readonly situacao: 'aberto' | 'respondido';
  readonly resposta: string | null;
}

export interface ConsentimentoPortalDto {
  readonly finalidade: PortalConsentPurpose;
  readonly titulo: string;
  readonly explicacao: string;
  readonly resposta: RespostaConsentimento;
  readonly versaoTexto: string;
  readonly atualizadoEm: string | null;
  /** Só para `escriba_ia`: o estado que o escriba usa (3 estados; não informado nega). */
  readonly estadoIa?: string;
}

const PG_INSUFFICIENT_PRIVILEGE = '42501';

function codigoPg(e: unknown): string | undefined {
  for (let x: unknown = e; x instanceof Error; x = x.cause) {
    const c = (x as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/**
 * Portal do paciente (contrato ApiPortal, veto B3): o titular sai SÓ da sessão do portal e do vínculo
 * conferido no banco. Nenhum método recebe id de paciente ou de clínica. Toda leitura e escrita grava
 * auditoria na trilha da clínica (ator = a conta, `paciente_portal`; só ids, códigos e contagens).
 * Conteúdo clínico do prontuário NÃO é exposto (só por pedido de acesso atendido pela clínica).
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger('portal');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(PORTAL_AUTH_PROVIDER) private readonly provider: PortalAuthProvider,
    @Inject(PortalVigilanciaService) private readonly vigilancia: PortalVigilanciaService,
    @Inject(ANTECEDENCIA_CANCELAMENTO) private readonly antecedenciaH: number,
  ) {}

  // ------------------------------------------------------------ sessão e vínculos

  async vinculos(sessao: SessaoDoPortal): Promise<VinculoDaContaDto[]> {
    await this.vigilancia.requisicao(sessao.contaId, sessao.vinculoId);
    const ids = await this.vinculosDaConta(sessao.contaId);
    const itens: VinculoDaContaDto[] = [];
    for (const id of ids) {
      itens.push(
        await this.db.runPortal(sessao.contaId, id, async (tx) => {
          const ctx = await this.contexto(tx, sessao.contaId, id);
          const d = await this.dadosDaSaudacao(tx, ctx);
          await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'portal_links', metadata: { op: 'list_links', link_id: id } });
          return { vinculoId: id, clinica: d.clinica, primeiroNome: d.primeiroNome, agindoComo: ctx.agindoComo };
        }),
      );
    }
    return itens;
  }

  /** Escolha da clínica/paciente NA SESSÃO do servidor (nunca por cabeçalho). */
  async escolherVinculo(sessao: SessaoDoPortal, req: RequisicaoParaSessao, vinculoId: string): Promise<VinculoDaContaDto> {
    await this.vigilancia.requisicao(sessao.contaId, sessao.vinculoId);
    if (!(await this.vinculosDaConta(sessao.contaId)).includes(vinculoId)) throw new NaoEncontradoError();
    const dto = await this.db.runPortal(sessao.contaId, vinculoId, async (tx) => {
      const ctx = await this.contexto(tx, sessao.contaId, vinculoId);
      const d = await this.dadosDaSaudacao(tx, ctx);
      await this.auditar(tx, ctx, { action: AuditAction.Login, scope: 'portal_session', metadata: { op: 'select_link', link_id: vinculoId } });
      return { vinculoId, clinica: d.clinica, primeiroNome: d.primeiroNome, agindoComo: ctx.agindoComo };
    });
    await this.provider.escolherVinculo(req, vinculoId);
    return dto;
  }

  sessaoAtual(sessao: SessaoDoPortal, req: RequisicaoParaSessao): Promise<VinculoDaContaDto> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const d = await this.dadosDaSaudacao(tx, ctx);
      return { vinculoId: ctx.vinculoId, clinica: d.clinica, primeiroNome: d.primeiroNome, agindoComo: ctx.agindoComo };
    });
  }

  /** Resgate do convite: uso único, dentro da validade. Falha sempre igual (409 convite_invalido). */
  async resgatar(sessao: SessaoDoPortal, req: RequisicaoParaSessao, token: string): Promise<{ vinculoId: string }> {
    await this.vigilancia.resgate(sessao.contaId);
    if (!TOKEN_CONVITE_RE.test(token)) throw new ConflitoError('convite_invalido');
    const vinculo = await this.db.semContextoDoPortal(async (tx) => {
      const r = await tx.execute<{ v: string | null }>(sql`select app_portal_redeem_invite(${sessao.contaId}::uuid, ${hashDoToken(token)}) as v`);
      return r[0]?.v ?? null;
    });
    if (!vinculo) {
      this.logger.warn('PORTAL_RESGATE_RECUSADO');
      throw new ConflitoError('convite_invalido');
    }
    await this.provider.escolherVinculo(req, vinculo);
    return { vinculoId: vinculo };
  }

  // ------------------------------------------------------------ consultas

  minhasConsultas(sessao: SessaoDoPortal, req: RequisicaoParaSessao): Promise<ConsultaPortalDto[]> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const agora = Date.now();
      const linhas = await tx
        .select({ a: appointments, profissional: professionals.displayName })
        .from(appointments)
        .innerJoin(professionals, and(eq(professionals.tenantId, appointments.tenantId), eq(professionals.id, appointments.professionalId)))
        .where(
          and(
            eq(appointments.tenantId, ctx.tenantId),
            eq(appointments.patientId, ctx.pacienteId),
            gte(appointments.startsAt, new Date(agora - JANELA_CONSULTAS.passadoMs)),
            lt(appointments.startsAt, new Date(agora + JANELA_CONSULTAS.futuroDias * 86_400_000)),
          ),
        )
        .orderBy(asc(appointments.startsAt), asc(appointments.id))
        .limit(JANELA_CONSULTAS.maximo);
      const itens = linhas.map(({ a, profissional }): ConsultaPortalDto => {
        const { data, hora } = noFusoDaClinica(a.startsAt);
        const futura = a.startsAt.getTime() > agora;
        return {
          id: a.id,
          data,
          hora,
          profissional,
          status: statusParaFront(a.status),
          podeConfirmar: futura && a.status === 'scheduled',
          podeCancelar: (a.status === 'scheduled' || a.status === 'confirmed') && a.startsAt.getTime() - agora >= this.antecedenciaH * 3_600_000,
        };
      });
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'appointments', metadata: { op: 'portal_list', count: itens.length } });
      return itens;
    });
  }

  /**
   * Confirmar, desfazer a confirmação ou cancelar UMA consulta do próprio paciente. Não usa a função
   * genérica de status da clínica: só as três transições do portal, consulta futura, e o cancelamento
   * com antecedência mínima. Consulta de outro paciente (ou de outra clínica) = 404, igual a inexistente.
   */
  agirNaConsulta(sessao: SessaoDoPortal, req: RequisicaoParaSessao, id: string, acao: AcaoNaConsulta): Promise<{ status: StatusFront }> {
    return this.noVinculo(
      sessao,
      req,
      async (tx, ctx) => {
        assertCanWrite((await loadTenantSubscription(tx, ctx.tenantId)).status);
        const [a] = await tx
          .select()
          .from(appointments)
          .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, id), eq(appointments.patientId, ctx.pacienteId)))
          .for('update');
        if (!a) throw new NaoEncontradoError();
        const novo = transicaoDoPortal(acao, a.status);
        if (!novo) throw new ConflitoError('status_nao_permite');
        const agora = new Date();
        if (a.startsAt.getTime() <= agora.getTime()) throw new ConflitoError('consulta_ja_comecou');
        if (acao === 'cancelar' && a.startsAt.getTime() - agora.getTime() < this.antecedenciaH * 3_600_000) {
          throw new ConflitoError('prazo_de_cancelamento_encerrado');
        }
        await tx
          .update(appointments)
          .set({ status: novo, updatedAt: agora, ...(novo === 'cancelled' ? { cancelledAt: agora } : {}) })
          .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, id), eq(appointments.patientId, ctx.pacienteId)));
        await this.auditar(tx, ctx, {
          action: AuditAction.Update,
          scope: 'appointments',
          metadata: { appointment_id: id, op: 'status', from: a.status, to: novo },
        });
        return { status: statusParaFront(novo) };
      },
    );
  }

  // ------------------------------------------------------------ recibos

  meusRecibos(sessao: SessaoDoPortal, req: RequisicaoParaSessao): Promise<ReciboPortalResumoDto[]> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const linhas = await tx
        .select({ r: receipts, p: payments, cancelado: receiptCancellations.id })
        .from(receipts)
        .innerJoin(payments, and(eq(payments.tenantId, receipts.tenantId), eq(payments.id, receipts.paymentId)))
        .innerJoin(charges, and(eq(charges.tenantId, payments.tenantId), eq(charges.id, payments.chargeId)))
        .leftJoin(receiptCancellations, and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)))
        .where(and(eq(receipts.tenantId, ctx.tenantId), eq(charges.patientId, ctx.pacienteId)))
        .orderBy(desc(receipts.issuedAt), desc(receipts.number))
        .limit(100);
      const itens = linhas.map(
        (l): ReciboPortalResumoDto => ({
          id: l.r.id,
          numero: l.r.number,
          data: noFusoDaClinica(l.p.receivedAt).data,
          valorCentavos: l.p.amountCents,
          forma: l.p.method,
          situacao: l.cancelado ? 'cancelado' : 'emitido',
        }),
      );
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'receipts', metadata: { op: 'portal_list', count: itens.length } });
      return itens;
    });
  }

  /**
   * Recibo do próprio paciente (retrato emitido). O CPF do PAGADOR terceiro (ex.: responsável) sai
   * mascarado: o recibo inteiro é do pagador; o titular vê o próprio CPF (beneficiário) inteiro.
   */
  meuRecibo(sessao: SessaoDoPortal, req: RequisicaoParaSessao, id: string): Promise<ConteudoDoRecibo & { id: string; numero: number; situacao: 'emitido' | 'cancelado' }> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const [l] = await tx
        .select({ r: receipts, cancelado: receiptCancellations.id })
        .from(receipts)
        .innerJoin(payments, and(eq(payments.tenantId, receipts.tenantId), eq(payments.id, receipts.paymentId)))
        .innerJoin(charges, and(eq(charges.tenantId, payments.tenantId), eq(charges.id, payments.chargeId)))
        .leftJoin(receiptCancellations, and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)))
        .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, id), eq(charges.patientId, ctx.pacienteId)));
      if (!l) throw new NaoEncontradoError();
      if (l.r.contentEnc === null) throw new ConflitoError('recibo_eliminado_por_retencao_fiscal');
      const c = JSON.parse((await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, id, CAMPO_RECIBO, l.r.contentEnc)) ?? '{}') as ConteudoDoRecibo;
      const terceiro = c.pagador.cpf !== null && c.pagador.cpf !== c.beneficiario.cpf;
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'receipts', metadata: { receipt_id: id, receipt_number: l.r.number, op: 'portal_read' } });
      return {
        ...c,
        pagador: terceiro ? { nome: c.pagador.nome, cpf: mascararCpf(c.pagador.cpf) } : c.pagador,
        id,
        numero: l.r.number,
        situacao: l.cancelado ? 'cancelado' : 'emitido',
      };
    });
  }

  /** Documentos (receitas, atestados) entram com a frente de documentos e o reforço do login (R14). */
  meusDocumentos(sessao: SessaoDoPortal, req: RequisicaoParaSessao): Promise<{ itens: never[]; disponivel: false }> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'portal_documents', metadata: { op: 'portal_list', count: 0 } });
      return { itens: [], disponivel: false };
    });
  }

  // ------------------------------------------------------------ meus dados e pedidos do titular

  meusDados(
    sessao: SessaoDoPortal,
    req: RequisicaoParaSessao,
  ): Promise<{ nome: string; nomeSocial: string | null; telefone: string | null; cpfMascarado: string | null; nascimento: string | null }> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const p = await this.paciente(tx, ctx);
      const dec = (col: 'cpf' | 'phone' | 'birth_date', v: string | null) =>
        v === null ? Promise.resolve(null) : this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, p.id, col), v);
      const dto = {
        nome: p.displayName,
        nomeSocial: p.socialName,
        telefone: await dec('phone', p.phoneEnc),
        cpfMascarado: mascararCpf(await dec('cpf', p.cpfEnc)),
        nascimento: await dec('birth_date', p.birthDateEnc),
      };
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'patients', metadata: { op: 'portal_self' } });
      return dto;
    });
  }

  /** Registra o pedido para a clínica atender (nada é executado automaticamente). */
  abrirPedido(sessao: SessaoDoPortal, req: RequisicaoParaSessao, tipo: RightsRequestKind, detalhe: string | undefined): Promise<PedidoPortalDto> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const id = randomUUID();
      const detailEnc = detalhe ? await this.cifrarDetalhe(tx, ctx, id, detalhe) : null;
      const [row] = await tx
        .insert(portalRightsRequests)
        .values({
          id,
          tenantId: ctx.tenantId,
          patientId: ctx.pacienteId,
          linkId: ctx.vinculoId,
          accountId: ctx.contaId,
          kind: tipo,
          actingAs: ctx.agindoComo,
          protocol: novoProtocolo(),
          detailEnc,
        })
        .returning();
      if (!row) throw new Error('pedido não gravado');
      await this.auditar(tx, ctx, {
        action: AuditAction.Create,
        scope: 'portal_rights_requests',
        metadata: { request_id: id, kind: tipo, has_detail: detailEnc !== null, acting_as: ctx.agindoComo },
      });
      return this.pedidoDto(row, null);
    });
  }

  meusPedidos(sessao: SessaoDoPortal, req: RequisicaoParaSessao): Promise<PedidoPortalDto[]> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const linhas = await tx
        .select()
        .from(portalRightsRequests)
        .where(
          and(
            eq(portalRightsRequests.tenantId, ctx.tenantId),
            eq(portalRightsRequests.patientId, ctx.pacienteId),
            eq(portalRightsRequests.accountId, ctx.contaId),
          ),
        )
        .orderBy(desc(portalRightsRequests.createdAt))
        .limit(100);
      const itens: PedidoPortalDto[] = [];
      for (const r of linhas) {
        const resposta = situacaoParaOTitular(r.status) === 'respondido' ? await decifrarCampoPortal(this.cipher, tx, ctx.tenantId, r.id, 'answer', r.answerEnc) : null;
        itens.push(this.pedidoDto(r, resposta));
      }
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'portal_rights_requests', metadata: { op: 'portal_list', count: itens.length } });
      return itens;
    });
  }

  // ------------------------------------------------------------ central de privacidade

  meusConsentimentos(sessao: SessaoDoPortal, req: RequisicaoParaSessao): Promise<ConsentimentoPortalDto[]> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const eventos = await this.eventos(tx, ctx);
      const itens = (Object.keys(CONSENTIMENTOS) as PortalConsentPurpose[]).map((f): ConsentimentoPortalDto => {
        const ultimo = eventos.filter((e) => e.purpose === f).at(-1);
        const resposta = estadoDoConsentimento(ultimo?.response);
        return {
          finalidade: f,
          titulo: CONSENTIMENTOS[f].titulo,
          explicacao: CONSENTIMENTOS[f].explicacao,
          resposta,
          versaoTexto: VERSAO_TEXTOS_CONSENTIMENTO,
          atualizadoEm: ultimo?.createdAt.toISOString() ?? null,
          ...(f === 'escriba_ia' ? { estadoIa: consentimentoIa(resposta) } : {}),
        };
      });
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'portal_consents', metadata: { op: 'portal_list', count: itens.length } });
      return itens;
    });
  }

  /**
   * Responder (`sim`/`nao`) ou desfazer (`desfeito`): grava SEMPRE um evento novo (histórico append-only,
   * R15). Repetir a resposta atual não grava nada. Menor de 18 anos agindo como o próprio titular não
   * responde: LGPD art. 14 §1º (conservador até o parecer D8 ⚖️).
   */
  responderConsentimento(
    sessao: SessaoDoPortal,
    req: RequisicaoParaSessao,
    finalidade: PortalConsentPurpose,
    resposta: PortalConsentResponse,
  ): Promise<{ resposta: RespostaConsentimento }> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      if (ctx.agindoComo === 'titular') {
        const p = await this.paciente(tx, ctx);
        const nasc = p.birthDateEnc ? await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, p.id, 'birth_date'), p.birthDateEnc) : null;
        if (nasc && idadeEm(nasc, hojeNaClinica()) < IDADE_CONSENTIMENTO_PROPRIO) throw new ConflitoError('consentimento_pelo_responsavel');
      }
      const atual = estadoDoConsentimento((await this.eventos(tx, ctx)).filter((e) => e.purpose === finalidade).at(-1)?.response);
      if (resposta === 'desfeito' && atual === 'nao_respondido') throw new ConflitoError('nada_a_desfazer');
      if (resposta === atual) return { resposta: atual };
      await tx.insert(portalConsents).values({
        tenantId: ctx.tenantId,
        patientId: ctx.pacienteId,
        linkId: ctx.vinculoId,
        accountId: ctx.contaId,
        purpose: finalidade,
        response: resposta,
        actingAs: ctx.agindoComo,
        textVersion: VERSAO_TEXTOS_CONSENTIMENTO,
        textHash: hashDoTexto(finalidade),
      });
      await this.auditar(tx, ctx, {
        action: AuditAction.ConsentChange,
        scope: 'portal_consents',
        metadata: { purpose: finalidade, response: resposta, from: atual, text_version: VERSAO_TEXTOS_CONSENTIMENTO, acting_as: ctx.agindoComo },
      });
      return { resposta: estadoDoConsentimento(resposta) };
    });
  }

  historicoConsentimento(
    sessao: SessaoDoPortal,
    req: RequisicaoParaSessao,
    finalidade: PortalConsentPurpose,
  ): Promise<{ resposta: PortalConsentResponse; em: string; canal: 'portal'; agindoComo: PortalActingAs; versaoTexto: string }[]> {
    return this.noVinculo(sessao, req, async (tx, ctx) => {
      const itens = (await this.eventos(tx, ctx))
        .filter((e) => e.purpose === finalidade)
        .map((e) => ({ resposta: e.response, em: e.createdAt.toISOString(), canal: e.channel, agindoComo: e.actingAs, versaoTexto: e.textVersion }));
      await this.auditar(tx, ctx, { action: AuditAction.Read, scope: 'portal_consents', metadata: { op: 'portal_history', purpose: finalidade, count: itens.length } });
      return itens;
    });
  }

  // ------------------------------------------------------------ internos

  /**
   * Abre a transação do portal no vínculo da sessão. Sem vínculo escolhido: com um só, escolhe; com
   * vários, 409 `escolher_vinculo`; com nenhum, 409 `sem_vinculo`. Vínculo revogado: 403 `vinculo_inativo`.
   * Leitura respeita a janela de saída da clínica (G4); conta no limite por conta.
   */
  private async noVinculo<T>(
    sessao: SessaoDoPortal,
    req: RequisicaoParaSessao,
    fn: (tx: TenantTx, ctx: ContextoPortal) => Promise<T>,
  ): Promise<T> {
    let vinculoId = sessao.vinculoId;
    await this.vigilancia.requisicao(sessao.contaId, vinculoId);
    if (!vinculoId) {
      const ids = await this.vinculosDaConta(sessao.contaId);
      if (ids.length === 0) throw new ConflitoError('sem_vinculo');
      if (ids.length > 1) throw new ConflitoError('escolher_vinculo');
      vinculoId = ids[0] as string;
      await this.provider.escolherVinculo(req, vinculoId);
    }
    let aberta = false;
    try {
      return await comPoliticaDeAssinatura(this.db.runPortal(sessao.contaId, vinculoId, async (tx) => {
        aberta = true;
        const ctx = await this.contexto(tx, sessao.contaId, vinculoId);
        const t = await loadTenantSubscription(tx, ctx.tenantId);
        if (!canRead(t.status, t.cancelledAt, new Date(), EXIT_WINDOW_DAYS)) throw new ExitWindowClosedError();
        return fn(tx, ctx);
      }));
    } catch (e) {
      if (!aberta && codigoPg(e) === PG_INSUFFICIENT_PRIVILEGE) throw new ProibidoError('vinculo_inativo');
      throw e;
    }
  }

  private async vinculosDaConta(contaId: string): Promise<string[]> {
    return this.db.semContextoDoPortal(async (tx) => {
      const r = await tx.execute<{ link_id: string }>(sql`select link_id from app_portal_links_of_account(${contaId}::uuid)`);
      return r.map((x) => x.link_id);
    });
  }

  private async contexto(tx: TenantTx, contaId: string, vinculoId: string): Promise<ContextoPortal> {
    const [c] = await tx.execute<{ tenant_id: string; patient_id: string }>(
      sql`select app_current_tenant() as tenant_id, app_portal_patient() as patient_id`,
    );
    if (!c?.tenant_id || !c.patient_id) throw new ProibidoError('vinculo_inativo');
    const [l] = await tx
      .select({ actingAs: portalLinks.actingAs })
      .from(portalLinks)
      .where(and(eq(portalLinks.tenantId, c.tenant_id), eq(portalLinks.id, vinculoId)));
    if (!l) throw new ProibidoError('vinculo_inativo');
    return { tenantId: c.tenant_id as TenantId, pacienteId: c.patient_id, contaId, vinculoId, agindoComo: l.actingAs };
  }

  private async paciente(tx: TenantTx, ctx: ContextoPortal) {
    const [p] = await tx.select().from(patients).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, ctx.pacienteId)));
    if (!p) throw new NaoEncontradoError();
    return p;
  }

  private async dadosDaSaudacao(tx: TenantTx, ctx: ContextoPortal): Promise<{ clinica: string; primeiroNome: string }> {
    const [t] = await tx.select({ nome: tenants.displayName }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const p = await this.paciente(tx, ctx);
    return { clinica: t?.nome ?? '', primeiroNome: primeiroNome(p.displayName, p.socialName) };
  }

  private eventos(tx: TenantTx, ctx: ContextoPortal) {
    return tx
      .select()
      .from(portalConsents)
      .where(and(eq(portalConsents.tenantId, ctx.tenantId), eq(portalConsents.patientId, ctx.pacienteId)))
      .orderBy(asc(portalConsents.createdAt), asc(portalConsents.id));
  }

  private pedidoDto(r: typeof portalRightsRequests.$inferSelect, resposta: string | null): PedidoPortalDto {
    return {
      id: r.id,
      protocolo: r.protocol,
      tipo: r.kind,
      abertoEm: r.createdAt.toISOString(),
      prazo: r.dueAt.toISOString(),
      situacao: situacaoParaOTitular(r.status),
      resposta,
    };
  }

  /** O portal nunca provisiona chave (V2 do #68): clínica sem chave = 409, a clínica provisiona. */
  private async cifrarDetalhe(tx: TenantTx, ctx: ContextoPortal, id: string, detalhe: string): Promise<string> {
    try {
      return await cifrarCampoPortal(this.cipher, tx, ctx.tenantId, null, id, 'detail', detalhe);
    } catch (e) {
      if (e instanceof TenantKeyMissingError) throw new ConflitoError('clinica_sem_chave_de_dados');
      throw e;
    }
  }

  /** Trilha da clínica: ator = a conta do portal; sempre com o paciente e a marca do portal. */
  private auditar(tx: TenantTx, ctx: ContextoPortal, entry: AuditEntry): Promise<void> {
    return insertAudit(
      tx,
      { tenantId: ctx.tenantId, actorId: ctx.contaId, actorKind: 'paciente_portal' },
      { ...entry, metadata: { ...entry.metadata, patient_id: ctx.pacienteId, via: 'portal' } },
    );
  }
}

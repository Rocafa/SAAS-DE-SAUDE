import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  appointments,
  clinicalAddenda,
  clinicalRecordVersions,
  clinicalSettings,
  encounters,
  patients,
  professionals,
  type AiConsentState,
  type PsychCompartmentMode,
  type RecordTemplate,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { exigirConteudoClinico } from '../auth/vinculo-de-cuidado';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { comNegacaoAuditada } from './acesso-clinico';
import { faltasParaFinalizar, MODELOS, modeloPelaEspecialidade, validarConteudo, type ConteudoRegistro } from './modelos';
import { hashDaFinalizacao, MODO_PSICOLOGIA_PADRAO, podeVerConteudo } from './prontuario-regras';
import type { AberturaDeAtendimento, Paginacao, SalvamentoDeRegistro } from './prontuario.validation';
import { CAMPO_ADENDO, CAMPO_VERSAO, cifrarCampoClinico, decifrarCampoClinico } from './record-fields';

export interface AdendoDto {
  readonly id: string;
  readonly texto: string;
  readonly em: string;
  readonly autorId: string;
}

/**
 * Atendimento com o registro atual. `conteudo`/`adendos` vêm vazios com `conteudoOculto: true`
 * quando quem pede passou pelo porteiro mas o compartimento de psicologia é restrito ao autor.
 */
export interface AtendimentoDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly profissionalId: string;
  readonly agendamentoId: string;
  readonly autorId: string;
  readonly modelo: RecordTemplate;
  /** Compartimento de psicologia (sigilo): true para registros do modelo psicologia. */
  readonly restrito: boolean;
  /** Sigilo gravado na abertura (B1 do #63): vale para este atendimento, qualquer que seja a configuração atual. */
  readonly sigilo: PsychCompartmentMode;
  readonly status: 'aberto' | 'finalizado';
  readonly versao: number;
  readonly versaoModelo: number | null;
  readonly conteudo: ConteudoRegistro | null;
  readonly adendos: readonly AdendoDto[];
  readonly consentimentoIa: AiConsentState;
  readonly abertoEm: string;
  readonly atualizadoEm: string;
  readonly finalizadoEm: string | null;
  readonly finalizadoPor: string | null;
  readonly hashFinalizacao: string | null;
  readonly conteudoOculto: boolean;
  readonly motivoOculto?: 'sigilo_psicologia';
}

/** Pedido de troca do sigilo da psicologia (B1 do #63). */
export interface ConfiguracaoDeSigilo {
  readonly psicologia: PsychCompartmentMode;
  /** Só com `restrito_ao_autor`: restringe também os atendimentos já abertos em `prontuario_unico`. */
  readonly restringirAnteriores?: boolean;
}

export interface RespostaConfiguracao {
  readonly psicologia: PsychCompartmentMode;
  /** Sempre true: a troca não muda o sigilo dos atendimentos já abertos (salvo restringir). */
  readonly valeSoParaNovos: true;
  readonly anterioresRestringidos: number;
}

export interface VersaoDto {
  readonly versao: number;
  readonly versaoModelo: number;
  readonly criadaEm: string;
  readonly criadaPor: string;
  readonly conteudo: ConteudoRegistro;
}

export interface PaginaDeHistorico {
  readonly itens: readonly AtendimentoDto[];
  readonly pagina: number;
  readonly limite: number;
  readonly temMais: boolean;
}

type LinhaAtendimento = typeof encounters.$inferSelect;
type LinhaVersao = typeof clinicalRecordVersions.$inferSelect;
type LinhaAdendo = typeof clinicalAddenda.$inferSelect;

const SCOPE_ATENDIMENTOS = 'encounters';
const SCOPE_REGISTROS = 'clinical_records';
const SCOPE_ADENDOS = 'clinical_addenda';
const SCOPE_CONFIGURACAO = 'clinical_settings';
/** Status do agendamento que permitem abrir o atendimento (check-in feito ou já atendido). */
const STATUS_ABRE_ATENDIMENTO = ['checked_in', 'in_progress', 'completed'] as const;

/** Modo do compartimento de psicologia da clínica (sem linha = padrão mais protetor). */
export async function modoPsicologia(tx: TenantTx, tenantId: TenantId): Promise<PsychCompartmentMode> {
  const [c] = await tx
    .select({ modo: clinicalSettings.psychCompartment })
    .from(clinicalSettings)
    .where(eq(clinicalSettings.tenantId, tenantId));
  return c?.modo ?? MODO_PSICOLOGIA_PADRAO;
}

/**
 * Atendimento e prontuário (PRO-02.1, 02.3, 02.7, 03.7, 03.8). Regras de toda operação:
 * - transação da clínica DA SESSÃO (RLS) com a política de assinatura (G1/G4);
 * - perfil não clínico é negado antes de qualquer consulta; depois, `exigirConteudoClinico` (perfil
 *   clínico + vínculo de cuidado calculado no servidor) na MESMA transação que lê/grava o conteúdo;
 * - negação gravada na trilha (`clinical_access_denied`), em transação própria;
 * - auditoria da operação na mesma transação, só com ids, versão, modelo e a base do vínculo;
 * - conteúdo SÓ cifrado no banco (chave da clínica); versões e adendos nunca são alterados/apagados.
 * Abrir o atendimento NÃO cria vínculo: o porteiro roda antes e não há mudança de status aqui (a
 * agenda continua sendo o único caminho para "em atendimento", com as regras dela).
 */
@Injectable()
export class ProntuarioService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  /** Abre (ou devolve, se já aberto pelo mesmo autor) o atendimento do agendamento. */
  abrir(ctx: RequestContext, dados: AberturaDeAtendimento): Promise<AtendimentoDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'abrir', targetId: dados.agendamentoId }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        const [ag] = await tx
          .select()
          .from(appointments)
          .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, dados.agendamentoId)))
          .for('update');
        if (!ag) throw new NaoEncontradoError();
        // Porteiro ANTES de qualquer mudança: abrir atendimento não cria vínculo para ninguém.
        const vinculo = await exigirConteudoClinico(tx, ctx, ag.patientId);
        const [prof] = await tx
          .select()
          .from(professionals)
          .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, ag.professionalId)));
        // R1: só o profissional DO agendamento registra o atendimento dele.
        if (!prof?.userId || prof.userId !== ctx.userId || !prof.active) throw new ProibidoError('somente_o_autor');
        const [existente] = await tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.tenantId, ctx.tenantId), eq(encounters.appointmentId, ag.id)));
        if (existente) {
          await recordAudit(tx, ctx, {
            action: AuditAction.Read,
            scope: SCOPE_ATENDIMENTOS,
            metadata: { encounter_id: existente.id, patient_id: existente.patientId, care_basis: vinculo.base },
          });
          return this.montar(tx, ctx, existente);
        }
        if (!(STATUS_ABRE_ATENDIMENTO as readonly string[]).includes(ag.status)) throw new ConflitoError('agendamento_sem_chegada');
        const modelo = dados.modelo ?? modeloPelaEspecialidade(prof.specialty);
        // B1 do #63: o sigilo vigente AGORA fica gravado no atendimento e vale para sempre para ele.
        const sigilo = await modoPsicologia(tx, ctx.tenantId);
        const [e] = await tx
          .insert(encounters)
          .values({
            tenantId: ctx.tenantId,
            patientId: ag.patientId,
            professionalId: ag.professionalId,
            appointmentId: ag.id,
            authorUserId: ctx.userId,
            template: modelo,
            compartment: modelo === 'psicologia' ? 'psicologia' : 'geral',
            confidentiality: sigilo,
            aiConsent: dados.consentimentoIa ?? 'nao_informado',
          })
          .returning();
        if (!e) throw new Error('falha ao abrir atendimento');
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE_ATENDIMENTOS,
          metadata: {
            encounter_id: e.id,
            appointment_id: ag.id,
            patient_id: ag.patientId,
            template: modelo,
            confidentiality: e.confidentiality,
            ai_consent: e.aiConsent,
            care_basis: vinculo.base,
          },
        });
        return this.montar(tx, ctx, e);
      }),
    );
  }

  obter(ctx: RequestContext, id: string): Promise<AtendimentoDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'ler_atendimento', targetId: id }, () =>
      lerNaClinica(this.db, ctx, async (tx) => {
        const e = await this.atendimento(tx, ctx, id, false);
        const vinculo = await exigirConteudoClinico(tx, ctx, e.patientId);
        const dto = await this.montar(tx, ctx, e);
        await recordAudit(tx, ctx, {
          action: AuditAction.Read,
          scope: SCOPE_REGISTROS,
          metadata: { encounter_id: e.id, patient_id: e.patientId, version: e.currentVersion, hidden: dto.conteudoOculto, care_basis: vinculo.base },
        });
        return dto;
      }),
    );
  }

  /** Salvamento (inclui o automático): cada chamada grava uma VERSÃO nova; nada é sobrescrito. */
  salvar(ctx: RequestContext, id: string, dados: SalvamentoDeRegistro): Promise<AtendimentoDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'salvar_registro', targetId: id }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        const e = await this.atendimento(tx, ctx, id, true);
        const vinculo = await exigirConteudoClinico(tx, ctx, e.patientId);
        if (e.authorUserId !== ctx.userId) throw new ProibidoError('somente_o_autor');
        if (e.status !== 'open') throw new ConflitoError('registro_finalizado');
        if (dados.versaoBase !== e.currentVersion) throw new ConflitoError('versao_desatualizada');
        const conteudo = validarConteudo(e.template, dados.conteudo);
        const versaoId = randomUUID();
        const versao = e.currentVersion + 1;
        const contentEnc = await cifrarCampoClinico(this.cipher, tx, ctx, versaoId, CAMPO_VERSAO, JSON.stringify(conteudo));
        await tx.insert(clinicalRecordVersions).values({
          id: versaoId,
          tenantId: ctx.tenantId,
          encounterId: e.id,
          version: versao,
          template: e.template,
          templateVersion: MODELOS[e.template].versao,
          contentEnc,
          createdBy: ctx.userId,
        });
        const [atualizado] = await tx
          .update(encounters)
          .set({ currentVersion: versao, updatedAt: new Date() })
          .where(and(eq(encounters.tenantId, ctx.tenantId), eq(encounters.id, e.id)))
          .returning();
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE_REGISTROS,
          metadata: { encounter_id: e.id, patient_id: e.patientId, version: versao, template: e.template, care_basis: vinculo.base },
        });
        return this.montar(tx, ctx, atualizado ?? e);
      }),
    );
  }

  /** Finaliza (bloqueia edição): exige os campos obrigatórios do modelo na versão atual. */
  finalizar(ctx: RequestContext, id: string): Promise<AtendimentoDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'finalizar', targetId: id }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        const e = await this.atendimento(tx, ctx, id, true);
        const vinculo = await exigirConteudoClinico(tx, ctx, e.patientId);
        if (e.authorUserId !== ctx.userId) throw new ProibidoError('somente_o_autor');
        if (e.status !== 'open') throw new ConflitoError('registro_finalizado');
        if (e.currentVersion === 0) throw new ConflitoError('registro_vazio');
        const v = await this.versaoAtual(tx, ctx, e);
        const conteudo = await this.decifrarVersao(tx, ctx, v);
        const faltas = faltasParaFinalizar(e.template, conteudo);
        if (faltas.length > 0) throw new ConflitoError('registro_incompleto', faltas);
        const agora = new Date();
        const hash = hashDaFinalizacao({
          tenantId: ctx.tenantId,
          encounterId: e.id,
          versionId: v.id,
          version: v.version,
          template: v.template,
          templateVersion: v.templateVersion,
          contentEnc: v.contentEnc,
          signedAt: agora,
          signedBy: ctx.userId,
        });
        const [atualizado] = await tx
          .update(encounters)
          .set({ status: 'signed', signedAt: agora, signedBy: ctx.userId, signedVersion: v.version, signedHash: hash, updatedAt: agora })
          .where(and(eq(encounters.tenantId, ctx.tenantId), eq(encounters.id, e.id)))
          .returning();
        // Evento da North Star "encounter_record_signed" (HU-PRO-007): ação `sign`, sem dado pessoal.
        await recordAudit(tx, ctx, {
          action: AuditAction.Sign,
          scope: SCOPE_ATENDIMENTOS,
          metadata: { encounter_id: e.id, patient_id: e.patientId, version: v.version, hash, care_basis: vinculo.base },
        });
        return this.montar(tx, ctx, atualizado ?? e);
      }),
    );
  }

  /** Adendo datado, com autoria, só depois da finalização. */
  adendo(ctx: RequestContext, id: string, texto: string): Promise<AtendimentoDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'adendo', targetId: id }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        const e = await this.atendimento(tx, ctx, id, true);
        const vinculo = await exigirConteudoClinico(tx, ctx, e.patientId);
        if (!podeVerConteudo(e, ctx.userId)) throw new ProibidoError('sigilo_psicologia');
        if (e.status !== 'signed') throw new ConflitoError('registro_nao_finalizado');
        const adendoId = randomUUID();
        const textEnc = await cifrarCampoClinico(this.cipher, tx, ctx, adendoId, CAMPO_ADENDO, texto);
        await tx.insert(clinicalAddenda).values({ id: adendoId, tenantId: ctx.tenantId, encounterId: e.id, textEnc, createdBy: ctx.userId });
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE_ADENDOS,
          metadata: { encounter_id: e.id, patient_id: e.patientId, addendum_id: adendoId, care_basis: vinculo.base },
        });
        return this.montar(tx, ctx, e);
      }),
    );
  }

  /** Todas as versões do registro (a mais antiga primeiro): prova de que nada foi reescrito. */
  versoes(ctx: RequestContext, id: string): Promise<VersaoDto[]> {
    return comNegacaoAuditada(this.db, ctx, { op: 'versoes', targetId: id }, () =>
      lerNaClinica(this.db, ctx, async (tx) => {
        const e = await this.atendimento(tx, ctx, id, false);
        const vinculo = await exigirConteudoClinico(tx, ctx, e.patientId);
        if (!podeVerConteudo(e, ctx.userId)) throw new ProibidoError('sigilo_psicologia');
        const linhas = await tx
          .select()
          .from(clinicalRecordVersions)
          .where(and(eq(clinicalRecordVersions.tenantId, ctx.tenantId), eq(clinicalRecordVersions.encounterId, e.id)))
          .orderBy(asc(clinicalRecordVersions.version));
        const out: VersaoDto[] = [];
        for (const v of linhas) {
          out.push({
            versao: v.version,
            versaoModelo: v.templateVersion,
            criadaEm: v.createdAt.toISOString(),
            criadaPor: v.createdBy,
            conteudo: await this.decifrarVersao(tx, ctx, v),
          });
        }
        await recordAudit(tx, ctx, {
          action: AuditAction.Read,
          scope: SCOPE_REGISTROS,
          metadata: { encounter_id: e.id, patient_id: e.patientId, op: 'versions', count: out.length, care_basis: vinculo.base },
        });
        return out;
      }),
    );
  }

  /** Histórico clínico do paciente (PRO-02.7), do mais recente para o mais antigo, paginado. */
  historico(ctx: RequestContext, pacienteId: string, pag: Paginacao): Promise<PaginaDeHistorico> {
    return comNegacaoAuditada(this.db, ctx, { op: 'historico', patientId: pacienteId }, () =>
      lerNaClinica(this.db, ctx, async (tx) => {
        const [p] = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)));
        if (!p) throw new NaoEncontradoError();
        const vinculo = await exigirConteudoClinico(tx, ctx, pacienteId);
        const linhas = await tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.tenantId, ctx.tenantId), eq(encounters.patientId, pacienteId)))
          .orderBy(desc(encounters.openedAt), desc(encounters.id))
          .limit(pag.limite + 1)
          .offset((pag.pagina - 1) * pag.limite);
        const pagina = linhas.slice(0, pag.limite);
        const visiveis = pagina.filter((e) => podeVerConteudo(e, ctx.userId));
        const ids = visiveis.map((e) => e.id);
        const versoes = ids.length
          ? await tx
              .select({ v: clinicalRecordVersions })
              .from(clinicalRecordVersions)
              .innerJoin(
                encounters,
                and(
                  eq(encounters.id, clinicalRecordVersions.encounterId),
                  eq(encounters.tenantId, clinicalRecordVersions.tenantId),
                  eq(encounters.currentVersion, clinicalRecordVersions.version),
                ),
              )
              .where(and(eq(clinicalRecordVersions.tenantId, ctx.tenantId), inArray(clinicalRecordVersions.encounterId, ids)))
          : [];
        const adendos = ids.length
          ? await tx
              .select()
              .from(clinicalAddenda)
              .where(and(eq(clinicalAddenda.tenantId, ctx.tenantId), inArray(clinicalAddenda.encounterId, ids)))
              .orderBy(asc(clinicalAddenda.createdAt), asc(clinicalAddenda.id))
          : [];
        const itens: AtendimentoDto[] = [];
        for (const e of pagina) {
          const v = versoes.find((x) => x.v.encounterId === e.id)?.v ?? null;
          itens.push(
            await this.dto(
              tx,
              ctx,
              e,
              v,
              adendos.filter((a) => a.encounterId === e.id),
            ),
          );
        }
        await recordAudit(tx, ctx, {
          action: AuditAction.Read,
          scope: SCOPE_REGISTROS,
          metadata: {
            patient_id: pacienteId,
            op: 'history',
            count: itens.length,
            hidden: itens.filter((i) => i.conteudoOculto).length,
            page: pag.pagina,
            care_basis: vinculo.base,
          },
        });
        return { itens, pagina: pag.pagina, limite: pag.limite, temMais: linhas.length > pag.limite };
      }),
    );
  }

  obterConfiguracao(ctx: RequestContext): Promise<{ psicologia: PsychCompartmentMode }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const modo = await modoPsicologia(tx, ctx.tenantId);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_CONFIGURACAO, metadata: { psych_compartment: modo } });
      return { psicologia: modo };
    });
  }

  /**
   * Muda o sigilo do compartimento de psicologia (auditado como mudança de permissão). B1 do #63:
   * vale SÓ para atendimentos abertos depois da troca; os já abertos mantêm o sigilo gravado neles.
   * A única troca que pode alcançar os anteriores é a MAIS protetora (`restrito_ao_autor` com
   * `restringirAnteriores: true`), porque só restringe. Abrir registro antigo ao prontuário único
   * não existe (depende da pergunta 1.11 do advogado, com o autor e auditado).
   */
  definirConfiguracao(ctx: RequestContext, conf: ConfiguracaoDeSigilo): Promise<RespostaConfiguracao> {
    const modo = conf.psicologia;
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const anterior = await modoPsicologia(tx, ctx.tenantId);
      let restringidos = 0;
      if (modo === 'restrito_ao_autor' && conf.restringirAnteriores) {
        const linhas = await tx
          .update(encounters)
          .set({ confidentiality: 'restrito_ao_autor' })
          .where(
            and(
              eq(encounters.tenantId, ctx.tenantId),
              eq(encounters.compartment, 'psicologia'),
              eq(encounters.confidentiality, 'prontuario_unico'),
            ),
          )
          .returning({ id: encounters.id });
        restringidos = linhas.length;
      }
      await tx
        .insert(clinicalSettings)
        .values({ tenantId: ctx.tenantId, psychCompartment: modo, updatedBy: ctx.userId })
        .onConflictDoUpdate({
          target: clinicalSettings.tenantId,
          set: { psychCompartment: modo, updatedBy: ctx.userId, updatedAt: sql`now()` },
        });
      await recordAudit(tx, ctx, {
        action: AuditAction.PermissionChange,
        scope: SCOPE_CONFIGURACAO,
        metadata: { from: anterior, to: modo, applies_to: 'new_encounters', restricted_existing: restringidos },
      });
      // B1-d: a resposta diz ao admin que a troca só vale para os novos (a interface mostra isso);
      // o aviso aos psicólogos da clínica entra com o módulo de notificações (fila, antes do piloto).
      return { psicologia: modo, valeSoParaNovos: true, anterioresRestringidos: restringidos };
    });
  }

  // ---------------------------------------------------------------- apoio

  private async atendimento(tx: TenantTx, ctx: RequestContext, id: string, travar: boolean): Promise<LinhaAtendimento> {
    const q = tx
      .select()
      .from(encounters)
      .where(and(eq(encounters.tenantId, ctx.tenantId), eq(encounters.id, id)));
    const [e] = travar ? await q.for('update') : await q;
    if (!e) throw new NaoEncontradoError();
    return e;
  }

  private async versaoAtual(tx: TenantTx, ctx: RequestContext, e: LinhaAtendimento): Promise<LinhaVersao> {
    const [v] = await tx
      .select()
      .from(clinicalRecordVersions)
      .where(
        and(
          eq(clinicalRecordVersions.tenantId, ctx.tenantId),
          eq(clinicalRecordVersions.encounterId, e.id),
          eq(clinicalRecordVersions.version, e.currentVersion),
        ),
      );
    if (!v) throw new Error('versão atual ausente');
    return v;
  }

  private async decifrarVersao(tx: TenantTx, ctx: RequestContext, v: LinhaVersao): Promise<ConteudoRegistro> {
    return JSON.parse(await decifrarCampoClinico(this.cipher, tx, ctx.tenantId, v.id, CAMPO_VERSAO, v.contentEnc)) as ConteudoRegistro;
  }

  private async montar(tx: TenantTx, ctx: RequestContext, e: LinhaAtendimento): Promise<AtendimentoDto> {
    if (!podeVerConteudo(e, ctx.userId)) return this.dto(tx, ctx, e, null, []);
    const v = e.currentVersion > 0 ? await this.versaoAtual(tx, ctx, e) : null;
    const adendos = await tx
      .select()
      .from(clinicalAddenda)
      .where(and(eq(clinicalAddenda.tenantId, ctx.tenantId), eq(clinicalAddenda.encounterId, e.id)))
      .orderBy(asc(clinicalAddenda.createdAt), asc(clinicalAddenda.id));
    return this.dto(tx, ctx, e, v, adendos);
  }

  private async dto(
    tx: TenantTx,
    ctx: RequestContext,
    e: LinhaAtendimento,
    v: LinhaVersao | null,
    adendos: readonly LinhaAdendo[],
  ): Promise<AtendimentoDto> {
    const visivel = podeVerConteudo(e, ctx.userId);
    const base = {
      id: e.id,
      pacienteId: e.patientId,
      profissionalId: e.professionalId,
      agendamentoId: e.appointmentId,
      autorId: e.authorUserId,
      modelo: e.template,
      restrito: e.compartment === 'psicologia',
      sigilo: e.confidentiality,
      status: e.status === 'signed' ? ('finalizado' as const) : ('aberto' as const),
      versao: e.currentVersion,
      consentimentoIa: e.aiConsent,
      abertoEm: e.openedAt.toISOString(),
      atualizadoEm: e.updatedAt.toISOString(),
      finalizadoEm: e.signedAt?.toISOString() ?? null,
      finalizadoPor: e.signedBy,
      hashFinalizacao: e.signedHash,
    };
    if (!visivel) {
      return { ...base, versaoModelo: null, conteudo: null, adendos: [], conteudoOculto: true, motivoOculto: 'sigilo_psicologia' };
    }
    const lista: AdendoDto[] = [];
    for (const a of adendos) {
      lista.push({
        id: a.id,
        texto: await decifrarCampoClinico(this.cipher, tx, ctx.tenantId, a.id, CAMPO_ADENDO, a.textEnc),
        em: a.createdAt.toISOString(),
        autorId: a.createdBy,
      });
    }
    return {
      ...base,
      versaoModelo: v?.templateVersion ?? null,
      conteudo: v ? await this.decifrarVersao(tx, ctx, v) : null,
      adendos: lista,
      conteudoOculto: false,
    };
  }
}

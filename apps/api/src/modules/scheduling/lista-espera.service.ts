import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { dbErrorCode } from '../../db/db-errors';
import { patients, professionals, waitlistEntries } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import type { Perfil } from '../auth/perfis';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { noFusoDaClinica } from './agenda-regras';
import { MAXIMO_ITENS_ESPERA, observacaoRef, textoDaPreferencia } from './lista-espera-regras';
import type { FiltroEspera, MotivoDeRetirada, NovoItemEspera, validarMarcacaoDaEspera } from './lista-espera.validation';
import { SchedulingService, type AgendamentoDto } from './scheduling.service';

/** Item da lista de espera no contrato do front (`ItemEspera` de apps/web/lib/api/tipos.ts) mais o estruturado. */
export interface ItemEsperaDto {
  readonly id: string;
  readonly pacienteId: string;
  /** Texto pronto para a tela (dias, período e observação); "Qualquer horário" se nada foi informado. */
  readonly preferencia: string;
  /** AAAA-MM-DD no fuso da clínica (como o fake). */
  readonly criadoEm: string;
  /** Instante ISO-8601 da entrada na lista (ordem de entrada). */
  readonly entrouEm: string;
  readonly profissionalId: string | null;
  /** 0 = domingo … 6 = sábado; vazio = qualquer dia. */
  readonly dias: readonly number[];
  readonly periodo: 'manha' | 'tarde' | 'noite' | null;
  readonly observacao: string | null;
}

const SCOPE = 'waitlist';

type Linha = typeof waitlistEntries.$inferSelect;
type Marcacao = ReturnType<typeof validarMarcacaoDaEspera>;

/**
 * Lista de espera (HU-AGD-009, migração 0102). Mesmas garantias da agenda: clínica da sessão (RLS), política de
 * assinatura e auditoria na mesma transação, só com ids e códigos. A observação é cifrada com a chave da clínica e
 * NUNCA vai para a trilha nem para log. "Marcar a partir da espera" cria o agendamento pelo fluxo da agenda
 * (`SchedulingService.criarNaTransacao`, com todas as regras) e tira o item da lista na MESMA transação.
 */
@Injectable()
export class ListaEsperaService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(SchedulingService) private readonly agenda: SchedulingService,
  ) {}

  /**
   * Itens NA LISTA, de paciente ativo, em ordem de entrada. Com vaga (`profissionalId`, dia, período), só os
   * compatíveis: item sem preferência aceita qualquer valor. Quem não cuida da agenda (só `profissional`) vê só os
   * itens marcados para o profissional ligado ao seu usuário.
   */
  listar(ctx: RequestContext, perfis: readonly Perfil[], filtro: FiltroEspera): Promise<{ itens: ItemEsperaDto[]; truncado: boolean }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes: SQL[] = [eq(waitlistEntries.tenantId, ctx.tenantId), isNull(waitlistEntries.removedAt), eq(patients.active, true)];
      const soOsDele = !perfis.includes('admin') && !perfis.includes('recepcao');
      if (soOsDele) {
        const meus = await tx
          .select({ id: professionals.id })
          .from(professionals)
          .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.userId, ctx.userId), eq(professionals.active, true)));
        const ids = meus.map((p) => p.id);
        if (ids.length === 0) {
          await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { count: 0, own_only: true } });
          return { itens: [], truncado: false };
        }
        condicoes.push(inArray(waitlistEntries.professionalId, ids));
      }
      if (filtro.profissionalId) {
        condicoes.push(or(isNull(waitlistEntries.professionalId), eq(waitlistEntries.professionalId, filtro.profissionalId)) as SQL);
      }
      if (filtro.dia !== undefined) {
        condicoes.push(sql`(cardinality(${waitlistEntries.weekdays}) = 0 OR ${filtro.dia}::smallint = ANY(${waitlistEntries.weekdays}))`);
      }
      if (filtro.periodo !== undefined) {
        condicoes.push(or(isNull(waitlistEntries.period), eq(waitlistEntries.period, filtro.periodo)) as SQL);
      }
      const linhas = await tx
        .select({ w: waitlistEntries })
        .from(waitlistEntries)
        .innerJoin(patients, and(eq(patients.tenantId, waitlistEntries.tenantId), eq(patients.id, waitlistEntries.patientId)))
        .where(and(...condicoes))
        .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
        .limit(MAXIMO_ITENS_ESPERA + 1);
      const truncado = linhas.length > MAXIMO_ITENS_ESPERA;
      const itens: ItemEsperaDto[] = [];
      for (const { w } of linhas.slice(0, MAXIMO_ITENS_ESPERA)) itens.push(await this.paraDto(tx, ctx.tenantId, w));
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE,
        metadata: { count: itens.length, own_only: soOsDele, ...(filtro.profissionalId ? { professional_id: filtro.profissionalId } : {}) },
      });
      return { itens, truncado };
    });
  }

  /** Coloca na lista. 409 `paciente_inativo`; 409 `ja_na_espera` (mesmo paciente e profissional já na lista). */
  async adicionar(ctx: RequestContext, dados: NovoItemEspera): Promise<ItemEsperaDto> {
    try {
      return await escreverNaClinica(this.db, ctx, async (tx) => {
        const [paciente] = await tx
          .select({ ativo: patients.active })
          .from(patients)
          .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, dados.pacienteId)));
        if (!paciente) throw new NaoEncontradoError();
        if (!paciente.ativo) throw new ConflitoError('paciente_inativo');
        if (dados.profissionalId) {
          const [prof] = await tx
            .select({ id: professionals.id })
            .from(professionals)
            .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, dados.profissionalId), eq(professionals.active, true)));
          if (!prof) throw new NaoEncontradoError();
        }
        // Duas recepções colocando o mesmo paciente ao mesmo tempo: a segunda espera e vê o item (o índice único é a rede).
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`espera:${ctx.tenantId}:${dados.pacienteId}`}, 0))`);
        const profissional = dados.profissionalId ?? null;
        const [existente] = await tx
          .select({ id: waitlistEntries.id })
          .from(waitlistEntries)
          .where(
            and(
              eq(waitlistEntries.tenantId, ctx.tenantId),
              eq(waitlistEntries.patientId, dados.pacienteId),
              isNull(waitlistEntries.removedAt),
              profissional ? eq(waitlistEntries.professionalId, profissional) : isNull(waitlistEntries.professionalId),
            ),
          );
        if (existente) throw new ConflitoError('ja_na_espera');
        const id = randomUUID();
        const [linha] = await tx
          .insert(waitlistEntries)
          .values({
            id,
            tenantId: ctx.tenantId,
            patientId: dados.pacienteId,
            professionalId: profissional,
            weekdays: [...dados.dias],
            period: dados.periodo,
            noteEnc: dados.observacao === null ? null : await this.cifrar(tx, ctx, id, dados.observacao),
            createdBy: ctx.userId,
          })
          .returning();
        if (!linha) throw new Error('falha ao colocar na lista de espera');
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE,
          metadata: {
            waitlist_id: linha.id,
            patient_id: linha.patientId,
            ...(linha.professionalId ? { professional_id: linha.professionalId } : {}),
            weekdays: linha.weekdays.length,
            ...(linha.period ? { period: linha.period } : {}),
            has_note: linha.noteEnc !== null,
          },
        });
        return this.paraDto(tx, ctx.tenantId, linha, dados.observacao);
      });
    } catch (e) {
      // Rede de segurança do índice único (corrida que escapou da trava).
      if (dbErrorCode(e) === '23505') throw new ConflitoError('ja_na_espera');
      throw e;
    }
  }

  /** Tira da lista (DELETE lógico). Devolve o item como estava, para o "Desfazer". 404 se não está na lista. */
  retirar(ctx: RequestContext, id: string, motivo: MotivoDeRetirada): Promise<ItemEsperaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travar(tx, ctx, id);
      if (atual.removedAt) throw new NaoEncontradoError();
      await tx
        .update(waitlistEntries)
        .set({ removedAt: new Date(), removedBy: ctx.userId, removalReason: motivo })
        .where(and(eq(waitlistEntries.tenantId, ctx.tenantId), eq(waitlistEntries.id, id)));
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { waitlist_id: id, op: 'remove', reason: motivo } });
      return this.paraDto(tx, ctx.tenantId, atual);
    });
  }

  /**
   * "Desfazer" da retirada: o item volta com a MESMA posição (data de entrada). Agendado não volta (409
   * `espera_agendada`); paciente inativo não volta (409 `paciente_inativo`); já na lista: idempotente.
   */
  async devolver(ctx: RequestContext, id: string): Promise<ItemEsperaDto> {
    try {
      return await escreverNaClinica(this.db, ctx, async (tx) => {
        const atual = await this.travar(tx, ctx, id);
        if (!atual.removedAt) return this.paraDto(tx, ctx.tenantId, atual);
        if (atual.removalReason === 'agendado') throw new ConflitoError('espera_agendada');
        const [paciente] = await tx
          .select({ ativo: patients.active })
          .from(patients)
          .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, atual.patientId)));
        if (!paciente?.ativo) throw new ConflitoError('paciente_inativo');
        const [linha] = await tx
          .update(waitlistEntries)
          .set({ removedAt: null, removedBy: null, removalReason: null })
          .where(and(eq(waitlistEntries.tenantId, ctx.tenantId), eq(waitlistEntries.id, id)))
          .returning();
        if (!linha) throw new NaoEncontradoError();
        await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { waitlist_id: id, op: 'restore' } });
        return this.paraDto(tx, ctx.tenantId, linha);
      });
    } catch (e) {
      // O paciente voltou para a lista por outro item enquanto este estava fora.
      if (dbErrorCode(e) === '23505') throw new ConflitoError('ja_na_espera');
      throw e;
    }
  }

  /**
   * Marca a partir da espera: trava o item, cria o agendamento com TODAS as regras da agenda (paciente ativo,
   * profissional e tipo ativos, não no passado, capacidade sob trava, auditoria) e tira o item da lista com motivo
   * `agendado` e o id do agendamento, tudo numa transação: se a agenda recusar (ex.: 409 `horario_lotado`), o item
   * continua na lista. Ordem das travas: item -> agenda do profissional -> trilha (nenhum caminho faz o inverso).
   */
  marcar(ctx: RequestContext, id: string, dados: Marcacao): Promise<{ agendamento: AgendamentoDto; esperaId: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travar(tx, ctx, id);
      if (atual.removedAt) throw new NaoEncontradoError();
      const profissionalId = dados.profissionalId ?? atual.professionalId;
      if (!profissionalId) throw new ConflitoError('espera_sem_profissional');
      const agendamento = await this.agenda.criarNaTransacao(tx, ctx, {
        pacienteId: atual.patientId,
        profissionalId,
        tipoId: dados.tipoId,
        data: dados.data,
        hora: dados.hora,
        encaixe: dados.encaixe,
      });
      await tx
        .update(waitlistEntries)
        .set({ removedAt: new Date(), removedBy: ctx.userId, removalReason: 'agendado', appointmentId: agendamento.id })
        .where(and(eq(waitlistEntries.tenantId, ctx.tenantId), eq(waitlistEntries.id, id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { waitlist_id: id, op: 'schedule', reason: 'agendado', appointment_id: agendamento.id },
      });
      return { agendamento, esperaId: id };
    });
  }

  /**
   * Job `lista-espera-retencao`: apaga os itens que saíram da lista há mais de 30 dias e os de paciente inativado há
   * mais de 30 dias (prazo no banco, app_waitlist_purge_run). Ator `sistema`; trilha só com a contagem.
   */
  purgarComoSistema(tenantId: TenantId): Promise<{ readonly apagados: number }> {
    const ctx: RequestContext = { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] };
    return this.db.run(tenantId, async (tx) => {
      const [r] = await tx.execute<{ n: number }>(sql`select app_waitlist_purge_run() as n`);
      const apagados = Number(r?.n ?? 0);
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { op: 'purge_run', purged: apagados } });
      return { apagados };
    });
  }

  private async travar(tx: TenantTx, ctx: RequestContext, id: string): Promise<Linha> {
    const [linha] = await tx
      .select()
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.tenantId, ctx.tenantId), eq(waitlistEntries.id, id)))
      .for('update');
    if (!linha) throw new NaoEncontradoError();
    return linha;
  }

  private async paraDto(tx: TenantTx, tenantId: TenantId, w: Linha, observacaoEmClaro?: string | null): Promise<ItemEsperaDto> {
    const observacao =
      observacaoEmClaro !== undefined ? observacaoEmClaro : w.noteEnc === null ? null : await this.cipher.decryptString(tx, observacaoRef(tenantId, w.id), w.noteEnc);
    const dias = [...w.weekdays];
    return {
      id: w.id,
      pacienteId: w.patientId,
      preferencia: textoDaPreferencia(dias, w.period, observacao),
      criadoEm: noFusoDaClinica(w.createdAt).data,
      entrouEm: w.createdAt.toISOString(),
      profissionalId: w.professionalId,
      dias,
      periodo: w.period,
      observacao,
    };
  }

  private async cifrar(tx: TenantTx, ctx: RequestContext, rowId: string, valor: string): Promise<string> {
    const ref = observacaoRef(ctx.tenantId, rowId);
    try {
      return await this.cipher.encrypt(tx, ref, valor);
    } catch (e) {
      if (!(e instanceof TenantKeyMissingError)) throw e;
      // Primeira escrita cifrada da clínica: provisiona a chave (idempotente, auditado) e tenta de novo.
      await this.cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
      return this.cipher.encrypt(tx, ref, valor);
    }
  }
}

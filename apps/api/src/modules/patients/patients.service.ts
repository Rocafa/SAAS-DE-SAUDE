import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, eq, like, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { IDADE_MAIORIDADE } from '../finance/financeiro-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { patientFieldRef, type PatientEncryptedColumn } from './patient-fields';
import { aniversarioDe, REGRA_INFORMACAO_CLINICA } from './responsaveis-regras';
import {
  normalizarBusca,
  type AlteracaoPaciente,
  type FiltroPacientes,
  type NovoPaciente,
} from './patients.validation';

/** Cadastro completo (detalhe). Sem conteúdo clínico: não existe prontuário nesta rodada. */
export interface PacienteDto {
  readonly id: string;
  readonly nome: string;
  readonly nomeSocial: string | null;
  readonly cpf: string | null;
  readonly telefone: string | null;
  readonly nascimento: string | null;
  readonly ativo: boolean;
}

/** Item da lista: o mínimo para achar o paciente. CPF/telefone/nascimento só no detalhe. */
export interface PacienteResumoDto {
  readonly id: string;
  readonly nome: string;
  readonly nomeSocial: string | null;
  readonly ativo: boolean;
}

export interface PaginaDePacientes {
  readonly itens: readonly PacienteResumoDto[];
  readonly pagina: number;
  readonly limite: number;
  readonly temMais: boolean;
}

const SCOPE = 'patients';

/** Escapa curingas do LIKE (o padrão do Postgres usa `\` como escape). */
function padraoContem(termo: string): string {
  return `%${termo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Pacientes: cada operação roda numa transação da clínica DA SESSÃO (withTenant + RLS), passa pela
 * política de assinatura (escrita: G1; leitura: G4) e grava auditoria na mesma transação — sem
 * registro de auditoria, a operação não acontece. A auditoria leva só ids e contagens.
 */
@Injectable()
export class PatientsService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  listar(ctx: RequestContext, filtro: FiltroPacientes): Promise<PaginaDePacientes> {
    return this.leitura(ctx, async (tx) => {
      const condicoes: SQL[] = [eq(patients.tenantId, ctx.tenantId)];
      if (filtro.situacao !== 'todos') condicoes.push(eq(patients.active, filtro.situacao === 'ativos'));
      if (filtro.busca) condicoes.push(like(patients.searchName, padraoContem(filtro.busca)));
      const linhas = await tx
        .select({
          id: patients.id,
          nome: patients.displayName,
          nomeSocial: patients.socialName,
          ativo: patients.active,
        })
        .from(patients)
        .where(and(...condicoes))
        .orderBy(asc(patients.searchName), asc(patients.id))
        .limit(filtro.limite + 1)
        .offset((filtro.pagina - 1) * filtro.limite);
      const temMais = linhas.length > filtro.limite;
      const itens = linhas.slice(0, filtro.limite);
      // O termo de busca é nome de paciente: não entra na auditoria, só o fato de ter havido busca.
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE,
        metadata: { count: itens.length, page: filtro.pagina, search: filtro.busca !== undefined },
      });
      return { itens, pagina: filtro.pagina, limite: filtro.limite, temMais };
    });
  }

  obter(ctx: RequestContext, id: string): Promise<PacienteDto> {
    return this.leitura(ctx, async (tx) => {
      const [linha] = await tx
        .select()
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)));
      if (!linha) throw new NaoEncontradoError();
      const dto = await this.paraDto(tx, ctx.tenantId, linha);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { patient_id: id } });
      return dto;
    });
  }

  criar(ctx: RequestContext, dados: NovoPaciente): Promise<PacienteDto> {
    return this.escrita(ctx, async (tx) => {
      const id = randomUUID();
      const nomeSocial = dados.nomeSocial ?? null;
      await tx.insert(patients).values(await this.prepararInsercao(tx, ctx, id, dados));
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: SCOPE, metadata: { patient_id: id } });
      return {
        id,
        nome: dados.nome,
        nomeSocial,
        cpf: dados.cpf ?? null,
        telefone: dados.telefone,
        nascimento: dados.nascimento ?? null,
        ativo: true,
      };
    });
  }

  atualizar(ctx: RequestContext, id: string, dados: AlteracaoPaciente): Promise<PacienteDto> {
    return this.escrita(ctx, async (tx) => {
      const atual = await this.travar(tx, ctx, id);
      if (!atual.active) throw new ConflitoError('paciente_inativo');
      const nome = dados.nome ?? atual.displayName;
      const nomeSocial = dados.nomeSocial === undefined ? atual.socialName : dados.nomeSocial;
      const campos: string[] = [];
      const mudancas: Partial<typeof patients.$inferInsert> = { updatedAt: new Date() };
      if (dados.nome !== undefined || dados.nomeSocial !== undefined) {
        mudancas.displayName = nome;
        mudancas.socialName = nomeSocial;
        mudancas.searchName = normalizarBusca(`${nome} ${nomeSocial ?? ''}`);
        if (dados.nome !== undefined) campos.push('name');
        if (dados.nomeSocial !== undefined) campos.push('social_name');
      }
      if (dados.cpf !== undefined) {
        mudancas.cpfEnc = await this.cifrarOpcional(tx, ctx, id, 'cpf', dados.cpf ?? undefined);
        campos.push('cpf');
      }
      if (dados.telefone !== undefined) {
        mudancas.phoneEnc = await this.cifrar(tx, ctx, id, 'phone', dados.telefone);
        campos.push('phone');
      }
      if (dados.nascimento !== undefined) {
        mudancas.birthDateEnc = await this.cifrarOpcional(tx, ctx, id, 'birth_date', dados.nascimento ?? undefined);
        campos.push('birth_date');
      }
      const [linha] = await tx
        .update(patients)
        .set(mudancas)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)))
        .returning();
      if (!linha) throw new NaoEncontradoError();
      // Só os NOMES das colunas alteradas, nunca os valores (antes/depois).
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { patient_id: id, changed: campos.join(',') },
      });
      if (dados.nascimento !== undefined) await this.recalcularSigiloDoPortal(tx, id, dados.nascimento ?? null);
      return this.paraDto(tx, ctx.tenantId, linha);
    });
  }

  /**
   * N3 do #68 (conferência de 22/10) e R1 do #73: a data de nascimento mudou. O gatilho da 0038 marcou a
   * mudança nesta transação; aqui o serviço recalcula pelo dia dos 12 (sigilo do adolescente) e dos 18 (fim
   * da representação) da data nova. Sem data válida, fecha. O banco só reabre com a marca desta transação
   * (que consome) e grava a trilha com os valores antigos e novos; se ninguém recalcular, o COMMIT fecha.
   */
  private async recalcularSigiloDoPortal(tx: TenantTx, id: string, nascimento: string | null): Promise<void> {
    const valida = nascimento !== null && /^\d{4}-\d{2}-\d{2}$/.test(nascimento);
    const sigilo = valida ? aniversarioDe(nascimento, REGRA_INFORMACAO_CLINICA.idadeInicioAdolescencia) : null;
    const maioridade = valida ? aniversarioDe(nascimento, IDADE_MAIORIDADE) : null;
    await tx.execute(sql`select app_portal_recalc_sigilo(${id}::uuid, ${sigilo}::date, ${maioridade}::date)`);
  }

  /** Inativar, nunca apagar (retenção por conselho; front-r8 R4). Idempotente. */
  inativar(ctx: RequestContext, id: string): Promise<{ id: string; ativo: false }> {
    return this.escrita(ctx, async (tx) => {
      const atual = await this.travar(tx, ctx, id);
      if (atual.active) {
        await tx
          .update(patients)
          .set({ active: false, inactivatedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)));
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE,
          metadata: { patient_id: id, changed: 'active' },
        });
      }
      return { id, ativo: false as const };
    });
  }

  /**
   * Linha de `patients` pronta para INSERT, com as MESMAS regras do cadastro: nome de busca normalizado e
   * CPF/telefone/nascimento cifrados com a chave da clínica (provisionada na primeira escrita). Usada pelo
   * cadastro e pelo importador (inserção em lote na transação do chamador, que audita). `dados` já validado.
   */
  async prepararInsercao(tx: TenantTx, ctx: RequestContext, id: string, dados: NovoPaciente): Promise<typeof patients.$inferInsert> {
    const nomeSocial = dados.nomeSocial ?? null;
    return {
      id,
      tenantId: ctx.tenantId,
      displayName: dados.nome,
      socialName: nomeSocial,
      searchName: normalizarBusca(`${dados.nome} ${nomeSocial ?? ''}`),
      cpfEnc: await this.cifrarOpcional(tx, ctx, id, 'cpf', dados.cpf),
      phoneEnc: await this.cifrar(tx, ctx, id, 'phone', dados.telefone),
      birthDateEnc: await this.cifrarOpcional(tx, ctx, id, 'birth_date', dados.nascimento),
    };
  }

  private async travar(tx: TenantTx, ctx: RequestContext, id: string): Promise<typeof patients.$inferSelect> {
    const [linha] = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)))
      .for('update');
    if (!linha) throw new NaoEncontradoError();
    return linha;
  }

  private leitura<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return lerNaClinica(this.db, ctx, fn);
  }

  private escrita<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return escreverNaClinica(this.db, ctx, fn);
  }

  private async cifrar(tx: TenantTx, ctx: RequestContext, rowId: string, coluna: PatientEncryptedColumn, valor: string): Promise<string> {
    const ref = patientFieldRef(ctx.tenantId, rowId, coluna);
    try {
      return await this.cipher.encrypt(tx, ref, valor);
    } catch (e) {
      if (!(e instanceof TenantKeyMissingError)) throw e;
      // Primeira escrita cifrada da clínica: provisiona a chave (idempotente, auditado) e tenta de novo.
      await this.cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
      return this.cipher.encrypt(tx, ref, valor);
    }
  }

  private async cifrarOpcional(
    tx: TenantTx,
    ctx: RequestContext,
    rowId: string,
    coluna: PatientEncryptedColumn,
    valor: string | undefined,
  ): Promise<string | null> {
    return valor === undefined ? null : this.cifrar(tx, ctx, rowId, coluna, valor);
  }

  private async decifrar(tx: TenantTx, tenantId: TenantId, rowId: string, coluna: PatientEncryptedColumn, valor: string | null) {
    return valor === null ? null : this.cipher.decryptString(tx, patientFieldRef(tenantId, rowId, coluna), valor);
  }

  private async paraDto(tx: TenantTx, tenantId: TenantId, linha: typeof patients.$inferSelect): Promise<PacienteDto> {
    return {
      id: linha.id,
      nome: linha.displayName,
      nomeSocial: linha.socialName,
      cpf: await this.decifrar(tx, tenantId, linha.id, 'cpf', linha.cpfEnc),
      telefone: await this.decifrar(tx, tenantId, linha.id, 'phone', linha.phoneEnc),
      nascimento: await this.decifrar(tx, tenantId, linha.id, 'birth_date', linha.birthDateEnc),
      ativo: linha.active,
    };
  }
}

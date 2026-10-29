import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, type PaginaPorCursor, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, eq, like, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { CURSOR_DE_PAGINACAO, CursorDePaginacao, type PosicaoLida } from './cursor-de-paginacao';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { IndiceCegoCpf } from './cpf-indice-cego';
import { patientFieldRef, type PatientEncryptedColumn } from './patient-fields';
import { hojeNaClinica } from '../insurance/guias-regras';
import { correcaoDeNascimentoExigeDocumento } from '../portal/portal-regras';
import { documentoNaoConferido, exigirPerfilQueConfere, nascimentoVigente, recalcularSigiloDoPortal } from './nascimento-do-cadastro';
import {
  normalizarBusca,
  PAGINA_MAXIMA,
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

/** Página com `proximoCursor` opaco e assinado (R5 do parecer #76; contrato em `@plataforma/shared`). */
export type PaginaDePacientes = PaginaPorCursor<PacienteResumoDto>;

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
  private readonly logger = new Logger('PatientsService');
  /** Índice cego do CPF por clínica (0046, R9 do importador): gravado junto com o CPF cifrado. */
  readonly indiceCpf: IndiceCegoCpf;

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
    @Inject(CURSOR_DE_PAGINACAO) private readonly cursor: CursorDePaginacao,
  ) {
    this.indiceCpf = new IndiceCegoCpf(cipher);
  }

  /**
   * Job `cpf-indice-reindexacao` (R9 do importador; observação "antes do GA" da conferência R3-a/R3-b):
   * os passos 2 e 3 da troca de chave do índice (api-dominio.md §12d) rodando sozinhos, todo dia, como
   * `sistema`. Cobre os pacientes anteriores à 0046, os que ficaram sem índice (gatilho de índice ausente) e o
   * que sobrou de um `girarChave`. Sem pendente, não decifra nada nem cria chave. Cada lote é uma transação
   * curta da clínica (`reindexar` trava as linhas do lote); no máximo `maxLotes` por dia, o resto fica para
   * a rodada seguinte. Com tudo na chave ativa, destrói as versões aposentadas sem paciente (o banco recusa
   * destruir versão em uso). Trilha e retorno só com contagens.
   */
  async reindexarIndiceCpfComoSistema(
    tenantId: TenantId,
    opcoes: { readonly lote?: number; readonly maxLotes?: number } = {},
  ): Promise<{ readonly reindexados: number; readonly pendentes: number; readonly chavesDescartadas: number }> {
    const ctx: RequestContext = { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] };
    const lote = opcoes.lote ?? 500;
    const maxLotes = opcoes.maxLotes ?? 20;
    let reindexados = 0;
    let pendentes = await this.db.run(tenantId, (tx) => this.indiceCpf.pendentes(tx, tenantId));
    for (let i = 0; pendentes > 0 && i < maxLotes; i++) {
      const r = await this.db.run(tenantId, (tx) => this.indiceCpf.reindexar(tx, ctx, lote));
      reindexados += r.reindexados;
      pendentes = r.pendentes;
      if (r.reindexados === 0) break;
    }
    const chavesDescartadas =
      pendentes > 0
        ? 0
        : await this.db.run(tenantId, async (tx) => ((await this.indiceCpf.temChaveAposentada(tx, tenantId)) ? this.indiceCpf.descartarChavesAntigas(tx, ctx) : 0));
    return { reindexados, pendentes, chavesDescartadas };
  }

  /**
   * Lista por keyset (nome de busca, id). A página 2 em diante só sai com cursor assinado desta sessão
   * e deste filtro (R5 do parecer #76); o cursor é conferido ANTES de abrir a transação, então cursor
   * recusado não lê nada nem grava auditoria de leitura (a vigilância já contou a chamada).
   */
  async listar(ctx: RequestContext, filtro: FiltroPacientes): Promise<PaginaDePacientes> {
    const amarra = { situacao: filtro.situacao, limite: filtro.limite, ...(filtro.busca !== undefined ? { busca: filtro.busca } : {}) };
    const posicao: PosicaoLida | undefined = filtro.cursor === undefined ? undefined : this.cursor.ler(ctx, amarra, filtro.cursor);
    const pagina = posicao?.pagina ?? 1;
    return this.leitura(ctx, async (tx) => {
      const condicoes: SQL[] = [eq(patients.tenantId, ctx.tenantId)];
      if (filtro.situacao !== 'todos') condicoes.push(eq(patients.active, filtro.situacao === 'ativos'));
      if (filtro.busca) condicoes.push(like(patients.searchName, padraoContem(filtro.busca)));
      if (posicao) {
        // Âncora pelo id técnico (o nome nunca vai no cursor), sem filtrar situação: inativar a âncora não
        // muda a posição dela na ordem. Sumiu ou mudou de nome de busca = 409, antes da auditoria (R9; §3b).
        const [ancora] = await tx
          .select({ nome: patients.searchName, id: patients.id })
          .from(patients)
          .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, posicao.depoisDe)));
        this.cursor.conferirAncora(posicao, ancora?.nome);
        condicoes.push(sql`(${patients.searchName}, ${patients.id}) > (${ancora!.nome}, ${ancora!.id}::uuid)`);
      }
      const linhas = await tx
        .select({
          id: patients.id,
          nome: patients.displayName,
          nomeSocial: patients.socialName,
          ativo: patients.active,
          nomeDeBusca: patients.searchName,
        })
        .from(patients)
        .where(and(...condicoes))
        .orderBy(asc(patients.searchName), asc(patients.id))
        .limit(filtro.limite + 1);
      const daPagina = linhas.slice(0, filtro.limite);
      // O nome de busca só serve para a marca da âncora; não sai na resposta.
      const itens: PacienteResumoDto[] = daPagina.map(({ id, nome, nomeSocial, ativo }) => ({ id, nome, nomeSocial, ativo }));
      const ultima = daPagina[daPagina.length - 1];
      // Limite de páginas como antes (PAGINA_MAXIMA): depois da última permitida não há cursor.
      const temMais = linhas.length > filtro.limite && pagina < PAGINA_MAXIMA;
      // O termo de busca é nome de paciente: não entra na auditoria, só o fato de ter havido busca.
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE,
        metadata: { count: itens.length, page: pagina, search: filtro.busca !== undefined },
      });
      const proximoCursor =
        temMais && ultima ? this.cursor.assinar(ctx, amarra, { pagina: pagina + 1, depoisDe: ultima.id, nomeDaAncora: ultima.nomeDeBusca }) : null;
      return { itens, pagina, limite: filtro.limite, temMais, proximoCursor };
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
      // R9 (0046): o índice cego anda junto com o CPF; mesmo CPF não reescreve nada (nem a cifra nem o índice).
      if (dados.cpf !== undefined && (dados.cpf ?? null) !== (await this.decifrar(tx, ctx.tenantId, id, 'cpf', atual.cpfEnc))) {
        mudancas.cpfEnc = await this.cifrarOpcional(tx, ctx, id, 'cpf', dados.cpf ?? undefined);
        const indice = dados.cpf ? await this.indiceCpf.indexar(tx, ctx, dados.cpf) : null;
        mudancas.cpfBidx = indice?.cpfBidx ?? null;
        mudancas.cpfBidxVersion = indice?.cpfBidxVersion ?? null;
        campos.push('cpf');
      }
      if (dados.telefone !== undefined) {
        mudancas.phoneEnc = await this.cifrar(tx, ctx, id, 'phone', dados.telefone);
        campos.push('phone');
      }
      // R1/R3 do #73: só reescreve a data cifrada (e recalcula o sigilo do portal) quando a data MUDOU de fato.
      // Data vigente ilegível (Conferência 0052, ressalva 2): conta como desconhecida e como mudança.
      const antes = dados.nascimento !== undefined ? await nascimentoVigente(this.cipher, tx, ctx.tenantId, id, atual.birthDateEnc) : null;
      const nascimentoAntes = antes?.valor ?? null;
      const nascimentoMudou = dados.nascimento !== undefined && (antes?.ilegivel === true || (dados.nascimento ?? null) !== nascimentoAntes);
      // C1-b′ (conferência de 24/10): reduzir a idade de paciente com 12 anos ou mais (ou de data atual
      // desconhecida/ilegível) exige documento conferido, com a MESMA regra (e o mesmo 422) do pedido de
      // correção pelo portal. Apagar a data não exige (o recálculo fecha: sigilo liga, representação acaba).
      // 0053: só admin ou profissional declara a conferência (403 `conferencia_exige_perfil`; o banco confere).
      const exigeDocumento =
        nascimentoMudou && typeof dados.nascimento === 'string' && correcaoDeNascimentoExigeDocumento(nascimentoAntes, dados.nascimento, hojeNaClinica());
      if (exigeDocumento && dados.documentoConferido !== true) throw documentoNaoConferido();
      const documentoConferido = nascimentoMudou && dados.documentoConferido === true;
      if (documentoConferido) exigirPerfilQueConfere(ctx);
      if (nascimentoMudou) {
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
        metadata: {
          patient_id: id,
          changed: campos.join(','),
          ...(nascimentoMudou
            ? { document_required: exigeDocumento, document_checked: documentoConferido, ...(antes?.ilegivel ? { birth_date_unreadable: true } : {}) }
            : {}),
        },
      });
      if (nascimentoMudou) {
        // A marca de conferência vai na marca da mudança da data desta transação (0052/0053): o recálculo do banco
        // recusa empurrar o sigilo de quem já tinha 12+ sem ela. A função grava a trilha com o usuário e o perfil.
        await recalcularSigiloDoPortal(tx, this.logger, {
          pacienteId: id,
          nascimento: dados.nascimento ?? null,
          emancipadoEm: atual.emancipatedOn,
          documentoConferido,
        });
      }
      return this.paraDto(tx, ctx.tenantId, linha);
    });
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
    const indice = dados.cpf ? await this.indiceCpf.indexar(tx, ctx, dados.cpf) : null;
    return {
      id,
      cpfBidx: indice?.cpfBidx ?? null,
      cpfBidxVersion: indice?.cpfBidxVersion ?? null,
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

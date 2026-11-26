/**
 * Linha do tempo do paciente (HU-PAC-007): junta, do mais recente para o mais antigo, eventos que JÁ
 * existem nas tabelas da clínica — agenda, financeiro, recibos e o metadado dos atendimentos — filtrados
 * pelo que o perfil da sessão pode ver (linha-do-tempo-regras.ts).
 *
 * - Transação da clínica DA SESSÃO (RLS) com a política de assinatura; toda fonte filtra `tenant_id` também.
 * - Só colunas administrativas: nenhuma coluna cifrada, nenhum conteúdo de prontuário é lido.
 * - As fontes que o perfil não pode ver nem entram na consulta; o mapeamento confere de novo.
 * - Paginação por keyset (instante, evento, id da origem) com o cursor opaco do projeto (CursorDePaginacao,
 *   escopo próprio `linha-do-tempo`, amarrado ao paciente e ao limite). Cursor recusado = 409, sem leitura.
 * - Auditoria de leitura na MESMA transação (`patient_timeline`), só com ids, contagens e a base do vínculo.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type PaginaPorCursor, type RequestContext } from '@plataforma/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { lerNaClinica } from '../../common/transacao-clinica';
import { patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { ehPerfil, podeLerConteudoClinico, temPermissao } from '../auth/perfis';
import { calcularVinculoDeCuidado } from '../auth/vinculo-de-cuidado';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { CursorDePaginacao, type PosicaoLida } from './cursor-de-paginacao';
import {
  escopoDaLinhaDoTempo,
  nomeDaAncora,
  paraEvento,
  type EscopoDaLinhaDoTempo,
  type EventoDaLinhaDoTempo,
  type EventoLinhaDoTempoDto,
  type LinhaDeOrigem,
} from './linha-do-tempo-regras';
import { PAGINA_MAXIMA } from './patients.validation';

export const CURSOR_DA_LINHA_DO_TEMPO = Symbol('CURSOR_DA_LINHA_DO_TEMPO');
export const SCOPE_LINHA_DO_TEMPO = 'patient_timeline';

export type PaginaDaLinhaDoTempo = PaginaPorCursor<EventoLinhaDoTempoDto>;

export interface FiltroLinhaDoTempo {
  readonly limite: number;
  readonly cursor?: string;
}

type LinhaCrua = {
  evento: EventoDaLinhaDoTempo;
  origem_id: string;
  chave: string;
  inicio: string | null;
  inicio_anterior: string | null;
  prof_nome: string | null;
  prof_sensivel: boolean | null;
  prof_usuario: string | null;
  compartimento: string | null;
  autor_usuario: string | null;
  valor_centavos: number | null;
  numero: string | number | null;
};

/** Instante em texto UTC com microssegundos: a chave exata do keyset (Date do JS perderia os microssegundos). */
function txt(coluna: SQL): SQL {
  return sql`to_char((${coluna}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
}

const NULO = {
  inicio: sql`NULL::timestamptz`,
  anterior: sql`NULL::timestamptz`,
  profNome: sql`NULL::text`,
  profSensivel: sql`NULL::boolean`,
  profUsuario: sql`NULL::uuid`,
  compartimento: sql`NULL::text`,
  autor: sql`NULL::uuid`,
  valor: sql`NULL::integer`,
  numero: sql`NULL::bigint`,
};

type Colunas = typeof NULO;

function selecao(evento: EventoDaLinhaDoTempo, origem: SQL, quando: SQL, c: Partial<Colunas>, resto: SQL): SQL {
  const x = { ...NULO, ...c };
  return sql`SELECT ${evento}::text AS evento, ${origem} AS origem_id, ${quando} AS ocorrido_em,
    ${x.inicio} AS inicio, ${x.anterior} AS inicio_anterior, ${x.profNome} AS prof_nome, ${x.profSensivel} AS prof_sensivel,
    ${x.profUsuario} AS prof_usuario, ${x.compartimento} AS compartimento, ${x.autor} AS autor_usuario,
    ${x.valor} AS valor_centavos, ${x.numero} AS numero ${resto}`;
}

/** Fontes visíveis para o escopo, já filtradas pela clínica e pelo paciente. */
function fontes(ctx: RequestContext, pacienteId: string, escopo: EscopoDaLinhaDoTempo): SQL[] {
  const t = sql`${ctx.tenantId}::uuid`;
  const p = sql`${pacienteId}::uuid`;
  const out: SQL[] = [];
  const prof = { profNome: sql`pr.display_name`, profSensivel: sql`pr.sensitive_area`, profUsuario: sql`pr.user_id` };
  const agenda = sql`FROM appointments a JOIN professionals pr ON pr.id = a.professional_id AND pr.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${t} AND a.patient_id = ${p}`;
  if (escopo.agenda) {
    out.push(selecao('agenda_marcada', sql`a.id`, sql`a.created_at`, { ...prof, inicio: sql`a.starts_at` }, agenda));
    out.push(
      selecao(
        'agenda_remarcada',
        sql`r.id`,
        sql`r.created_at`,
        { ...prof, inicio: sql`r.to_starts_at`, anterior: sql`r.from_starts_at` },
        sql`FROM appointment_reschedules r
          JOIN appointments a ON a.id = r.appointment_id AND a.tenant_id = r.tenant_id
          JOIN professionals pr ON pr.id = a.professional_id AND pr.tenant_id = a.tenant_id
          WHERE r.tenant_id = ${t} AND a.patient_id = ${p}`,
      ),
    );
    out.push(
      selecao('agenda_cancelada', sql`a.id`, sql`a.cancelled_at`, { ...prof, inicio: sql`a.starts_at` }, sql`${agenda} AND a.status = 'cancelled' AND a.cancelled_at IS NOT NULL`),
    );
    out.push(
      selecao(
        'agenda_compareceu',
        sql`a.id`,
        sql`COALESCE(a.checked_in_at, a.starts_at)`,
        { ...prof, inicio: sql`a.starts_at` },
        sql`${agenda} AND a.status IN ('checked_in', 'in_progress', 'completed')`,
      ),
    );
    out.push(selecao('agenda_faltou', sql`a.id`, sql`a.starts_at`, { ...prof, inicio: sql`a.starts_at` }, sql`${agenda} AND a.status = 'no_show'`));
  }
  if (escopo.financeiro) {
    const cobranca = sql`FROM charges c WHERE c.tenant_id = ${t} AND c.patient_id = ${p}`;
    out.push(selecao('cobranca_registrada', sql`c.id`, sql`c.created_at`, { valor: sql`c.amount_cents` }, cobranca));
    out.push(selecao('cobranca_cancelada', sql`c.id`, sql`c.cancelled_at`, {}, sql`${cobranca} AND c.cancelled_at IS NOT NULL`));
    const pagamento = sql`FROM payments pg JOIN charges c ON c.id = pg.charge_id AND c.tenant_id = pg.tenant_id
      WHERE pg.tenant_id = ${t} AND c.patient_id = ${p}`;
    out.push(selecao('pagamento_recebido', sql`pg.id`, sql`pg.received_at`, { valor: sql`pg.amount_cents` }, pagamento));
    out.push(
      selecao(
        'pagamento_estornado',
        sql`es.id`,
        sql`es.reversed_at`,
        { valor: sql`pg.amount_cents` },
        sql`FROM payment_reversals es
          JOIN payments pg ON pg.id = es.payment_id AND pg.tenant_id = es.tenant_id
          JOIN charges c ON c.id = pg.charge_id AND c.tenant_id = pg.tenant_id
          WHERE es.tenant_id = ${t} AND c.patient_id = ${p}`,
      ),
    );
    out.push(
      selecao(
        'recibo_emitido',
        sql`rc.id`,
        sql`rc.issued_at`,
        { numero: sql`rc.number` },
        sql`FROM receipts rc
          JOIN payments pg ON pg.id = rc.payment_id AND pg.tenant_id = rc.tenant_id
          JOIN charges c ON c.id = pg.charge_id AND c.tenant_id = pg.tenant_id
          WHERE rc.tenant_id = ${t} AND c.patient_id = ${p}`,
      ),
    );
    out.push(
      selecao(
        'recibo_cancelado',
        sql`rx.id`,
        sql`rx.cancelled_at`,
        { numero: sql`rc.number` },
        sql`FROM receipt_cancellations rx
          JOIN receipts rc ON rc.id = rx.receipt_id AND rc.tenant_id = rx.tenant_id
          JOIN payments pg ON pg.id = rc.payment_id AND pg.tenant_id = rc.tenant_id
          JOIN charges c ON c.id = pg.charge_id AND c.tenant_id = pg.tenant_id
          WHERE rx.tenant_id = ${t} AND c.patient_id = ${p}`,
      ),
    );
  }
  if (escopo.clinico) {
    // Só metadado do atendimento (nenhuma coluna de versão, adendo ou nota). Psicologia: só o autor.
    out.push(
      selecao(
        'atendimento_registrado',
        sql`e.id`,
        sql`e.opened_at`,
        { profNome: sql`pr.display_name`, compartimento: sql`e.compartment`, autor: sql`e.author_user_id` },
        sql`FROM encounters e JOIN professionals pr ON pr.id = e.professional_id AND pr.tenant_id = e.tenant_id
          WHERE e.tenant_id = ${t} AND e.patient_id = ${p}
            AND (e.compartment <> 'psicologia' OR e.author_user_id = ${ctx.userId}::uuid)`,
      ),
    );
  }
  return out;
}

function paraLinha(r: LinhaCrua): LinhaDeOrigem {
  return {
    evento: r.evento,
    origemId: r.origem_id,
    chave: r.chave,
    inicio: r.inicio,
    inicioAnterior: r.inicio_anterior,
    profissionalNome: r.prof_nome,
    profissionalSensivel: r.prof_sensivel,
    profissionalUsuarioId: r.prof_usuario,
    compartimento: r.compartimento,
    autorUsuarioId: r.autor_usuario,
    valorCentavos: r.valor_centavos === null ? null : Number(r.valor_centavos),
    numero: r.numero === null ? null : Number(r.numero),
  };
}

@Injectable()
export class LinhaDoTempoService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(CURSOR_DA_LINHA_DO_TEMPO) private readonly cursor: CursorDePaginacao,
  ) {}

  /** Cursor amarrado ao paciente e ao limite (AAD/HMAC): cursor de outro paciente ou limite = 409. */
  private amarra(pacienteId: string, filtro: FiltroLinhaDoTempo) {
    return { situacao: `paciente:${pacienteId}`, limite: filtro.limite };
  }

  listar(ctx: RequestContext, pacienteId: string, filtro: FiltroLinhaDoTempo): Promise<PaginaDaLinhaDoTempo> {
    const amarra = this.amarra(pacienteId, filtro);
    // Conferido ANTES da transação: cursor recusado não lê nada nem grava leitura.
    const posicao: PosicaoLida | undefined = filtro.cursor === undefined ? undefined : this.cursor.ler(ctx, amarra, filtro.cursor);
    const pagina = posicao?.pagina ?? 1;
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [paciente] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)));
      if (!paciente) throw new NaoEncontradoError();
      const perfis = ctx.roles.filter(ehPerfil);
      // Vínculo só é calculado para perfil clínico (os demais nunca veem evento clínico).
      const vinculo = temPermissao(perfis, 'conteudo_clinico:ler') ? await calcularVinculoDeCuidado(tx, ctx, pacienteId) : null;
      const escopo = escopoDaLinhaDoTempo(perfis, vinculo !== null && podeLerConteudoClinico(perfis, vinculo));
      const uniao = sql.join(fontes(ctx, pacienteId, escopo), sql` UNION ALL `);
      let depois: SQL = sql`TRUE`;
      if (posicao) {
        const ancora = await this.ancora(tx, uniao, posicao);
        depois = sql`(ev.ocorrido_em, ev.evento, ev.origem_id) < ((${ancora.chave}::timestamp at time zone 'UTC'), ${ancora.evento}::text, ${ancora.origemId}::uuid)`;
      }
      const brutas = await tx.execute<LinhaCrua>(sql`
        SELECT ev.evento, ev.origem_id, ${txt(sql`ev.ocorrido_em`)} AS chave, ${txt(sql`ev.inicio`)} AS inicio,
          ${txt(sql`ev.inicio_anterior`)} AS inicio_anterior, ev.prof_nome, ev.prof_sensivel, ev.prof_usuario,
          ev.compartimento, ev.autor_usuario, ev.valor_centavos, ev.numero
        FROM (${uniao}) ev
        WHERE ${depois}
        ORDER BY ev.ocorrido_em DESC, ev.evento DESC, ev.origem_id DESC
        LIMIT ${filtro.limite + 1}`);
      const linhas = [...brutas].map(paraLinha);
      const daPagina = linhas.slice(0, filtro.limite);
      const itens = daPagina.map((l) => paraEvento(l, escopo, ctx.userId)).filter((e): e is EventoLinhaDoTempoDto => e !== null);
      const temMais = linhas.length > filtro.limite && pagina < PAGINA_MAXIMA;
      const ultima = daPagina[daPagina.length - 1];
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_LINHA_DO_TEMPO,
        metadata: {
          patient_id: pacienteId,
          count: itens.length,
          clinical_count: itens.filter((i) => i.categoria === 'clinico').length,
          clinical: escopo.clinico,
          amounts: escopo.valores,
          page: pagina,
          care_basis: vinculo?.base ?? null,
        },
      });
      const proximoCursor =
        temMais && ultima ? this.cursor.assinar(ctx, amarra, { pagina: pagina + 1, depoisDe: ultima.origemId, nomeDaAncora: nomeDaAncora(ultima) }) : null;
      return { itens, pagina, limite: filtro.limite, temMais, proximoCursor };
    });
  }

  /**
   * Relê a âncora pelo id da origem (pode haver mais de um evento por linha: marcada e cancelada, por exemplo) e
   * escolhe o que a marca do cursor reconhece. Sumiu, mudou de instante ou ficou fora do escopo = 409.
   */
  private async ancora(tx: TenantTx, uniao: SQL, posicao: PosicaoLida): Promise<{ evento: string; chave: string; origemId: string }> {
    const candidatos = await tx.execute<{ evento: EventoDaLinhaDoTempo; chave: string }>(sql`
      SELECT ev.evento, ${txt(sql`ev.ocorrido_em`)} AS chave FROM (${uniao}) ev WHERE ev.origem_id = ${posicao.depoisDe}::uuid`);
    const achado = [...candidatos].find((c) => this.cursor.ancoraConfere(posicao, nomeDaAncora(c)));
    if (!achado) {
      this.cursor.conferirAncora(posicao, candidatos.length === 0 ? undefined : '');
      throw new NaoEncontradoError(); // inalcançável: conferirAncora já lançou 409
    }
    return { evento: achado.evento, chave: achado.chave, origemId: posicao.depoisDe };
  }
}

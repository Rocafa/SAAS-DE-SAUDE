/**
 * Consulta da trilha pela própria clínica (E10 da revisão interna de 04/11; LGPD arts. 18, 19, 37 e 48).
 *
 * `GET /clinica/auditoria`: só o admin, com MFA recente. Filtros por paciente (o `patient_id` gravado na linha),
 * usuário (quem agiu), período e ação, com paginação por cursor. Devolve só o que a trilha já guarda: ids, ação,
 * escopo, tipo de ator, data e a metadata (que o contrato da 0005 já limita a ids e códigos, sem conteúdo nem dado
 * pessoal). A própria consulta vai para a trilha, com os filtros usados (só ids).
 */
import { Controller, Get, Inject, Injectable, Query, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { lerNaClinica } from '../../common/transacao-clinica';
import { ehDataValida, exigirObjeto, Validador } from '../../common/validacao';
import { auditLog } from '../../db/schema';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { ExigeMfaRecente } from '../auth/mfa';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { recordAudit } from './audit-log';

export const SCOPE_CONSULTA_TRILHA = 'audit_trail';
export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 100;
const ACOES: readonly string[] = Object.values(AuditAction);

export interface FiltroDaTrilha {
  readonly pacienteId?: string;
  readonly usuarioId?: string;
  /** `AAAA-MM-DD`, inclusivo, em UTC. */
  readonly de?: string;
  /** `AAAA-MM-DD`, inclusivo, em UTC. */
  readonly ate?: string;
  readonly acao?: string;
  readonly limite: number;
  /** Id da última linha da página anterior. */
  readonly cursor?: string;
}

export interface LinhaDaTrilhaDto {
  readonly id: string;
  readonly em: string;
  readonly acao: string;
  readonly escopo: string;
  readonly atorId: string;
  readonly tipoDeAtor: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface PaginaDaTrilha {
  readonly itens: readonly LinhaDaTrilhaDto[];
  /** Passe em `cursor` para a próxima página; `null` = acabou. */
  readonly proximo: string | null;
}

/**
 * Cursor = id (UUID) da última linha da página. A comparação usa o horário EXATO dela no banco (microssegundos), lido
 * por subconsulta: com o horário arredondado para ms, linhas da mesma transação (mesmo `now()`) sumiam entre páginas
 * (R1 do parecer do #135).
 */
const UUID_CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function codificarCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodificarCursor(valor: string): string | null {
  const id = Buffer.from(valor, 'base64url').toString('utf8');
  return UUID_CURSOR.test(id) ? id : null;
}

/** Teto do período pedido (fila do parecer do #135): evita varrer anos de trilha numa consulta. */
export const PERIODO_MAXIMO_DIAS = 366;

/**
 * Chaves da metadata que a clínica vê (R4 do parecer do #135): só ids e códigos necessários para investigar. Ficam de
 * fora detalhes que passam do necessário (`hidden`, `template`, `export_consent` e QUALQUER contagem, como `count`, que
 * revelaria quantas notas privadas ou registros de psicologia existem; ressalva (a) da reconferência do #135).
 */
export const CHAVES_VISIVEIS: ReadonlySet<string> = new Set([
  'op',
  'rule',
  'reason',
  'patient_id',
  'encounter_id',
  'appointment_id',
  'professional_id',
  'target_id',
  'care_basis',
  'ticket',
  'actor_id',
  'creator_id',
  'filter_user_id',
  'filter_action',
]);

export function metadataVisivel(m: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m).filter(([k]) => CHAVES_VISIVEIS.has(k)));
}

/** Valida a query (campos desconhecidos, datas, período, ação fora da lista, limite e cursor): 400 com os campos. */
export function validarFiltro(query: unknown): FiltroDaTrilha {
  const v = new Validador(exigirObjeto(query ?? {}, ['pacienteId', 'usuarioId', 'de', 'ate', 'acao', 'limite', 'cursor']));
  const pacienteId = v.uuid('pacienteId', false);
  const usuarioId = v.uuid('usuarioId', false);
  const de = v.texto('de', { max: 10 });
  const ate = v.texto('ate', { max: 10 });
  const acao = v.texto('acao', { max: 40 });
  const limite = v.inteiroDeTexto('limite', { min: 1, max: LIMITE_MAXIMO, padrao: LIMITE_PADRAO });
  const cursorTexto = v.texto('cursor', { max: 200 });
  if (de !== undefined && !ehDataValida(de)) v.falhar('de');
  if (ate !== undefined && !ehDataValida(ate)) v.falhar('ate');
  if (de !== undefined && ate !== undefined && ehDataValida(de) && ehDataValida(ate)) {
    if (de > ate) v.falhar('ate');
    else if ((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000 >= PERIODO_MAXIMO_DIAS) v.falhar('ate');
  }
  if (acao !== undefined && !ACOES.includes(acao)) v.falhar('acao');
  const cursor = cursorTexto === undefined ? undefined : decodificarCursor(cursorTexto);
  if (cursor === null) v.falhar('cursor');
  v.concluir();
  return {
    limite,
    ...(pacienteId ? { pacienteId } : {}),
    ...(usuarioId ? { usuarioId } : {}),
    ...(de ? { de } : {}),
    ...(ate ? { ate } : {}),
    ...(acao ? { acao } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function diaSeguinte(data: string): Date {
  const d = new Date(`${data}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

@Injectable()
export class ConsultaDaTrilhaService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  consultar(ctx: RequestContext, f: FiltroDaTrilha): Promise<PaginaDaTrilha> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      // R3 do parecer do #135: consulta pesada não segura a conexão (índices na 0061).
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const condicoes: SQL[] = [eq(auditLog.tenantId, ctx.tenantId)];
      if (f.usuarioId) condicoes.push(eq(auditLog.actorId, f.usuarioId));
      if (f.pacienteId) condicoes.push(sql`${auditLog.metadata}->>'patient_id' = ${f.pacienteId}`);
      // Sem `de`, o período vai até 366 dias antes do fim (ressalva (b) da reconferência do #135): nunca a trilha inteira.
      const fim = f.ate ? diaSeguinte(f.ate) : null;
      const inicio = f.de ? new Date(`${f.de}T00:00:00.000Z`) : new Date((fim ?? new Date()).getTime() - PERIODO_MAXIMO_DIAS * 86_400_000);
      condicoes.push(gte(auditLog.createdAt, inicio));
      if (fim) condicoes.push(lt(auditLog.createdAt, fim));
      if (f.acao) condicoes.push(eq(auditLog.action, f.acao));
      if (f.cursor) {
        condicoes.push(
          sql`(${auditLog.createdAt}, ${auditLog.id}) < (select a.created_at, a.id from audit_log a where a.tenant_id = ${ctx.tenantId} and a.id = ${f.cursor})`,
        );
      }
      const linhas = await tx
        .select()
        .from(auditLog)
        .where(and(...condicoes))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(f.limite + 1);
      const pagina = linhas.slice(0, f.limite);
      const ultima = pagina.at(-1);
      // A consulta também é um acesso: vai para a trilha, só com os filtros (ids) e a contagem.
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_CONSULTA_TRILHA,
        metadata: {
          op: 'consulta',
          count: pagina.length,
          ...(f.pacienteId ? { patient_id: f.pacienteId } : {}),
          ...(f.usuarioId ? { filter_user_id: f.usuarioId } : {}),
          ...(f.acao ? { filter_action: f.acao } : {}),
        },
      });
      return {
        itens: pagina.map((l) => ({
          id: l.id,
          em: l.createdAt.toISOString(),
          acao: l.action,
          escopo: l.scope,
          atorId: l.actorId,
          tipoDeAtor: l.actorKind ?? null,
          metadata: metadataVisivel(l.metadata as Record<string, unknown>),
        })),
        proximo: linhas.length > f.limite && ultima ? codificarCursor(ultima.id) : null,
      };
    });
  }
}

@Controller('clinica/auditoria')
@UseGuards(SessaoGuard)
export class ConsultaDaTrilhaController {
  constructor(@Inject(ConsultaDaTrilhaService) private readonly service: ConsultaDaTrilhaService) {}

  @Get()
  @Permissao('auditoria:consultar')
  @ExigeMfaRecente()
  consultar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<PaginaDaTrilha> {
    return this.service.consultar(paraRequestContext(auth), validarFiltro(query));
  }
}

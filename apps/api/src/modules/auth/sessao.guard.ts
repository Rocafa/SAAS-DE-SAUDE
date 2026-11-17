import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_PROVIDER, type AuthContext, type AuthProvider, type RequisicaoParaSessao } from './auth-context';
import { AuditAction } from '@plataforma/shared';
import { ProibidoError } from '../../common/erros-dominio';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { paraRequestContext } from './auth-context';
import { createHash } from 'node:crypto';
import { MemoryRateLimitStore, rateLimitStoreAtivo, type RateLimitStore } from '../../security/rate-limit-store';
import { MFA_RECENTE_KEY, recusaDeMfa } from './mfa';
import { temPermissao, type Perfil, type Permissao as NomePermissao } from './perfis';
import { and, eq } from 'drizzle-orm';
import { AMBIENTES_SESSAO_FICTICIA } from './auth-provider.factory';
import { clinicMembers } from '../../db/schema';
import { origemDaRequisicao, registrarEventoDeSeguranca, registrarNoMaximoUmaVez } from '../../security/log-de-seguranca';
import { avisarAdminsDeAnomalia } from '../records/avisos';

const PERMISSAO_KEY = 'plataforma:permissao';

/** Permissão exigida pela rota. Rota sob o guard SEM este decorator é negada (falha fechada). */
export const Permissao = (permissao: NomePermissao): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSAO_KEY, permissao);

interface RequisicaoComSessao extends RequisicaoParaSessao {
  auth?: AuthContext;
  params?: Readonly<Record<string, string | undefined>>;
  method?: string;
  route?: { path?: unknown };
  ip?: string;
}

/** Método + TEMPLATE da rota (`GET /pacientes/:id`): nunca a URL real, que pode ter ids ou query. */
function rotaDoTemplate(req: RequisicaoComSessao): string {
  const caminho = typeof req.route?.path === 'string' ? req.route.path : '';
  return `${req.method ?? 'GET'} ${caminho.startsWith('/') ? caminho : '/' + caminho}`;
}

function nomeDoHandler(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`;
}

/**
 * E2 da revisão interna de 04/11: perfis da sessão MENOS os revogados no banco. Revogar um perfil (ou todos, para
 * desligar alguém) vale na próxima requisição, sem esperar a sessão acabar.
 * - Usuário com QUALQUER linha em `clinic_members`: só ficam os perfis da sessão que estão ATIVOS no banco (R1 do
 *   parecer do #130: perfil que só o provedor diz não vale). A qualificação `psicologo` não é perfil de sessão, então
 *   não segura ninguém (R2): desligado é quem não tem perfil de sessão ativo.
 * - Usuário sem linha nenhuma: fica como o provedor disse (transição; com o provedor real da D4, os perfis da
 *   sessão passam a vir SÓ do banco, condição do contrato do provedor).
 */
export function perfisVigentes(perfis: readonly Perfil[], linhas: readonly { role: string; revokedAt: Date | null }[]): readonly Perfil[] {
  if (linhas.length === 0) return perfis;
  const ativos = new Set(linhas.filter((l) => l.revokedAt === null).map((l) => l.role));
  return perfis.filter((p) => ativos.has(p));
}

/** Escopo da linha da trilha de uma recusa por MFA em rota sensível (B2 do parecer de 03/11 sobre o #123). */
export const SCOPE_MFA_RECUSADO = 'mfa_denied';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R9 do parecer do #123: recusas por MFA em rota sensível não inundam a trilha. Na janela, 1 linha por usuário, rota
 * e motivo; acima do teto por usuário, 429 e um único alerta de anomalia.
 */
export const JANELA_RECUSA_MFA_MS = 60_000;
export const TETO_RECUSAS_MFA = 20;
/** Sem store registrado (módulos de teste, boot sem http-security): conta em memória nesta instância. */
const STORE_LOCAL = new MemoryRateLimitStore();

/** 429 por excesso de recusas por MFA na janela. */
export class LimiteDeRecusasMfaError extends HttpException {
  constructor() {
    super({ statusCode: 429, message: 'Too Many Requests', codigo: 'limite_de_recusas_mfa' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Chave do contador sem id em claro (o store pode ser o Redis compartilhado). */
function chaveDeRecusa(...partes: string[]): string {
  return `mfa_recusa:${createHash('sha256').update(partes.join('\u0000')).digest('hex')}`;
}

/**
 * Guard das rotas de domínio: (1) resolve a sessão pelo provedor (porta AuthProvider) — sem sessão,
 * 401; (2) confere a permissão do perfil — sem permissão, 403; (3) confere o MFA (mfa.ts) — 403 com código. A clínica usada daqui em diante é a
 * da sessão. O guard NÃO lê nenhum cabeçalho de clínica (`x-tenant-id`, `x-clinica-id`...): não
 * existe caminho do cliente até o tenant (regra 1 da D4; teste em test/security).
 */
@Injectable()
export class SessaoGuard implements CanActivate {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    @Inject(Reflector) private readonly reflector: Reflector,
    // Opcional só para módulos de teste sem banco; em produção o TenancyModule é global.
    @Optional() @Inject(TenantDatabase) private readonly db?: TenantDatabase,
  ) {}


  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequisicaoComSessao>();
    let auth = await this.provider.resolver(req);
    if (!auth) {
      registrarEventoDeSeguranca('SESSAO_INVALIDA', { rota: rotaDoTemplate(req), origem: origemDaRequisicao(req.ip) });
      throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
    }
    const perfis = await this.perfisDoBanco(auth);
    const revogado = perfis.length < auth.perfis.length;
    if (revogado) auth = { ...auth, perfis };
    const permissao = this.reflector.getAllAndOverride<NomePermissao | undefined>(PERMISSAO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permissao || !temPermissao(auth.perfis, permissao)) {
      registrarEventoDeSeguranca('ACESSO_NEGADO_PERFIL', {
        tenantId: auth.tenantId,
        userId: auth.userId,
        handler: nomeDoHandler(context),
        rota: rotaDoTemplate(req),
        ...(revogado ? { motivo: 'perfil_revogado' } : {}),
      });
      throw new ForbiddenException({ statusCode: 403, message: 'Sem permissão' });
    }
    // (3) MFA (issue #106): obrigatório para todo perfil e recente nas rotas marcadas. Recusa antes de qualquer leitura.
    const janela = this.reflector.getAllAndOverride<number | undefined>(MFA_RECENTE_KEY, [context.getHandler(), context.getClass()]) ?? null;
    const recusa = recusaDeMfa(auth, janela);
    if (recusa) {
      registrarNoMaximoUmaVez(`mfa:${auth.tenantId}:${auth.userId}:${nomeDoHandler(context)}:${recusa}`, 60_000, 'MFA_RECUSADO', { tenantId: auth.tenantId, userId: auth.userId, handler: nomeDoHandler(context), motivo: recusa });
      if (janela !== null) await this.registrarRecusa(auth, recusa, `${context.getClass().name}.${context.getHandler().name}`, req.params?.id);
      throw new ProibidoError(recusa);
    }
    req.auth = auth;
    return true;
  }

  /** E2: lê as linhas do usuário em `clinic_members` (RLS da clínica da sessão) e tira os perfis revogados. */
  private async perfisDoBanco(auth: AuthContext): Promise<readonly Perfil[]> {
    if (!this.db) {
      // R3 do parecer do #130: sem banco, só em dev/test (módulos de teste sem banco). Fora disso, nega.
      if (!AMBIENTES_SESSAO_FICTICIA.has(process.env.NODE_ENV ?? '')) throw new Error('SessaoGuard sem banco fora de dev/test: perfis não conferidos');
      return auth.perfis;
    }
    // R4 do parecer do #130: falha ao conferir os perfis nega (o erro sobe; banco fora vira 503 no filtro) e alarma, no
    // máximo uma vez por clínica a cada 60 s (R2 do parecer do #136).
    const linhas = await this.db
      .run(
        auth.tenantId,
        (tx) =>
          tx
            .select({ role: clinicMembers.role, revokedAt: clinicMembers.revokedAt })
            .from(clinicMembers)
            .where(and(eq(clinicMembers.tenantId, auth.tenantId), eq(clinicMembers.userId, auth.userId))),
        auth.userId,
      )
      .catch((err: unknown) => {
        registrarNoMaximoUmaVez(`perfis:${auth.tenantId}`, 60_000, 'PERFIS_NAO_CONFERIDOS', { tenantId: auth.tenantId, userId: auth.userId });
        throw err;
      });
    return perfisVigentes(auth.perfis, linhas);
  }

  /**
   * B2 + R9: conta a recusa; a primeira da janela (por usuário, rota e motivo) vai para a trilha; acima do teto por
   * usuário, um alerta de anomalia (uma vez) e 429. Store indisponível: grava a linha (melhor registrar a mais).
   */
  private async registrarRecusa(auth: AuthContext, motivo: string, handler: string, alvo: string | undefined): Promise<void> {
    const store: RateLimitStore = rateLimitStoreAtivo() ?? STORE_LOCAL;
    const contar = (chave: string) => store.hit(chave, JANELA_RECUSA_MFA_MS).catch(() => null);
    const [daRota, doUsuario] = await Promise.all([
      contar(chaveDeRecusa('rota', auth.tenantId, auth.userId, handler, motivo)),
      contar(chaveDeRecusa('usuario', auth.tenantId, auth.userId)),
    ]);
    if (!daRota || daRota.count === 1) await this.auditarRecusa(auth, motivo, handler, alvo);
    if (doUsuario && doUsuario.count > TETO_RECUSAS_MFA) {
      if (doUsuario.count === TETO_RECUSAS_MFA + 1) {
        registrarEventoDeSeguranca('MFA_LIMITE_DE_RECUSAS', { tenantId: auth.tenantId, userId: auth.userId, contagem: doUsuario.count });
        await this.alertarVolume(auth, doUsuario.count);
      }
      throw new LimiteDeRecusasMfaError();
    }
  }

  /** Alerta de volume anômalo de recusas por MFA (R9), no formato dos outros alertas da vigilância. */
  private async alertarVolume(auth: AuthContext, contagem: number): Promise<void> {
    if (!this.db) return;
    const ctx = paraRequestContext(auth);
    try {
      await this.db.run(
        ctx.tenantId,
        async (tx) => {
          await recordAudit(tx, ctx, {
            action: AuditAction.AnomalyAlert,
            scope: SCOPE_MFA_RECUSADO,
            metadata: { rule: 'mfa_recusas_por_usuario', window_s: JANELA_RECUSA_MFA_MS / 1000, threshold: TETO_RECUSAS_MFA, count: contagem },
          });
          await avisarAdminsDeAnomalia(tx, ctx, 'mfa_recusas_por_usuario');
        },
        ctx.userId,
      );
    } catch {
      registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { tenantId: auth.tenantId, motivo: 'mfa_alerta_de_volume' });
    }
  }

  /**
   * B2: a recusa por MFA numa rota sensível vai para a trilha da clínica da sessão, só com ids (o handler e o id do
   * alvo, se for UUID). Se a gravação falhar, a recusa continua (falha fechada) e o erro vai para o log sem dado.
   */
  private async auditarRecusa(auth: AuthContext, motivo: string, handler: string, alvo: string | undefined): Promise<void> {
    if (!this.db) return;
    const ctx = paraRequestContext(auth);
    try {
      await this.db.run(
        ctx.tenantId,
        (tx) =>
          recordAudit(tx, ctx, {
            action: AuditAction.Read,
            scope: SCOPE_MFA_RECUSADO,
            metadata: { op: handler.slice(0, 64), reason: motivo, ...(alvo && UUID_RE.test(alvo) ? { target_id: alvo } : {}) },
          }),
        ctx.userId,
      );
    } catch {
      registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { tenantId: auth.tenantId, motivo: 'mfa_recusa' });
    }
  }
}

/** Contexto da sessão resolvido pelo SessaoGuard. */
export const Sessao = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<RequisicaoComSessao>().auth;
  // Só acontece se a rota esquecer o guard: falha fechada.
  if (!auth) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
  return auth;
});

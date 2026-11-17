/**
 * Convite da equipe (D4, PR 3b; desenho §14.2 revisto depois do veto; R1, R2, R8, R9 e R16 do parecer do desenho).
 *
 * - O admin convida por e-mail e perfil. O convite fica SÓ na tabela da clínica (`team_invites`, RLS): não concede
 *   perfil e não toca `identidade.usuario` (R2). A resposta é a mesma exista ou não conta com esse e-mail.
 * - O token (mostrado UMA vez ao admin, que o entrega fora da plataforma) leva o id da clínica e 32 bytes aleatórios;
 *   o banco guarda só o SHA-256. O e-mail fica só em HMAC, para conferir no aceite (R16).
 * - O aceite abre a transação NA clínica do token, como o admin que convidou (o banco exige `granted_by` = usuário da
 *   transação): se ele não for mais admin ativo, nada acontece. O vínculo nasce aqui, com a trilha (`member_grant`,
 *   `via: convite`). A sessão aberta no aceite só serve ao cadastro do TOTP, por 15 min (R8).
 * - Teto diário de convites por admin (R9).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { clinicMembers, teamInvites, type ClinicMemberRole } from '../../db/schema';
import { origemDaRequisicao } from '../../security/log-de-seguranca';
import { loadRateLimitHashKey } from '../../security/rate-limit-store';
import { CABECALHO_ORIGEM } from './better-auth/protecao';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { AUTH_PROVIDER, ehProvedorDeConvite, paraRequestContext, type AuthContext, type AuthProvider } from './auth-context';
import { ehPerfilDoBanco, exigirPerfilNoBanco, gravarConcessao } from './membros';
import { ExigeMfaRecente } from './mfa';
import { Permissao, Sessao, SessaoGuard } from './sessao.guard';

export const VALIDADE_DO_CONVITE_MS = 72 * 60 * 60 * 1000;
/** HMAC "zerado" do convite descartado (formato válido no CHECK, não corresponde a nenhum e-mail). */
export const EMAIL_DESCARTADO = '0'.repeat(32);
/** R9: convites por admin por dia (corta abuso sem atrapalhar a montagem de uma equipe). */
export const TETO_DIARIO_DE_CONVITES = 20;
const SCOPE = 'team_invites';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConviteCriado {
  readonly conviteId: string;
  /** Mostrado UMA vez: o admin entrega fora da plataforma (sem provedor de e-mail, §9). */
  readonly token: string;
  readonly expiraEm: string;
}

export interface ConviteListado {
  readonly id: string;
  readonly perfil: string;
  readonly criadoEm: string;
  readonly expiraEm: string;
  readonly convidadoPor: string;
}

/** Token = base64url(16 bytes do id da clínica + 32 bytes aleatórios). O id da clínica não é segredo. */
export function gerarTokenDeConvite(tenantId: string): string {
  return Buffer.concat([Buffer.from(tenantId.replace(/-/g, ''), 'hex'), randomBytes(32)]).toString('base64url');
}

/** Clínica do token (ou null se o formato não fecha). */
export function clinicaDoToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{64}$/.test(token)) return null;
  const b = Buffer.from(token, 'base64url');
  if (b.length !== 48) return null;
  const h = b.subarray(0, 16).toString('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return UUID_RE.test(id) ? id : null;
}

export const hashDoToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function hmacDoEmail(email: string, chave: Uint8Array = loadRateLimitHashKey(process.env)): string {
  return createHmac('sha256', chave).update(`convite-email:${email.trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

@Injectable()
export class ConvitesService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
  ) {}

  criar(ctx: RequestContext, email: string, perfil: ClinicMemberRole): Promise<ConviteCriado> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [hoje] = await tx
        .select({ n: count() })
        .from(teamInvites)
        .where(and(eq(teamInvites.tenantId, ctx.tenantId), eq(teamInvites.createdBy, ctx.userId), gt(teamInvites.createdAt, desde)));
      if ((hoje?.n ?? 0) >= TETO_DIARIO_DE_CONVITES) throw new ConflitoError('teto_diario_de_convites');
      const token = gerarTokenDeConvite(ctx.tenantId);
      const [c] = await tx
        .insert(teamInvites)
        .values({ tenantId: ctx.tenantId, tokenHash: hashDoToken(token), emailHmac: hmacDoEmail(email), role: perfil, createdBy: ctx.userId, expiresAt: sql`now() + interval '72 hours'` })
        .returning({ id: teamInvites.id, expiraEm: teamInvites.expiresAt });
      if (!c) throw new Error('falha ao criar convite');
      await recordAudit(tx, ctx, { action: AuditAction.PermissionChange, scope: SCOPE, metadata: { op: 'member_invite', invite_id: c.id, role: perfil } });
      // O prazo vem do relógio do banco (o mesmo do created_at), para a trava de 72 h fechar exata.
      return { conviteId: c.id, token, expiraEm: c.expiraEm.toISOString() };
    });
  }

  /** Convites pendentes da clínica: perfil, datas e quem convidou. Sem e-mail (a clínica não o guarda em claro). */
  listar(ctx: RequestContext): Promise<ConviteListado[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const linhas = await tx
        .select()
        .from(teamInvites)
        .where(and(eq(teamInvites.tenantId, ctx.tenantId), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt), gt(teamInvites.expiresAt, new Date())))
        .orderBy(asc(teamInvites.createdAt));
      return linhas.map((l) => ({ id: l.id, perfil: l.role, criadoEm: l.createdAt.toISOString(), expiraEm: l.expiresAt.toISOString(), convidadoPor: l.createdBy }));
    });
  }

  revogar(ctx: RequestContext, conviteId: string): Promise<void> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const r = await tx
        .update(teamInvites)
        .set({ revokedAt: new Date(), revokedBy: ctx.userId })
        .where(and(eq(teamInvites.tenantId, ctx.tenantId), eq(teamInvites.id, conviteId), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt)))
        .returning({ id: teamInvites.id });
      if (r.length === 0) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.PermissionChange, scope: SCOPE, metadata: { op: 'member_invite_revoke', invite_id: conviteId } });
    });
  }

  /**
   * Aceite de pessoa NOVA (a conta existente é o PR 3b-2: exige login completo). Mesmo erro (404) para token
   * inválido, vencido, usado, revogado ou e-mail diferente. Devolve os `Set-Cookie` da sessão de cadastro.
   */
  async aceitar(e: { token: string; email: string; nome?: string; senha: string; codigo?: string; cabecalhos: Headers }): Promise<string[]> {
    const provedor = this.provider;
    if (!ehProvedorDeConvite(provedor)) throw new NaoEncontradoError();
    const tenantId = clinicaDoToken(e.token);
    if (!tenantId) throw new NaoEncontradoError();
    const hash = hashDoToken(e.token);
    const [convite] = await this.db.run(tenantId as TenantId, (tx) =>
      tx
        .select()
        .from(teamInvites)
        .where(and(eq(teamInvites.tokenHash, hash), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt), gt(teamInvites.expiresAt, new Date()))),
    );
    if (!convite || convite.emailHmac !== hmacDoEmail(e.email)) throw new NaoEncontradoError();
    if (!ehPerfilDoBanco(convite.role)) throw new NaoEncontradoError();
    const perfil = convite.role;
    const id = await provedor.idParaContaDoConvite(e.email);
    // R18: quem usa o token percebe se a conta já existe (registrado no RIPD). Conta existente: login COMPLETO.
    if (id === 'conta_existente') return this.aceitarComContaExistente(e, convite, perfil, tenantId);
    if (!e.nome) throw new ConflitoError('nome_obrigatorio', ['nome']);
    const nome = e.nome;
    const { userId, reaproveita } = id;
    let contaCriada = false;
    const ctx: RequestContext = { tenantId: tenantId as TenantId, userId: convite.createdBy as RequestContext['userId'], roles: [] };
    // Tudo dentro da transação da clínica: convite travado, admin conferido, conta criada e vínculo gravado. Qualquer
    // falha desfaz o vínculo e o convite; a conta só é criada depois do convite travado, e a criação falha antes do
    // vínculo (o app_auth não apaga identidade.usuario, R18).
    // Quem convidou deixou de ser admin: o mesmo 404 de convite inválido (quem tem o token não aprende nada).
    const naoAdmin = (err: unknown): never => {
      throw err instanceof ProibidoError ? new NaoEncontradoError() : err;
    };
    await escreverNaClinica(this.db, ctx, async (tx) => {
      // Quem convidou precisa continuar admin ativo; o convite é travado e conferido de novo (aceite em paralelo).
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const marcado = await tx
        .update(teamInvites)
        .set({ acceptedAt: new Date(), acceptedUserId: userId })
        .where(and(eq(teamInvites.id, convite.id), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt), gt(teamInvites.expiresAt, new Date())))
        .returning({ id: teamInvites.id });
      if (marcado.length === 0) throw new NaoEncontradoError();
      // R1 do código do 3b-1: o vínculo ANTES e a conta POR ÚLTIMO (ela vive em outra transação, no app_auth).
      await gravarConcessao(tx, ctx, userId, perfil, 'member_grant', { via: 'convite', invite_id: convite.id });
      const conta = await provedor.criarContaDoConvite({ userId, reaproveita, email: e.email, nome, senha: e.senha, clinicaDeOrigem: tenantId, conviteDeOrigem: convite.id });
      if (conta === 'conta_existente') throw new ConflitoError('conta_existente_exige_login');
      if (conta === 'senha_vazada') throw new ConflitoError('senha_vazada', ['senha']);
      contaCriada = true;
    })
      .catch(async (err: unknown) => {
        // Se a clínica não confirmou depois de a conta existir, a conta fica inativa e sem senha; o mesmo convite a
        // reaproveita na próxima tentativa (idParaContaDoConvite).
        if (contaCriada) await provedor.desfazerContaDoConvite(userId);
        throw err;
      })
      .catch(naoAdmin);
    if (reaproveita) await provedor.completarContaReaproveitada({ userId, nome, clinicaDeOrigem: tenantId, conviteDeOrigem: convite.id });
    return provedor.abrirSessaoDeCadastro({ email: e.email, senha: e.senha, cabecalhos: e.cabecalhos });
  }

  /**
   * Aceite por quem JÁ tem conta (R1 e R2 do desenho do PR 3; R15 e R16): senha e código TOTP, pelos bloqueios de
   * login e de fator. Ver o token não basta. Mesmo erro para senha ou código errados. A conta autenticada é a do e-mail
   * do convite (o HMAC já conferiu o e-mail usado no login). O vínculo nasce na transação da clínica, como o admin que
   * convidou; perfil já ativo não duplica.
   */
  private async aceitarComContaExistente(
    e: { email: string; senha: string; codigo?: string; cabecalhos: Headers },
    convite: { id: string; createdBy: string },
    perfil: ClinicMemberRole,
    tenantId: string,
  ): Promise<string[]> {
    const provedor = this.provider;
    if (!ehProvedorDeConvite(provedor)) throw new NaoEncontradoError();
    if (!e.codigo || !/^[0-9]{6}$/.test(e.codigo)) throw new ConflitoError('conta_existente_exige_login', ['codigo']);
    // Sem abrir sessão (vale também para a conta desligada que está sendo recontratada); a pessoa entra depois.
    const login = await provedor.conferirCredenciais({ email: e.email, senha: e.senha, codigo: e.codigo, cabecalhos: e.cabecalhos });
    if (login === 'indisponivel') throw new ServiceUnavailableException({ statusCode: 503, message: 'Serviço indisponível' });
    if (login === 'falhou' || login === 'bloqueado') throw new ConflitoError('credenciais_invalidas');
    if (login === 'sem_fator') throw new ConflitoError('conta_sem_fator');
    const ctx: RequestContext = { tenantId: tenantId as TenantId, userId: convite.createdBy as RequestContext['userId'], roles: [] };
    await escreverNaClinica(this.db, ctx, async (tx) => {
      await exigirPerfilNoBanco(tx, ctx, 'admin');
      const marcado = await tx
        .update(teamInvites)
        .set({ acceptedAt: new Date(), acceptedUserId: login.userId })
        .where(and(eq(teamInvites.id, convite.id), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt), gt(teamInvites.expiresAt, new Date())))
        .returning({ id: teamInvites.id });
      if (marcado.length === 0) throw new NaoEncontradoError();
      const [ja] = await tx
        .select({ id: clinicMembers.id })
        .from(clinicMembers)
        .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.userId, login.userId), eq(clinicMembers.role, perfil), isNull(clinicMembers.revokedAt)));
      if (!ja) await gravarConcessao(tx, ctx, login.userId, perfil, 'member_grant', { via: 'convite', invite_id: convite.id });
    }).catch((err: unknown) => {
      throw err instanceof ProibidoError ? new NaoEncontradoError() : err;
    });
    return [];
  }

  /**
   * Retenção (R3 do código do 3b-1; RIPD-identidade §3): convite aceito, revogado ou vencido há mais de 30 dias perde o
   * HMAC do e-mail (pseudônimo) e fica só como histórico (quem convidou, perfil, datas). Job `convites-descarte`.
   */
  async descartarEncerradosComoSistema(tenantId: TenantId): Promise<{ descartados: number }> {
    const r = await this.db.run(tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`
        update team_invites set email_hmac = ${EMAIL_DESCARTADO}
         where tenant_id = ${tenantId} and email_hmac <> ${EMAIL_DESCARTADO}
           and coalesce(accepted_at, revoked_at, expires_at) < now() - interval '30 days'
        returning id`),
    );
    return { descartados: [...r].length };
  }
}

function exigirPerfil(valor: unknown): ClinicMemberRole {
  if (!ehPerfilDoBanco(valor)) throw new ConflitoError('perfil_invalido', ['perfil']);
  return valor;
}

@Controller('clinica/convites')
@UseGuards(SessaoGuard)
export class ConvitesController {
  constructor(@Inject(ConvitesService) private readonly convites: ConvitesService) {}

  @Post()
  @ExigeMfaRecente()
  @Permissao('cadastros:gerir')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ConviteCriado> {
    const v = new Validador(exigirObjeto(corpo, ['email', 'perfil']));
    const email = v.texto('email', { max: 320, obrigatorio: true });
    const perfil = v.texto('perfil', { max: 20, obrigatorio: true });
    v.concluir();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ConflitoError('email_invalido', ['email']);
    return this.convites.criar(paraRequestContext(auth), email, exigirPerfil(perfil));
  }

  @Get()
  @Permissao('cadastros:gerir')
  listar(@Sessao() auth: AuthContext): Promise<ConviteListado[]> {
    return this.convites.listar(paraRequestContext(auth));
  }

  @Post(':id/revogar')
  @ExigeMfaRecente()
  @HttpCode(204)
  @Permissao('cadastros:gerir')
  revogar(@Sessao() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.convites.revogar(paraRequestContext(auth), exigirUuid(id, 'id'));
  }
}

/** Aceite do convite: sem sessão (a pessoa ainda não tem conta). Rate limit e CSRF da borda valem. */
@Controller('convites')
export class AceiteDeConviteController {
  constructor(@Inject(ConvitesService) private readonly convites: ConvitesService) {}

  @Post('aceitar')
  @HttpCode(204)
  async aceitar(
    @Body() corpo: unknown,
    @Req() req: { headers: Record<string, string | string[] | undefined>; ip?: string },
    @Res({ passthrough: true }) res: { append(nome: string, valor: string[]): void },
  ): Promise<void> {
    const v = new Validador(exigirObjeto(corpo, ['token', 'email', 'nome', 'senha', 'codigo']));
    const token = v.texto('token', { max: 100, obrigatorio: true });
    const email = v.texto('email', { max: 320, obrigatorio: true });
    const nome = v.texto('nome', { max: 200 });
    const senha = v.texto('senha', { max: 128, obrigatorio: true });
    const codigo = v.texto('codigo', { max: 6 });
    v.concluir();
    if (senha.length < 12) throw new ConflitoError('senha_curta', ['senha']);
    const cabecalhos = new Headers();
    // A origem é calculada AQUI (HMAC do IP), nunca aceita do cliente: o bloqueio de login usa esse valor.
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') cabecalhos.set('user-agent', ua);
    const origem = origemDaRequisicao(req.ip);
    if (origem) cabecalhos.set(CABECALHO_ORIGEM, origem);
    res.append('Set-Cookie', await this.convites.aceitar({ token, email, senha, cabecalhos, ...(nome ? { nome } : {}), ...(codigo ? { codigo } : {}) }));
  }
}

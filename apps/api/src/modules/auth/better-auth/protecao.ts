/**
 * Proteção do login e do segundo fator (D4, PR 2). Desenho: autenticacao-better-auth.md §§6–7; R5 e R6 do parecer
 * do #123. Ganchos `before`/`after` NOSSOS na biblioteca (rodam antes dos ganchos do plugin):
 *
 * - **Bloqueio do login:** 5 falhas em 15 min por e-mail (em HMAC) e 30 por origem (a clínica inteira sai por um IP
 *   só; 5 falhas de pessoas diferentes não podem trancar todo mundo). Bloqueado, a resposta é IGUAL à da senha
 *   errada, com o mesmo custo de hash: não revela se a conta existe nem se está bloqueada.
 * - **Bloqueio do fator:** 5 falhas em 15 min por pessoa (reverificação com sessão aberta e senha do cadastro) e 30
 *   por origem (inclui o login em duas etapas, que a biblioteca também tranca por conta no banco, `dois_fatores`).
 * - **`mfa_em` só pelo nosso gancho** depois que a biblioteca aceitou o código (R6 do #123): nada do cliente.
 * - **Código já apresentado não vale de novo** por 90 s (a biblioteca aceita ±1 período e não impede o reuso; RFC 6238 §5.2).
 * - **"Lembrar este aparelho" recusado:** pular o segundo fator por 30 dias contraria a regra 2 da D4.
 * - **Códigos de reserva fora da resposta do cadastro:** os endpoints que os usam estão fechados (R17, PR 3).
 * - **Senha vazada (R15):** toda senha NOVA é conferida por k-anonimato (senha-vazada.ts) e recusada se vazou.
 * - **Eventos do fator** no log de segurança (cadastro, verificação, falha, bloqueio) e, com clínica, na trilha.
 *
 * Os contadores ficam no store do rate limit (Redis em produção), com chaves em HMAC: nenhum e-mail ou id em claro.
 */
import { createHmac } from 'node:crypto';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { registrarEventoDeSeguranca, registrarNoMaximoUmaVez } from '../../../security/log-de-seguranca';
import type { RateLimitStore } from '../../../security/rate-limit-store';
import type { ConferirSenhaVazada } from './senha-vazada';

/** Cabeçalho que a NOSSA montagem preenche com o HMAC da origem (o do cliente é apagado antes). */
export const CABECALHO_ORIGEM = 'x-plataforma-origem';
export const JANELA_DE_BLOQUEIO_MS = 15 * 60 * 1000;
export const TETO_DE_FALHAS = 5;
export const TETO_DE_FALHAS_POR_ORIGEM = 30;
/** Três períodos de 30 s (a janela de ±1 da biblioteca): um código aceito não é aceito de novo nesse prazo. */
export const JANELA_DE_REUSO_MS = 90 * 1000;

export const ROTA_LOGIN = '/sign-in/email';
export const ROTA_CADASTRO_DO_FATOR = '/two-factor/enable';
export const ROTA_VERIFICACAO_DO_FATOR = '/two-factor/verify-totp';
/** Rotas da biblioteca que definem senha nova e o campo dela (as fechadas na montagem também passam por aqui). */
export const ROTAS_DE_SENHA_NOVA: Readonly<Record<string, string>> = {
  '/change-password': 'newPassword',
  '/reset-password': 'newPassword',
  '/set-password': 'newPassword',
  '/sign-up/email': 'password',
};

export type MotivoDaVerificacao = 'login_em_duas_etapas' | 'reverificacao' | 'cadastro_do_fator';

export interface DependenciasDaProtecao {
  readonly store: RateLimitStore;
  /** Mesmo segredo do HMAC de origem (RATE_LIMIT_HASH_KEY). */
  readonly chaveHmac: Uint8Array;
  /** Gasta o mesmo tempo de uma conferência de senha (resposta do bloqueio igual à da senha errada). */
  readonly gastarTempoDeSenha: (senha: string) => Promise<unknown>;
  /** Conferência de senha vazada por k-anonimato (R15). */
  readonly conferirSenhaVazada: ConferirSenhaVazada;
  /** Código aceito pela biblioteca: grava `mfa_em` e a trilha (provedor). Erro aqui derruba a resposta (falha fechada). */
  readonly aoVerificarMfa: (e: { sessaoId: string; userId: string; motivo: MotivoDaVerificacao }) => Promise<void>;
  /** Código ou senha do cadastro recusados, com sessão aberta: trilha da clínica (provedor). */
  readonly aoFalharMfa: (e: { sessaoId: string; userId: string; bloqueou: boolean }) => Promise<void>;
}

/** Mesma resposta da biblioteca para senha errada ou conta inexistente (`INVALID_EMAIL_OR_PASSWORD`). */
export function erroDeCredencial(): APIError {
  return new APIError('UNAUTHORIZED', { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
}

/** Mesma resposta do bloqueio da biblioteca no login em duas etapas (`ACCOUNT_TEMPORARILY_LOCKED`). */
export function erroDeFatorBloqueado(): APIError {
  return new APIError('TOO_MANY_REQUESTS', {
    message: 'Too many failed verification attempts. Your account is temporarily locked. Please try again later.',
    code: 'ACCOUNT_TEMPORARILY_LOCKED',
  });
}

type RegraDoBloqueio = 'login_por_email' | 'login_por_origem' | 'fator_por_pessoa' | 'fator_por_origem';
type Contador = { readonly chave: string; readonly teto: number; readonly regra: RegraDoBloqueio };
type Reserva = { readonly contadores: Contador[]; readonly contagens: number[] };
type Situacao = { readonly sessaoId?: string; readonly userId?: string; readonly cadastro: boolean; readonly reserva?: Reserva };

const HEX16 = /^[0-9a-f]{16}$/;

export function criarProtecao(d: DependenciasDaProtecao) {
  const chave = (tipo: string, valor: string): string =>
    `bl:v1:${tipo}:${createHmac('sha256', d.chaveHmac).update(`${tipo}:${valor}`).digest('hex').slice(0, 32)}`;

  /** Situação da sessão vista no `before`, para o `after` da mesma requisição (cadastro x reverificação). */
  const situacoes = new WeakMap<object, Situacao>();

  const origemDe = (cabecalhos: Headers | undefined): string | undefined => {
    const v = cabecalhos?.get(CABECALHO_ORIGEM) ?? undefined;
    return v && HEX16.test(v) ? v : undefined;
  };

  const contadoresDoLogin = (identificador: string, origem: string | undefined): Contador[] => [
    ...(identificador ? [{ chave: chave('login', identificador), teto: TETO_DE_FALHAS, regra: 'login_por_email' as const }] : []),
    ...(origem ? [{ chave: chave('login-origem', origem), teto: TETO_DE_FALHAS_POR_ORIGEM, regra: 'login_por_origem' as const }] : []),
  ];

  const contadoresDoFator = (userId: string | undefined, origem: string | undefined): Contador[] => [
    ...(userId ? [{ chave: chave('fator', userId), teto: TETO_DE_FALHAS, regra: 'fator_por_pessoa' as const }] : []),
    ...(origem ? [{ chave: chave('fator-origem', origem), teto: TETO_DE_FALHAS_POR_ORIGEM, regra: 'fator_por_origem' as const }] : []),
  ];

  /**
   * R1 do parecer do código do PR 2: a tentativa é RESERVADA com `hit` atômico ANTES de a biblioteca conferir a
   * credencial, e devolvida (`release`) se der certo. Assim, N requisições em paralelo não passam todas pela consulta
   * antes da primeira falha ser contada: no máximo `teto` chegam à conferência por janela. Bloqueado = alguma reserva
   * passou do teto. Store fora: segue sem bloqueio e alarma (como o rate limit).
   */
  const reservar = async (contadores: Contador[], motivo: 'bloqueio_de_login' | 'bloqueio_do_fator'): Promise<{ reserva: Reserva | null; travou?: Contador }> => {
    try {
      const contagens: number[] = [];
      for (const c of contadores) contagens.push((await d.store.hit(c.chave, JANELA_DE_BLOQUEIO_MS)).count);
      const i = contadores.findIndex((c, j) => (contagens[j] ?? 0) > c.teto);
      return { reserva: { contadores, contagens }, ...(i >= 0 && contadores[i] ? { travou: contadores[i] } : {}) };
    } catch {
      registrarEventoDeSeguranca('RATE_LIMIT_FAIL_OPEN', { motivo });
      return { reserva: null };
    }
  };

  /**
   * Sem requisição HTTP (chamada interna do servidor, `auth.api.*`), o `before` não casa com o `after`: consulta sem
   * reservar e a falha é contada depois. Esse caminho não fica exposto para fora (a montagem só entrega HTTP).
   */
  const reservarOuConsultar = async (
    k: object | undefined,
    contadores: Contador[],
    motivo: 'bloqueio_de_login' | 'bloqueio_do_fator',
  ): Promise<{ reserva: Reserva | null; travou?: Contador }> => {
    if (k) return reservar(contadores, motivo);
    try {
      for (const c of contadores) if ((await d.store.peek(c.chave, JANELA_DE_BLOQUEIO_MS)) >= c.teto) return { reserva: null, travou: c };
    } catch {
      registrarEventoDeSeguranca('RATE_LIMIT_FAIL_OPEN', { motivo });
    }
    return { reserva: null };
  };

  /** Falha sem reserva (chamada interna): conta agora e devolve os contadores que atingiram o teto. */
  const contarSemReserva = async (contadores: Contador[]): Promise<Contador[]> => {
    const saida: Contador[] = [];
    for (const c of contadores) {
      const r = await d.store.hit(c.chave, JANELA_DE_BLOQUEIO_MS).catch(() => null);
      if (r?.count === c.teto) saida.push(c);
    }
    return saida;
  };

  /** A tentativa reservada deu certo (ou não chegou a conferir): não conta como falha. */
  const devolver = async (r: Reserva | undefined): Promise<void> => {
    if (!r) return;
    for (const c of r.contadores) await d.store.release(c.chave, JANELA_DE_BLOQUEIO_MS).catch(() => undefined);
  };

  /** Contadores em que ESTA falha (reservada) atingiu o teto: o bloqueio começa agora (R2 do parecer). */
  const atingidos = (r: Reserva | undefined): Contador[] => (r ? r.contadores.filter((c, j) => r.contagens[j] === c.teto) : []);

  type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
  const chaveDaRequisicao = (ctx: Ctx): object | undefined => ctx.request ?? ctx.headers;
  const corpo = (ctx: Ctx): Record<string, unknown> => (ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {});
  const identificadorDe = (ctx: Ctx): string => {
    const e = corpo(ctx)['email'];
    return typeof e === 'string' ? e.trim().toLowerCase() : '';
  };

  /**
   * Pessoa do login em duas etapas (ainda sem sessão): o desafio que a biblioteca gravou e assinou no cookie
   * `two_factor`. Só leitura; quem consome o desafio é a biblioteca.
   */
  const pessoaDoDesafio = async (ctx: Ctx): Promise<string | undefined> => {
    try {
      const nome = ctx.context.createAuthCookie('two_factor').name;
      const desafio = await ctx.getSignedCookie(nome, ctx.context.secret);
      if (!desafio) return undefined;
      const v = await ctx.context.internalAdapter.findVerificationValue(desafio);
      return v && new Date(v.expiresAt).getTime() > Date.now() ? v.value : undefined;
    } catch {
      return undefined;
    }
  };

  const codigoDe = (ctx: Ctx): string | undefined => {
    const c = corpo(ctx)['code'];
    return typeof c === 'string' && /^[0-9]{6}$/.test(c) ? c : undefined;
  };

  const antes = createAuthMiddleware(async (ctx) => {
    const origem = origemDe(ctx.headers);
    const k = chaveDaRequisicao(ctx);
    const campoDaSenhaNova = ROTAS_DE_SENHA_NOVA[ctx.path];
    if (campoDaSenhaNova) {
      const nova = corpo(ctx)[campoDaSenhaNova];
      if (typeof nova !== 'string' || nova.length === 0 || nova.length > 128) return;
      let vazou = false;
      try {
        vazou = await d.conferirSenhaVazada(nova);
      } catch {
        registrarEventoDeSeguranca('CONFERENCIA_DE_SENHA_INDISPONIVEL', { motivo: 'conferencia_indisponivel', ...(origem ? { origem } : {}) });
      }
      if (vazou) {
        const lida = await getSessionFromCtx(ctx).catch(() => null);
        registrarEventoDeSeguranca('SENHA_VAZADA_RECUSADA', { motivo: 'senha_vazada', ...(lida ? { userId: lida.user.id } : {}), ...(origem ? { origem } : {}) });
        throw new APIError('BAD_REQUEST', { message: 'This password appeared in a data breach. Choose another one.', code: 'PASSWORD_COMPROMISED' });
      }
      return;
    }

    if (ctx.path === ROTA_LOGIN) {
      const { reserva, travou } = await reservarOuConsultar(k, contadoresDoLogin(identificadorDe(ctx), origem), 'bloqueio_de_login');
      if (travou) {
        const b = corpo(ctx);
        if (typeof b['password'] === 'string') await d.gastarTempoDeSenha(b['password'].slice(0, 128));
        registrarNoMaximoUmaVez(`login-bloqueado:${travou.chave}`, 60_000, 'LOGIN_BLOQUEADO', { motivo: 'bloqueio_de_login', regra: travou.regra, ...(origem ? { origem } : {}) });
        throw erroDeCredencial();
      }
      if (k && reserva) situacoes.set(k, { cadastro: false, reserva });
      return;
    }

    if (ctx.path !== ROTA_VERIFICACAO_DO_FATOR && ctx.path !== ROTA_CADASTRO_DO_FATOR) return;
    const b = corpo(ctx);
    if (ctx.path === ROTA_VERIFICACAO_DO_FATOR && b['trustDevice'] !== undefined && b['trustDevice'] !== false) {
      throw new APIError('BAD_REQUEST', { message: 'trustDevice is not allowed', code: 'TRUST_DEVICE_NOT_ALLOWED' });
    }
    // R12 do parecer: só TOTP, e o emissor é o nosso (o cliente não escolhe o nome que aparece no autenticador).
    if (ctx.path === ROTA_CADASTRO_DO_FATOR && ((b['method'] !== undefined && b['method'] !== 'totp') || b['issuer'] !== undefined)) {
      throw new APIError('BAD_REQUEST', { message: 'Only TOTP with the default issuer is allowed', code: 'TOTP_ONLY' });
    }
    const lida = await getSessionFromCtx(ctx).catch(() => null);
    const userId = lida?.user.id ?? (ctx.path === ROTA_VERIFICACAO_DO_FATOR ? await pessoaDoDesafio(ctx) : undefined);
    const { reserva, travou } = await reservarOuConsultar(k, contadoresDoFator(userId, origem), 'bloqueio_do_fator');
    if (travou) {
      registrarNoMaximoUmaVez(`fator-bloqueado:${travou.chave}`, 60_000, 'MFA_BLOQUEADO', {
        motivo: 'bloqueio_do_fator',
        regra: travou.regra,
        ...(userId ? { userId } : {}),
        ...(origem ? { origem } : {}),
      });
      throw erroDeFatorBloqueado();
    }
    if (k) {
      situacoes.set(k, {
        ...(lida ? { sessaoId: lida.session.id } : {}),
        ...(userId ? { userId } : {}),
        cadastro: lida ? (lida.user as { twoFactorEnabled?: boolean }).twoFactorEnabled !== true : false,
        ...(reserva ? { reserva } : {}),
      });
    }
    const codigo = codigoDe(ctx);
    if (ctx.path === ROTA_VERIFICACAO_DO_FATOR && userId && codigo) {
      // Registro atômico ANTES da conferência: duas requisições simultâneas com o mesmo código não passam juntas.
      // O código repetido conta como falha (a reserva acima não é devolvida).
      let usado = false;
      try {
        usado = (await d.store.hit(chave('totp-usado', `${userId}:${codigo}`), JANELA_DE_REUSO_MS)).count > 1;
      } catch {
        registrarEventoDeSeguranca('RATE_LIMIT_FAIL_OPEN', { motivo: 'codigo_reutilizado' });
      }
      if (usado) {
        if (k) situacoes.delete(k);
        registrarEventoDeSeguranca('MFA_FALHOU', { motivo: 'codigo_reutilizado', userId, ...(origem ? { origem } : {}) });
        throw new APIError('UNAUTHORIZED', { message: 'Invalid code', code: 'INVALID_CODE' });
      }
    }
  });

  const depois = createAuthMiddleware(async (ctx) => {
    const retorno: unknown = ctx.context.returned;
    const falhou = isAPIError(retorno);
    const origem = origemDe(ctx.headers);
    const k = chaveDaRequisicao(ctx);
    const situacao: Situacao = (k && situacoes.get(k)) || { cadastro: false };
    if (k) situacoes.delete(k);

    if (ctx.path === ROTA_LOGIN) {
      // Só a credencial recusada (401) fica contada; o resto (acerto, e-mail mal formado) devolve a reserva.
      if (falhou && retorno.statusCode === 401) {
        const travaram = k ? atingidos(situacao.reserva) : await contarSemReserva(contadoresDoLogin(identificadorDe(ctx), origem));
        for (const c of travaram) {
          registrarEventoDeSeguranca('LOGIN_BLOQUEADO', { motivo: 'bloqueio_de_login', regra: c.regra, ...(origem ? { origem } : {}) });
        }
      } else {
        await devolver(situacao.reserva);
      }
      return;
    }
    if (ctx.path !== ROTA_VERIFICACAO_DO_FATOR && ctx.path !== ROTA_CADASTRO_DO_FATOR) return;

    if (falhou) {
      // Código errado (401) na verificação; senha errada (400 INVALID_PASSWORD) no cadastro.
      const contaComoFalha = ctx.path === ROTA_VERIFICACAO_DO_FATOR ? retorno.statusCode === 401 : retorno.body?.code === 'INVALID_PASSWORD';
      if (!contaComoFalha) {
        await devolver(situacao.reserva);
        return;
      }
      const travaram = k ? atingidos(situacao.reserva) : await contarSemReserva(contadoresDoFator(situacao.userId, origem));
      const ids = { ...(situacao.userId ? { userId: situacao.userId } : {}), ...(origem ? { origem } : {}) };
      registrarEventoDeSeguranca('MFA_FALHOU', { motivo: ctx.path === ROTA_VERIFICACAO_DO_FATOR ? 'codigo_errado' : 'senha_errada', ...ids });
      for (const c of travaram) registrarEventoDeSeguranca('MFA_BLOQUEADO', { motivo: 'bloqueio_do_fator', regra: c.regra, ...ids });
      if (situacao.sessaoId && situacao.userId) {
        await d.aoFalharMfa({ sessaoId: situacao.sessaoId, userId: situacao.userId, bloqueou: travaram.length > 0 }).catch(() => {
          registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo: 'codigo_errado', userId: situacao.userId });
        });
      }
      return;
    }

    await devolver(situacao.reserva);

    if (ctx.path === ROTA_CADASTRO_DO_FATOR) {
      // Cadastro iniciado: devolve só o URI do TOTP (os códigos de reserva não servem até a R17).
      const r = (retorno ?? {}) as { method?: unknown; totpURI?: unknown };
      return ctx.json({ method: r.method, totpURI: r.totpURI });
    }

    // Código aceito. No login em duas etapas e no cadastro a biblioteca cria uma sessão NOVA (newSession).
    const nova = ctx.context.newSession;
    const sessaoId = nova?.session.id ?? situacao.sessaoId;
    const userId = nova?.user.id ?? situacao.userId;
    if (!sessaoId || !userId) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized', code: 'UNAUTHORIZED' });
    const motivo: MotivoDaVerificacao = situacao.sessaoId ? (situacao.cadastro ? 'cadastro_do_fator' : 'reverificacao') : 'login_em_duas_etapas';
    try {
      await d.aoVerificarMfa({ sessaoId, userId, motivo });
    } catch (err) {
      // R11 do parecer: sem `mfa_em` gravado, a sessão nova não fica viva (falha fechada).
      if (nova) await ctx.context.internalAdapter.deleteSession(nova.session.token).catch(() => undefined);
      throw err;
    }
    if (motivo === 'cadastro_do_fator') registrarEventoDeSeguranca('MFA_CADASTRADO', { motivo, userId, ...(origem ? { origem } : {}) });
    registrarEventoDeSeguranca('MFA_VERIFICADO', { motivo, userId, ...(origem ? { origem } : {}) });
    return;
  });

  return { antes, depois };
}

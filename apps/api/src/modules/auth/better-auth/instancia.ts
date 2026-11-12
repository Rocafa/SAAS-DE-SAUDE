/**
 * Instância do Better Auth (D4). Desenho: docs/04-arquitetura/autenticacao-better-auth.md (§§2–4, 7–8 e 12).
 *
 * A biblioteca cuida só da CREDENCIAL (senha, sessão, cookie). Clínica, perfis, MFA e auditoria são nossos. Pontos
 * do parecer do desenho que esta configuração cumpre:
 * - R2: segredo e baseURL vêm da configuração (sem padrão); R8: cookie seguro fora de dev/test, SameSite=Strict,
 *   freshAge de 15 min, trustedOrigins da allowlist do CORS; R9: hash scrypt nosso; R10: IP e user-agent só em HMAC,
 *   rate limit da biblioteca desligado; R12: logger da biblioteca sem corpo de requisição; R5: campos nossos com
 *   `input: false`; cadastro público desligado; cookieCache desligado (GHSA-xg6x-h9c9-2m83).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { Database } from '../../../db/tenant-transaction';

import { conta, doisFatores, sessao, usuario, verificacao } from '../../../db/identidade';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import type { RateLimitStore } from '../../../security/rate-limit-store';
import { CABECALHO_ORIGEM, criarProtecao, JANELA_DE_BLOQUEIO_MS, TETO_DE_FALHAS, type DependenciasDaProtecao } from './protecao';
import { conferirSenha, gerarHashDeSenha } from './senha';

/** Inatividade (E5): sem uso por 15 min, a sessão morre no servidor. */
export const INATIVIDADE_S = 15 * 60;
/** Prazo absoluto (R3): nenhuma sessão vive mais que 12 h, mesmo em uso. */
export const PRAZO_ABSOLUTO_MS = 12 * 60 * 60 * 1000;
export { CABECALHO_ORIGEM };
/** Nome do emissor no aplicativo autenticador (sem dado de clínica). */
export const EMISSOR_DO_TOTP = 'Plataforma Saude';

export interface OpcoesDaAutenticacao {
  /** Drizzle no pool do papel `app_auth` (R1): o único com acesso ao schema identidade. */
  readonly db: Database;
  /** BETTER_AUTH_SECRET: 32 bytes ou mais, do Secrets Manager (R2). */
  readonly segredo: string;
  /** BETTER_AUTH_SECRETS (R9 do #152): a primeira cifra; as demais só decifram. O `segredo` vira o legado. */
  readonly segredosVersionados?: readonly { readonly version: number; readonly value: string }[];
  /** URL pública fixa da API (R2): nunca derivada do Host da requisição. */
  readonly baseURL: string;
  /** A mesma allowlist do CORS, sem curinga (R8). */
  readonly origensConfiaveis: readonly string[];
  /** true fora de development/test: cookie Secure e prefixo __Host- (R8). */
  readonly producao: boolean;
  /** Segredo do HMAC de origem e user-agent (R10). */
  readonly chaveHmac: Uint8Array;
  /** Store dos contadores de bloqueio (o do rate limit: Redis em produção). */
  readonly store: RateLimitStore;
  /** Ganchos do provedor para o código aceito ou recusado (mfa_em e trilha). */
  readonly fator: Pick<DependenciasDaProtecao, 'aoVerificarMfa' | 'aoFalharMfa' | 'podeCadastrarFator' | 'aoBloquearFator'>;
  /** Conferência de senha vazada (R15): k-anonimato em produção; dublê nos testes. */
  readonly conferirSenhaVazada: DependenciasDaProtecao['conferirSenhaVazada'];
}

export const TAMANHO_MINIMO_DO_SEGREDO = 32;

/** Nome do cookie de sessão: `__Host-` fora de dev/test (exige Secure, Path=/ e sem Domain). */
export function nomeDoCookie(producao: boolean): string {
  return producao ? '__Host-sessao' : 'sessao';
}

export function hmacCurto(chave: Uint8Array, valor: string): string {
  return createHmac('sha256', chave).update(valor).digest('hex').slice(0, 16);
}

const HEX16 = /^[0-9a-f]{16}$/;

export function criarAutenticacao(o: OpcoesDaAutenticacao): Auth {
  if (Buffer.byteLength(o.segredo, 'utf8') < TAMANHO_MINIMO_DO_SEGREDO) {
    throw new Error(`BETTER_AUTH_SECRET precisa de ao menos ${TAMANHO_MINIMO_DO_SEGREDO} bytes`);
  }
  if (o.origensConfiaveis.some((x) => x.includes('*'))) throw new Error('trustedOrigins com curinga é proibido');
  const protecao = criarProtecao({ store: o.store, chaveHmac: o.chaveHmac, gastarTempoDeSenha: gerarHashDeSenha, conferirSenhaVazada: o.conferirSenhaVazada, ...o.fator });
  const opcoes: BetterAuthOptions = {
    appName: 'plataforma-saude',
    baseURL: o.baseURL,
    basePath: '/api/auth',
    secret: o.segredo,
    ...(o.segredosVersionados?.length ? { secrets: o.segredosVersionados.map((s) => ({ version: s.version, value: s.value })) } : {}),
    telemetry: { enabled: false },
    trustedOrigins: [...o.origensConfiaveis],
    database: drizzleAdapter(o.db, { provider: 'pg', schema: { usuario, sessao, conta, verificacao, doisFatores } }),
    user: {
      modelName: 'usuario',
      additionalFields: {
        ativo: { type: 'boolean', input: false, required: false, defaultValue: true },
        clinicaDeOrigem: { type: 'string', input: false, required: false, returned: false },
        conviteDeOrigem: { type: 'string', input: false, required: false, returned: false },
        inativaPor: { type: 'string', input: false, required: false, returned: false },
      },
    },
    session: {
      modelName: 'sessao',
      expiresIn: INATIVIDADE_S,
      updateAge: 60,
      freshAge: INATIVIDADE_S,
      cookieCache: { enabled: false },
      additionalFields: {
        clinicaAtiva: { type: 'string', input: false, required: false, returned: false },
        mfaEm: { type: 'date', input: false, required: false, returned: false },
        perfisNoMfa: { type: 'string', input: false, required: false, returned: false },
        mfaSemClinicaEm: { type: 'date', input: false, required: false, returned: false },
        cadastroPendenteAte: { type: 'date', input: false, required: false, returned: false },
      },
    },
    account: { modelName: 'conta' },
    verification: { modelName: 'verificacao' },
    emailAndPassword: {
      enabled: true,
      // A conta nasce pelo convite da clínica (PR 3); cadastro público desligado. Recuperação desligada até
      // existir o provedor de e-mail (§9 do desenho): sem sendResetPassword.
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      password: { hash: gerarHashDeSenha, verify: conferirSenha },
    },
    // PR 2: TOTP. A OBRIGATORIEDADE do MFA continua nossa (mfa.ts); a biblioteca só confere o código. Sem OTP por
    // e-mail/SMS (sem sendOTP) e sem "lembrar este aparelho" (recusado no gancho). O bloqueio da biblioteca no login
    // em duas etapas fica em 5 falhas e 15 min, igual ao nosso.
    plugins: [
      twoFactor({
        issuer: EMISSOR_DO_TOTP,
        totpOptions: { digits: 6, period: 30 },
        accountLockout: { enabled: true, maxFailedAttempts: TETO_DE_FALHAS, durationSeconds: JANELA_DE_BLOQUEIO_MS / 1000 },
        twoFactorCookieMaxAge: 5 * 60,
        trustDeviceMaxAge: 1,
        // As chaves JS da tabela já são os nomes da biblioteca (colunas em português no SQL, 0065).
        schema: { twoFactor: { modelName: 'doisFatores' } },
      }),
    ],
    hooks: { before: protecao.antes, after: protecao.depois },
    // R10: o rate limit da biblioteca (em memória, por instância) fica desligado; o bloqueio é nosso, no Redis.
    rateLimit: { enabled: false },
    advanced: {
      // R8 do parecer do código (#149): com useSecureCookies a biblioteca acrescenta __Secure- ao nome e o cookie
      // sairia __Secure-__Host-sessao. O Secure vem dos atributos; o nome fica exatamente o nosso.
      useSecureCookies: false,
      cookies: { session_token: { name: nomeDoCookie(o.producao) } },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', secure: o.producao, path: '/' },
      database: { generateId: () => randomUUID() },
      // A origem chega já em HMAC por um cabeçalho que a nossa montagem preenche (o do cliente é apagado antes).
      ipAddress: { ipAddressHeaders: [CABECALHO_ORIGEM] },
    },
    // R12: nunca o corpo da requisição nem a mensagem (podem ter e-mail); só que houve erro interno na biblioteca.
    logger: {
      level: 'error',
      log: () => registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo: 'erro_na_autenticacao' }),
    },
    databaseHooks: {
      session: {
        create: {
          // R10: só HMAC na tabela. O IP chega em HMAC pelo nosso cabeçalho; o user-agent vira HMAC aqui.
          before: async (s) => {
            // Conta inativa (desligada) não abre sessão nem gera LOGIN_OK (ressalva do parecer do código, #149).
            const [u] = await o.db.select({ ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, s.userId));
            if (!u?.ativo) return false;
            return {
              data: {
                ...s,
                ipAddress: typeof s.ipAddress === 'string' && HEX16.test(s.ipAddress) ? s.ipAddress : null,
                userAgent: typeof s.userAgent === 'string' && s.userAgent !== '' ? hmacCurto(o.chaveHmac, `ua:${s.userAgent}`) : null,
              },
            };
          },
          // Login aceito no log de segurança, com o usuário e a origem em HMAC (nunca o e-mail). R3 do #152: com TOTP
          // cadastrado, a sessão do passo da senha é PROVISÓRIA (a biblioteca a apaga e abre o desafio): sai
          // `LOGIN_SENHA_OK` aguardando o fator, e o `LOGIN_OK` só na sessão definitiva, depois do código.
          after: async (s, ctx) => {
            const origem = typeof s.ipAddress === 'string' && HEX16.test(s.ipAddress) ? { origem: s.ipAddress } : {};
            if (ctx?.path === '/sign-in/email') {
              const [u] = await o.db.select({ fator: usuario.twoFactorEnabled }).from(usuario).where(eq(usuario.id, s.userId));
              if (u?.fator) {
                registrarEventoDeSeguranca('LOGIN_SENHA_OK', { motivo: 'aguardando_fator', userId: s.userId, ...origem });
                return;
              }
            }
            registrarEventoDeSeguranca('LOGIN_OK', { userId: s.userId, ...origem });
          },
        },
      },
    },
  };
  return betterAuth(opcoes);
}

/** Tipo público da biblioteca (o inferido citaria tipos internos do zod; os endpoints do plugin vão pela HTTP). */
export type Autenticacao = Auth;

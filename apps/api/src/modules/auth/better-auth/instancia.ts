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
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Database } from '../../../db/tenant-transaction';

import { conta, sessao, usuario, verificacao } from '../../../db/identidade';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { conferirSenha, gerarHashDeSenha } from './senha';

/** Inatividade (E5): sem uso por 15 min, a sessão morre no servidor. */
export const INATIVIDADE_S = 15 * 60;
/** Prazo absoluto (R3): nenhuma sessão vive mais que 12 h, mesmo em uso. */
export const PRAZO_ABSOLUTO_MS = 12 * 60 * 60 * 1000;
/** Cabeçalho que a NOSSA montagem preenche com o HMAC da origem (o do cliente é apagado antes). */
export const CABECALHO_ORIGEM = 'x-plataforma-origem';

export interface OpcoesDaAutenticacao {
  /** Drizzle no pool do papel `app_auth` (R1): o único com acesso ao schema identidade. */
  readonly db: Database;
  /** BETTER_AUTH_SECRET: 32 bytes ou mais, do Secrets Manager (R2). */
  readonly segredo: string;
  /** URL pública fixa da API (R2): nunca derivada do Host da requisição. */
  readonly baseURL: string;
  /** A mesma allowlist do CORS, sem curinga (R8). */
  readonly origensConfiaveis: readonly string[];
  /** true fora de development/test: cookie Secure e prefixo __Host- (R8). */
  readonly producao: boolean;
  /** Segredo do HMAC de origem e user-agent (R10). */
  readonly chaveHmac: Uint8Array;
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

export function criarAutenticacao(o: OpcoesDaAutenticacao) {
  if (Buffer.byteLength(o.segredo, 'utf8') < TAMANHO_MINIMO_DO_SEGREDO) {
    throw new Error(`BETTER_AUTH_SECRET precisa de ao menos ${TAMANHO_MINIMO_DO_SEGREDO} bytes`);
  }
  if (o.origensConfiaveis.some((x) => x.includes('*'))) throw new Error('trustedOrigins com curinga é proibido');
  return betterAuth({
    appName: 'plataforma-saude',
    baseURL: o.baseURL,
    basePath: '/api/auth',
    secret: o.segredo,
    telemetry: { enabled: false },
    trustedOrigins: [...o.origensConfiaveis],
    database: drizzleAdapter(o.db, { provider: 'pg', schema: { usuario, sessao, conta, verificacao } }),
    user: {
      modelName: 'usuario',
      additionalFields: { ativo: { type: 'boolean', input: false, required: false, defaultValue: true } },
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
    // R10: o rate limit da biblioteca (em memória, por instância) fica desligado; o bloqueio é nosso, no Redis.
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: o.producao,
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
          before: (s) =>
            Promise.resolve({
              data: {
                ...s,
                ipAddress: typeof s.ipAddress === 'string' && HEX16.test(s.ipAddress) ? s.ipAddress : null,
                userAgent: typeof s.userAgent === 'string' && s.userAgent !== '' ? hmacCurto(o.chaveHmac, `ua:${s.userAgent}`) : null,
              },
            }),
        },
      },
    },
  });
}

export type Autenticacao = ReturnType<typeof criarAutenticacao>;

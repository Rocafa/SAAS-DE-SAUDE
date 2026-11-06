/**
 * Better Auth configurado para os critérios da decisão D4.
 * Nada aqui é código de produção: é PoC para MEDIR, com dados sintéticos.
 *
 * Decisões espelhando os critérios do pedido:
 * - MFA TOTP + WebAuthn: plugins `twoFactor` e `passkey`.
 * - Usuário em várias clínicas + troca de clínica: plugin `organization` (organização = clínica).
 * - Access token curto: plugin `jwt` com 15 min; a sessão vive em cookie HttpOnly.
 * - Recuperação de conta sem revelar se o usuário existe: `sendResetPassword` sempre
 *   responde igual; o gancho só registra no log local.
 */
import { betterAuth } from 'better-auth';
import { bearer, jwt, organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { Pool } from 'pg';

const connectionString = process.env.POC_DATABASE_URL;
if (!connectionString) throw new Error('POC_DATABASE_URL é obrigatória (veja .env.example)');

/**
 * Sem valor padrão de propósito: segredo escrito no código vira segredo em produção,
 * e um valor de exemplo no .env.example faz o gitleaks acusar vazamento no CI.
 */
const secret = process.env.POC_AUTH_SECRET;
if (!secret) throw new Error('POC_AUTH_SECRET é obrigatória (gere com: openssl rand -base64 32)');
const baseURL = process.env.POC_BASE_URL ?? 'http://localhost:8085';

export const auth = betterAuth({
  database: new Pool({ connectionString }),
  secret,
  baseURL,
  basePath: '/api/auth',
  emailAndPassword: {
    enabled: true,
    // Não revela se o e-mail existe: a resposta do endpoint é a mesma nos dois casos.
    sendResetPassword: ({ user }) => {
      process.stdout.write(`[poc] pedido de recuperacao para ${user.id}\n`);
      return Promise.resolve();
    },
  },
  session: {
    expiresIn: 60 * 60 * 8, // 8 h de sessão
    updateAge: 60 * 15,
    freshAge: 60 * 15,
  },
  advanced: {
    // Cookie de sessão: HttpOnly e SameSite são padrão do Better Auth; aqui fica explícito.
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
    useSecureCookies: false, // PoC em http://localhost; em produção, true.
  },
  plugins: [
    twoFactor({ issuer: 'PoC D4' }),
    passkey({ rpID: 'localhost', rpName: 'PoC D4', origin: baseURL }),
    organization({ allowUserToCreateOrganization: true }),
    jwt({ jwt: { expirationTime: '15m' } }),
    bearer(),
  ],
});

export type Auth = typeof auth;

/**
 * Schema `identidade` (migração 0064, D4: Better Auth). Só o papel `app_auth` tem acesso (R1 do parecer do desenho).
 *
 * As CHAVES em JS seguem os nomes de campo que a biblioteca espera (`email`, `emailVerified`, `expiresAt`…); as
 * COLUNAS no SQL ficam em português. Os campos nossos da sessão (`clinicaAtiva`, `mfaEm`, `perfisNoMfa`) só são
 * gravados pelas nossas funções (R5). Nada aqui é dado de clínica: o vínculo pessoa×clínica continua em
 * `clinic_members`.
 */
import { boolean, index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const identidade = pgSchema('identidade');

export const usuario = identidade.table('usuario', {
  id: uuid('id').primaryKey(),
  name: text('nome').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verificado').notNull().default(false),
  image: text('imagem'),
  ativo: boolean('ativo').notNull().default(true),
  createdAt: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const sessao = identidade.table(
  'sessao',
  {
    id: uuid('id').primaryKey(),
    token: text('token').notNull(),
    expiresAt: timestamp('expira_em', { withTimezone: true }).notNull(),
    createdAt: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
    /** R10: HMAC de 16 hex; a biblioteca chama de ipAddress, mas nunca recebe o IP em claro (gancho de banco). */
    ipAddress: text('ip_hmac'),
    userAgent: text('agente_hmac'),
    userId: uuid('usuario_id').notNull(),
    clinicaAtiva: uuid('clinica_ativa'),
    mfaEm: timestamp('mfa_em', { withTimezone: true }),
    perfisNoMfa: text('perfis_no_mfa'),
  },
  (t) => [index('sessao_usuario_idx').on(t.userId)],
);

export const conta = identidade.table('conta', {
  id: uuid('id').primaryKey(),
  accountId: text('conta_id').notNull(),
  providerId: text('provedor_id').notNull(),
  userId: uuid('usuario_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expira_em', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expira_em', { withTimezone: true }),
  scope: text('escopo'),
  password: text('senha'),
  createdAt: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

export const verificacao = identidade.table('verificacao', {
  id: uuid('id').primaryKey(),
  identifier: text('identificador').notNull(),
  value: text('valor').notNull(),
  expiresAt: timestamp('expira_em', { withTimezone: true }).notNull(),
  createdAt: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
});

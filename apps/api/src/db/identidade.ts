/**
 * Schema `identidade` (migração 0064, D4: Better Auth). Só o papel `app_auth` tem acesso (R1 do parecer do desenho).
 *
 * As CHAVES em JS seguem os nomes de campo que a biblioteca espera (`email`, `emailVerified`, `expiresAt`…); as
 * COLUNAS no SQL ficam em português. Os campos nossos da sessão (`clinicaAtiva`, `mfaEm`, `perfisNoMfa`) só são
 * gravados pelas nossas funções (R5). Nada aqui é dado de clínica: o vínculo pessoa×clínica continua em
 * `clinic_members`.
 */
import { boolean, index, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const identidade = pgSchema('identidade');

export const usuario = identidade.table('usuario', {
  id: uuid('id').primaryKey(),
  name: text('nome').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verificado').notNull().default(false),
  image: text('imagem'),
  ativo: boolean('ativo').notNull().default(true),
  /** 0069 (R1 do código do 3b-3): por que a conta está inativa; só 'sem_vinculo' volta a valer numa concessão. */
  // 0082 (B13): 'substituida' (R5, definitiva) e 'suspensa_na_troca' (P2, volta no cancelamento).
  inativaPor: text('inativa_por', { enum: ['sem_vinculo', 'anonimizada', 'convite_desfeito', 'expurgada', 'substituida', 'suspensa_na_troca'] }),
  /** 0071: quando ficou inativa (o expurgo apaga a credencial da desligada há mais de 90 dias). */
  inativaDesde: timestamp('inativa_desde', { withTimezone: true }),
  /** Cadastro do TOTP concluído (0065): o login passa a pedir o código. */
  twoFactorEnabled: boolean('dois_fatores_ativo').notNull().default(false),
  /** 0067 (R17): clínica e convite de onde a conta veio. */
  clinicaDeOrigem: uuid('clinica_de_origem'),
  conviteDeOrigem: uuid('convite_de_origem'),
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
    /** TOTP aceito sem clínica ativa (0066): só a escolha de clínica em até 5 min o converte em `mfaEm`. */
    mfaSemClinicaEm: timestamp('mfa_sem_clinica_em', { withTimezone: true }),
    /** 0067 (R8): sessão aberta no aceite do convite; só serve ao cadastro do TOTP até esta hora. */
    cadastroPendenteAte: timestamp('cadastro_pendente_ate', { withTimezone: true }),
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

/**
 * 0073 (V3 do #177): clínicas onde a conta aceitou convite que ainda guarda o HMAC do e-mail (só ids), espelho de
 * `team_invites` para a anonimização. A linha sai quando o HMAC é descartado (V1 do #178).
 */
export const conviteAceito = identidade.table('convite_aceito', {
  usuarioId: uuid('usuario_id').notNull(),
  clinicaId: uuid('clinica_id').notNull(),
});

/** Espelho dos vínculos ATIVOS (só ids e papel de sessão), mantido por trigger em clinic_members (R7). Só leitura. */
export const vinculo = identidade.table('vinculo', {
  usuarioId: uuid('usuario_id').notNull(),
  clinicaId: uuid('clinica_id').notNull(),
  papel: text('papel').notNull(),
});

/**
 * Segundo fator (0065, PR 2). `secret` e `backupCodes` chegam CIFRADOS pela biblioteca. `failedVerificationCount` e
 * `lockedUntil` são o bloqueio da biblioteca no login em duas etapas; a reverificação com sessão aberta usa o nosso.
 */
export const doisFatores = identidade.table('dois_fatores', {
  id: uuid('id').primaryKey(),
  userId: uuid('usuario_id').notNull(),
  secret: text('segredo').notNull(),
  backupCodes: text('codigos_reserva').notNull(),
  verified: boolean('verificado').notNull().default(false),
  failedVerificationCount: integer('falhas').notNull().default(0),
  lockedUntil: timestamp('bloqueado_ate', { withTimezone: true }),
  /** 0066: para o expurgo do cadastro não concluído (a biblioteca não grava; o banco preenche). */
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
});

/** Token de recuperação pelo admin (0068, PR 3b-2): uso único, 15 min, só o hash. */
export const recuperacao = identidade.table('recuperacao', {
  id: uuid('id').primaryKey(),
  usuarioId: uuid('usuario_id').notNull(),
  tipo: text('tipo', { enum: ['senha', 'fator'] }).notNull(),
  tokenHash: text('token_hash').notNull(),
  clinicaId: uuid('clinica_id').notNull(),
  criadoPor: uuid('criado_por').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
  usadoEm: timestamp('usado_em', { withTimezone: true }),
  /** 0077 (B12): 'suporte' = emitido pelo comando operacional, só tipo `fator`, ator sistema, 24 h, com `chamado`. */
  origem: text('origem', { enum: ['admin', 'suporte'] }).notNull().default('admin'),
  /** `SUP-<número>`, só com origem 'suporte' (check da 0077). */
  chamado: text('chamado'),
});

/**
 * Ativação do fundador da clínica provisionada (0076; B11, R1 do parecer de 16/11/2026). `id` = uuid do pedido. Só o
 * HMAC do e-mail e o SHA-256 do token, 72 h, uso único; no máximo uma pendente por clínica.
 */
export const ativacaoDoFundador = identidade.table('ativacao_do_fundador', {
  id: uuid('id').primaryKey(),
  clinicaId: uuid('clinica_id').notNull(),
  usuarioId: uuid('usuario_id').notNull(),
  emailHmac: text('email_hmac').notNull(),
  contaExistente: boolean('conta_existente').notNull(),
  tokenHash: text('token_hash').notNull(),
  contrato: text('contrato').notNull(),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
  usadoEm: timestamp('usado_em', { withTimezone: true }),
  falhas: integer('falhas').notNull().default(0),
  /** 0082 (B13): 'troca' = conta nova da troca do admin único (24 h, sempre conta nova, com chamado e troca). */
  origem: text('origem', { enum: ['provisionamento', 'troca'] }).notNull().default('provisionamento'),
  chamado: text('chamado'),
  trocaId: uuid('troca_id'),
});

/**
 * Troca do admin único que perdeu senha e fator (0082; B13, parecer do Guardião de 24/11/2026). `id` = uuid do pedido.
 * Só ids, códigos e o HMAC do e-mail novo (zerado na emissão e no encerramento). `operadorPedido` fica SÓ aqui (R4),
 * nunca na trilha da clínica. O trigger da 0082 aceita só o grafo de estados do desenho (R3).
 */
export const ESTADOS_DA_TROCA = ['aguardando', 'emitida', 'liberada_sem_token', 'ativada', 'concluida', 'contestada', 'suspensa', 'cancelada', 'vencida'] as const;
export type EstadoDaTroca = (typeof ESTADOS_DA_TROCA)[number];
/** Estados finais (nenhuma transição sai deles). */
export const ESTADOS_FINAIS_DA_TROCA: readonly EstadoDaTroca[] = ['concluida', 'contestada', 'cancelada', 'vencida'];
/** Estados em andamento (contam como pedido pendente da clínica). */
export const ESTADOS_ABERTOS_DA_TROCA: readonly EstadoDaTroca[] = ['aguardando', 'emitida', 'liberada_sem_token', 'ativada', 'suspensa'];

export const trocaDoAdmin = identidade.table('troca_do_admin', {
  id: uuid('id').primaryKey(),
  clinicaId: uuid('clinica_id').notNull(),
  usuarioAntigo: uuid('usuario_antigo').notNull(),
  usuarioNovo: uuid('usuario_novo').notNull(),
  operadorPedido: uuid('operador_pedido').notNull(),
  emailHmac: text('email_hmac').notNull(),
  motivo: text('motivo', { enum: ['perdeu_senha_e_fator', 'titular_indisponivel', 'suspeita_de_invasao'] }).notNull(),
  chamado: text('chamado').notNull(),
  contrato: text('contrato').notNull(),
  pedidoEm: timestamp('pedido_em', { withTimezone: true }).notNull().defaultNow(),
  liberaEm: timestamp('libera_em', { withTimezone: true }).notNull(),
  estado: text('estado', { enum: ESTADOS_DA_TROCA }).notNull().default('aguardando'),
  encerradaEm: timestamp('encerrada_em', { withTimezone: true }),
  encerradaPor: text('encerrada_por', { enum: ['contrato', 'dpo', 'titular', 'login_da_conta_antiga', 'sistema'] }),
  reemissoes: integer('reemissoes').notNull().default(0),
  contaAntigaSuspensa: boolean('conta_antiga_suspensa').notNull().default(false),
});

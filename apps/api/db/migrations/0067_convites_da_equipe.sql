-- 0067 — Convite da equipe e cadastro do fator preso ao convite (D4, PR 3b; desenho §14.2, R1, R2 e R8 do parecer
-- do desenho do PR 3). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * `team_invites` (da CLÍNICA, com RLS): o convite NÃO toca `identidade.usuario` nem concede perfil; o vínculo só nasce
--   no aceite (R2). Guarda só o SHA-256 do token e o HMAC do e-mail (para conferir no aceite, R16); nunca o e-mail em
--   claro. Vale no máximo 72 h; termina aceito OU revogado.
-- * `identidade.sessao.cadastro_pendente_ate`: a sessão aberta no aceite só serve ao cadastro do TOTP, por no máximo
--   15 min (R8); o `enable` só é aceito nela.
-- * `identidade.usuario.clinica_de_origem` e `convite_de_origem` (R17): de onde a conta veio, para a disputa de e-mail.

CREATE TABLE team_invites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  token_hash       text NOT NULL CONSTRAINT team_invites_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email_hmac       text NOT NULL CONSTRAINT team_invites_email_hmac_check CHECK (email_hmac ~ '^[0-9a-f]{32}$'),
  role             text NOT NULL CONSTRAINT team_invites_role_check CHECK (role IN ('admin', 'profissional', 'recepcao', 'financeiro', 'psicologo')),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid,
  revoked_at       timestamptz,
  revoked_by       uuid,
  CONSTRAINT team_invites_token_hash_key UNIQUE (token_hash),
  CONSTRAINT team_invites_validity_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours'),
  CONSTRAINT team_invites_accept_check CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL)),
  CONSTRAINT team_invites_revoke_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT team_invites_terminal_check CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX team_invites_pending_idx ON team_invites (tenant_id, created_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- Teto diário por admin (R9): contagem dos convites de quem convidou no dia.
CREATE INDEX team_invites_created_by_idx ON team_invites (tenant_id, created_by, created_at);

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_invites
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE DELETE, TRUNCATE ON team_invites FROM app_user;
-- Na sessão do portal do paciente, nenhuma linha (padrão das tabelas da clínica, 0027).
CREATE POLICY portal_fora ON team_invites AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

ALTER TABLE identidade.sessao ADD COLUMN cadastro_pendente_ate timestamptz;
ALTER TABLE identidade.usuario ADD COLUMN clinica_de_origem uuid, ADD COLUMN convite_de_origem uuid;

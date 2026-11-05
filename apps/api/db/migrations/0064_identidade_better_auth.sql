-- 0064 — Identidade da autenticação real (D4: Better Auth). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Desenho: docs/04-arquitetura/autenticacao-better-auth.md; parecer: docs/03-seguranca-lgpd/revisoes/2026-11-05-desenho-better-auth.md.
--
-- * Schema `identidade` (criado pelo bootstrap, dono app_migrator): pessoa, sessão, credencial e tokens de uso único.
--   Sem tenant_id nem RLS por clínica (a pessoa pode estar em várias clínicas); o acesso é só do papel `app_auth`
--   (R1 do parecer). O `app_user` das rotas de negócio NÃO tem GRANT aqui: o token da sessão fica em claro na tabela.
-- * IP e user-agent da sessão só em HMAC (R10). Campos NOSSOS na sessão: `clinica_ativa`, `mfa_em` e
--   `perfis_no_mfa` (gravados só pelas nossas funções; a biblioteca recebe `input: false`, R5).
-- * `app_clinicas_do_usuario(usuario)`: as clínicas com vínculo ATIVO da pessoa (só ids), para a escolha da clínica
--   (R7). `clinic_members` tem RLS forçado por clínica; a leitura cruzada vale SÓ dentro desta função, por uma
--   política que exige o DONO da tabela E a GUC que a cláusula SET da função liga. Outras funções SECURITY DEFINER
--   do mesmo dono não ligam a GUC e seguem vendo só a clínica da transação; o app_user não é dono.

CREATE TABLE identidade.usuario (
  id               uuid PRIMARY KEY,
  nome             text NOT NULL CONSTRAINT usuario_nome_check CHECK (length(nome) BETWEEN 1 AND 200),
  email            text NOT NULL CONSTRAINT usuario_email_check CHECK (length(email) BETWEEN 3 AND 320),
  email_verificado boolean NOT NULL DEFAULT false,
  imagem           text,
  -- Desligamento (PR 3): conta inativa não entra. Nunca se apaga enquanto houver autoria clínica (R18).
  ativo            boolean NOT NULL DEFAULT true,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usuario_email_idx ON identidade.usuario (lower(email));

CREATE TABLE identidade.sessao (
  id            uuid PRIMARY KEY,
  token         text NOT NULL,
  expira_em     timestamptz NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  -- R10: só HMAC (16 hex), nunca o IP ou o user-agent em claro.
  ip_hmac       text CONSTRAINT sessao_ip_hmac_check CHECK (ip_hmac IS NULL OR ip_hmac ~ '^[0-9a-f]{16}$'),
  agente_hmac   text CONSTRAINT sessao_agente_hmac_check CHECK (agente_hmac IS NULL OR agente_hmac ~ '^[0-9a-f]{16}$'),
  usuario_id    uuid NOT NULL REFERENCES identidade.usuario (id) ON DELETE CASCADE,
  clinica_ativa uuid,
  mfa_em        timestamptz,
  perfis_no_mfa text CONSTRAINT sessao_perfis_no_mfa_check CHECK (perfis_no_mfa IS NULL OR perfis_no_mfa ~ '^[0-9a-f]{16}$')
);
CREATE UNIQUE INDEX sessao_token_idx ON identidade.sessao (token);
CREATE INDEX sessao_usuario_idx ON identidade.sessao (usuario_id);
CREATE INDEX sessao_expira_idx ON identidade.sessao (expira_em);

CREATE TABLE identidade.conta (
  id                      uuid PRIMARY KEY,
  conta_id                text NOT NULL,
  provedor_id             text NOT NULL,
  usuario_id              uuid NOT NULL REFERENCES identidade.usuario (id) ON DELETE CASCADE,
  access_token            text,
  refresh_token           text,
  id_token                text,
  access_token_expira_em  timestamptz,
  refresh_token_expira_em timestamptz,
  escopo                  text,
  -- Hash scrypt nosso (N=2^16, r=8, p=2), nunca a senha (R9).
  senha                   text,
  criado_em               timestamptz NOT NULL DEFAULT now(),
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conta_usuario_idx ON identidade.conta (usuario_id);

CREATE TABLE identidade.verificacao (
  id            uuid PRIMARY KEY,
  identificador text NOT NULL,
  valor         text NOT NULL,
  expira_em     timestamptz NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verificacao_identificador_idx ON identidade.verificacao (identificador);

-- R1: só o app_auth. Sem DELETE em usuario e conta (desligar é marcar inativo; R18).
REVOKE ALL ON ALL TABLES IN SCHEMA identidade FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON identidade.usuario, identidade.conta TO app_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON identidade.sessao, identidade.verificacao TO app_auth;

-- R7: clínicas com vínculo ativo da pessoa (só ids). Perfis de sessão apenas (a qualificação psicologo não conta).
CREATE POLICY clinicas_do_usuario_leitura ON clinic_members FOR SELECT
  USING (current_setting('app.clinicas_do_usuario', true) = 'on' AND (SELECT app_running_as_owner('public.clinic_members'::regclass)));

CREATE FUNCTION app_clinicas_do_usuario(p_usuario uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET app.clinicas_do_usuario = 'on'
AS $$
  SELECT DISTINCT m.tenant_id FROM public.clinic_members m
   WHERE m.user_id = p_usuario AND m.revoked_at IS NULL AND m.role IN ('admin', 'profissional', 'recepcao', 'financeiro')
   ORDER BY m.tenant_id
$$;
REVOKE ALL ON FUNCTION app_clinicas_do_usuario(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_clinicas_do_usuario(uuid) TO app_auth;

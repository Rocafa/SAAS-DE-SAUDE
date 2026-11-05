-- 0064 — Identidade da autenticação real (D4: Better Auth). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Desenho: docs/04-arquitetura/autenticacao-better-auth.md; parecer: docs/03-seguranca-lgpd/revisoes/2026-11-05-desenho-better-auth.md.
--
-- * Schema `identidade` (criado pelo bootstrap, dono app_migrator): pessoa, sessão, credencial e tokens de uso único.
--   Sem tenant_id nem RLS por clínica (a pessoa pode estar em várias clínicas); o acesso é só do papel `app_auth`
--   (R1 do parecer). O `app_user` das rotas de negócio NÃO tem GRANT aqui: o token da sessão fica em claro na tabela.
-- * IP e user-agent da sessão só em HMAC (R10). Campos NOSSOS na sessão: `clinica_ativa`, `mfa_em` e
--   `perfis_no_mfa` (gravados só pelas nossas funções; a biblioteca recebe `input: false`, R5).
-- * `identidade.vinculo`: espelho (só ids e papel) dos vínculos ATIVOS, mantido por trigger em clinic_members, para a
--   escolha da clínica (R7). Nenhuma política nova em clinic_members.

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

-- R7: clínicas com vínculo ATIVO da pessoa, só ids e papel de sessão (a qualificação psicologo não conta).
-- Espelho mantido por trigger em clinic_members (mesmo padrão do portal_link_index da 0027): a autenticação lê o
-- espelho no schema identidade e NENHUMA política nova é criada em clinic_members (a guarda de schema recusa política
-- com current_setting, alterável por SQL injetado). O app_user não lê o espelho; o app_auth só lê.
CREATE TABLE identidade.vinculo (
  usuario_id uuid NOT NULL,
  clinica_id uuid NOT NULL,
  papel      text NOT NULL CONSTRAINT vinculo_papel_check CHECK (papel IN ('admin', 'profissional', 'recepcao', 'financeiro')),
  PRIMARY KEY (usuario_id, clinica_id, papel)
);
REVOKE ALL ON identidade.vinculo FROM PUBLIC;
GRANT SELECT ON identidade.vinculo TO app_auth;

CREATE FUNCTION app_espelhar_vinculo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role NOT IN ('admin', 'profissional', 'recepcao', 'financeiro') THEN
    RETURN NULL;
  END IF;
  IF NEW.revoked_at IS NULL THEN
    INSERT INTO identidade.vinculo (usuario_id, clinica_id, papel) VALUES (NEW.user_id, NEW.tenant_id, NEW.role)
      ON CONFLICT DO NOTHING;
  ELSE
    -- Só some do espelho se não houver OUTRA linha ativa do mesmo papel (revogado e concedido de novo).
    DELETE FROM identidade.vinculo v
     WHERE v.usuario_id = NEW.user_id AND v.clinica_id = NEW.tenant_id AND v.papel = NEW.role
       AND NOT EXISTS (SELECT 1 FROM public.clinic_members m
                        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.role = NEW.role
                          AND m.revoked_at IS NULL AND m.id <> NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_espelhar_vinculo() FROM PUBLIC;
CREATE TRIGGER zz_espelhar_vinculo AFTER INSERT OR UPDATE OF revoked_at ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION app_espelhar_vinculo();

-- Carga inicial: o dono só enxerga todas as clínicas com o RLS forçado desligado, e só nesta transação.
ALTER TABLE clinic_members NO FORCE ROW LEVEL SECURITY;
INSERT INTO identidade.vinculo (usuario_id, clinica_id, papel)
  SELECT DISTINCT m.user_id, m.tenant_id, m.role FROM clinic_members m
   WHERE m.revoked_at IS NULL AND m.role IN ('admin', 'profissional', 'recepcao', 'financeiro')
  ON CONFLICT DO NOTHING;
ALTER TABLE clinic_members FORCE ROW LEVEL SECURITY;

-- 0068 — Recuperação de credencial pelo admin (D4, PR 3b-2; R17 do parecer do desenho da D4; R1 do parecer do
-- desenho do PR 3). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * Token de uso único, 15 min, só o SHA-256 no banco, preso à pessoa, ao tipo e à clínica do admin que o emitiu.
-- * NENHUM token restaura os dois fatores (R1): o de senha exige o código TOTP atual; o de fator exige a senha atual.
-- * Só o papel `app_auth` acessa (schema identidade, R1 do desenho da D4).

CREATE TABLE identidade.recuperacao (
  id          uuid PRIMARY KEY,
  usuario_id  uuid NOT NULL REFERENCES identidade.usuario (id) ON DELETE CASCADE,
  tipo        text NOT NULL CONSTRAINT recuperacao_tipo_check CHECK (tipo IN ('senha', 'fator')),
  token_hash  text NOT NULL CONSTRAINT recuperacao_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  clinica_id  uuid NOT NULL,
  criado_por  uuid NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  expira_em   timestamptz NOT NULL,
  usado_em    timestamptz,
  CONSTRAINT recuperacao_token_hash_key UNIQUE (token_hash),
  CONSTRAINT recuperacao_validade_check CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '15 minutes')
);
CREATE INDEX recuperacao_usuario_idx ON identidade.recuperacao (usuario_id);

REVOKE ALL ON identidade.recuperacao FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON identidade.recuperacao TO app_auth;

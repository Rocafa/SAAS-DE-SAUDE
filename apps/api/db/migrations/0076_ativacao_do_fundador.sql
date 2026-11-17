-- 0076 — Ativação do fundador da clínica provisionada (B11, PR 1; R1, R6 e R8 do parecer do Guardião de 16/11/2026 sobre
-- docs/04-arquitetura/provisionamento-da-clinica.md). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * Uma linha por pedido de provisionamento (`id` = uuid do pedido, que torna a tarefa idempotente). Sem e-mail nem nome
--   em claro e sem e-mail cifrado recuperável (R1): só o HMAC do e-mail (uso `convite-email`, o mesmo do convite, para a
--   ativação conferir o e-mail digitado como o aceite confere) e o SHA-256 do token de uso único (72 h).
-- * `usuario_id` é a conta que já existe ou o uuid reservado para a conta que nasce na ativação (R2). Sem FK para
--   `identidade.usuario`: a conta nova ainda não existe.
-- * No máximo uma ativação pendente por clínica (R8). A invalidação (reemissão, bloqueio na 5ª falha) fica para o PR 2,
--   que fecha a linha preenchendo `usado_em` ou atualiza o token na própria linha.
-- * `email_hmac` é zerado (32 zeros, como `EMAIL_DESCARTADO` do convite) na ativação ou no vencimento (R6, PR 2).
-- * Schema identidade: só o `app_auth` acessa, como `identidade.recuperacao` (0068). O `app_user` não lê nem escreve.

CREATE TABLE identidade.ativacao_do_fundador (
  id               uuid PRIMARY KEY,
  clinica_id       uuid NOT NULL,
  usuario_id       uuid NOT NULL,
  email_hmac       text NOT NULL CONSTRAINT ativacao_do_fundador_email_hmac_check CHECK (email_hmac ~ '^[0-9a-f]{32}$'),
  conta_existente  boolean NOT NULL,
  token_hash       text NOT NULL CONSTRAINT ativacao_do_fundador_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  contrato         text NOT NULL CONSTRAINT ativacao_do_fundador_contrato_check CHECK (contrato ~ '^CTR-[0-9]{1,7}$'),
  criado_em        timestamptz NOT NULL DEFAULT now(),
  expira_em        timestamptz NOT NULL,
  usado_em         timestamptz,
  falhas           integer NOT NULL DEFAULT 0 CONSTRAINT ativacao_do_fundador_falhas_check CHECK (falhas BETWEEN 0 AND 5),
  CONSTRAINT ativacao_do_fundador_token_hash_key UNIQUE (token_hash),
  CONSTRAINT ativacao_do_fundador_validade_check CHECK (expira_em > criado_em AND expira_em <= criado_em + interval '72 hours')
);
CREATE UNIQUE INDEX ativacao_do_fundador_pendente_idx ON identidade.ativacao_do_fundador (clinica_id) WHERE usado_em IS NULL;

REVOKE ALL ON identidade.ativacao_do_fundador FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON identidade.ativacao_do_fundador TO app_auth;

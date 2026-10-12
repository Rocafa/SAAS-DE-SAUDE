-- 0004 — Chaves de dados por clínica (S5: criptografia de campo em envelope).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/criptografia-de-campo.md.
--
-- Cada clínica tem uma chave mestra própria (KEK: chave no KMS em produção) e uma ou mais chaves de
-- dados (DEK). Aqui fica SÓ a DEK cifrada pela KEK ("wrapped"): o banco, seus snapshots e backups
-- nunca guardam chave em claro. Destruir a KEK da clínica torna ilegíveis todas as cópias da DEK e,
-- com elas, todos os campos cifrados (crypto-shredding — retencao-e-descarte.md §4.1, opção C).
--
-- Ciclo de vida das linhas: active -> retired -> destroyed (ou active -> destroyed).
-- - Uma única chave mestra ativa por clínica. As aposentadas (após rotação da KEK) continuam
--   registradas: backups anteriores à rotação ainda dependem delas, e a eliminação da clínica
--   precisa destruir TODAS — por isso a lista vive no banco, não só no KMS.
-- - Uma única DEK ativa por clínica (cifra os dados novos); as aposentadas continuam decifrando os
--   dados antigos, o que permite girar a chave sem downtime. Destruída é terminal e sem chave.

CREATE TABLE tenant_master_keys (
  -- ARN da chave no KMS (produção) ou identificador do provedor local (dev/teste). Não é segredo.
  id           text PRIMARY KEY
                 CONSTRAINT tenant_master_keys_id_check CHECK (length(id) BETWEEN 1 AND 2048),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  status       text NOT NULL DEFAULT 'active'
                 CONSTRAINT tenant_master_keys_status_check
                 CHECK (status IN ('active', 'retired', 'destroyed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  CONSTRAINT tenant_master_keys_destroyed_check CHECK ((status = 'destroyed') = (destroyed_at IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_master_keys_one_active_idx ON tenant_master_keys (tenant_id) WHERE status = 'active';
CREATE INDEX tenant_master_keys_tenant_idx ON tenant_master_keys (tenant_id);

CREATE TABLE tenant_data_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  master_key_id text NOT NULL REFERENCES tenant_master_keys (id),
  wrapped_key   bytea
                  CONSTRAINT tenant_data_keys_wrapped_key_check
                  CHECK (wrapped_key IS NULL OR length(wrapped_key) BETWEEN 32 AND 1024),
  status        text NOT NULL DEFAULT 'active'
                  CONSTRAINT tenant_data_keys_status_check
                  CHECK (status IN ('active', 'retired', 'destroyed')),
  -- Cifragens feitas com esta DEK (aproximado: cada instância soma em lotes). Com IV aleatório de
  -- 96 bits, o NIST SP 800-38D limita a 2^32 usos por chave; a aplicação gira bem antes (2^30).
  encrypt_count bigint NOT NULL DEFAULT 0
                  CONSTRAINT tenant_data_keys_encrypt_count_check CHECK (encrypt_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  retired_at    timestamptz,
  destroyed_at  timestamptz,
  CONSTRAINT tenant_data_keys_destroyed_check
    CHECK ((status = 'destroyed') = (wrapped_key IS NULL)
       AND (status = 'destroyed') = (destroyed_at IS NOT NULL))
);
-- No máximo uma DEK ativa por clínica (a corrida de provisionamento termina em conflito, não em duas).
CREATE UNIQUE INDEX tenant_data_keys_one_active_idx ON tenant_data_keys (tenant_id) WHERE status = 'active';
CREATE INDEX tenant_data_keys_tenant_idx ON tenant_data_keys (tenant_id);

ALTER TABLE tenant_master_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_master_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_master_keys_select ON tenant_master_keys FOR SELECT
  USING (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY tenant_master_keys_insert ON tenant_master_keys FOR INSERT
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY tenant_master_keys_update ON tenant_master_keys FOR UPDATE
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE tenant_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_data_keys_select ON tenant_data_keys FOR SELECT
  USING (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY tenant_data_keys_insert ON tenant_data_keys FOR INSERT
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY tenant_data_keys_update ON tenant_data_keys FOR UPDATE
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
-- Sem DELETE/TRUNCATE (a linha destruída fica como lápide auditável) e UPDATE só nas colunas do
-- ciclo de vida (id, tenant_id e created_at são imutáveis também pelo trigger abaixo).
REVOKE DELETE, TRUNCATE, UPDATE ON tenant_master_keys, tenant_data_keys FROM app_user;
GRANT UPDATE (status, destroyed_at) ON tenant_master_keys TO app_user;
GRANT UPDATE (master_key_id, wrapped_key, status, encrypt_count, retired_at, destroyed_at) ON tenant_data_keys TO app_user;

-- Transições válidas, para qualquer papel (inclusive o dono): nada volta a 'active', 'destroyed' é
-- terminal, identidade imutável, nenhuma linha é apagada.
-- Vale para as duas tabelas (mesmas colunas id, tenant_id, created_at e status).
CREATE FUNCTION tenant_keys_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% não permite %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identidade da chave de dados é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'destroyed' THEN
    RAISE EXCEPTION 'chave de dados destruída não pode ser alterada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'chave de dados aposentada não volta a ser ativa' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_master_keys_guard_update
  BEFORE UPDATE OR DELETE ON tenant_master_keys
  FOR EACH ROW EXECUTE FUNCTION tenant_keys_guard();
CREATE TRIGGER tenant_master_keys_guard_truncate
  BEFORE TRUNCATE ON tenant_master_keys
  FOR EACH STATEMENT EXECUTE FUNCTION tenant_keys_guard();
CREATE TRIGGER tenant_data_keys_guard_update
  BEFORE UPDATE OR DELETE ON tenant_data_keys
  FOR EACH ROW EXECUTE FUNCTION tenant_keys_guard();
CREATE TRIGGER tenant_data_keys_guard_truncate
  BEFORE TRUNCATE ON tenant_data_keys
  FOR EACH STATEMENT EXECUTE FUNCTION tenant_keys_guard();

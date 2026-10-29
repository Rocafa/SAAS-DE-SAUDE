-- 0046 — Importador: R3 (crypto-shredding por lote) e R9 (índice cego do CPF por clínica) do parecer do
-- importador (docs/03-seguranca-lgpd/revisoes/2026-10-16-importador.md). Rodada 22, PR #73.
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §12d.
--
-- ---------------------------------------------------------------- R3: chave própria do lote
-- Antes: o arquivo bruto era cifrado com a DEK da CLÍNICA. Apagar a linha não alcançava WAL, snapshot
-- nem backup, que continuavam legíveis enquanto a chave da clínica vivesse.
-- Agora: cada lote tem uma chave mestra PRÓPRIA no provedor de chaves (KMS em produção; tag tenant_id,
-- DEK amarrada à clínica pelo EncryptionContext), criada pela mesma porta KeyProvider. A DEK do lote vai
-- embrulhada em import_batch_keys; o bruto (formato v1, keyId = id do lote) só abre com ela.
-- Descarte (vencimento, aplicar, desfazer, expirado): app_purge_import_raw_files() apaga o bruto, APAGA a
-- DEK embrulhada e marca a chave `destroying`; a API então agenda a destruição da chave mestra do lote no
-- provedor e fecha com app_finish_import_batch_key_destroy() (`destroyed`). A partir daí a DEK embrulhada
-- que ficou num backup não abre mais: "descartado" passa a significar "ilegível em qualquer cópia".
-- Por que a DEK do lote não é embrulhada pela chave da clínica: a DEK embrulhada mora no mesmo banco que o
-- bruto; o backup levaria as duas e a chave da clínica (viva) abriria. Só uma chave destruível sozinha
-- alcança o backup. A clínica continua dona: a chave do lote leva a clínica na tag e no contexto.

CREATE TABLE import_batch_keys (
  batch_id       uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  -- ARN no KMS (produção) ou id do provedor local. Não é segredo.
  master_key_id  text NOT NULL CONSTRAINT import_batch_keys_master_check CHECK (length(master_key_id) BETWEEN 1 AND 2048),
  -- DEK do lote cifrada pela chave mestra do lote; NULL a partir do descarte.
  wrapped_key    bytea,
  status         text NOT NULL DEFAULT 'active' CONSTRAINT import_batch_keys_status_check
                   CHECK (status IN ('active', 'destroying', 'destroyed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  discarded_at   timestamptz,
  destroyed_at   timestamptz,
  CONSTRAINT import_batch_keys_life_check CHECK (
    (status = 'active' AND wrapped_key IS NOT NULL AND discarded_at IS NULL AND destroyed_at IS NULL)
    OR (status = 'destroying' AND wrapped_key IS NULL AND discarded_at IS NOT NULL AND destroyed_at IS NULL)
    OR (status = 'destroyed' AND wrapped_key IS NULL AND discarded_at IS NOT NULL AND destroyed_at IS NOT NULL)),
  CONSTRAINT import_batch_keys_batch_fk FOREIGN KEY (batch_id, tenant_id) REFERENCES import_batches (id, tenant_id)
);
CREATE INDEX import_batch_keys_pending_idx ON import_batch_keys (tenant_id) WHERE status = 'destroying';

-- Nasce só com o lote `recebido` e ainda sem arquivo bruto (é a chave DELE). Não muda pelo runtime: o
-- descarte e o fechamento passam só pelas funções SECURITY DEFINER abaixo.
CREATE FUNCTION import_batch_keys_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NOT EXISTS (
         SELECT 1 FROM import_batches b WHERE b.id = NEW.batch_id AND b.tenant_id = NEW.tenant_id AND b.status = 'recebido')
       OR EXISTS (SELECT 1 FROM import_raw_files f WHERE f.batch_id = NEW.batch_id) THEN
      RAISE EXCEPTION 'chave do lote só nasce com o lote recebido e antes do arquivo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.batch_id = OLD.batch_id AND NEW.tenant_id = OLD.tenant_id AND NEW.master_key_id = OLD.master_key_id
       AND NEW.created_at = OLD.created_at
       AND ((OLD.status = 'active' AND NEW.status = 'destroying' AND NEW.wrapped_key IS NULL AND NEW.discarded_at = now())
         OR (OLD.status = 'destroying' AND NEW.status = 'destroyed' AND NEW.discarded_at = OLD.discarded_at AND NEW.destroyed_at = now()))
       AND app_running_as_owner('public.import_batch_keys'::regclass) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'chave do lote só anda active -> destroying -> destroyed, pelas funções do expurgo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'chave do lote não se apaga (a linha destruída fica como lápide)' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION import_batch_keys_guard() FROM PUBLIC;
CREATE TRIGGER import_batch_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON import_batch_keys
  FOR EACH ROW EXECUTE FUNCTION import_batch_keys_guard();
CREATE TRIGGER import_batch_keys_no_truncate BEFORE TRUNCATE ON import_batch_keys
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

ALTER TABLE import_batch_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_batch_keys
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON import_batch_keys AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON import_batch_keys FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON import_batch_keys FROM app_user;
GRANT SELECT, INSERT ON import_batch_keys TO app_user;

-- Arquivo bruto NOVO: só com a chave do próprio lote (keyId do formato v1 = id do lote) e com a chave
-- ativa. Os brutos anteriores à 0046 (cifrados com a DEK da clínica) continuam abrindo até vencerem
-- (≤ 7 dias); nenhum bruto novo nasce com a chave da clínica.
CREATE FUNCTION import_raw_files_key_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF split_part(NEW.content_enc, ':', 2) IS DISTINCT FROM NEW.batch_id::text OR NOT EXISTS (
       SELECT 1 FROM import_batch_keys k WHERE k.batch_id = NEW.batch_id AND k.tenant_id = NEW.tenant_id AND k.status = 'active') THEN
    RAISE EXCEPTION 'arquivo bruto só com a chave própria do lote (R3)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION import_raw_files_key_guard() FROM PUBLIC;
CREATE TRIGGER import_raw_files_key_guard BEFORE INSERT ON import_raw_files
  FOR EACH ROW EXECUTE FUNCTION import_raw_files_key_guard();

-- Expurgo (0024) + R3: depois de apagar o bruto, toda chave de lote ATIVA cujo bruto não existe mais
-- perde a DEK embrulhada e vira `destroying` (inclusive lote terminal sem arquivo). A API destrói a chave
-- mestra no provedor e fecha com app_finish_import_batch_key_destroy.
CREATE OR REPLACE FUNCTION app_purge_import_raw_files() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t uuid := app_current_tenant();
  n integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'expurgo exige o contexto da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE import_batches
     SET status = 'expirado', expired_at = now(), updated_at = now()
   WHERE tenant_id = t AND status IN ('recebido', 'validado', 'simulado') AND raw_expires_at <= now();
  WITH apagados AS (
    DELETE FROM import_raw_files f
     USING import_batches b
     WHERE f.tenant_id = t AND b.tenant_id = t AND b.id = f.batch_id
       AND (f.expires_at <= now() OR b.status IN ('aplicado', 'desfeito', 'expirado'))
    RETURNING f.batch_id
  )
  UPDATE import_batches b SET raw_discarded_at = now(), updated_at = now()
    FROM apagados a WHERE b.tenant_id = t AND b.id = a.batch_id AND b.raw_discarded_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE import_batches SET raw_discarded_at = now(), updated_at = now()
   WHERE tenant_id = t AND raw_discarded_at IS NULL AND status IN ('aplicado', 'desfeito', 'expirado')
     AND NOT EXISTS (SELECT 1 FROM import_raw_files f WHERE f.tenant_id = t AND f.batch_id = import_batches.id);
  UPDATE import_batch_keys k SET status = 'destroying', wrapped_key = NULL, discarded_at = now()
   WHERE k.tenant_id = t AND k.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM import_raw_files f WHERE f.tenant_id = t AND f.batch_id = k.batch_id)
     AND EXISTS (SELECT 1 FROM import_batches b WHERE b.tenant_id = t AND b.id = k.batch_id AND b.raw_discarded_at IS NOT NULL);
  DELETE FROM import_issues i USING import_batches b
   WHERE i.tenant_id = t AND b.tenant_id = t AND b.id = i.batch_id AND i.run < b.current_run;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION app_purge_import_raw_files() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_import_raw_files() TO app_user;

-- Fecha a destruição depois que o provedor agendou a exclusão da chave mestra do lote. Idempotente.
CREATE FUNCTION app_finish_import_batch_key_destroy(p_batch uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t uuid := app_current_tenant();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'exige o contexto da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE import_batch_keys SET status = 'destroyed', destroyed_at = now()
   WHERE tenant_id = t AND batch_id = p_batch AND status = 'destroying';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app_finish_import_batch_key_destroy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finish_import_batch_key_destroy(uuid) TO app_user;

-- As duas funções SECURITY DEFINER desta migração: dono sem superpoder (mesma regra da 0024).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f, o.rolsuper, o.rolbypassrls, o.rolname
             FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
            WHERE p.oid IN ('app_purge_import_raw_files()'::regprocedure, 'app_finish_import_batch_key_destroy(uuid)'::regprocedure)
  LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'função % com dono sem a restrição exigida (%)', r.f, r.rolname;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------- R9: índice cego do CPF por clínica
-- Antes: a deduplicação do importador decifrava TODOS os CPFs da clínica a cada validação/aplicar.
-- Agora: patients.cpf_bidx = HMAC-SHA256(chave de índice da clínica, "patients.cpf:v1:" + 11 dígitos), em
-- base64url, com a VERSÃO da chave em cpf_bidx_version. A chave de índice é aleatória (32 bytes), por
-- clínica, guardada SÓ cifrada pela chave da clínica (FieldCipher: DEK embrulhada pela chave mestra da
-- clínica no KMS), como a do WhatsApp (0032); substitui a chave de ambiente antiga (IMPORT_CPF_FP_KEY,
-- removida na 0030). Destruir as chaves da clínica (G3) destrói o índice junto.
-- Não substitui a cifra do CPF; não há índice único (CPF repetido continua possível, como antes) e o
-- índice nunca compara entre clínicas (chave diferente por clínica + RLS).
-- Troca da chave (rotação/suspeita de vazamento): nova versão `active`, a antiga `retired` (continua
-- casando enquanto houver paciente indexado com ela), reindexação em lotes e, com zero pacientes na
-- versão antiga, a antiga vira `destroyed` (key_enc apagada). Ver api-dominio.md §12d.

CREATE TABLE patient_cpf_index_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  version      smallint NOT NULL CONSTRAINT patient_cpf_index_keys_version_check CHECK (version BETWEEN 1 AND 32000),
  key_enc      text CONSTRAINT patient_cpf_index_keys_key_check CHECK (key_enc IS NULL OR app_is_sealed_field(key_enc)),
  status       text NOT NULL DEFAULT 'active' CONSTRAINT patient_cpf_index_keys_status_check CHECK (status IN ('active', 'retired', 'destroyed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  destroyed_at timestamptz,
  PRIMARY KEY (tenant_id, version),
  CONSTRAINT patient_cpf_index_keys_life_check CHECK (
    (status = 'active' AND key_enc IS NOT NULL AND retired_at IS NULL AND destroyed_at IS NULL)
    OR (status = 'retired' AND key_enc IS NOT NULL AND retired_at IS NOT NULL AND destroyed_at IS NULL)
    OR (status = 'destroyed' AND key_enc IS NULL AND retired_at IS NOT NULL AND destroyed_at IS NOT NULL))
);
CREATE UNIQUE INDEX patient_cpf_index_keys_one_active ON patient_cpf_index_keys (tenant_id) WHERE status = 'active';

CREATE FUNCTION patient_cpf_index_keys_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.version <> COALESCE(
         (SELECT max(k.version) FROM patient_cpf_index_keys k WHERE k.tenant_id = NEW.tenant_id), 0) + 1 THEN
      RAISE EXCEPTION 'chave de índice nasce ativa e na próxima versão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id = OLD.tenant_id AND NEW.version = OLD.version AND NEW.created_at = OLD.created_at
       AND ((OLD.status = 'active' AND NEW.status = 'retired' AND NEW.key_enc = OLD.key_enc AND NEW.retired_at = now())
         OR (OLD.status = 'retired' AND NEW.status = 'destroyed' AND NEW.key_enc IS NULL AND NEW.retired_at = OLD.retired_at
             AND NEW.destroyed_at = now()
             AND NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.cpf_bidx_version = NEW.version))) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'chave de índice só anda active -> retired -> destroyed (destruir só sem paciente indexado nela)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'chave de índice não se apaga (a destruída fica como lápide)' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION patient_cpf_index_keys_guard() FROM PUBLIC;
CREATE TRIGGER patient_cpf_index_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_cpf_index_keys
  FOR EACH ROW EXECUTE FUNCTION patient_cpf_index_keys_guard();
CREATE TRIGGER patient_cpf_index_keys_no_truncate BEFORE TRUNCATE ON patient_cpf_index_keys
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

ALTER TABLE patient_cpf_index_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_cpf_index_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_cpf_index_keys
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON patient_cpf_index_keys AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON patient_cpf_index_keys FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON patient_cpf_index_keys FROM app_user;
GRANT SELECT, INSERT, UPDATE ON patient_cpf_index_keys TO app_user;

ALTER TABLE patients
  ADD COLUMN cpf_bidx         text CONSTRAINT patients_cpf_bidx_check CHECK (cpf_bidx IS NULL OR cpf_bidx ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN cpf_bidx_version smallint,
  ADD CONSTRAINT patients_cpf_bidx_pair_check CHECK ((cpf_bidx IS NULL) = (cpf_bidx_version IS NULL)),
  ADD CONSTRAINT patients_cpf_bidx_needs_cpf_check CHECK (cpf_bidx IS NULL OR cpf_enc IS NOT NULL),
  ADD CONSTRAINT patients_cpf_bidx_key_fk FOREIGN KEY (tenant_id, cpf_bidx_version) REFERENCES patient_cpf_index_keys (tenant_id, version);
CREATE INDEX patients_cpf_bidx_idx ON patients (tenant_id, cpf_bidx) WHERE cpf_bidx IS NOT NULL;

-- CPF mudou (ou foi apagado/recifrado) sem índice novo na MESMA escrita: o índice velho cai (NULL). Quem
-- procura por CPF trata o paciente sem índice como pendente de reindexação (decifra só esses). Assim um
-- caminho que esqueça o índice nunca deixa um índice errado, só um ausente.
CREATE FUNCTION patients_cpf_bidx_stale() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.cpf_enc IS DISTINCT FROM OLD.cpf_enc AND NEW.cpf_bidx IS NOT DISTINCT FROM OLD.cpf_bidx
     AND NEW.cpf_bidx_version IS NOT DISTINCT FROM OLD.cpf_bidx_version THEN
    NEW.cpf_bidx := NULL;
    NEW.cpf_bidx_version := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION patients_cpf_bidx_stale() FROM PUBLIC;
CREATE TRIGGER patients_cpf_bidx_stale BEFORE UPDATE OF cpf_enc ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_cpf_bidx_stale();

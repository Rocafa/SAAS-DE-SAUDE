-- 0049 — Importador: chave de lote nunca fica ÓRFÃ no KMS (observação 1 da conferência R3-a/R3-b, 23/10/2026,
-- docs/03-seguranca-lgpd/revisoes/2026-10-16-importador.md). Rodada 23, PR #73.
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §12d.
--
-- Antes: o `receber` criava a chave mestra do lote no KMS DENTRO da transação do lote. Se a transação caísse e
-- o KMS também falhasse ao destruir a chave recém-criada, a chave ficava no KMS sem nenhuma linha para retomar
-- e sem log. Nenhum cifrado tinha sido gravado (sem dado em risco), mas a chave viva ficava sem dono.
-- Agora: o `receber` REGISTRA a intenção (linha `pending`, commit próprio) ANTES de criar a chave, grava o ARN
-- logo depois de o KMS devolvê-lo (commit próprio) e só então abre a transação do lote, que fecha a intenção
-- como `committed` no MESMO commit em que nasce a linha de import_batch_keys. Se o `receber` falhar, a API
-- destrói a chave na hora e fecha como `destroyed`; se o KMS também falhar, a linha fica `pending` e o job de
-- expurgo (importador-expurgo) a retoma depois do prazo (a API não destrói chave de recebimento em andamento).
-- Intenção sem ARN (o KMS pode ter criado a chave e o ARN não chegou ao banco) vira `abandoned` e gera o log
-- CHAVE_LOTE_ORFA (só a clínica e a contagem), para a varredura do IaC por purpose=import_batch.
-- Só ids e ARN (não é segredo): nenhum dado pessoal.

CREATE TABLE import_batch_key_intents (
  -- Id que o lote vai ter (é a tag batch_id da chave no KMS).
  batch_id       uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  -- ARN no KMS (produção) ou id do provedor local; NULL até o KMS devolver.
  master_key_id  text CONSTRAINT import_batch_key_intents_master_check CHECK (master_key_id IS NULL OR length(master_key_id) BETWEEN 1 AND 2048),
  status         text NOT NULL DEFAULT 'pending' CONSTRAINT import_batch_key_intents_status_check
                   CHECK (status IN ('pending', 'committed', 'destroyed', 'abandoned')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  CONSTRAINT import_batch_key_intents_life_check CHECK (
    (status = 'pending' AND closed_at IS NULL)
    OR (status IN ('committed', 'destroyed') AND master_key_id IS NOT NULL AND closed_at IS NOT NULL)
    OR (status = 'abandoned' AND master_key_id IS NULL AND closed_at IS NOT NULL))
);
CREATE INDEX import_batch_key_intents_pending_idx ON import_batch_key_intents (tenant_id, created_at) WHERE status = 'pending';

-- Nasce `pending`, sem ARN, com o relógio do banco, por ADMIN da sessão (mesma regra de quem cria o lote, 0024),
-- e com um id que ainda não é lote. Só anda pelas funções abaixo; não se apaga (fica como lápide).
CREATE FUNCTION import_batch_key_intents_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.master_key_id IS NOT NULL OR NEW.closed_at IS NOT NULL
       OR v_user IS NULL OR NOT app_user_has_role(v_user, 'admin')
       OR EXISTS (SELECT 1 FROM import_batches b WHERE b.id = NEW.batch_id) THEN
      RAISE EXCEPTION 'intenção de chave de lote só nasce pendente, sem ARN, por admin da sessão e antes do lote'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.batch_id = OLD.batch_id AND NEW.tenant_id = OLD.tenant_id AND NEW.created_at = OLD.created_at
       AND OLD.status = 'pending'
       AND (
         -- ARN gravado logo depois de o KMS criar a chave (uma vez só).
         (NEW.status = 'pending' AND OLD.master_key_id IS NULL AND NEW.master_key_id IS NOT NULL AND NEW.closed_at IS NULL)
         -- Lote gravado: a chave virou a de import_batch_keys no mesmo commit.
         OR (NEW.status = 'committed' AND NEW.master_key_id = OLD.master_key_id AND NEW.closed_at = now()
             AND EXISTS (SELECT 1 FROM import_batch_keys k
                          WHERE k.batch_id = NEW.batch_id AND k.tenant_id = NEW.tenant_id AND k.master_key_id = NEW.master_key_id))
         -- Recebimento falhou e a chave foi destruída no provedor (nunca a de um lote gravado).
         OR (NEW.status = 'destroyed' AND NEW.master_key_id = OLD.master_key_id AND NEW.closed_at = now()
             AND NOT EXISTS (SELECT 1 FROM import_batch_keys k WHERE k.batch_id = NEW.batch_id))
         -- Sem ARN gravado: não há o que destruir pela API (log CHAVE_LOTE_ORFA; varredura do IaC).
         OR (NEW.status = 'abandoned' AND OLD.master_key_id IS NULL AND NEW.master_key_id IS NULL AND NEW.closed_at = now()))
       AND app_running_as_owner('public.import_batch_key_intents'::regclass) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'intenção de chave de lote só anda pending -> committed/destroyed/abandoned, pelas funções do importador'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'intenção de chave de lote não se apaga (fica como lápide)' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION import_batch_key_intents_guard() FROM PUBLIC;
CREATE TRIGGER import_batch_key_intents_guard BEFORE INSERT OR UPDATE OR DELETE ON import_batch_key_intents
  FOR EACH ROW EXECUTE FUNCTION import_batch_key_intents_guard();
CREATE TRIGGER import_batch_key_intents_no_truncate BEFORE TRUNCATE ON import_batch_key_intents
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

ALTER TABLE import_batch_key_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch_key_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_batch_key_intents
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON import_batch_key_intents AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON import_batch_key_intents FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON import_batch_key_intents FROM app_user;
GRANT SELECT, INSERT ON import_batch_key_intents TO app_user;

-- Grava o ARN da intenção pendente da clínica do contexto. Devolve false se não estava pendente sem ARN.
CREATE FUNCTION app_record_import_batch_key_intent(p_batch uuid, p_master text) RETURNS boolean
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
  UPDATE import_batch_key_intents SET master_key_id = p_master
   WHERE tenant_id = t AND batch_id = p_batch AND status = 'pending' AND master_key_id IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app_record_import_batch_key_intent(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_import_batch_key_intent(uuid, text) TO app_user;

-- Fecha a intenção pendente: `committed` (lote gravado), `destroyed` (chave destruída no provedor) ou
-- `abandoned` (sem ARN). As condições de cada uma estão no gatilho. Devolve false se já estava fechada.
CREATE FUNCTION app_close_import_batch_key_intent(p_batch uuid, p_status text) RETURNS boolean
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
  IF p_status NOT IN ('committed', 'destroyed', 'abandoned') THEN
    RAISE EXCEPTION 'situação de fechamento inválida' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE import_batch_key_intents SET status = p_status, closed_at = now()
   WHERE tenant_id = t AND batch_id = p_batch AND status = 'pending';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app_close_import_batch_key_intent(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_close_import_batch_key_intent(uuid, text) TO app_user;

-- As funções SECURITY DEFINER desta migração: dono sem superpoder (mesma regra da 0024/0046).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f, o.rolsuper, o.rolbypassrls, o.rolname
             FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
            WHERE p.oid IN ('app_record_import_batch_key_intent(uuid, text)'::regprocedure,
                            'app_close_import_batch_key_intent(uuid, text)'::regprocedure)
  LOOP
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'função % com dono sem a restrição exigida (%)', r.f, r.rolname;
    END IF;
  END LOOP;
END;
$$;

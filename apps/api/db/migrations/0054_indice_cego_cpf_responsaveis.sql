-- 0054 — Índice cego do CPF também nos RESPONSÁVEIS (`guardians`). Pendência "antes do GA" do parecer do
-- importador (docs/03-seguranca-lgpd/revisoes/2026-10-16-importador.md, conferências) e proposta do §12d de
-- docs/04-arquitetura/api-dominio.md. Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Antes: a deduplicação de responsáveis do importador (0048) decifrava o CPF de TODAS as pessoas
-- responsáveis da clínica a cada validação/aplicar.
-- Agora: guardians.cpf_bidx = HMAC-SHA256(chave de índice da clínica, "guardians.cpf:v1:" + 11 dígitos), em
-- base64url, com a versão da chave em cpf_bidx_version. MESMA chave e MESMA tabela de chaves dos pacientes
-- (patient_cpf_index_keys, 0046); o rótulo de domínio é outro, então o mesmo CPF dá índice diferente no
-- paciente e no responsável (e nunca compara entre clínicas: chave por clínica + RLS). O domínio dos
-- pacientes ("patients.cpf:v1:") não muda; os índices atuais continuam válidos.
--
-- - Colunas, CHECKs, par, FK para a versão da chave e índice parcial: iguais aos de `patients` (0046).
-- - Gatilho de índice ausente: CPF mudou sem índice novo na MESMA escrita = índice cai para NULL (pendente;
--   a busca decifra só esses). Um caminho que esqueça o índice nunca deixa índice errado, só ausente.
-- - guardians_guard (0031): exceção SÓ para a UPDATE que muda apenas cpf_bidx/cpf_bidx_version — passa sem
--   o usuário da sessão (job `sistema`), não mexe em updated_at/updated_by e não gera histórico (o gatilho
--   de histórico só registra nome/CPF/telefone). Assim a reindexação não conta como `alterado_depois` no
--   desfazer do lote (0048). Qualquer outra coluna mudando junto cai nas regras de sempre. O descarte, que
--   apaga o CPF, também zera o índice.
-- - patient_cpf_index_keys_guard (0046): só destrói uma versão sem paciente NEM responsável indexado nela.

-- ---------------------------------------------------------------- colunas

ALTER TABLE guardians
  ADD COLUMN cpf_bidx         text CONSTRAINT guardians_cpf_bidx_check CHECK (cpf_bidx IS NULL OR cpf_bidx ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN cpf_bidx_version smallint,
  ADD CONSTRAINT guardians_cpf_bidx_pair_check CHECK ((cpf_bidx IS NULL) = (cpf_bidx_version IS NULL)),
  ADD CONSTRAINT guardians_cpf_bidx_needs_cpf_check CHECK (cpf_bidx IS NULL OR cpf_enc IS NOT NULL),
  ADD CONSTRAINT guardians_cpf_bidx_key_fk FOREIGN KEY (tenant_id, cpf_bidx_version) REFERENCES patient_cpf_index_keys (tenant_id, version);
CREATE INDEX guardians_cpf_bidx_idx ON guardians (tenant_id, cpf_bidx) WHERE cpf_bidx IS NOT NULL;

-- ---------------------------------------------------------------- índice ausente

CREATE FUNCTION guardians_cpf_bidx_stale() RETURNS trigger
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
REVOKE ALL ON FUNCTION guardians_cpf_bidx_stale() FROM PUBLIC;
CREATE TRIGGER guardians_cpf_bidx_stale BEFORE UPDATE OF cpf_enc ON guardians
  FOR EACH ROW EXECUTE FUNCTION guardians_cpf_bidx_stale();

-- ---------------------------------------------------------------- guarda da pessoa (0031 + exceção do índice)

CREATE OR REPLACE FUNCTION guardians_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semDados guardians;
  semIndice guardians;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'guardians: pessoa descartada é terminal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 0054: só o índice cego do CPF mudou (reindexação/gravação do índice). Sem usuário da sessão, sem
  -- updated_at/updated_by e sem histórico. Qualquer outra coluna junto = regras abaixo.
  IF TG_OP = 'UPDATE' THEN
    semIndice := NEW;
    semIndice.cpf_bidx := OLD.cpf_bidx;
    semIndice.cpf_bidx_version := OLD.cpf_bidx_version;
    IF semIndice IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Descarte (A4 do #67): só apaga os dados, uma vez, vencido o prazo; vale para o job do sistema. O índice
  -- do CPF vai junto (0054).
  IF TG_OP = 'UPDATE' AND NEW.discarded_at IS NOT NULL THEN
    semDados := NEW;
    semDados.name_enc := OLD.name_enc;
    semDados.cpf_enc := OLD.cpf_enc;
    semDados.phone_enc := OLD.phone_enc;
    semDados.cpf_bidx := OLD.cpf_bidx;
    semDados.cpf_bidx_version := OLD.cpf_bidx_version;
    semDados.discarded_at := OLD.discarded_at;
    semDados.updated_at := OLD.updated_at;
    semDados.updated_by := OLD.updated_by;
    IF semDados IS DISTINCT FROM OLD OR NEW.name_enc IS NOT NULL OR NEW.cpf_enc IS NOT NULL OR NEW.phone_enc IS NOT NULL THEN
      RAISE EXCEPTION 'guardians: o descarte só apaga nome, CPF e telefone' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_guardian_discardable(OLD.tenant_id, OLD.id) THEN
      RAISE EXCEPTION 'guardians: descarte só de cadastro anulado com o prazo vencido' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.cpf_bidx := NULL;
    NEW.cpf_bidx_version := NULL;
    NEW.discarded_at := now();
    NEW.updated_at := now();
    NEW.updated_by := COALESCE(v_user, OLD.updated_by);
    RETURN NEW;
  END IF;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'responsável: escrita exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.discarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'guardians: pessoa nasce com dados' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_by IS DISTINCT FROM v_user OR NEW.updated_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'guardians: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'guardians: identidade e criação são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'guardians: autor da alteração tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guardians_guard() FROM PUBLIC;

-- ---------------------------------------------------------------- chave do índice: destruir só sem uso

CREATE OR REPLACE FUNCTION patient_cpf_index_keys_guard() RETURNS trigger
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
             AND NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.cpf_bidx_version = NEW.version)
             AND NOT EXISTS (SELECT 1 FROM guardians g WHERE g.tenant_id = NEW.tenant_id AND g.cpf_bidx_version = NEW.version))) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'chave de índice só anda active -> retired -> destroyed (destruir só sem paciente nem responsável indexado nela)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'chave de índice não se apaga (a destruída fica como lápide)' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION patient_cpf_index_keys_guard() FROM PUBLIC;

-- ---------------------------------------------------------------- conferência final

-- O gatilho de índice ausente roda ANTES da guarda (ordem alfabética dos BEFORE): a guarda vê o índice já
-- zerado quando o CPF muda sem índice novo. E nenhuma das funções desta migração é SECURITY DEFINER.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.guardians'::regclass AND tgname = 'guardians_cpf_bidx_stale')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.guardians'::regclass AND tgname = 'guardians_guard')
     OR 'guardians_cpf_bidx_stale' >= 'guardians_guard' COLLATE "C" THEN
    RAISE EXCEPTION '0054: gatilhos de guardians fora do esperado';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid IN ('guardians_cpf_bidx_stale()'::regprocedure, 'guardians_guard()'::regprocedure,
                            'patient_cpf_index_keys_guard()'::regprocedure)
                AND prosecdef) THEN
    RAISE EXCEPTION '0054: função de gatilho não pode ser SECURITY DEFINER';
  END IF;
END;
$$;

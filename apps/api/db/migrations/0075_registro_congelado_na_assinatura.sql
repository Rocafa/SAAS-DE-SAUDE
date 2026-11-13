-- 0075 — Conselho e número do profissional CONGELADOS no atendimento na assinatura (B1 do parecer do código do #194,
-- 13/11/2026). Sem isso, mudar o número no cadastro (outra região, correção) reescreveria, na tela e na exportação, a
-- identificação de evoluções já assinadas (Res. COFFITO 414 e 415, art. 1º §1º VIII). Executar com o papel de MIGRAÇÃO.
--
-- Quem copia é o BANCO, na transição open -> signed, a partir do profissional do atendimento: a aplicação não escolhe
-- o valor. Antes da assinatura as colunas ficam nulas (CHECK); depois, o encounters_guard já impede qualquer mudança.
-- Atendimentos assinados ANTES desta migração ficam com as colunas nulas: o registro deles não foi gravado na época.

ALTER TABLE encounters
  ADD COLUMN signed_council text,
  ADD COLUMN signed_council_registration text;

ALTER TABLE encounters ADD CONSTRAINT encounters_signed_council_only_when_signed
  CHECK (status = 'signed' OR (signed_council IS NULL AND signed_council_registration IS NULL));

CREATE FUNCTION encounters_council_snapshot() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'signed' THEN
    SELECT p.council, p.council_registration
      INTO NEW.signed_council, NEW.signed_council_registration
      FROM professionals p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id;
  ELSIF NEW.signed_council IS DISTINCT FROM OLD.signed_council
     OR NEW.signed_council_registration IS DISTINCT FROM OLD.signed_council_registration THEN
    RAISE EXCEPTION 'registro no conselho do atendimento só é gravado pelo banco, na assinatura' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Dispara depois do encounters_guard (ordem alfabética dos triggers BEFORE da mesma tabela).
CREATE TRIGGER encounters_snapshot_council BEFORE UPDATE ON encounters FOR EACH ROW EXECUTE FUNCTION encounters_council_snapshot();

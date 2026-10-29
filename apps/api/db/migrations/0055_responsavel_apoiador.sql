-- 0055 — Tipo `apoiador` nos responsáveis do paciente (tomada de decisão apoiada, CC art. 1.783-A). Fecha a
-- pendência A3 do parecer do #67 (docs/03-seguranca-lgpd/revisoes/2026-10-20-pr67.md e 2026-10-21-pr67.md).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- O apoiador APOIA a pessoa com deficiência, que continua plenamente capaz e decide em nome próprio. Ele
-- NÃO a representa. Por isso:
-- - Só para paciente maior (o serviço recusa com `apoio_de_menor`; o banco não lê a data de nascimento).
-- - Exige a referência do termo homologado pelo juiz e os limites do apoio (CC art. 1.783-A, §§ 1º a 3º),
--   cifrados nas MESMAS colunas da curatela (`court_decision_ref_enc`, `curatorship_scope_enc`).
-- - Informação clínica: desligada por padrão; como na curatela, só liga por decisão do profissional com
--   justificativa (A1 do #67). A regra fica no serviço (`informacaoClinica`).
-- - Não representa no portal nem recebe lembrete pelo paciente. O serviço recusa, e o banco também:
--   convite e vínculo do portal como `responsavel_legal` com vínculo de apoiador são recusados, e
--   `app_whatsapp_guardian_ok` passa a devolver false para o apoiador.
-- O tipo do vínculo é imutável (patient_guardians_guard, 0034), então basta conferir na criação do convite
-- e do vínculo do portal.

-- ---------------------------------------------------------------- tipo e termo de apoio

ALTER TABLE patient_guardians DROP CONSTRAINT patient_guardians_kind_check;
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_kind_check
  CHECK (kind IN ('pai_mae', 'tutor', 'curador', 'representante', 'apoiador'));

ALTER TABLE patient_guardians DROP CONSTRAINT patient_guardians_curatorship_check;
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_curatorship_check CHECK (
  kind NOT IN ('curador', 'apoiador') OR eliminated_at IS NOT NULL
  OR (court_decision_ref_enc IS NOT NULL AND curatorship_scope_enc IS NOT NULL));

-- ---------------------------------------------------------------- portal: apoiador não representa

-- SECURITY DEFINER: o vínculo do portal nasce no resgate do convite (função do dono, 0033), e o tipo do
-- vínculo precisa ser lido em qualquer sessão. Só lê; não grava nada.
CREATE FUNCTION portal_apoiador_nao_representa_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.acting_as = 'responsavel_legal' AND EXISTS (
       SELECT 1 FROM public.patient_guardians g
        WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.guardian_link_id AND g.kind = 'apoiador') THEN
    RAISE EXCEPTION 'apoiador (decisão apoiada) não representa o paciente no portal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION portal_apoiador_nao_representa_guard() FROM PUBLIC;

CREATE TRIGGER portal_invites_apoiador_guard
  BEFORE INSERT OR UPDATE OF acting_as, guardian_link_id ON portal_invites
  FOR EACH ROW EXECUTE FUNCTION portal_apoiador_nao_representa_guard();
CREATE TRIGGER portal_links_apoiador_guard
  BEFORE INSERT OR UPDATE OF acting_as, guardian_link_id ON portal_links
  FOR EACH ROW EXECUTE FUNCTION portal_apoiador_nao_representa_guard();

-- ---------------------------------------------------------------- WhatsApp: apoiador não recebe pelo paciente

-- Mesma assinatura e mesmos atributos da 0036 (invocador, RLS da clínica do contexto); só ganha o filtro do tipo.
CREATE OR REPLACE FUNCTION app_whatsapp_guardian_ok(p_tenant uuid, p_patient uuid, p_guardian uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.patient_guardians v
      JOIN public.patients p ON p.tenant_id = v.tenant_id AND p.id = v.patient_id
     WHERE v.tenant_id = p_tenant AND v.patient_id = p_patient AND v.guardian_id = p_guardian
       AND v.ended_at IS NULL AND v.end_reason IS NULL AND v.eliminated_at IS NULL
       AND v.kind <> 'apoiador'
       AND v.valid_from <= public.app_fiscal_today()
       AND (v.valid_until IS NULL OR v.valid_until > public.app_fiscal_today())
       AND (v.kind = 'curador' OR p.emancipated_on IS NULL OR p.emancipated_on > public.app_fiscal_today()))
$$;
REVOKE ALL ON FUNCTION app_whatsapp_guardian_ok(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_whatsapp_guardian_ok(uuid, uuid, uuid) TO app_user;

-- 0055 — Tipo `apoiador` nos responsáveis do paciente (tomada de decisão apoiada, CC art. 1.783-A). Fecha a
-- pendência A3 do parecer do #67 (docs/03-seguranca-lgpd/revisoes/2026-10-20-pr67.md e 2026-10-21-pr67.md),
-- com as correções do parecer de 29/10 (docs/03-seguranca-lgpd/revisoes/2026-10-29-apoiador.md).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- O apoiador APOIA a pessoa com deficiência, que continua plenamente capaz e decide em nome próprio. Ele
-- NÃO a representa. Por isso:
-- - Só para paciente maior, com data de nascimento conhecida (o serviço recusa `apoio_de_menor` e
--   `apoio_sem_data_de_nascimento`; o banco não lê a data cifrada).
-- - Exige a referência do termo homologado pelo juiz e os limites do apoio (CC art. 1.783-A, §§ 1º a 3º),
--   cifrados nas MESMAS colunas da curatela (`court_decision_ref_enc`, `curatorship_scope_enc`).
-- - Informação clínica (B1 do parecer de 29/10): desligada por padrão. O apoiado é CAPAZ, então revelar dado
--   de saúde ao apoiador exige a AUTORIZAÇÃO EXPRESSA DO PACIENTE (CEM art. 73, CFP art. 9º, LGPD art. 11, I;
--   Lei 13.146/2015 arts. 6º e 84), além da decisão do profissional. A autorização fica no vínculo
--   (`patient_authorized_by`/`patient_authorized_at`: quem registrou e quando; como e em que limites do termo,
--   na justificativa cifrada da decisão). Só existe com a marca ligada: desligar a marca = revogar (apaga a
--   autorização); religar exige nova decisão e nova autorização.
-- - Não representa no portal nem recebe lembrete pelo paciente. O serviço recusa, e o banco também:
--   convite e vínculo do portal como `responsavel_legal` com vínculo de apoiador são recusados,
--   `app_portal_representation_ok` e `app_whatsapp_guardian_ok` devolvem false para o apoiador.
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

-- ---------------------------------------------------------------- autorização do paciente (B1)

-- Sem campo cifrado novo de propósito: a eliminação da guarda de 20 anos (0034/0037) apaga só os campos
-- cifrados conhecidos, e quem/quando ficam como `clinical_info_decided_by/at`.
ALTER TABLE patient_guardians
  ADD COLUMN patient_authorized_by uuid,
  ADD COLUMN patient_authorized_at timestamptz,
  ADD CONSTRAINT patient_guardians_patient_auth_pair_check CHECK ((patient_authorized_by IS NULL) = (patient_authorized_at IS NULL)),
  -- Só o apoiador leva a autorização, e só com a marca ligada (desligar = revogar).
  ADD CONSTRAINT patient_guardians_patient_auth_kind_check CHECK (
    patient_authorized_by IS NULL OR (kind = 'apoiador' AND receives_clinical_info)),
  -- Apoiador com a marca ligada = autorização do paciente registrada.
  ADD CONSTRAINT patient_guardians_patient_auth_required_check CHECK (
    kind <> 'apoiador' OR NOT receives_clinical_info OR eliminated_at IS NOT NULL OR patient_authorized_by IS NOT NULL);

-- Quem registra é o usuário da sessão, e a data é do banco. A autorização só nasce junto com uma NOVA decisão
-- do profissional (ligar a marca, ou trocar a justificativa com ela ligada) e só some ao desligar a marca.
CREATE FUNCTION patient_guardians_patient_auth_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_decide boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.patient_authorized_by IS NOT NULL THEN
      IF NEW.patient_authorized_by IS DISTINCT FROM app_current_user() THEN
        RAISE EXCEPTION 'patient_guardians: quem registra a autorização do paciente é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.patient_authorized_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.patient_authorized_by IS NOT DISTINCT FROM OLD.patient_authorized_by
     AND NEW.patient_authorized_at IS NOT DISTINCT FROM OLD.patient_authorized_at THEN
    RETURN NEW;
  END IF;
  IF NEW.patient_authorized_by IS NULL THEN
    IF NEW.receives_clinical_info THEN
      RAISE EXCEPTION 'patient_guardians: a autorização do paciente só cai junto com a marca' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  v_decide := NEW.receives_clinical_info
    AND (NOT OLD.receives_clinical_info OR NEW.clinical_info_basis_enc IS DISTINCT FROM OLD.clinical_info_basis_enc);
  IF NOT v_decide THEN
    RAISE EXCEPTION 'patient_guardians: a autorização do paciente só é registrada com uma nova decisão do profissional' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.patient_authorized_by IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'patient_guardians: quem registra a autorização do paciente é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.patient_authorized_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION patient_guardians_patient_auth_guard() FROM PUBLIC;

CREATE TRIGGER patient_guardians_patient_auth_guard
  BEFORE INSERT OR UPDATE ON patient_guardians
  FOR EACH ROW EXECUTE FUNCTION patient_guardians_patient_auth_guard();

-- ---------------------------------------------------------------- portal: apoiador não representa

-- Invocador (R1 do parecer de 29/10): o convite nasce na sessão da clínica e o vínculo do portal no resgate,
-- que já roda como dono (0033); nos dois casos o vínculo da 0028 é visível. Falha fechada: vínculo de
-- responsável que não aparece também é recusado.
CREATE FUNCTION portal_apoiador_nao_representa_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.acting_as = 'responsavel_legal' THEN
    SELECT g.kind INTO v_kind FROM public.patient_guardians g
     WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.guardian_link_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portal: vínculo de responsável não encontrado' USING ERRCODE = 'check_violation';
    END IF;
    IF v_kind = 'apoiador' THEN
      RAISE EXCEPTION 'apoiador (decisão apoiada) não representa o paciente no portal' USING ERRCODE = 'check_violation';
    END IF;
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

-- A representação no portal vale HOJE? Mesma função da 0033, mais o filtro do tipo (R1): mesmo que um vínculo
-- de apoiador chegasse ao portal, ele não representa.
CREATE OR REPLACE FUNCTION app_portal_representation_ok(p_tenant uuid, p_link uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN l.acting_as = 'titular' THEN true ELSE COALESCE((
    SELECT g.ended_at IS NULL AND g.end_reason IS NULL
           AND g.kind <> 'apoiador'
           AND g.valid_from <= public.app_fiscal_today()
           AND (g.valid_until IS NULL OR g.valid_until > public.app_fiscal_today())
           AND (g.kind = 'curador'
                OR (l.represent_until IS NOT NULL AND l.represent_until > public.app_fiscal_today()
                    AND (SELECT p.emancipated_on IS NULL FROM public.patients p WHERE p.tenant_id = l.tenant_id AND p.id = l.patient_id)))
      FROM public.patient_guardians g
     WHERE g.tenant_id = l.tenant_id AND g.id = l.guardian_link_id AND g.patient_id = l.patient_id AND g.guardian_id = l.guardian_id), false) END
    FROM public.portal_links l
   WHERE l.tenant_id = p_tenant AND l.id = p_link
$$;
REVOKE ALL ON FUNCTION app_portal_representation_ok(uuid, uuid) FROM PUBLIC;

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

-- 0058 — Pedido de sigilo do adolescente ligado ao atendimento do prontuário (R5 do parecer de 29/10/2026,
-- docs/03-seguranca-lgpd/revisoes/2026-10-29-sigilo-adolescente.md). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- O pedido continua sem texto (minimização). Numa disputa com o responsável, a prova de que o adolescente pediu fica
-- na evolução do prontuário; agora o pedido pode apontar para ela pelo id do atendimento (`encounter_id`), sem copiar
-- conteúdo. Opcional, gravado só na criação e nunca alterado.
-- O atendimento tem de ser do MESMO paciente e de autoria do MESMO profissional que registra o pedido (o usuário da
-- sessão). Assim ninguém aponta para a evolução de outro profissional, nem descobre se ela existe (psicologia:
-- `restrito_ao_autor`). Sem chave estrangeira de propósito: o pedido é apagado na eliminação dos responsáveis e o
-- prontuário tem ciclo próprio; a conferência fica no gatilho, que roda com o papel da aplicação (RLS de tenant).

ALTER TABLE adolescent_confidentiality_requests ADD COLUMN encounter_id uuid;

CREATE OR REPLACE FUNCTION adolescent_confidentiality_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.guardians_eliminating', true) = OLD.tenant_id::text || ':' || OLD.patient_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pedido de sigilo do adolescente não se apaga (revogue)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR NOT app_user_has_role(v_user, 'profissional') THEN
    RAISE EXCEPTION 'pedido de sigilo do adolescente: só o profissional registra e revoga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by IS DISTINCT FROM v_user OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'pedido de sigilo do adolescente: nasce vigente e registrado pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.guardian_link_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM patient_guardians g
          WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.guardian_link_id AND g.patient_id = NEW.patient_id
            AND g.guardian_id = NEW.guardian_id) THEN
      RAISE EXCEPTION 'pedido de sigilo do adolescente: o vínculo tem de ser do mesmo paciente e da mesma pessoa' USING ERRCODE = 'check_violation';
    END IF;
    -- 0058 (R5): o atendimento é do mesmo paciente e de autoria de quem registra.
    IF NEW.encounter_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM encounters e
          WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.encounter_id AND e.patient_id = NEW.patient_id
            AND e.author_user_id = v_user) THEN
      RAISE EXCEPTION 'pedido de sigilo do adolescente: o atendimento tem de ser do mesmo paciente e de autoria de quem registra' USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'pedido de sigilo do adolescente: revogado é terminal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.guardian_link_id IS DISTINCT FROM OLD.guardian_link_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.revoked_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'pedido de sigilo do adolescente: só a revogação, pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION adolescent_confidentiality_requests_guard() FROM PUBLIC;

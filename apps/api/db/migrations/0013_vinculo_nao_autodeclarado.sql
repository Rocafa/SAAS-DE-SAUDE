-- 0013 — Vínculo de cuidado não autodeclarado (V1 do parecer do Guardião sobre o PR #61).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §"Vínculo de cuidado".
--
-- NUMERAÇÃO: 0011 (guias e pacotes, PR #62) e 0012 (prontuário, em andamento) já estão reservadas.
-- Esta migração não depende delas nem elas desta: só acrescenta colunas novas a appointments e tenants.
--
-- 1. appointments.created_by: usuário da sessão que criou o agendamento. Com ele a API reconhece o
--    AUTOAGENDAMENTO (o profissional cria um agendamento para si mesmo, encaixe incluído), que NÃO dá
--    vínculo de cuidado antes do atendimento efetivo. Linhas antigas ficam NULL (origem desconhecida;
--    seguem as demais regras). Imutável depois do INSERT (trigger abaixo): quem criou não muda.
-- 2. tenants.care_link_days: janela de continuidade do cuidado depois de um atendimento, por clínica
--    (R1 do parecer #61: padrão 90 dias, teto 180). A mudança é feita pela API e auditada.

ALTER TABLE appointments ADD COLUMN created_by uuid;

CREATE FUNCTION appointments_created_by_imutavel() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'appointments.created_by é imutável' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_created_by_imutavel
  BEFORE UPDATE OF created_by ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_created_by_imutavel();

ALTER TABLE tenants ADD COLUMN care_link_days smallint NOT NULL DEFAULT 90
  CONSTRAINT tenants_care_link_days_check CHECK (care_link_days BETWEEN 1 AND 180);

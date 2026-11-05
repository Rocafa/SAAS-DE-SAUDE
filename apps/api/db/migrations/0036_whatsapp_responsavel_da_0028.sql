-- 0036 — Integração da rodada 19 (eng/integracao-r19): WhatsApp (0032) encontra os responsáveis (0028) e o
-- portal (0027/0033). Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §13.
--
-- NUMERAÇÃO: 0024–0035 vêm dos PRs #66 (importador), #67 (responsáveis), #68 (portal), #69 (WhatsApp) e #65
-- (financeiro), aplicadas em ordem de número; esta é a primeira da integração.
--
-- (1) R4 do parecer #69: o lembrete de MENOR sai pelo telefone do responsável VIGENTE da 0028.
--     - FK de `guardian_id` (opt-in e fila) para `guardians (id, tenant_id)` — a 0032 deixou sem FK porque a
--       0028 estava em outra branch. A pessoa nunca é apagada (o descarte só limpa os campos), então a FK
--       não trava descarte nem eliminação; não aponta para patients/appointments (regra do desfazer intacta).
--     - Conferência no banco, no INSERT do opt-in e da fila de destinatário `responsavel`: vínculo vigente
--       HOJE (não encerrado, não anulado, não eliminado, dentro de [desde, até)) entre ESTE paciente e ESTA
--       pessoa e, fora a curatela, paciente não emancipado. A maioridade depende da data de nascimento, que é
--       cifrada: quem confere é o serviço (`responsavelRepresentaParaLembrete`), no opt-in, no programar e no
--       despacho; o banco garante o vínculo e a emancipação.
-- (2) `whatsapp_routes` é INTERNA (número de negócio -> clínica, para o webhook que chega SEM sessão). O laço
--     dinâmico da 0033 (portal) criou nela `portal_fora` (exige `tenant_id = app_current_tenant()`), o que
--     cegou o webhook e a checagem de dono do número entre clínicas (as duas leem como dono, sem contexto).
--     A tabela não tem privilégio nenhum para o runtime (guarda de schema) nem é lida na sessão do portal:
--     a policy sai e ela volta a ser só do dono, como na 0032 (e como as internas do portal na 0033).

-- (2) Rota do webhook: só do dono.
DROP POLICY IF EXISTS portal_fora ON whatsapp_routes;

-- (1) FK para a pessoa responsável da 0028.
ALTER TABLE whatsapp_opt_ins
  ADD CONSTRAINT whatsapp_opt_ins_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id);
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id);
CREATE INDEX whatsapp_opt_ins_guardian_idx ON whatsapp_opt_ins (tenant_id, guardian_id) WHERE guardian_id IS NOT NULL;
CREATE INDEX whatsapp_outbox_guardian_idx ON whatsapp_outbox (tenant_id, guardian_id) WHERE guardian_id IS NOT NULL;

-- Representação vigente HOJE do responsável para o lembrete (sem a maioridade, que é do serviço).
-- Invocador: RLS da clínica do contexto (o opt-in e a fila são gravados na sessão da clínica ou do sistema).
CREATE FUNCTION app_whatsapp_guardian_ok(p_tenant uuid, p_patient uuid, p_guardian uuid) RETURNS boolean
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
       AND v.valid_from <= public.app_fiscal_today()
       AND (v.valid_until IS NULL OR v.valid_until > public.app_fiscal_today())
       AND (v.kind = 'curador' OR p.emancipated_on IS NULL OR p.emancipated_on > public.app_fiscal_today()))
$$;
REVOKE ALL ON FUNCTION app_whatsapp_guardian_ok(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_whatsapp_guardian_ok(uuid, uuid, uuid) TO app_user;

CREATE FUNCTION whatsapp_guardian_vigente_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.recipient_kind = 'responsavel' AND NOT app_whatsapp_guardian_ok(NEW.tenant_id, NEW.patient_id, NEW.guardian_id) THEN
    RAISE EXCEPTION 'responsável sem vínculo vigente com o paciente (ou paciente emancipado)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER whatsapp_opt_ins_guardian_vigente BEFORE INSERT ON whatsapp_opt_ins
  FOR EACH ROW EXECUTE FUNCTION whatsapp_guardian_vigente_guard();
CREATE TRIGGER whatsapp_outbox_guardian_vigente BEFORE INSERT ON whatsapp_outbox
  FOR EACH ROW EXECUTE FUNCTION whatsapp_guardian_vigente_guard();

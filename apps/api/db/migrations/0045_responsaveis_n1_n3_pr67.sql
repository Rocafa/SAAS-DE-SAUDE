-- 0045 — Responsáveis: pontos novos N1 e N3 da conferência das ressalvas do PR #67 (Guardião, 22/10/2026).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10a.
--
-- NUMERAÇÃO: 0044 é de outra branch da rodada 21; esta é a 0045 (as duas não se tocam).
--
-- N1: a guarda de 20 anos do prontuário (`app_patient_record_retention_until`) passa a contar também
--     `patients.updated_at`, as sessões de PACOTE (`package_sessions`: consumo e estorno), as sessões de
--     GUIA (`guide_sessions`: consumo e estorno) e as ASSINATURAS de guia (`guide_session_signatures`).
--     É GREATEST: a mudança só alonga a guarda (nunca encurta). CHECKLIST: toda tabela nova do prontuário
--     (atendimento, documento assinado, anexo clínico) entra nesta função na mesma migração que a cria
--     (docs/03-seguranca-lgpd/retencao-e-descarte.md).
-- N3: corrida entre recebimento e anulação do pagador. O gatilho do recebimento trava a linha do vínculo
--     com FOR SHARE (conflita com o UPDATE da anulação, que pega FOR NO KEY UPDATE; FOR KEY SHARE não
--     bastaria). Se a anulação veio antes e ainda não confirmou, o recebimento espera e, confirmada a
--     anulação, a linha deixa de passar no filtro (READ COMMITTED reavalia a versão nova) e o recebimento é
--     recusado. Se o recebimento veio antes, a anulação espera o COMMIT dele e o gatilho da anulação já
--     enxerga o recebimento (regra R1: exige perfil que opera o financeiro).

-- ---------------------------------------------------------------- N1: base completa da guarda

CREATE OR REPLACE FUNCTION app_patient_record_retention_until(p_tenant uuid, p_patient uuid) RETURNS date
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT ((GREATEST(
      (SELECT GREATEST(pa.created_at, pa.updated_at) FROM patients pa WHERE pa.tenant_id = p_tenant AND pa.id = p_patient),
      (SELECT max(GREATEST(e.opened_at, e.updated_at, e.signed_at)) FROM encounters e WHERE e.tenant_id = p_tenant AND e.patient_id = p_patient),
      (SELECT max(v.created_at) FROM clinical_record_versions v
         JOIN encounters e ON e.tenant_id = v.tenant_id AND e.id = v.encounter_id
        WHERE e.tenant_id = p_tenant AND e.patient_id = p_patient),
      (SELECT max(a.created_at) FROM clinical_addenda a
         JOIN encounters e ON e.tenant_id = a.tenant_id AND e.id = a.encounter_id
        WHERE e.tenant_id = p_tenant AND e.patient_id = p_patient),
      (SELECT max(h.occurred_at) FROM patient_guardian_history h
         JOIN patient_guardians v ON v.tenant_id = h.tenant_id AND v.id = h.link_id
        WHERE v.tenant_id = p_tenant AND v.patient_id = p_patient AND h.event <> 'vinculo_eliminado'),
      -- N1: sessões de pacote (consumo e estorno).
      (SELECT max(GREATEST(ps.consumed_at, ps.reversed_at)) FROM package_sessions ps
         JOIN session_packages sp ON sp.tenant_id = ps.tenant_id AND sp.id = ps.package_id
        WHERE sp.tenant_id = p_tenant AND sp.patient_id = p_patient),
      -- N1: sessões de guia (atendimento por convênio: consumo e estorno) e as assinaturas delas.
      (SELECT max(GREATEST(gs.consumed_at, gs.reversed_at)) FROM guide_sessions gs
         JOIN insurance_guides g ON g.tenant_id = gs.tenant_id AND g.id = gs.guide_id
        WHERE g.tenant_id = p_tenant AND g.patient_id = p_patient),
      (SELECT max(sg.signed_at) FROM guide_session_signatures sg
         JOIN guide_sessions gs ON gs.tenant_id = sg.tenant_id AND gs.id = sg.guide_session_id
         JOIN insurance_guides g ON g.tenant_id = gs.tenant_id AND g.id = gs.guide_id
        WHERE g.tenant_id = p_tenant AND g.patient_id = p_patient)
    ) AT TIME ZONE 'America/Sao_Paulo')::date + make_interval(years => app_record_retention_years()))::date
$$;
REVOKE ALL ON FUNCTION app_patient_record_retention_until(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_patient_record_retention_until(uuid, uuid) TO app_user;

-- ---------------------------------------------------------------- N3: trava do vínculo no recebimento

CREATE OR REPLACE FUNCTION payments_guardian_payer_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.guardian_payer_resolved_by IS NOT NULL OR NEW.guardian_payer_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'payments: saneamento do pagador não entra no recebimento' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.guardian_payer_link_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.guardian_payer_enc IS NULL OR NEW.guardian_payer_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'payments: o pagador do cadastro entra com o retrato cifrado' USING ERRCODE = 'check_violation';
  END IF;
  -- N3: FOR SHARE OF pg trava o vínculo até o fim desta transação. Uma anulação (ou troca de pagador)
  -- concorrente espera; se ela já tinha a linha, este SELECT espera o COMMIT dela e reavalia o filtro na
  -- versão nova (vínculo encerrado => nenhuma linha => recusa).
  PERFORM 1 FROM charges c
    JOIN patient_guardians pg ON pg.tenant_id = c.tenant_id AND pg.patient_id = c.patient_id
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.charge_id AND c.payer_name IS NULL
     AND pg.id = NEW.guardian_payer_link_id AND pg.is_payer AND pg.ended_at IS NULL
     AND pg.valid_from <= app_fiscal_today()
  FOR SHARE OF pg;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payments: o vínculo não é o pagador vigente do paciente da cobrança' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 0069 — Desligamento pela revogação e aviso de fator bloqueado (D4, PR 3b-3; desenho §14.2; R10 do parecer do
-- desenho do PR 3; R6 do parecer do código do #152). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * O trigger de espelho (0064) passa também a:
--   - ao revogar o ÚLTIMO perfil de sessão da pessoa numa clínica: apagar as sessões dela COM ESSA clínica ativa (as
--     sessões em outras clínicas ficam intactas, R10);
--   - sem perfil de sessão em NENHUMA clínica: conta inativa (`ativo = false`) e todas as sessões caem;
--   - ao conceder um perfil de sessão: reativar a conta (recontratação pelo convite).
--   Tudo na MESMA transação da revogação ou da concessão.
-- * `fator_bloqueado` entra na lista fechada de regras de anomalia que viram aviso aos admins (R6 do #152).

-- R1 do parecer do código do 3b-3: o MOTIVO da inatividade. Só a conta desligada por falta de vínculo volta a valer numa
-- concessão; a anonimizada nunca (a concessão é recusada); a de convite desfeito volta só pelo reaproveitamento.
ALTER TABLE identidade.usuario ADD COLUMN inativa_por text
  CONSTRAINT usuario_inativa_por_check CHECK (inativa_por IS NULL OR inativa_por IN ('sem_vinculo', 'anonimizada', 'convite_desfeito'));
ALTER TABLE identidade.usuario ADD CONSTRAINT usuario_inativa_coerente_check CHECK ((ativo = false) OR (inativa_por IS NULL));

CREATE OR REPLACE FUNCTION app_espelhar_vinculo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role NOT IN ('admin', 'profissional', 'recepcao', 'financeiro') THEN
    RETURN NULL;
  END IF;
  IF NEW.revoked_at IS NULL THEN
    -- Conta anonimizada não recebe vínculo (a anonimização é definitiva).
    IF EXISTS (SELECT 1 FROM identidade.usuario u WHERE u.id = NEW.user_id AND u.inativa_por = 'anonimizada') THEN
      RAISE EXCEPTION 'conta anonimizada não recebe perfil' USING ERRCODE = '42501';
    END IF;
    INSERT INTO identidade.vinculo (usuario_id, clinica_id, papel) VALUES (NEW.user_id, NEW.tenant_id, NEW.role)
      ON CONFLICT DO NOTHING;
    -- Recontratação: só a conta desligada por falta de vínculo volta a valer (a credencial continua sendo da pessoa).
    UPDATE identidade.usuario SET ativo = true, inativa_por = NULL WHERE id = NEW.user_id AND ativo = false AND inativa_por = 'sem_vinculo';
  ELSE
    -- Só some do espelho se não houver OUTRA linha ativa do mesmo papel (revogado e concedido de novo).
    DELETE FROM identidade.vinculo v
     WHERE v.usuario_id = NEW.user_id AND v.clinica_id = NEW.tenant_id AND v.papel = NEW.role
       AND NOT EXISTS (SELECT 1 FROM public.clinic_members m
                        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.role = NEW.role
                          AND m.revoked_at IS NULL AND m.id <> NEW.id);
    -- Desligamento nesta clínica: sem nenhum perfil de sessão nela, as sessões com ela ativa caem (R10).
    IF NOT EXISTS (SELECT 1 FROM identidade.vinculo v WHERE v.usuario_id = NEW.user_id AND v.clinica_id = NEW.tenant_id) THEN
      DELETE FROM identidade.sessao s WHERE s.usuario_id = NEW.user_id AND s.clinica_ativa = NEW.tenant_id;
    END IF;
    -- Sem vínculo em nenhuma clínica: conta inativa e nenhuma sessão viva.
    IF NOT EXISTS (SELECT 1 FROM identidade.vinculo v WHERE v.usuario_id = NEW.user_id) THEN
      UPDATE identidade.usuario SET ativo = false, inativa_por = 'sem_vinculo' WHERE id = NEW.user_id AND ativo = true;
      DELETE FROM identidade.sessao s WHERE s.usuario_id = NEW.user_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_espelhar_vinculo() FROM PUBLIC;

ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_anomaly_rule_check;
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_anomaly_rule_check CHECK (anomaly_rule IN (
  'paginas_de_pacientes', 'fichas_distintas', 'limite_por_usuario', 'vinculo_autoagendado', 'vinculo_cruzado',
  'mfa_recusas_por_usuario', 'fator_bloqueado'));

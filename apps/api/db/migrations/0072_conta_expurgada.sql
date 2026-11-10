-- 0072 — Conta expurgada (D4; ressalvas 7 e 8 da reconferência do #173). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * `inativa_por = 'expurgada'`: o job `identidade-expurgo` marca a conta desligada há mais de 90 dias depois de apagar
--   a credencial, o fator, o e-mail e o nome. O id fica, preso ao histórico clínico (R18). A autoria clínica está em
--   `professionals` da clínica, não aqui.
-- * O trigger de espelho recusa a concessão de perfil à conta expurgada (42501), como já fazia com a anonimizada.
--   Quem volta recebe conta NOVA pelo convite (B2 do veto do #173).

ALTER TABLE identidade.usuario DROP CONSTRAINT usuario_inativa_por_check;
ALTER TABLE identidade.usuario ADD CONSTRAINT usuario_inativa_por_check
  CHECK (inativa_por IS NULL OR inativa_por IN ('sem_vinculo', 'anonimizada', 'convite_desfeito', 'expurgada'));

-- Contas que o expurgo já processou (e-mail trocado pelo marcador) passam a ter a marca, e o nome sai (art. 16).
UPDATE identidade.usuario SET inativa_por = 'expurgada', name = 'Conta desligada'
 WHERE ativo = false AND email LIKE 'desligada-%@desligada.invalid';

CREATE OR REPLACE FUNCTION app_espelhar_vinculo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role NOT IN ('admin', 'profissional', 'recepcao', 'financeiro') THEN
    RETURN NULL;
  END IF;
  IF NEW.revoked_at IS NULL THEN
    -- Conta anonimizada ou expurgada não recebe vínculo (as duas são definitivas; quem volta recebe conta nova).
    IF EXISTS (SELECT 1 FROM identidade.usuario u WHERE u.id = NEW.user_id AND u.inativa_por IN ('anonimizada', 'expurgada')) THEN
      RAISE EXCEPTION 'conta encerrada não recebe perfil' USING ERRCODE = '42501';
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

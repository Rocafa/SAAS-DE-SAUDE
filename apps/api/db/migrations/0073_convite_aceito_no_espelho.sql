-- 0073 — Espelho dos convites aceitos (D4; V3 do parecer do #177). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * `identidade.convite_aceito`: só ids (pessoa e clínica) dos convites que a conta aceitou E que ainda guardam o HMAC
--   do e-mail, mantido por trigger em `team_invites`, como o espelho de vínculos da 0064. A anonimização lê daqui SÓ as
--   clínicas onde ainda há pseudônimo a apagar, no lugar de varrer todas as clínicas da plataforma
--   (`app_job_tenants()`), e apaga as linhas da pessoa no fim.
-- * Retenção (V1 do parecer do #178): a linha só existe enquanto houver convite aceito com HMAC vivo naquela clínica.
--   Quando o `convites-descarte` (30 dias) ou a anonimização zera o HMAC, o trigger apaga a linha, salvo se ainda
--   restar outro convite aceito com HMAC vivo da mesma pessoa na mesma clínica (mesmo padrão do ramo ELSE da 0064).
-- * Nenhuma política nova em `team_invites`; o app_user não lê o espelho; o app_auth lê e apaga.

CREATE TABLE identidade.convite_aceito (
  usuario_id uuid NOT NULL,
  clinica_id uuid NOT NULL,
  PRIMARY KEY (usuario_id, clinica_id)
);
REVOKE ALL ON identidade.convite_aceito FROM PUBLIC;
GRANT SELECT, DELETE ON identidade.convite_aceito TO app_auth;

CREATE FUNCTION app_espelhar_convite_aceito() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.accepted_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.email_hmac <> repeat('0', 32) THEN
    INSERT INTO identidade.convite_aceito (usuario_id, clinica_id) VALUES (NEW.accepted_user_id, NEW.tenant_id)
      ON CONFLICT DO NOTHING;
  ELSE
    -- HMAC descartado: a linha só fica se outro convite aceito da pessoa nesta clínica ainda tiver HMAC vivo. O trigger
    -- roda na transação da clínica (contexto definido), então a RLS deixa ver só as linhas desta clínica.
    DELETE FROM identidade.convite_aceito c
     WHERE c.usuario_id = NEW.accepted_user_id AND c.clinica_id = NEW.tenant_id
       AND NOT EXISTS (SELECT 1 FROM public.team_invites i
                        WHERE i.tenant_id = NEW.tenant_id AND i.accepted_user_id = NEW.accepted_user_id
                          AND i.email_hmac <> repeat('0', 32) AND i.id <> NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_espelhar_convite_aceito() FROM PUBLIC;
CREATE TRIGGER zz_espelhar_convite_aceito AFTER INSERT OR UPDATE OF accepted_user_id, email_hmac ON team_invites
  FOR EACH ROW EXECUTE FUNCTION app_espelhar_convite_aceito();

-- Carga inicial: só os convites aceitos com HMAC vivo. O dono só enxerga todas as clínicas com o RLS forçado
-- desligado, e só nesta transação.
ALTER TABLE team_invites NO FORCE ROW LEVEL SECURITY;
INSERT INTO identidade.convite_aceito (usuario_id, clinica_id)
  SELECT DISTINCT i.accepted_user_id, i.tenant_id FROM team_invites i
   WHERE i.accepted_user_id IS NOT NULL AND i.email_hmac <> repeat('0', 32)
  ON CONFLICT DO NOTHING;
ALTER TABLE team_invites FORCE ROW LEVEL SECURITY;

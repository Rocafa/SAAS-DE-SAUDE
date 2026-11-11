-- 0073 — Espelho dos convites aceitos (D4; V3 do parecer do #177). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * `identidade.convite_aceito`: só ids (pessoa e clínica) dos convites que a conta aceitou, mantido por trigger em
--   `team_invites`, como o espelho de vínculos da 0064. A anonimização lê daqui SÓ as clínicas onde a pessoa aceitou
--   convite, no lugar de varrer todas as clínicas da plataforma (`app_job_tenants()`), e apaga as linhas da pessoa no
--   fim. Nenhuma política nova em `team_invites`; o app_user não lê o espelho; o app_auth lê e apaga.

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
  IF NEW.accepted_user_id IS NOT NULL THEN
    INSERT INTO identidade.convite_aceito (usuario_id, clinica_id) VALUES (NEW.accepted_user_id, NEW.tenant_id)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_espelhar_convite_aceito() FROM PUBLIC;
CREATE TRIGGER zz_espelhar_convite_aceito AFTER INSERT OR UPDATE OF accepted_user_id ON team_invites
  FOR EACH ROW EXECUTE FUNCTION app_espelhar_convite_aceito();

-- Carga inicial: o dono só enxerga todas as clínicas com o RLS forçado desligado, e só nesta transação.
ALTER TABLE team_invites NO FORCE ROW LEVEL SECURITY;
INSERT INTO identidade.convite_aceito (usuario_id, clinica_id)
  SELECT DISTINCT i.accepted_user_id, i.tenant_id FROM team_invites i WHERE i.accepted_user_id IS NOT NULL
  ON CONFLICT DO NOTHING;
ALTER TABLE team_invites FORCE ROW LEVEL SECURITY;

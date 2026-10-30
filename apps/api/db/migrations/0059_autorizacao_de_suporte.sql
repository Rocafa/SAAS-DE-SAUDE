-- 0059 — Autorização de acesso do suporte pela clínica (S9 do checklist da rodada 7; requisitos-tecnicos-seguranca.md
-- §2: "acesso de colaboradores nossos a dados de clientes: proibido por padrão; somente com chamado da clínica,
-- [...] expiração automática"). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Até aqui a trilha só exigia, na linha de suporte, o número do chamado e o motivo (CHECK da 0008). Nada conferia
-- que a CLÍNICA tinha pedido. Agora:
-- * o administrador da clínica autoriza um chamado (`SUP-<até 7 dígitos>`) por tempo limitado (até 72 h) e pode
--   revogar antes; quem autoriza e quem revoga é o usuário da sessão, com perfil `admin` ativo; datas do banco;
-- * a trilha RECUSA linha de suporte com motivo `pedido_da_clinica` sem autorização vigente para aquele chamado
--   naquela clínica. Vale para qualquer caminho de código, inclusive SQL direto.
-- * `break_glass` (emergência) não depende da clínica: continua aceito pelo banco e fica visível na trilha que a
--   clínica exporta. A aprovação por duas pessoas do lado do operador depende da identidade do operador (D4).
-- A autorização só guarda ids, o chamado e datas: nenhum dado de paciente.

CREATE TABLE support_access_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  ticket      text NOT NULL CONSTRAINT support_access_grants_ticket_check CHECK (ticket ~ '^SUP-[0-9]{1,7}$'),
  granted_by  uuid NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_by  uuid,
  revoked_at  timestamptz,
  CONSTRAINT support_access_grants_window_check CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '72 hours'),
  CONSTRAINT support_access_grants_revoke_check CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE INDEX support_access_grants_ticket_idx ON support_access_grants (tenant_id, ticket);

CREATE FUNCTION support_access_grants_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'autorização de suporte não se apaga (revogue)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR NOT app_user_has_role(v_user, 'admin') THEN
    RAISE EXCEPTION 'autorização de suporte: só o administrador da clínica autoriza e revoga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.granted_by IS DISTINCT FROM v_user OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'autorização de suporte: nasce vigente e dada pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A janela conta da data do banco: o prazo pedido é preservado e o CHECK limita a 72 h.
    NEW.expires_at := now() + (NEW.expires_at - NEW.granted_at);
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'autorização de suporte: revogada é terminal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.ticket IS DISTINCT FROM OLD.ticket
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.revoked_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'autorização de suporte: só a revogação, pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION support_access_grants_guard() FROM PUBLIC;

CREATE TRIGGER support_access_grants_guard
  BEFORE INSERT OR UPDATE OR DELETE ON support_access_grants
  FOR EACH ROW EXECUTE FUNCTION support_access_grants_guard();
CREATE TRIGGER support_access_grants_no_truncate BEFORE TRUNCATE ON support_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_access_grants
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
-- O portal nunca vê nem mexe na autorização.
CREATE POLICY portal_fora ON support_access_grants AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON support_access_grants FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON support_access_grants FROM app_user;
GRANT SELECT, INSERT, UPDATE ON support_access_grants TO app_user;

-- ---------------------------------------------------------------- a trilha confere a autorização

-- Linha de suporte com motivo `pedido_da_clinica` só com autorização vigente do mesmo chamado nesta clínica.
-- Roda com o papel de quem grava (RLS de tenant na autorização). Não altera a linha: a cadeia de hash não muda.
CREATE FUNCTION audit_log_support_grant_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.actor_kind = 'suporte_plataforma' AND (NEW.metadata ->> 'reason') = 'pedido_da_clinica' AND NOT EXISTS (
       SELECT 1 FROM support_access_grants g
        WHERE g.tenant_id = NEW.tenant_id AND g.ticket = (NEW.metadata ->> 'ticket')
          AND g.revoked_at IS NULL AND g.granted_at <= now() AND now() < g.expires_at) THEN
    RAISE EXCEPTION 'acesso de suporte sem autorização vigente da clínica para o chamado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION audit_log_support_grant_guard() FROM PUBLIC;

CREATE TRIGGER audit_log_support_grant_guard
  BEFORE INSERT ON audit_log
  FOR EACH ROW WHEN (NEW.actor_kind = 'suporte_plataforma')
  EXECUTE FUNCTION audit_log_support_grant_guard();

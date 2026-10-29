-- 0043 — Agendador de jobs (rodada 20, "agendador real" antes do piloto). Executar com o papel de MIGRAÇÃO
-- (app_migrator). Ver docs/04-arquitetura/api-dominio.md §14.
--
-- NUMERAÇÃO: 0043 é da rodada 20 (jobs), depois da 0042 (ressalvas #65/#63).
--
-- O agendador roda cada job UMA clínica por vez, dentro de withTenant (RLS) e com o sentinela de sistema no
-- slot do usuário (0019). Para isso precisa da lista de clínicas, que ninguém enxerga sem contexto: `tenants`
-- tem RLS FORÇADO, inclusive para o dono (as funções SECURITY DEFINER). Abrir `tenants` ao dono com uma
-- policy `USING (true)` deixaria TODA função SECURITY DEFINER que filtra `tenants` por parâmetro (0022, 0039,
-- 0040, 0042) ver outras clínicas; por isso não.
--
-- Desenho (mesmo de `portal_link_index`, 0027, e `whatsapp_routes`, 0032):
--   * `job_tenant_index` (INTERNA: zero privilégio para o runtime, policy só do dono): só o id da clínica;
--   * gatilho AFTER INSERT em `tenants` (SECURITY DEFINER) mantém o índice; carga inicial nesta migração;
--   * `app_job_tenants()` (SECURITY DEFINER, search_path fixo) devolve SÓ os ids, e só FORA de contexto de
--     clínica: dentro de uma transação de clínica (withTenant) recusa (42501), para nenhum código de domínio
--     usá-la para descobrir outras clínicas.

-- ------------------------------------------------------------------ índice interno

CREATE TABLE job_tenant_index (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id)
);
REVOKE ALL ON job_tenant_index FROM PUBLIC;
REVOKE ALL ON job_tenant_index FROM app_user;
ALTER TABLE job_tenant_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_tenant_index FORCE ROW LEVEL SECURITY;
CREATE POLICY job_tenant_index_definer_only ON job_tenant_index TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE FUNCTION job_tenant_index_sync() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.job_tenant_index (tenant_id) VALUES (NEW.id) ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION job_tenant_index_sync() FROM PUBLIC;
CREATE TRIGGER tenants_job_tenant_index AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION job_tenant_index_sync();

-- Carga inicial: o dono só enxerga `tenants` sem o FORCE; desligado e religado NESTA transação (atômico).
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
INSERT INTO job_tenant_index (tenant_id) SELECT id FROM tenants ON CONFLICT (tenant_id) DO NOTHING;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------ lista para o agendador

CREATE FUNCTION app_job_tenants() RETURNS SETOF uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenant_context WHERE xid = txid_current_if_assigned()) THEN
    RAISE EXCEPTION 'lista de clínicas do agendador só fora de contexto de clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT i.tenant_id FROM public.job_tenant_index i ORDER BY 1;
END;
$$;
REVOKE ALL ON FUNCTION app_job_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_job_tenants() TO app_user;

-- ------------------------------------------------------------------ lista fechada das tabelas internas (0038)

CREATE OR REPLACE FUNCTION app_internal_tables() RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT ARRAY['schema_migrations', 'tenant_context', 'portal_invite_lookup', 'portal_link_index', 'portal_invite_otp',
               'fiscal_retention_policy', 'whatsapp_routes', 'portal_birth_date_changes', 'job_tenant_index']::text[]
$$;

-- ------------------------------------------------------------------ conferência final

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolsuper, o.rolbypassrls, o.rolname
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_job_tenants()'::regprocedure, 'job_tenant_index_sync()'::regprocedure)
  LOOP
    IF NOT r.prosecdef OR r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION '%: SECURITY DEFINER com dono sem superpoder e diferente do runtime', r.f;
    END IF;
  END LOOP;
  IF NOT (SELECT c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'public.tenants'::regclass) THEN
    RAISE EXCEPTION 'tenants: RLS forçado tem de voltar ao fim da carga';
  END IF;
END;
$$;

-- 0066 — Fecha as duas exceções de RLS encontradas pela guarda agregada de schema.
-- Executar com app_migrator. Não muda dados, privilégios do runtime nem regras de tenant.
--
-- As duas tabelas já eram internas: REVOKE ALL de PUBLIC/app_user e acesso do domínio só por
-- SECURITY DEFINER (fiscal) ou pelo migrador (schema_migrations). O REVOKE continua obrigatório;
-- RLS FORCE + policy só do dono é defesa em profundidade caso um GRANT indevido apareça depois.
-- Reversão por migração compensatória: remover as duas policies e desabilitar RLS nas duas tabelas.

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY schema_migrations_definer_only ON schema_migrations TO CURRENT_USER
  USING (true) WITH CHECK (true);

ALTER TABLE fiscal_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_retention_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_retention_policy_definer_only ON fiscal_retention_policy TO CURRENT_USER
  USING (true) WITH CHECK (true);

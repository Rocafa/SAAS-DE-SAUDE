-- Impressão digital das guardas do banco (R12 do parecer do PR #61).
-- Uma linha por objeto: tipo <TAB> objeto <TAB> md5 da definição. Sem dado de linha, sem segredo:
-- só catálogo (pg_proc, pg_policy, pg_trigger, pg_class). Somente leitura.
--
-- Cobre o que o alarme de DDL avisa mas não prova que voltou ao normal:
--   funcao   corpo, SECURITY DEFINER, SET de config, dono e ACL de cada função/procedure
--            (CREATE OR REPLACE / ALTER FUNCTION / DROP FUNCTION ... CASCADE);
--   policy   comando, permissiva/restritiva, papéis, USING e WITH CHECK (CREATE/ALTER/DROP POLICY);
--   trigger  definição e estado de habilitação (DISABLE/DROP TRIGGER);
--   tabela   dono, ENABLE e FORCE ROW LEVEL SECURITY (ALTER TABLE ... OWNER / NO FORCE RLS).
-- Objetos de extensão (pgaudit, pg_stat_statements) ficam de fora: não vêm das migrações.
--
-- Uso: psql -X -q -At -F '	' -f infra/rds/verificar-guardas.sql   (ver verificar-guardas.sh)
SET search_path = pg_catalog;

WITH esquemas AS (
  SELECT oid, nspname FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND nspname NOT LIKE 'pg\_temp\_%' AND nspname NOT LIKE 'pg\_toast\_temp\_%'
),
fora_extensao AS (
  SELECT objid, classid FROM pg_depend WHERE deptype = 'e'
),
funcoes AS (
  SELECT 'funcao' AS tipo,
         format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS objeto,
         md5(concat_ws(E'\n', pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), p.proacl::text)) AS hash
    FROM pg_proc p JOIN esquemas n ON n.oid = p.pronamespace
   WHERE p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM fora_extensao e
                      WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid)
),
policies AS (
  SELECT 'policy',
         format('%I.%I/%I', n.nspname, c.relname, pol.polname),
         md5(concat_ws(E'\n', pol.polcmd::text, pol.polpermissive::text,
               (SELECT string_agg(CASE r WHEN 0 THEN 'public' ELSE pg_get_userbyid(r) END, ',' ORDER BY 1)
                  FROM unnest(pol.polroles) AS r),
               coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-'),
               coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')))
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN esquemas n ON n.oid = c.relnamespace
),
gatilhos AS (
  SELECT 'trigger',
         format('%I.%I/%I', n.nspname, c.relname, t.tgname),
         md5(concat_ws(E'\n', pg_get_triggerdef(t.oid), t.tgenabled::text))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN esquemas n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
),
tabelas AS (
  SELECT 'tabela',
         format('%I.%I', n.nspname, c.relname),
         md5(concat_ws(E'\n', pg_get_userbyid(c.relowner),
               c.relrowsecurity::text, c.relforcerowsecurity::text))
    FROM pg_class c JOIN esquemas n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND NOT EXISTS (SELECT 1 FROM fora_extensao e
                      WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid)
)
SELECT tipo, objeto, hash FROM (
  SELECT * FROM funcoes
  UNION ALL SELECT * FROM policies
  UNION ALL SELECT * FROM gatilhos
  UNION ALL SELECT * FROM tabelas
) AS guardas
ORDER BY tipo COLLATE "C", objeto COLLATE "C";

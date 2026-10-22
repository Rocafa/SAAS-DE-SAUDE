-- Impressão digital das guardas do banco (R12 do parecer do PR #61; R10 do parecer do PR #58).
-- Uma linha por objeto: tipo <TAB> objeto <TAB> md5 da definição, mais uma linha "contagem" por
-- tipo. Sem dado de linha, sem segredo: só catálogo. Somente leitura.
--
-- Cobre o que o alarme de DDL avisa mas não prova que voltou ao normal:
--   funcao      corpo, SECURITY DEFINER, SET de config, dono e ACL de cada função/procedure;
--   policy      comando, permissiva/restritiva, papéis, USING e WITH CHECK;
--   trigger     definição e estado (tgenabled: O normal, D desligado, R só réplica, A sempre);
--   tabela      dono, ENABLE/FORCE RLS, ACL da tabela (GRANT/REVOKE), ACL de coluna, colunas
--               NOT NULL, reloptions e, em view, a definição. Inclui views e sequências;
--   constraint  pg_get_constraintdef + validada/deferrable (DROP/ALTER CONSTRAINT, NOT VALID);
--   indice      únicos, parciais e de exclusão: pg_get_indexdef + válido/pronto (DROP INDEX);
--   regra       rules fora das views (CREATE RULE ... DO INSTEAD) e o estado ev_enabled;
--   esquema     dono e ACL (GRANT CREATE ON SCHEMA);
--   privpadrao  ALTER DEFAULT PRIVILEGES (papel, esquema, tipo de objeto, ACL);
--   contagem    número de objetos de cada tipo (some/aparece objeto => muda).
-- Objetos de extensão (pgaudit, pg_stat_statements) ficam de fora: não vêm das migrações.
--
-- Uso: psql -X -q -At -F '	' -f infra/rds/verificar-guardas.sql   (ver verificar-guardas.sh)
SET search_path = pg_catalog;

WITH esquemas AS (
  SELECT oid, nspname, nspowner, nspacl FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND nspname NOT LIKE 'pg\_temp\_%' AND nspname NOT LIKE 'pg\_toast\_temp\_%'
),
fora_extensao AS (
  SELECT objid, classid FROM pg_depend WHERE deptype = 'e'
),
relacoes AS (
  SELECT c.*, n.nspname FROM pg_class c JOIN esquemas n ON n.oid = c.relnamespace
   WHERE NOT EXISTS (SELECT 1 FROM fora_extensao e
                      WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid)
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
         format('%I.%I/%I', c.nspname, c.relname, pol.polname),
         md5(concat_ws(E'\n', pol.polcmd::text, pol.polpermissive::text,
               (SELECT string_agg(CASE r WHEN 0 THEN 'public' ELSE pg_get_userbyid(r) END, ',' ORDER BY 1)
                  FROM unnest(pol.polroles) AS r),
               coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-'),
               coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')))
    FROM pg_policy pol
    JOIN relacoes c ON c.oid = pol.polrelid
),
gatilhos AS (
  SELECT 'trigger',
         format('%I.%I/%I', c.nspname, c.relname, t.tgname),
         md5(concat_ws(E'\n', pg_get_triggerdef(t.oid), t.tgenabled::text))
    FROM pg_trigger t
    JOIN relacoes c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
),
tabelas AS (
  SELECT 'tabela',
         format('%I.%I', c.nspname, c.relname),
         md5(concat_ws(E'\n', c.relkind::text, pg_get_userbyid(c.relowner),
               c.relrowsecurity::text, c.relforcerowsecurity::text,
               coalesce(c.relacl::text, '-'),
               coalesce(c.reloptions::text, '-'),
               (SELECT string_agg(format('%I=%s', a.attname, a.attacl::text), ',' ORDER BY a.attnum)
                  FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),
               (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY a.attnum)
                  FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull),
               CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END))
    FROM relacoes c
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
restricoes AS (
  SELECT 'constraint',
         format('%I.%I/%I', c.nspname, c.relname, k.conname),
         md5(concat_ws(E'\n', pg_get_constraintdef(k.oid), k.convalidated::text,
               k.condeferrable::text, k.condeferred::text))
    FROM pg_constraint k
    JOIN relacoes c ON c.oid = k.conrelid
),
indices AS (
  SELECT 'indice',
         format('%I.%I/%I', c.nspname, c.relname, ic.relname),
         md5(concat_ws(E'\n', pg_get_indexdef(i.indexrelid), i.indisvalid::text, i.indisready::text))
    FROM pg_index i
    JOIN relacoes c ON c.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE i.indisunique OR i.indisexclusion OR i.indpred IS NOT NULL
),
regras AS (
  SELECT 'regra',
         format('%I.%I/%I', c.nspname, c.relname, r.rulename),
         md5(concat_ws(E'\n', pg_get_ruledef(r.oid), r.ev_enabled::text))
    FROM pg_rewrite r
    JOIN relacoes c ON c.oid = r.ev_class
   WHERE r.rulename <> '_RETURN'
),
esquemas_acl AS (
  SELECT 'esquema',
         format('%I', n.nspname),
         md5(concat_ws(E'\n', pg_get_userbyid(n.nspowner), coalesce(n.nspacl::text, '-')))
    FROM esquemas n
   WHERE NOT EXISTS (SELECT 1 FROM fora_extensao e
                      WHERE e.classid = 'pg_namespace'::regclass AND e.objid = n.oid)
),
privilegios_padrao AS (
  SELECT 'privpadrao',
         format('%s/%s/%s', pg_get_userbyid(d.defaclrole),
                coalesce((SELECT quote_ident(nspname) FROM pg_namespace WHERE oid = d.defaclnamespace), '*'),
                d.defaclobjtype),
         md5(coalesce(d.defaclacl::text, '-'))
    FROM pg_default_acl d
),
guardas AS (
  SELECT * FROM funcoes
  UNION ALL SELECT * FROM policies
  UNION ALL SELECT * FROM gatilhos
  UNION ALL SELECT * FROM tabelas
  UNION ALL SELECT * FROM restricoes
  UNION ALL SELECT * FROM indices
  UNION ALL SELECT * FROM regras
  UNION ALL SELECT * FROM esquemas_acl
  UNION ALL SELECT * FROM privilegios_padrao
)
SELECT tipo, objeto, hash FROM (
  SELECT tipo, objeto, hash FROM guardas
  UNION ALL
  SELECT 'contagem', tipo, count(*)::text FROM guardas GROUP BY tipo
) AS impressao
ORDER BY tipo COLLATE "C", objeto COLLATE "C";

-- 0035 — Importador: regra das FK do desfazer conferida a CADA migração (R11 da re-revisão 2 do Guardião, 20/10/2026).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0035 é do importador (rodada 19); até a 0034 já está em uso em outras branches.
--
-- R11: a regra "FK para patients/appointments só RESTRICT/NO ACTION; CASCADE, SET NULL ou SET DEFAULT só se
-- a tabela estiver em app_import_batch_blockers" era conferida só uma vez (bloco DO da 0030) e no teste do
-- catálogo. Uma migração nova com FK em CASCADE passaria no deploy se o teste fosse removido ou pulado, e o
-- desfazer de um lote apagaria, sem aviso, o que veio depois.
-- Agora a regra vira função, e scripts/migrate.mjs a chama DENTRO da transação de cada migração aplicada
-- (a partir desta): a migração que quebrar a regra falha e é desfeita, no CI e no deploy de produção.
-- O papel de migração não é superusuário, então não dá para usar event trigger; o runner é o ponto único.

CREATE FUNCTION app_assert_regra_fk_desfazer() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r record;
  corpo text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.app_import_batch_blockers(uuid)'::regprocedure);
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS tabela, c.confrelid::regclass::text AS alvo
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid IN ('public.patients'::regclass, 'public.appointments'::regclass)
       AND c.confdeltype NOT IN ('r', 'a')
  LOOP
    IF corpo !~ ('\m' || r.tabela || '\M') THEN
      RAISE EXCEPTION 'FK % (% -> %) não é RESTRICT e a tabela não está em app_import_batch_blockers', r.conname, r.tabela, r.alvo;
    END IF;
  END LOOP;
END;
$$;

-- Só o papel de migração chama (o runtime não tem o que fazer com ela).
REVOKE ALL ON FUNCTION app_assert_regra_fk_desfazer() FROM PUBLIC;

SELECT app_assert_regra_fk_desfazer();

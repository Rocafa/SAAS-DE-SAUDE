-- 0030 — Importador: remove o alerta de CPFs em outra clínica (V2 da re-revisão do Guardião, 19/10/2026).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0030 é do importador (rodada 19); 0029 do #65. 0027 e 0028 são de outras branches.
--
-- V2: app_import_cpfs_em_outras_clinicas (0026, R6 b) era um oráculo entre controladoras. Com 4 CPFs que
-- o atacante sabe estarem importados em outra clínica + 1 CPF alvo, a resposta (5 ou 0) dizia se o alvo é
-- paciente de outra clínica — dado referente à saúde, sem base legal (art. 11), fora das instruções da
-- controladora dona (art. 39) e comunicação que configura incidente (art. 48). Trocar por sim/não não
-- resolve (1 bit por consulta basta). Decisão: opção (a) do parecer — o cliente não recebe NENHUM sinal
-- sobre outras clínicas. Saem a função de consulta, a de registro, a tabela de impressões (e com ela a
-- única FK em CASCADE para patients) e a chave IMPORT_CPF_FP_KEY (só existia no ambiente).
-- Ficam: a confirmação de nome/CNPJ da clínica no aplicar (R6 a, import_batches_origin_guard), a checagem
-- de duplicidade DENTRO da própria clínica e o termo.
--
-- As impressões gravadas são apagadas junto com a tabela (DROP): eram HMAC com chave da plataforma, sem
-- uso fora do alerta, e não há o que migrar.

DROP FUNCTION app_import_cpfs_em_outras_clinicas(text[]);
DROP FUNCTION app_import_register_cpf_fingerprints(uuid, uuid[], text[]);
DROP TABLE import_cpf_fingerprints;

-- Regra para a frente (re-revisão do importador): FK para patients/appointments só RESTRICT/NO ACTION.
-- CASCADE, SET NULL ou SET DEFAULT só se a tabela também estiver em app_import_batch_blockers; senão o
-- desfazer apagaria ou alteraria, sem aviso, o que veio depois. Conferido aqui e no teste que lê o catálogo.
DO $$
DECLARE
  r record;
  corpo text := (SELECT prosrc FROM pg_proc WHERE oid = 'app_import_batch_blockers(uuid)'::regprocedure);
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

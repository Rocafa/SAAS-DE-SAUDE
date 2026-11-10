-- 0070 — Retenção dos tokens de recuperação (D4; R7 do parecer do código do 3b-2). Executar com o papel de MIGRAÇÃO.
-- O job `identidade-expurgo` apaga os tokens vencidos há mais de 30 dias (usados ou não). DELETE só nesta tabela.
GRANT DELETE ON identidade.recuperacao TO app_auth;

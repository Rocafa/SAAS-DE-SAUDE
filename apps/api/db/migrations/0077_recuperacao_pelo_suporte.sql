-- 0077 — Recuperação do fator do admin único pelo suporte (B12; resposta 2, R2, R6 e R7 do parecer do Guardião de
-- 16/11/2026 sobre docs/04-arquitetura/recuperacao-do-admin-unico.md). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * Mesma tabela e mesmo uso do #159 (0068): a separação das provas vem de colunas, não de tabela nova.
-- * `origem`: 'admin' (#159, padrão: as linhas que já existem continuam iguais) ou 'suporte' (comando
--   ops/recuperar-admin-unico).
-- * `chamado`: só `SUP-<número>`; obrigatório com origem 'suporte' e nulo com 'admin'. Nunca nome ou e-mail.
-- * Com origem 'suporte': só o tipo 'fator' (a recuperação completa é VETADA; nenhum token restaura os dois fatores),
--   `criado_por` = ator de sistema (o operador fica só no log de segurança) e validade de até 24 h. A origem 'admin'
--   mantém os 15 min da 0068.
-- * O teto do suporte (1 por clínica em 30 dias, 2 por pessoa em 12 meses) conta estas linhas: o índice parcial atende
--   as duas contagens. O expurgo mantém as linhas do suporte por 13 meses (as do admin seguem com 30 dias).

ALTER TABLE identidade.recuperacao
  ADD COLUMN origem text NOT NULL DEFAULT 'admin' CONSTRAINT recuperacao_origem_check CHECK (origem IN ('admin', 'suporte')),
  ADD COLUMN chamado text CONSTRAINT recuperacao_chamado_check CHECK (chamado ~ '^SUP-[0-9]{1,7}$');

ALTER TABLE identidade.recuperacao
  ADD CONSTRAINT recuperacao_chamado_da_origem_check CHECK ((origem = 'suporte') = (chamado IS NOT NULL)),
  ADD CONSTRAINT recuperacao_suporte_check CHECK (
    origem = 'admin' OR (tipo = 'fator' AND criado_por = '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE identidade.recuperacao DROP CONSTRAINT recuperacao_validade_check;
ALTER TABLE identidade.recuperacao
  ADD CONSTRAINT recuperacao_validade_check CHECK (
    expira_em > criado_em
    AND expira_em <= criado_em + CASE WHEN origem = 'suporte' THEN interval '24 hours' ELSE interval '15 minutes' END
  );

CREATE INDEX recuperacao_suporte_idx ON identidade.recuperacao (clinica_id, usuario_id, criado_em) WHERE origem = 'suporte';

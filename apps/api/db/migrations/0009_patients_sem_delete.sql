-- 0009 — Retenção: o runtime não apaga paciente (R3 do parecer do Guardião sobre o PR #57; front-r8 R4).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- A API não tem rota de exclusão de paciente (inativa, com inactivated_at). O DELETE que sobrou dos
-- DEFAULT PRIVILEGES da 0001 deixava um bug ou uma injeção apagar paciente sem agendamento. Agora
-- nenhuma tabela da clínica permite DELETE/TRUNCATE ao runtime; a eliminação ao fim do contrato (G3)
-- será um job próprio, com papel próprio e auditoria. A guarda de schema cobra a lista exata.

REVOKE DELETE, TRUNCATE ON patients FROM app_user;

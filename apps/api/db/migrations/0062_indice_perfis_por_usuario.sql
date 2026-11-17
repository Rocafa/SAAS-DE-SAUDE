-- 0062 — Índice para a conferência de perfis a cada requisição (E2 da revisão interna de 04/11; R7 do parecer do #130).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- O SessaoGuard lê TODAS as linhas do usuário em clinic_members (ativas e revogadas) a cada requisição autenticada. O
-- índice único da 0020 é parcial (só ativas) e inclui o perfil; este cobre a busca por (clínica, usuário) inteira.
-- Nenhuma linha muda.

CREATE INDEX clinic_members_tenant_user_idx ON clinic_members (tenant_id, user_id);

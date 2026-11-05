-- 0010 — Ação de auditoria para alerta de anomalia (R5 do parecer do Guardião sobre o PR #57).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §"Limite por usuário e alerta".
--
-- Quando um usuário da clínica passa de um padrão de leitura de pacientes (muitas páginas da lista ou
-- muitas fichas distintas em pouco tempo, ou o limite por usuário da listagem), a API grava um evento
-- `anomaly_alert` na trilha da clínica, com o próprio usuário como ator e SÓ a regra, a janela, o
-- limiar e a contagem no metadata (nunca id de paciente, nome ou termo de busca).
--
-- Mesmo padrão da 0006: só AMPLIA o conjunto (toda linha existente continua válida), NOT VALID +
-- VALIDATE, sem tocar o hash (action já está no JSON canônico). O enum AuditAction de
-- packages/shared/src/enums.ts ganha o mesmo valor (teste de paridade em test/audit-chain.rls.test.ts).
-- Migração que redefinir este CHECK depois (ex.: 0011) precisa manter 'anomaly_alert'.

ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN (
  'read', 'create', 'update', 'sign', 'export', 'share',
  'login', 'login_failed', 'permission_change', 'consent_change',
  'key_provision', 'key_rotate', 'key_destroy',
  'ai_use', 'ai_refusal',
  'break_glass',
  'anomaly_alert')) NOT VALID;
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_action_check;

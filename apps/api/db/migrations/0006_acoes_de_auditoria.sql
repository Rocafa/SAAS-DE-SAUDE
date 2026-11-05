-- 0006 — Ações novas na trilha de auditoria (ORDEM-004 do Maestro, resposta 5).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- O CHECK de audit_log.action (0002) é a barreira final do enum AuditAction de
-- packages/shared/src/enums.ts; os dois precisam ter exatamente os mesmos valores (teste de paridade
-- em test/audit-chain.rls.test.ts). Ações novas:
--   key_provision, key_rotate, key_destroy  — ciclo de vida das chaves por clínica (S5, 0004);
--   ai_use, ai_refusal                       — uso e recusa de IA sobre dado da clínica;
--   break_glass                              — acesso de emergência fora da permissão normal.
--
-- Só AMPLIA o conjunto: toda linha existente continua válida. NOT VALID + VALIDATE separa a troca
-- da regra (instantânea) da varredura, que só lê. Não toca o hash: action já faz parte do JSON
-- canônico (0005) e as linhas antigas não mudam.

ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN (
  'read', 'create', 'update', 'sign', 'export', 'share',
  'login', 'login_failed', 'permission_change', 'consent_change',
  'key_provision', 'key_rotate', 'key_destroy',
  'ai_use', 'ai_refusal',
  'break_glass')) NOT VALID;
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_action_check;

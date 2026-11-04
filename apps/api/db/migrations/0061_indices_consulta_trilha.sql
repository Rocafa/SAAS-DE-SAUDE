-- 0061 — Índices da consulta da trilha pela clínica (E10 da revisão interna de 04/11/2026; R3 do parecer do #135).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- `GET /clinica/auditoria` filtra por paciente (o `patient_id` gravado na metadata) e por usuário (`actor_id`) e pagina
-- por (created_at, id) da mais nova para a mais antiga. Sem índice, um paciente com poucos acessos fazia varrer anos de
-- trilha da clínica. A consulta também roda com `statement_timeout` de 5 s.
--
-- O índice do paciente é parcial (só linhas com `patient_id`): a igualdade `metadata->>'patient_id' = $1` implica
-- `IS NOT NULL`, então o planejador consegue usá-lo. Nenhuma linha muda; a trilha continua só de inserção.

CREATE INDEX audit_log_paciente_idx
  ON audit_log (tenant_id, (metadata->>'patient_id'), created_at DESC, id DESC)
  WHERE (metadata->>'patient_id') IS NOT NULL;

CREATE INDEX audit_log_ator_idx
  ON audit_log (tenant_id, actor_id, created_at DESC, id DESC);

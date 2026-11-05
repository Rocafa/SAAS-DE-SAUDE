-- 0063 — Alerta de anomalia vira aviso aos admins (resto do E10 da revisão interna de 04/11/2026). Executar com o papel
-- de MIGRAÇÃO (app_migrator).
--
-- Os alertas de anomalia (`anomaly_alert`) ficavam só na trilha: ninguém da clínica os via. Agora, quando um alerta nasce
-- numa sessão da EQUIPE, os DEMAIS admins ativos recebem um aviso na caixa interna, com a regra e quem disparou (só o
-- id). Alertas do portal (sessão do paciente) seguem só na trilha: o trigger dos avisos exige um usuário da clínica.
-- O trigger `clinical_notices_guard` cobre o tipo pelo caminho geral (criado pelo usuário da sessão, nasce não lido).

ALTER TABLE clinical_notices
  ADD COLUMN anomaly_rule text CONSTRAINT clinical_notices_anomaly_rule_check CHECK (anomaly_rule IN (
    'paginas_de_pacientes', 'fichas_distintas', 'limite_por_usuario', 'vinculo_autoagendado', 'vinculo_cruzado',
    'mfa_recusas_por_usuario'));

ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_kind_check;
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_kind_check CHECK (kind IN (
  'sigilo_psicologia_alterado', 'perfil_alterado', 'retencao_retirada_pedida', 'retencao_retirada_aprovada',
  'pedido_titular_aberto', 'portal_sigilo_transicao', 'area_sensivel_desmarcada', 'alerta_anomalia'));

-- Só o tipo novo usa a coluna, e ele sempre a usa.
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_anomalia_check CHECK ((kind = 'alerta_anomalia') = (anomaly_rule IS NOT NULL));

-- Forma (recriada da 0060 com o ramo novo; o ELSE continua false).
ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_shape_check;
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_shape_check CHECK (
  CASE kind
    WHEN 'sigilo_psicologia_alterado' THEN
      from_mode IS NOT NULL AND to_mode IS NOT NULL
      AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
      AND rights_request_id IS NULL
    WHEN 'perfil_alterado' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NOT NULL AND subject_role IS NOT NULL AND change IS NOT NULL AND legal_hold_id IS NULL
      AND rights_request_id IS NULL
    WHEN 'pedido_titular_aberto' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
      AND rights_request_id IS NOT NULL
    WHEN 'portal_sigilo_transicao' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
      AND rights_request_id IS NULL
    WHEN 'area_sensivel_desmarcada' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
      AND rights_request_id IS NULL AND professional_id IS NOT NULL
    WHEN 'alerta_anomalia' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NOT NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
      AND rights_request_id IS NULL AND professional_id IS NULL AND anomaly_rule IS NOT NULL
    WHEN 'retencao_retirada_pedida' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NOT NULL
      AND rights_request_id IS NULL
    WHEN 'retencao_retirada_aprovada' THEN
      from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
      AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NOT NULL
      AND rights_request_id IS NULL
    ELSE false
  END);

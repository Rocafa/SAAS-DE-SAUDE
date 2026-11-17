-- 0060 — Aviso quando a área sensível de um profissional é DESMARCADA (E8 da revisão interna de 04/11/2026, R1 do
-- parecer do #131). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Desmarcar a área sensível tira do profissional o MFA recente e o tratamento de sigilo da psicologia. A rota já
-- exige MFA recente (#131); agora a mudança também não passa despercebida: o profissional afetado (se tiver usuário)
-- e os DEMAIS admins ativos recebem um aviso na caixa interna. O aviso leva só o id do profissional; o fato completo
-- está na trilha. Nenhum dado de paciente.
--
-- O trigger `clinical_notices_guard` (0050) já cobre o tipo novo pelo caminho geral: criado pelo usuário da sessão e
-- nasce não lido.

ALTER TABLE clinical_notices
  ADD COLUMN professional_id uuid,
  ADD CONSTRAINT clinical_notices_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id);

ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_kind_check;
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_kind_check CHECK (kind IN (
  'sigilo_psicologia_alterado', 'perfil_alterado', 'retencao_retirada_pedida', 'retencao_retirada_aprovada',
  'pedido_titular_aberto', 'portal_sigilo_transicao', 'area_sensivel_desmarcada'));

-- Forma do tipo novo: SÓ o id do profissional. E nenhum outro tipo usa a coluna.
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_area_sensivel_check CHECK (
  (kind = 'area_sensivel_desmarcada') = (professional_id IS NOT NULL)
  AND (kind <> 'area_sensivel_desmarcada' OR (
    from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
    AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
    AND rights_request_id IS NULL AND patient_id IS NULL AND portal_transition IS NULL)));

-- B1/R1 do parecer do #133: a shape_check da 0039 tem ELSE (tipos de retenção, que exigem legal_hold_id). Sem um
-- ramo próprio, o tipo novo cairia no ELSE e NENHUM aviso seria gravado. Recriada igual à da 0039, com o ramo novo
-- antes do ELSE e o ELSE restrito explicitamente aos dois tipos de retenção.
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

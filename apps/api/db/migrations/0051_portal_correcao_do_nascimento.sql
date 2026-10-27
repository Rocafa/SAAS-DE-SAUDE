-- 0051 — C1 da conferência do contrato ApiPortal (24/10/2026): a data de nascimento NÃO se edita pelo portal.
-- Ela muda só por pedido de CORREÇÃO do titular (ou do responsável legal), analisado pela clínica. Executar com
-- o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10h e
-- docs/03-seguranca-lgpd/revisoes/2026-10-24-front-vetos.md ("Conferência do contrato ApiPortal").
--
-- * `birth_date_proposed_enc`: a data que o pedido diz ser a certa, CIFRADA como a do cadastro (AAD com a
--   clínica, a tabela, a coluna e o id do pedido). Só em pedido `correcao`, gravada na abertura pelo portal e
--   imutável depois (o detalhe do pedido já era).
-- * `document_checked_by` / `document_checked_at`: quem da clínica conferiu o documento da data proposta, e
--   quando. Uma vez só, pelo usuário da sessão da clínica, no instante da transação; depois, imutável.
--
-- A data é cifrada: só a API sabe se a data proposta REDUZ a idade de paciente com 12 anos ou mais (o que pode
-- tirá-lo do sigilo do adolescente ou devolver a representação). Por isso a regra "atender essa correção exige
-- documento conferido" é da API (portal-clinica.service, `correcaoDeNascimentoExigeDocumento`); o banco
-- garante o que consegue ver: a data proposta só existe em correção, ninguém do portal marca a conferência, a
-- marca tem autor e hora reais e não se apaga nem se reescreve.

ALTER TABLE portal_rights_requests
  ADD COLUMN birth_date_proposed_enc text
    CONSTRAINT portal_rights_requests_birth_date_proposed_check
    CHECK (birth_date_proposed_enc IS NULL OR app_is_sealed_field(birth_date_proposed_enc)),
  ADD COLUMN document_checked_by uuid,
  ADD COLUMN document_checked_at timestamptz,
  ADD CONSTRAINT portal_rights_requests_birth_date_kind_check
    CHECK (birth_date_proposed_enc IS NULL OR kind = 'correcao'),
  ADD CONSTRAINT portal_rights_requests_document_checked_pair_check
    CHECK ((document_checked_by IS NULL) = (document_checked_at IS NULL)),
  ADD CONSTRAINT portal_rights_requests_document_checked_needs_date_check
    CHECK (document_checked_at IS NULL OR birth_date_proposed_enc IS NOT NULL);

-- Mesmo gatilho da 0033, com a data proposta imutável e a marca de conferência só pela clínica, uma vez.
CREATE OR REPLACE FUNCTION portal_rights_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_portal_patient() IS NULL OR NEW.patient_id IS DISTINCT FROM app_portal_patient()
       OR NEW.link_id IS DISTINCT FROM app_portal_link() OR NEW.account_id IS DISTINCT FROM app_portal_account() THEN
      RAISE EXCEPTION 'pedido do titular é aberto pela sessão do portal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.status <> 'aberta' OR NEW.handled_by IS NOT NULL OR NEW.answer_enc IS NOT NULL
       OR NEW.document_checked_by IS NOT NULL OR NEW.document_checked_at IS NOT NULL
       OR NEW.acting_as IS DISTINCT FROM
          (SELECT l.acting_as FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id AND l.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'pedido do titular nasce aberto, no vínculo ativo' USING ERRCODE = 'check_violation';
    END IF;
    -- Teto diário por vínculo (A3c do #68). Trava o vínculo para a contagem não correr.
    PERFORM pg_advisory_xact_lock(hashtextextended('portal_rights:' || NEW.link_id::text, 0));
    IF (SELECT count(*) FROM portal_rights_requests r
         WHERE r.tenant_id = NEW.tenant_id AND r.link_id = NEW.link_id AND r.created_at > now() - interval '1 day') >= 5 THEN
      RAISE EXCEPTION 'teto diário de pedidos do titular atingido' USING ERRCODE = 'program_limit_exceeded';
    END IF;
    -- V1: qual responsável agiu sai do vínculo (nunca de quem grava).
    NEW.guardian_id := (SELECT l.guardian_id FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id);
    NEW.due_at := NEW.created_at + interval '15 days';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.protocol IS DISTINCT FROM OLD.protocol
     OR NEW.detail_enc IS DISTINCT FROM OLD.detail_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.birth_date_proposed_enc IS DISTINCT FROM OLD.birth_date_proposed_enc THEN
    RAISE EXCEPTION 'pedido do titular: identidade e detalhe são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.handled_by IS DISTINCT FROM v_user OR NEW.handled_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'só o usuário da sessão da clínica atende o pedido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('atendida', 'recusada') THEN
    RAISE EXCEPTION 'pedido encerrado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT ((OLD.status = 'aberta' AND NEW.status IN ('em_andamento', 'atendida', 'recusada'))
          OR (OLD.status = 'em_andamento' AND NEW.status IN ('atendida', 'recusada'))) THEN
    RAISE EXCEPTION 'transição de pedido do titular inválida' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('atendida', 'recusada') AND NEW.answer_enc IS NULL THEN
    RAISE EXCEPTION 'pedido atendido ou recusado exige resposta ao titular' USING ERRCODE = 'check_violation';
  END IF;
  -- C1: conferência do documento da data proposta: uma vez, pelo usuário da sessão, agora; depois imutável.
  IF OLD.document_checked_at IS NOT NULL THEN
    IF NEW.document_checked_by IS DISTINCT FROM OLD.document_checked_by OR NEW.document_checked_at IS DISTINCT FROM OLD.document_checked_at THEN
      RAISE EXCEPTION 'conferência de documento do pedido é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.document_checked_at IS NOT NULL
        AND (NEW.document_checked_by IS DISTINCT FROM v_user OR NEW.document_checked_at IS DISTINCT FROM now()) THEN
    RAISE EXCEPTION 'conferência de documento: autor e hora são da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

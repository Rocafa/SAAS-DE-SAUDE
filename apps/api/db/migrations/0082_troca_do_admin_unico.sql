-- 0082 — Troca do admin único que perdeu senha e fator (B13). Desenho v2: docs/04-arquitetura/troca-do-admin-unico.md;
-- parecer do Guardião de 24/11/2026 (R1 a R5; P3, P4, P7 a P10). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- A pessoa NÃO volta para a conta antiga (nenhum token restaura os dois fatores): recebe uma conta NOVA, com outro
-- e-mail, ativada pelo token de uso único do provisionamento (`ativacao_do_fundador`, origem `troca`). Fases da tarefa
-- avulsa (papel `app_provisionamento`, ampliado aqui por P7): `pedir`, `emitir` (depois da janela) e `cancelar`. Na API
-- (`app_auth`): o consumo do token (conta nova), a conclusão SÓ na confirmação do TOTP da conta nova (R1), a suspensão
-- pelo login completo da conta antiga, a contestação ("não fui eu") e o alarme de login da conta substituída (R5).
--
-- 1. identidade.troca_do_admin: o pedido, só com ids, códigos e o HMAC do e-mail novo (zerado na emissão). O operador
--    do `pedir` fica SÓ aqui (R4), nunca na trilha da clínica.
-- 2. Trigger de transições (R3): só o grafo do desenho (mais `suspensa`/`liberada_sem_token` -> `contestada`, para o
--    "não fui eu" de quem já entrou). `emitida` e a volta a `aguardando` só pelo login do provisionamento; `ativada` e
--    `concluida` só pelo login da autenticação, e `concluida` só com o TOTP da conta nova confirmado (R1).
-- 3. Nascimento do `usuario_novo` (R3): a conta com o uuid reservado só nasce na transação que consumiu a ativação
--    `origem = 'troca'` dela (`consumirAtivacao`). Convite, aceite ou INSERT avulso com o uuid: 42501.
-- 4. ativacao_do_fundador ganha `origem`, `chamado` e `troca_id`; validade por origem (72 h provisionamento, 24 h troca).
-- 5. identidade.usuario: `inativa_por` ganha `substituida` (R5: definitiva, nunca reativada nem concedida) e
--    `suspensa_na_troca` (P2, só com `--suspender-conta-antiga`; volta a valer no cancelamento).
-- 6. clinic_members_guard: na sessão de sistema do provisionamento, a concessão do admin ao `usuario_novo` de troca
--    `aguardando` já liberada e a revogação do vínculo inerte de troca `cancelada` ou `vencida`. A revogação do vínculo
--    ANTIGO não tem ramo novo: quem revoga é a conta nova, admin com fator, na sessão dela.
-- 7. clinic_members_trilha_check: a concessão pelo sentinela aceita também a trilha da troca (`member_grant` com ator
--    sistema, `via = 'troca_do_admin'`, chamado e `member_id`).
-- 8. app_espelhar_vinculo: conta com troca concluída vira `substituida` (não `sem_vinculo`) no último vínculo; conta
--    substituída não recebe perfil.
-- 9. Funções SECURITY DEFINER estreitas, pela chave, EXECUTE só para `app_provisionamento`, e os grants (P7).
--
-- A lista exata dos privilégios fica cobrada por `test/guarda-papeis.rls.test.ts`.

-- ------------------------------------------------------------------ 1. a troca

CREATE TABLE identidade.troca_do_admin (
  id                     uuid PRIMARY KEY,
  clinica_id             uuid NOT NULL,
  usuario_antigo         uuid NOT NULL,
  usuario_novo           uuid NOT NULL CONSTRAINT troca_do_admin_usuario_novo_key UNIQUE,
  operador_pedido        uuid NOT NULL,
  email_hmac             text NOT NULL CONSTRAINT troca_do_admin_email_hmac_check CHECK (email_hmac ~ '^[0-9a-f]{32}$'),
  motivo                 text NOT NULL CONSTRAINT troca_do_admin_motivo_check
                           CHECK (motivo IN ('perdeu_senha_e_fator', 'titular_indisponivel', 'suspeita_de_invasao')),
  chamado                text NOT NULL CONSTRAINT troca_do_admin_chamado_check CHECK (chamado ~ '^SUP-[0-9]{1,7}$'),
  contrato               text NOT NULL CONSTRAINT troca_do_admin_contrato_check CHECK (contrato ~ '^CTR-[0-9]{1,7}$'),
  pedido_em              timestamptz NOT NULL DEFAULT now(),
  libera_em              timestamptz NOT NULL,
  estado                 text NOT NULL DEFAULT 'aguardando' CONSTRAINT troca_do_admin_estado_check
                           CHECK (estado IN ('aguardando', 'emitida', 'liberada_sem_token', 'ativada', 'concluida',
                                             'contestada', 'suspensa', 'cancelada', 'vencida')),
  encerrada_em           timestamptz,
  encerrada_por          text CONSTRAINT troca_do_admin_encerrada_por_check
                           CHECK (encerrada_por IN ('contrato', 'dpo', 'titular', 'login_da_conta_antiga', 'sistema')),
  reemissoes             integer NOT NULL DEFAULT 0 CONSTRAINT troca_do_admin_reemissoes_check CHECK (reemissoes BETWEEN 0 AND 1),
  -- P2 (padrão até decisão dos sócios): só com `--suspender-conta-antiga` e motivo `suspeita_de_invasao`.
  conta_antiga_suspensa  boolean NOT NULL DEFAULT false,
  CONSTRAINT troca_do_admin_contas_check CHECK (usuario_novo <> usuario_antigo),
  -- P1 (padrão até decisão dos sócios): 48 h corridas, no mínimo.
  CONSTRAINT troca_do_admin_janela_check CHECK (libera_em >= pedido_em + interval '48 hours'),
  CONSTRAINT troca_do_admin_suspensao_check CHECK (NOT conta_antiga_suspensa OR motivo = 'suspeita_de_invasao')
);
-- Uma troca não encerrada por clínica (a recuperação do B12 entra pela mesma trava consultiva e pelo teto).
CREATE UNIQUE INDEX troca_do_admin_pendente_idx ON identidade.troca_do_admin (clinica_id)
  WHERE estado NOT IN ('concluida', 'contestada', 'cancelada', 'vencida');
CREATE INDEX troca_do_admin_antigo_idx ON identidade.troca_do_admin (usuario_antigo, pedido_em);
CREATE INDEX troca_do_admin_clinica_idx ON identidade.troca_do_admin (clinica_id, pedido_em);
REVOKE ALL ON identidade.troca_do_admin FROM PUBLIC;

-- ------------------------------------------------------------------ 2. transições (R3)

CREATE FUNCTION identidade.troca_do_admin_transicao() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
DECLARE
  v_finais constant text[] := ARRAY['concluida', 'contestada', 'cancelada', 'vencida'];
  v_zeros constant text := repeat('0', 32);
  v_prov boolean := pg_has_role(session_user, 'app_provisionamento', 'MEMBER');
  v_auth boolean := pg_has_role(session_user, 'app_auth', 'MEMBER');
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- O pedido nasce `aguardando`, sem reemissão nem encerramento, com a hora do banco.
    IF NEW.estado <> 'aguardando' OR NEW.reemissoes <> 0 OR NEW.encerrada_por IS NOT NULL OR NEW.email_hmac = v_zeros THEN
      RAISE EXCEPTION 'troca do admin nasce aguardando' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.pedido_em := now();
    NEW.encerrada_em := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Só o expurgo de 13 meses (app_auth), e só a troca encerrada.
    IF OLD.estado = ANY (v_finais) AND OLD.pedido_em < now() - interval '13 months' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'troca do admin só sai pelo expurgo de 13 meses' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.clinica_id, NEW.usuario_antigo, NEW.usuario_novo, NEW.operador_pedido, NEW.motivo, NEW.chamado,
      NEW.contrato, NEW.pedido_em, NEW.libera_em, NEW.conta_antiga_suspensa)
     IS DISTINCT FROM
     (OLD.id, OLD.clinica_id, OLD.usuario_antigo, OLD.usuario_novo, OLD.operador_pedido, OLD.motivo, OLD.chamado,
      OLD.contrato, OLD.pedido_em, OLD.libera_em, OLD.conta_antiga_suspensa) THEN
    RAISE EXCEPTION 'troca do admin: só o estado muda' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.email_hmac IS DISTINCT FROM OLD.email_hmac AND NEW.email_hmac <> v_zeros THEN
    RAISE EXCEPTION 'troca do admin: o HMAC do e-mail só pode ser zerado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- O encerramento é do banco: a hora vem daqui.
  NEW.encerrada_em := OLD.encerrada_em;

  IF NEW.estado = OLD.estado THEN
    -- Única mudança sem troca de estado: a reemissão do token de FATOR de uma troca `ativada` (0 -> 1).
    IF NEW.reemissoes IS DISTINCT FROM OLD.reemissoes
       AND NOT (OLD.estado = 'ativada' AND OLD.reemissoes = 0 AND NEW.reemissoes = 1 AND v_prov) THEN
      RAISE EXCEPTION 'troca do admin: reemissão fora do caminho' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.encerrada_por IS DISTINCT FROM OLD.encerrada_por THEN
      RAISE EXCEPTION 'troca do admin: encerramento sem mudança de estado' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  v_ok := CASE OLD.estado
    WHEN 'aguardando' THEN NEW.estado IN ('emitida', 'contestada', 'suspensa', 'cancelada')
    WHEN 'suspensa' THEN NEW.estado IN ('aguardando', 'contestada', 'cancelada')
    WHEN 'emitida' THEN NEW.estado IN ('ativada', 'liberada_sem_token', 'contestada', 'suspensa', 'cancelada')
    WHEN 'liberada_sem_token' THEN NEW.estado IN ('emitida', 'vencida', 'contestada', 'cancelada')
    WHEN 'ativada' THEN NEW.estado IN ('concluida', 'contestada', 'suspensa', 'cancelada', 'vencida')
    ELSE false
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'troca do admin: transição % -> % recusada', OLD.estado, NEW.estado USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Reemissões: só a do token de ativação (liberada_sem_token -> emitida, 0 -> 1).
  IF NEW.reemissoes IS DISTINCT FROM OLD.reemissoes
     AND NOT (OLD.estado = 'liberada_sem_token' AND NEW.estado = 'emitida' AND OLD.reemissoes = 0 AND NEW.reemissoes = 1) THEN
    RAISE EXCEPTION 'troca do admin: reemissão fora do caminho' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.estado = 'liberada_sem_token' AND NEW.estado = 'emitida' AND NEW.reemissoes <> 1 THEN
    RAISE EXCEPTION 'troca do admin: a reemissão conta' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- `vencida` só depois da única reemissão (segunda falha).
  IF NEW.estado = 'vencida' AND OLD.reemissoes <> 1 THEN
    RAISE EXCEPTION 'troca do admin: vencida só depois da reemissão' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Quem faz cada passo.
  IF NEW.estado = 'emitida' AND (NOT v_prov OR OLD.libera_em > now()) THEN
    RAISE EXCEPTION 'troca do admin: emissão só pela tarefa, depois da janela' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.estado = 'suspensa' AND NEW.estado = 'aguardando' AND NOT v_prov THEN
    RAISE EXCEPTION 'troca do admin: retomada só pela tarefa, com a revisão do DPO' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.estado IN ('ativada', 'concluida') AND NOT v_auth THEN
    RAISE EXCEPTION 'troca do admin: ativação e conclusão só pela API' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- R1: concluir só com o TOTP da conta nova confirmado.
  IF NEW.estado = 'concluida' AND NOT EXISTS (
       SELECT 1 FROM identidade.usuario u
        WHERE u.id = NEW.usuario_novo AND u.ativo AND u.inativa_por IS NULL AND u.dois_fatores_ativo) THEN
    RAISE EXCEPTION 'troca do admin: conclusão sem o TOTP da conta nova' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.estado = ANY (v_finais) OR NEW.estado = 'suspensa' THEN
    IF NEW.encerrada_por IS NULL THEN
      RAISE EXCEPTION 'troca do admin: encerramento sem quem encerrou' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.encerrada_por IS DISTINCT FROM OLD.encerrada_por AND NEW.encerrada_por IS NOT NULL THEN
    RAISE EXCEPTION 'troca do admin: encerramento fora do encerramento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.estado = ANY (v_finais) THEN
    NEW.encerrada_em := now();
  END IF;
  -- O HMAC do e-mail novo sai na emissão e no encerramento (retenção, seção 12). A suspensão o mantém (pode voltar).
  IF NEW.estado = 'emitida' OR NEW.estado = ANY (v_finais) THEN
    NEW.email_hmac := v_zeros;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identidade.troca_do_admin_transicao() FROM PUBLIC;
CREATE TRIGGER troca_do_admin_transicao BEFORE INSERT OR UPDATE OR DELETE ON identidade.troca_do_admin
  FOR EACH ROW EXECUTE FUNCTION identidade.troca_do_admin_transicao();

-- ------------------------------------------------------------------ 4. ativação com origem

ALTER TABLE identidade.ativacao_do_fundador
  ADD COLUMN origem text NOT NULL DEFAULT 'provisionamento'
    CONSTRAINT ativacao_do_fundador_origem_check CHECK (origem IN ('provisionamento', 'troca')),
  ADD COLUMN chamado text CONSTRAINT ativacao_do_fundador_chamado_check CHECK (chamado ~ '^SUP-[0-9]{1,7}$'),
  ADD COLUMN troca_id uuid CONSTRAINT ativacao_do_fundador_troca_fkey REFERENCES identidade.troca_do_admin (id);

ALTER TABLE identidade.ativacao_do_fundador
  ADD CONSTRAINT ativacao_do_fundador_troca_check CHECK (
    (origem = 'troca') = (chamado IS NOT NULL)
    AND (origem = 'troca') = (troca_id IS NOT NULL)
    AND (origem = 'provisionamento' OR NOT conta_existente)
  );
ALTER TABLE identidade.ativacao_do_fundador DROP CONSTRAINT ativacao_do_fundador_validade_check;
ALTER TABLE identidade.ativacao_do_fundador
  ADD CONSTRAINT ativacao_do_fundador_validade_check CHECK (
    expira_em > criado_em
    AND expira_em <= criado_em + CASE WHEN origem = 'troca' THEN interval '24 hours' ELSE interval '72 hours' END
  );
CREATE INDEX ativacao_do_fundador_troca_idx ON identidade.ativacao_do_fundador (troca_id) WHERE troca_id IS NOT NULL;

-- ------------------------------------------------------------------ 3. nascimento do usuario_novo (R3)

CREATE FUNCTION identidade.usuario_novo_da_troca() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identidade.troca_do_admin t WHERE t.usuario_novo = NEW.id) THEN
    -- Só na transação que consumiu a ativação `troca` desta troca (usado_em = now(), o início da transação) e passou a
    -- troca a `ativada`: é o `consumirAtivacao`.
    IF NOT EXISTS (
         SELECT 1
           FROM identidade.troca_do_admin t
           JOIN identidade.ativacao_do_fundador a ON a.troca_id = t.id
          WHERE t.usuario_novo = NEW.id AND t.estado = 'ativada'
            AND a.origem = 'troca' AND a.usuario_id = NEW.id AND a.usado_em = now()) THEN
      RAISE EXCEPTION 'a conta nova da troca só nasce na ativação' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identidade.usuario_novo_da_troca() FROM PUBLIC;
CREATE TRIGGER usuario_novo_da_troca BEFORE INSERT ON identidade.usuario
  FOR EACH ROW EXECUTE FUNCTION identidade.usuario_novo_da_troca();

-- ------------------------------------------------------------------ 5. conta substituída e suspensa

ALTER TABLE identidade.usuario DROP CONSTRAINT usuario_inativa_por_check;
ALTER TABLE identidade.usuario ADD CONSTRAINT usuario_inativa_por_check
  CHECK (inativa_por IS NULL OR inativa_por IN ('sem_vinculo', 'anonimizada', 'convite_desfeito', 'expurgada', 'substituida', 'suspensa_na_troca'));

-- Base: 0072. Mudanças: conta substituída não recebe perfil (R5), e o último vínculo de uma conta com troca concluída
-- a deixa `substituida`, nunca `sem_vinculo` (que a próxima concessão reativaria).
CREATE OR REPLACE FUNCTION app_espelhar_vinculo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role NOT IN ('admin', 'profissional', 'recepcao', 'financeiro') THEN
    RETURN NULL;
  END IF;
  IF NEW.revoked_at IS NULL THEN
    -- Conta anonimizada, expurgada ou substituída não recebe vínculo (definitivas; quem volta recebe conta nova).
    IF EXISTS (SELECT 1 FROM identidade.usuario u WHERE u.id = NEW.user_id AND u.inativa_por IN ('anonimizada', 'expurgada', 'substituida')) THEN
      RAISE EXCEPTION 'conta encerrada não recebe perfil' USING ERRCODE = '42501';
    END IF;
    INSERT INTO identidade.vinculo (usuario_id, clinica_id, papel) VALUES (NEW.user_id, NEW.tenant_id, NEW.role)
      ON CONFLICT DO NOTHING;
    -- Recontratação: só a conta desligada por falta de vínculo volta a valer (a credencial continua sendo da pessoa).
    UPDATE identidade.usuario SET ativo = true, inativa_por = NULL WHERE id = NEW.user_id AND ativo = false AND inativa_por = 'sem_vinculo';
    -- F1 do #175: o UPDATE acima espera o expurgo que já travou a linha. Se ele marcou a conta nesse meio-tempo, este
    -- comando (foto nova, READ COMMITTED) vê a marca e recusa. Sem FOR UPDATE: a trava extra reabriria o deadlock
    -- entre conexões do 3b-1.
    IF EXISTS (SELECT 1 FROM identidade.usuario u WHERE u.id = NEW.user_id AND u.inativa_por IN ('anonimizada', 'expurgada', 'substituida')) THEN
      RAISE EXCEPTION 'conta encerrada não recebe perfil' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Só some do espelho se não houver OUTRA linha ativa do mesmo papel (revogado e concedido de novo).
    DELETE FROM identidade.vinculo v
     WHERE v.usuario_id = NEW.user_id AND v.clinica_id = NEW.tenant_id AND v.papel = NEW.role
       AND NOT EXISTS (SELECT 1 FROM public.clinic_members m
                        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.role = NEW.role
                          AND m.revoked_at IS NULL AND m.id <> NEW.id);
    -- Desligamento nesta clínica: sem nenhum perfil de sessão nela, as sessões com ela ativa caem (R10).
    IF NOT EXISTS (SELECT 1 FROM identidade.vinculo v WHERE v.usuario_id = NEW.user_id AND v.clinica_id = NEW.tenant_id) THEN
      DELETE FROM identidade.sessao s WHERE s.usuario_id = NEW.user_id AND s.clinica_ativa = NEW.tenant_id;
    END IF;
    -- Sem vínculo em nenhuma clínica: conta inativa e nenhuma sessão viva. Com troca concluída (R5): `substituida`.
    IF NOT EXISTS (SELECT 1 FROM identidade.vinculo v WHERE v.usuario_id = NEW.user_id) THEN
      UPDATE identidade.usuario
         SET ativo = false,
             inativa_por = CASE WHEN EXISTS (SELECT 1 FROM identidade.troca_do_admin t
                                              WHERE t.usuario_antigo = NEW.user_id AND t.estado = 'concluida')
                                THEN 'substituida' ELSE 'sem_vinculo' END
       WHERE id = NEW.user_id AND ativo = true;
      DELETE FROM identidade.sessao s WHERE s.usuario_id = NEW.user_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_espelhar_vinculo() FROM PUBLIC;

-- ------------------------------------------------------------------ 6. clinic_members_guard (base: 0080)

CREATE OR REPLACE FUNCTION clinic_members_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semRevogacao clinic_members;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'clinic_members não se apaga (revogue)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    -- Sessão de sistema: só o login membro de app_provisionamento (0080), e só os ramos abaixo. A trilha vai no COMMIT.
    IF app_is_system_session() AND pg_has_role(session_user, 'app_provisionamento', 'MEMBER') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || COALESCE(NEW.tenant_id, OLD.tenant_id)::text, 0));
      IF TG_OP = 'INSERT' THEN
        IF NEW.role = 'admin'
           AND NEW.granted_by = '00000000-0000-0000-0000-000000000000'::uuid
           AND NEW.revoked_by IS NULL AND NEW.revoked_at IS NULL THEN
          -- 0078/0080: fundação pelo provisionamento (admin do fundador registrado, clínica sem nenhuma linha).
          IF EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = NEW.user_id)
             AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id) THEN
            NEW.granted_at := now();
            RETURN NEW;
          END IF;
          -- 0082 (B13): admin da conta nova de troca `aguardando` já liberada; só admin (P8), uma vez.
          IF EXISTS (SELECT 1 FROM identidade.troca_do_admin t
                      WHERE t.clinica_id = NEW.tenant_id AND t.usuario_novo = NEW.user_id
                        AND t.estado = 'aguardando' AND t.libera_em <= now())
             AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id) THEN
            NEW.granted_at := now();
            RETURN NEW;
          END IF;
        END IF;
      ELSE
        -- 0082 (B13): revogação do vínculo inerte da conta nova de troca `cancelada` ou `vencida`, pelo sentinela.
        semRevogacao := NEW;
        semRevogacao.revoked_by := OLD.revoked_by;
        semRevogacao.revoked_at := OLD.revoked_at;
        IF semRevogacao IS NOT DISTINCT FROM OLD AND OLD.revoked_at IS NULL
           AND NEW.revoked_by = '00000000-0000-0000-0000-000000000000'::uuid AND NEW.revoked_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM identidade.troca_do_admin t
                        WHERE t.clinica_id = OLD.tenant_id AND t.usuario_novo = OLD.user_id
                          AND t.estado IN ('cancelada', 'vencida')) THEN
          NEW.revoked_at := now();
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'perfil da clínica exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || COALESCE(NEW.tenant_id, OLD.tenant_id)::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW.granted_by IS DISTINCT FROM v_user OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'perfil é concedido por quem está na sessão e nasce ativo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_user_has_role(v_user, 'admin') THEN
      -- Fundação (R15): só o FUNDADOR registrado em tenants, numa clínica sem nenhuma linha; ou a
      -- correção do fundador sob incidente (0042), em que o novo fundador se registra como admin.
      IF NOT (NEW.role = 'admin' AND NEW.user_id = v_user
              AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = v_user)
              AND (NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id)
                   OR app_runbook_corrigindo_fundador(NEW.tenant_id))) THEN
        RAISE EXCEPTION 'só um admin ativo da clínica concede perfil' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  semRevogacao := NEW;
  semRevogacao.revoked_by := OLD.revoked_by;
  semRevogacao.revoked_at := OLD.revoked_at;
  IF semRevogacao IS DISTINCT FROM OLD OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'perfil só se revoga, uma vez, por quem está na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT app_user_has_role(v_user, 'admin') AND NOT app_runbook_corrigindo_fundador(OLD.tenant_id) THEN
    RAISE EXCEPTION 'só um admin ativo da clínica revoga perfil' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.role = 'admin' AND NOT EXISTS (
       SELECT 1 FROM clinic_members m
        WHERE m.tenant_id = OLD.tenant_id AND m.role = 'admin' AND m.revoked_at IS NULL AND m.id <> OLD.id) THEN
    RAISE EXCEPTION 'a clínica não fica sem admin ativo' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------ 7. trilha da concessão pelo sentinela (base: 0078)

CREATE OR REPLACE FUNCTION clinic_members_trilha_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.granted_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    IF NOT app_trilha_do_provisionamento(NEW.tenant_id, 'clinic_members', 'member_found', NEW.id)
       -- 0082 (B13): ou a concessão da troca do admin, com ator sistema, o chamado e o member_id.
       AND NOT EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.tenant_id = NEW.tenant_id AND a.scope = 'clinic_members'
            AND a.actor_kind = 'sistema' AND a.actor_id = '00000000-0000-0000-0000-000000000000'::uuid
            AND a.metadata->>'op' = 'member_grant'
            AND a.metadata->>'via' = 'troca_do_admin'
            AND COALESCE(a.metadata->>'ticket', '') ~ '^SUP-[0-9]{1,7}$'
            AND a.metadata->>'member_id' = NEW.id::text) THEN
      RAISE EXCEPTION 'fundação pelo sistema sem a trilha do provisionamento' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM audit_log a
        WHERE a.tenant_id = NEW.tenant_id AND a.scope = 'clinic_members'
          AND a.metadata->>'member_id' = NEW.id::text
          AND a.metadata->>'op' = ANY (CASE WHEN TG_OP = 'INSERT' THEN ARRAY['member_found', 'member_grant']
                                            ELSE ARRAY['member_revoke'] END)) THEN
    RAISE EXCEPTION 'mudança de perfil sem o evento correspondente na trilha' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------------ 9. funções pela chave (EXECUTE só app_provisionamento)

-- Quantos dos ids são conta ativa com fator verificado (`ha_outro_admin`), sem ler mais nada da conta.
CREATE FUNCTION identidade.admins_com_fator(p_ids uuid[]) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
  SELECT count(*)::int FROM identidade.usuario u
   WHERE u.id = ANY (p_ids) AND u.ativo AND u.inativa_por IS NULL AND u.dois_fatores_ativo
$$;

-- A conta antiga existe, está ativa e não está marcada (`conta_inativa`).
CREATE FUNCTION identidade.conta_admin_apta(p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM identidade.usuario u WHERE u.id = p_id AND u.ativo AND u.inativa_por IS NULL)
$$;

-- Teto e pendências SOMANDO B12 (recuperação origem suporte) e B13 (troca): 1 por clínica em 30 dias, 2 por pessoa em
-- 12 meses; pendentes por clínica (token do suporte vivo ou troca não encerrada).
CREATE FUNCTION identidade.contagem_admin_unico(p_clinica uuid, p_usuario uuid)
  RETURNS TABLE (clinica_30d integer, pessoa_12m integer, pendentes integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
  SELECT
    ((SELECT count(*) FROM identidade.recuperacao r
       WHERE r.origem = 'suporte' AND r.clinica_id = p_clinica AND r.criado_em > now() - interval '30 days')
     + (SELECT count(*) FROM identidade.troca_do_admin t
         WHERE t.clinica_id = p_clinica AND t.pedido_em > now() - interval '30 days'))::int,
    ((SELECT count(*) FROM identidade.recuperacao r
       WHERE r.origem = 'suporte' AND r.usuario_id = p_usuario AND r.criado_em > now() - interval '12 months')
     + (SELECT count(*) FROM identidade.troca_do_admin t
         WHERE t.usuario_antigo = p_usuario AND t.pedido_em > now() - interval '12 months'))::int,
    ((SELECT count(*) FROM identidade.recuperacao r
       WHERE r.origem = 'suporte' AND r.clinica_id = p_clinica AND r.usado_em IS NULL AND r.expira_em > now())
     + (SELECT count(*) FROM identidade.troca_do_admin t
         WHERE t.clinica_id = p_clinica AND t.estado NOT IN ('concluida', 'contestada', 'cancelada', 'vencida')))::int
$$;

-- P2 (padrão até decisão dos sócios): só a troca `aguardando` com `suspeita_de_invasao` e `--suspender-conta-antiga`.
-- Derruba as sessões da conta antiga e a suspende (`suspensa_na_troca`) até a conclusão ou o cancelamento.
CREATE FUNCTION identidade.derrubar_sessoes_da_troca(p_troca uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
DECLARE
  v_antigo uuid;
  v_n integer;
BEGIN
  SELECT t.usuario_antigo INTO v_antigo FROM identidade.troca_do_admin t
   WHERE t.id = p_troca AND t.estado = 'aguardando' AND t.motivo = 'suspeita_de_invasao' AND t.conta_antiga_suspensa;
  IF v_antigo IS NULL THEN
    RAISE EXCEPTION 'troca sem suspensão da conta antiga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE identidade.usuario SET ativo = false, inativa_por = 'suspensa_na_troca'
   WHERE id = v_antigo AND ativo AND inativa_por IS NULL;
  DELETE FROM identidade.sessao s WHERE s.usuario_id = v_antigo;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Cancelamento de troca com a conta antiga suspensa: a conta volta a valer (só a suspensão desta troca).
CREATE FUNCTION identidade.reativar_conta_da_troca(p_troca uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
DECLARE
  v_antigo uuid;
BEGIN
  SELECT t.usuario_antigo INTO v_antigo FROM identidade.troca_do_admin t
   WHERE t.id = p_troca AND t.estado IN ('cancelada', 'contestada') AND t.conta_antiga_suspensa;
  IF v_antigo IS NULL THEN
    RETURN false;
  END IF;
  UPDATE identidade.usuario SET ativo = true, inativa_por = NULL
   WHERE id = v_antigo AND NOT ativo AND inativa_por = 'suspensa_na_troca';
  RETURN FOUND;
END;
$$;

-- Emissão (e a única reemissão) do token de ativação da troca: copia o HMAC do e-mail sem a tarefa poder lê-lo, fecha o
-- token anterior da troca, grava a linha `origem = 'troca'` (24 h, P9) e passa a troca a `emitida` (o trigger zera o
-- HMAC da troca). Só o SHA-256 do token chega aqui.
CREATE FUNCTION identidade.emitir_ativacao_da_troca(p_troca uuid, p_ativacao uuid, p_token_hash text) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
DECLARE
  t identidade.troca_do_admin;
  v_hmac text;
  v_expira timestamptz;
BEGIN
  SELECT * INTO t FROM identidade.troca_do_admin WHERE id = p_troca FOR UPDATE;
  IF NOT FOUND OR t.libera_em > now() THEN
    RAISE EXCEPTION 'troca não liberada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF t.estado = 'aguardando' THEN
    v_hmac := t.email_hmac;
  ELSIF t.estado = 'liberada_sem_token' AND t.reemissoes = 0 THEN
    SELECT a.email_hmac INTO v_hmac FROM identidade.ativacao_do_fundador a
     WHERE a.troca_id = p_troca ORDER BY a.criado_em DESC LIMIT 1;
  ELSE
    RAISE EXCEPTION 'troca fora da emissão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_hmac IS NULL OR v_hmac = repeat('0', 32) THEN
    RAISE EXCEPTION 'e-mail da troca descartado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE identidade.ativacao_do_fundador SET usado_em = now(), email_hmac = repeat('0', 32)
   WHERE troca_id = p_troca AND usado_em IS NULL;
  INSERT INTO identidade.ativacao_do_fundador
    (id, clinica_id, usuario_id, email_hmac, conta_existente, token_hash, contrato, expira_em, origem, chamado, troca_id)
  VALUES
    (p_ativacao, t.clinica_id, t.usuario_novo, v_hmac, false, p_token_hash, t.contrato, now() + interval '24 hours',
     'troca', t.chamado, t.id)
  RETURNING expira_em INTO v_expira;
  UPDATE identidade.troca_do_admin
     SET estado = 'emitida', reemissoes = CASE WHEN t.estado = 'liberada_sem_token' THEN 1 ELSE reemissoes END
   WHERE id = p_troca;
  RETURN v_expira;
END;
$$;

-- Reemissão para troca `ativada` (a conta nova existe e não confirmou o TOTP): token só de FATOR (tipo `fator` do #159,
-- origem `suporte`, o chamado da troca, 24 h). Exige a senha que a pessoa acabou de criar.
CREATE FUNCTION identidade.emitir_fator_da_troca(p_troca uuid, p_recuperacao uuid, p_token_hash text) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
DECLARE
  t identidade.troca_do_admin;
  v_expira timestamptz;
BEGIN
  SELECT * INTO t FROM identidade.troca_do_admin WHERE id = p_troca FOR UPDATE;
  IF NOT FOUND OR t.estado <> 'ativada' OR t.reemissoes <> 0
     OR NOT EXISTS (SELECT 1 FROM identidade.usuario u
                     WHERE u.id = t.usuario_novo AND u.ativo AND u.inativa_por IS NULL AND NOT u.dois_fatores_ativo) THEN
    RAISE EXCEPTION 'troca fora da reemissão do fator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE identidade.recuperacao SET usado_em = now() WHERE usuario_id = t.usuario_novo AND usado_em IS NULL;
  INSERT INTO identidade.recuperacao (id, usuario_id, tipo, token_hash, clinica_id, criado_por, origem, chamado, expira_em)
  VALUES (p_recuperacao, t.usuario_novo, 'fator', p_token_hash, t.clinica_id, '00000000-0000-0000-0000-000000000000'::uuid,
          'suporte', t.chamado, now() + interval '24 hours')
  RETURNING expira_em INTO v_expira;
  UPDATE identidade.troca_do_admin SET reemissoes = 1 WHERE id = p_troca;
  RETURN v_expira;
END;
$$;

-- Encerramento: invalida o token de ativação e o de fator ainda vivos da conta nova da troca encerrada.
CREATE FUNCTION identidade.encerrar_tokens_da_troca(p_troca uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
DECLARE
  v_novo uuid;
  v_a integer;
  v_r integer;
BEGIN
  SELECT t.usuario_novo INTO v_novo FROM identidade.troca_do_admin t
   WHERE t.id = p_troca AND t.estado IN ('cancelada', 'vencida', 'contestada', 'suspensa');
  IF v_novo IS NULL THEN
    RAISE EXCEPTION 'troca não encerrada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE identidade.ativacao_do_fundador SET usado_em = now(), email_hmac = repeat('0', 32)
   WHERE troca_id = p_troca AND usado_em IS NULL;
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE identidade.recuperacao SET usado_em = now() WHERE usuario_id = v_novo AND usado_em IS NULL;
  GET DIAGNOSTICS v_r = ROW_COUNT;
  RETURN v_a + v_r;
END;
$$;

REVOKE ALL ON FUNCTION
  identidade.admins_com_fator(uuid[]),
  identidade.conta_admin_apta(uuid),
  identidade.contagem_admin_unico(uuid, uuid),
  identidade.derrubar_sessoes_da_troca(uuid),
  identidade.reativar_conta_da_troca(uuid),
  identidade.emitir_ativacao_da_troca(uuid, uuid, text),
  identidade.emitir_fator_da_troca(uuid, uuid, text),
  identidade.encerrar_tokens_da_troca(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  identidade.admins_com_fator(uuid[]),
  identidade.conta_admin_apta(uuid),
  identidade.contagem_admin_unico(uuid, uuid),
  identidade.derrubar_sessoes_da_troca(uuid),
  identidade.reativar_conta_da_troca(uuid),
  identidade.emitir_ativacao_da_troca(uuid, uuid, text),
  identidade.emitir_fator_da_troca(uuid, uuid, text),
  identidade.encerrar_tokens_da_troca(uuid)
TO app_provisionamento;

-- ------------------------------------------------------------------ grants (P7: ampliar o app_provisionamento)

-- Tarefa: lê a troca sem o HMAC do e-mail; grava o pedido; muda só estado e quem encerrou (o trigger confere o grafo).
GRANT SELECT (id, clinica_id, usuario_antigo, usuario_novo, operador_pedido, motivo, chamado, contrato, pedido_em,
              libera_em, estado, encerrada_em, encerrada_por, reemissoes, conta_antiga_suspensa)
  ON identidade.troca_do_admin TO app_provisionamento;
GRANT INSERT ON identidade.troca_do_admin TO app_provisionamento;
GRANT UPDATE (estado, encerrada_por) ON identidade.troca_do_admin TO app_provisionamento;
-- Reemissão: a tarefa vê se o token da troca venceu sem uso (sem o hash nem o HMAC). A escrita é só pelas funções.
GRANT SELECT (troca_id, usado_em, expira_em) ON identidade.ativacao_do_fundador TO app_provisionamento;
-- Revogação do vínculo inerte pelo sentinela (o clinic_members_guard confere a troca encerrada).
GRANT UPDATE (revoked_by, revoked_at) ON clinic_members TO app_provisionamento;

-- API: contestação, suspensão no login, ativação e conclusão; expurgo de 13 meses (o trigger confere).
GRANT SELECT, DELETE ON identidade.troca_do_admin TO app_auth;
GRANT UPDATE (estado, encerrada_por) ON identidade.troca_do_admin TO app_auth;

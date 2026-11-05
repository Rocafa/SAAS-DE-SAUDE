-- 0008 — Tipo de ator na trilha de auditoria (Decisão 1 do Guardião, parecer do PR #57; ressalvas R6/R7).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/auditoria-encadeada.md §"Tipo de ator".
--
-- A trilha passa a sair no pacote de exportação (G2) com os campos da cadeia, para a clínica
-- verificar. Por isso o ator interno (equipe de suporte da plataforma) é gravado JÁ pseudonimizado:
-- reescrever actor_id na saída quebraria o hash e a verificação.
--
--   actor_kind = 'usuario_clinica'    -> actor_id é o id real do usuário da clínica;
--   actor_kind = 'suporte_plataforma' -> actor_id = UUID derivado de
--                                        HMAC-SHA256(segredo do servidor, tenant_id || id do atendente)
--                                        (src/modules/audit/ator-suporte.ts) e o metadata leva o número
--                                        do chamado (ticket = 'SUP-<até 7 dígitos>') e o motivo (reason);
--   actor_kind = 'sistema'            -> actor_id = 00000000-0000-0000-0000-000000000000.
--
-- SEM REESCREVER O PASSADO E SEM QUEBRAR A CADEIA:
-- * a coluna nasce NULA e sem DEFAULT: as linhas antigas não mudam (um DEFAULT faria o Postgres
--   devolvê-lo também nas linhas antigas, mudando o conteúdo delas);
-- * o JSON canônico ganha a versão 2 (com actor_kind) SÓ para linhas com actor_kind preenchido;
--   linha com actor_kind NULO continua com o JSON v1 byte a byte, então o hash antigo confere;
-- * a primeira linha nova encadeia no hash da última antiga, como sempre (prev_hash);
-- * leitura das linhas antigas: actor_id zero = sistema; qualquer outro = usuario_clinica (até
--   aqui não existia acesso de suporte).
-- Toda linha NOVA tem actor_kind: a trigger da cadeia deduz 'sistema'/'usuario_clinica' quando o
-- INSERT não traz (SQL direto) e o CHECK NOT VALID recusa NULO dali em diante.

ALTER TABLE audit_log ADD COLUMN actor_kind text;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_check CHECK (
    actor_kind IN ('usuario_clinica', 'suporte_plataforma', 'sistema')
  );

-- Coerência do ator (NULO passa: linhas antigas).
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_shape_check CHECK (
    (actor_kind = 'sistema') = (actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    AND (actor_kind <> 'suporte_plataforma' OR (
          metadata ? 'ticket'
          AND (metadata ->> 'ticket') ~ '^SUP-[0-9]{1,7}$'
          AND (metadata ->> 'reason') IN ('pedido_da_clinica', 'break_glass')))
  );

-- Toda linha nova com tipo de ator. NOT VALID: as antigas (NULAS) ficam como estão.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_required_check CHECK (actor_kind IS NOT NULL) NOT VALID;

-- JSON canônico: v1 (exatamente o da 0005) para linhas sem actor_kind; v2 para as novas.
CREATE OR REPLACE FUNCTION audit_log_canonical(r audit_log) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN r.actor_kind IS NULL THEN
    jsonb_build_object(
      'v', 1,
      'tenant_id', r.tenant_id,
      'seq', r.seq,
      'prev_hash', r.prev_hash,
      'id', r.id,
      'actor_id', r.actor_id,
      'action', r.action,
      'scope', r.scope,
      'metadata', r.metadata,
      'created_at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  ELSE
    jsonb_build_object(
      'v', 2,
      'tenant_id', r.tenant_id,
      'seq', r.seq,
      'prev_hash', r.prev_hash,
      'id', r.id,
      'actor_id', r.actor_id,
      'actor_kind', r.actor_kind,
      'action', r.action,
      'scope', r.scope,
      'metadata', r.metadata,
      'created_at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  END::text
$$;

-- Mesma trigger da 0005, com um passo a mais no início: deduzir actor_kind quando não vier.
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_seq  bigint;
  v_hash text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit_log exige transação READ COMMITTED (a cadeia de hash lê o último elo)'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.tenant_id::text, 0));

  SELECT a.seq, a.hash INTO v_seq, v_hash
    FROM public.audit_log a
   WHERE a.tenant_id = NEW.tenant_id AND a.seq IS NOT NULL
   ORDER BY a.seq DESC
   LIMIT 1;

  IF NEW.seq IS NOT NULL OR NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL THEN
    IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'MEMBER') THEN
      RAISE EXCEPTION 'seq/prev_hash/hash de audit_log são definidos pelo banco'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.seq IS DISTINCT FROM COALESCE(v_seq, 0) + 1
       OR NEW.prev_hash IS DISTINCT FROM COALESCE(v_hash, repeat('0', 64))
       OR NEW.hash IS DISTINCT FROM encode(sha256(convert_to(audit_log_canonical(NEW), 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'linha de audit_log não continua a cadeia da clínica'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Antes do hash: o tipo de ator faz parte do JSON canônico v2. 'suporte_plataforma' nunca é
  -- deduzido (exige pseudônimo e chamado, ver CHECK audit_log_actor_shape_check). Linha com elos
  -- prontos (carga, acima) não é tocada: o conteúdo dela é o que o hash cobre.
  IF NEW.actor_kind IS NULL THEN
    NEW.actor_kind := CASE WHEN NEW.actor_id = '00000000-0000-0000-0000-000000000000'::uuid
                           THEN 'sistema' ELSE 'usuario_clinica' END;
  END IF;

  NEW.created_at := now();
  NEW.seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := COALESCE(v_hash, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(audit_log_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

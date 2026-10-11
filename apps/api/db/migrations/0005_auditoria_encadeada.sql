-- 0005 — Auditoria encadeada por clínica (S6). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/auditoria-encadeada.md.
--
-- Cada linha nova de audit_log recebe, DENTRO do banco e na mesma transação do INSERT:
--   seq       = posição na cadeia da clínica (1, 2, 3, ...);
--   prev_hash = hash da linha anterior da clínica (64 zeros na primeira);
--   hash      = SHA-256 do JSON canônico da linha (inclui seq e prev_hash).
-- Alterar, apagar ou reordenar uma linha quebra o hash dela ou o elo da seguinte; o verificador
-- (src/modules/audit/audit-chain.ts) recalcula tudo e aponta onde.
--
-- Por que no banco e não na aplicação: todo INSERT entra na cadeia, inclusive SQL direto, e a
-- trava por clínica e a leitura do último elo acontecem no mesmo lugar que a gravação (sem corrida).
--
-- Linhas anteriores a esta migração ficam fora da cadeia (seq NULL): o append-only impede
-- reescrevê-las e o verificador as conta à parte.

ALTER TABLE audit_log
  ADD COLUMN seq       bigint,
  ADD COLUMN prev_hash text,
  ADD COLUMN hash      text,
  ADD CONSTRAINT audit_log_chain_shape_check CHECK (
    (seq IS NULL) = (hash IS NULL) AND (seq IS NULL) = (prev_hash IS NULL)
    AND (seq IS NULL OR seq >= 1)
    AND (hash IS NULL OR hash ~ '^[0-9a-f]{64}$')
    AND (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$')
  );
CREATE UNIQUE INDEX audit_log_tenant_seq_idx ON audit_log (tenant_id, seq) WHERE seq IS NOT NULL;

-- JSON canônico: jsonb normaliza (chaves ordenadas, sem duplicatas, espaçamento fixo) e o texto
-- de saída é determinístico. Data sempre em UTC com microssegundos, independente do fuso da sessão.
CREATE FUNCTION audit_log_canonical(r audit_log) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
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
  )::text
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_seq  bigint;
  v_hash text;
BEGIN
  -- Uma cadeia por clínica: trava até o fim da transação. Duas transações da mesma clínica nunca
  -- leem o mesmo "último elo"; clínicas diferentes não se bloqueiam.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.tenant_id::text, 0));

  SELECT a.seq, a.hash INTO v_seq, v_hash
    FROM public.audit_log a
   WHERE a.tenant_id = NEW.tenant_id AND a.seq IS NOT NULL
   ORDER BY a.seq DESC
   LIMIT 1;

  IF NEW.seq IS NOT NULL OR NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL THEN
    -- Só o dono da tabela ou superusuário (carga de dados já encadeados) traz os elos prontos, e
    -- mesmo assim eles precisam continuar a cadeia e bater com o próprio conteúdo.
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

  NEW.seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := COALESCE(v_hash, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(audit_log_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

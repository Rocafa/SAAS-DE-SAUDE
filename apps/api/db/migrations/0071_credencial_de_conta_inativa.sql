-- 0071 — Prazo da credencial de conta inativa (D4; ressalva 4 do parecer do 3c parcial; RIPD-identidade §3).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- * `inativa_desde`: quando a conta ficou inativa. O job `identidade-expurgo` apaga a SENHA e o TOTP da conta
--   desligada (`inativa_por = 'sem_vinculo'`) há mais de 90 dias; a conta e o id ficam (R18). A recontratação pelo
--   convite define uma senha nova (a conta sem credencial é tratada como nova no aceite).

ALTER TABLE identidade.usuario ADD COLUMN inativa_desde timestamptz;
ALTER TABLE identidade.usuario ADD CONSTRAINT usuario_inativa_desde_check CHECK ((ativo = false) OR (inativa_desde IS NULL));
-- Contas já inativas: começam a contar agora (nada é apagado retroativamente sem aviso).
UPDATE identidade.usuario SET inativa_desde = now() WHERE ativo = false AND inativa_desde IS NULL;

CREATE OR REPLACE FUNCTION identidade.marcar_inativa_desde() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ativo = false AND OLD.ativo = true THEN NEW.inativa_desde := now(); END IF;
  IF NEW.ativo = true THEN NEW.inativa_desde := NULL; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identidade.marcar_inativa_desde() FROM PUBLIC;
CREATE TRIGGER usuario_marcar_inativa_desde BEFORE UPDATE OF ativo ON identidade.usuario
  FOR EACH ROW EXECUTE FUNCTION identidade.marcar_inativa_desde();

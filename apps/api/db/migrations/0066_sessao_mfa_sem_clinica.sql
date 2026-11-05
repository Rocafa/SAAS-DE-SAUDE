-- 0066 — MFA feito antes de escolher a clínica (D4, PR 3a; R7 do parecer do código do #152, R4 do parecer do desenho
-- do PR 3). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Quem tem várias clínicas passa pelo TOTP sem clínica ativa. O código aceito grava `mfa_sem_clinica_em`; a PRIMEIRA
-- escolha de clínica em até 5 min converte esse valor em `mfa_em` (com a impressão dos perfis da clínica escolhida) e
-- o zera. O provedor NUNCA lê esta coluna como MFA: ela só vale dentro da escolha de clínica.

ALTER TABLE identidade.sessao ADD COLUMN mfa_sem_clinica_em timestamptz;

-- R7 do desenho do PR 3: o expurgo diário apaga o cadastro de TOTP não concluído há mais de 24 h; precisa da data.
ALTER TABLE identidade.dois_fatores ADD COLUMN criado_em timestamptz NOT NULL DEFAULT now();

-- R6 do parecer do código do 3a: o cadastro refeito (segredo novo) renova `criado_em`.
CREATE FUNCTION identidade.dois_fatores_renova_criacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.segredo IS DISTINCT FROM OLD.segredo THEN NEW.criado_em := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dois_fatores_renova_criacao BEFORE UPDATE ON identidade.dois_fatores
  FOR EACH ROW EXECUTE FUNCTION identidade.dois_fatores_renova_criacao();
REVOKE ALL ON FUNCTION identidade.dois_fatores_renova_criacao() FROM PUBLIC;

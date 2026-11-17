-- 0074 — Conselho e número de registro do profissional (Res. COFFITO 414/2012 e 415/2012, art. 1º §1º VIII: a
-- identificação de quem registra traz o nome completo e o número no CREFITO; conferidas em
-- https://www.coffito.gov.br/nsite/?p=3177 e ?p=3178 em 13/11/2026). Também é o que o documento emitido precisa
-- para ter valor. Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Numeração: 0065–0073 estão na pilha do login (Better Auth). Esta migração é independente delas.

ALTER TABLE professionals
  ADD COLUMN council text CONSTRAINT professionals_council_check CHECK (council IN ('CREFITO', 'CRP', 'CRFa', 'CRN', 'CRO', 'CRM', 'COREN')),
  -- Só o número como o conselho escreve (ex.: "3/123456-F"): letras, dígitos, barra, hífen e ponto, com ao menos um
  -- dígito (R2 do parecer: "FulanoDeTal" não passa). Nada de nome.
  ADD COLUMN council_registration text CONSTRAINT professionals_council_registration_check
    CHECK (council_registration ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,29}$' AND council_registration ~ '[0-9]');

-- Os dois juntos ou nenhum.
ALTER TABLE professionals ADD CONSTRAINT professionals_council_pair_check CHECK ((council IS NULL) = (council_registration IS NULL));

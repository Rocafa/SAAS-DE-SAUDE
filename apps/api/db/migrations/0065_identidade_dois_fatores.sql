-- 0065 — Segundo fator (TOTP) da autenticação real (D4: Better Auth, PR 2). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Desenho: docs/04-arquitetura/autenticacao-better-auth.md §6; parecer: docs/03-seguranca-lgpd/revisoes/2026-11-05-desenho-better-auth.md.
--
-- * `identidade.dois_fatores`: o segredo do TOTP e os códigos de reserva, CIFRADOS pela biblioteca (AES com o
--   BETTER_AUTH_SECRET) antes de chegar ao banco. Uma linha por pessoa. Só o papel `app_auth` acessa (R1).
-- * Os códigos de reserva existem na tabela porque a biblioteca sempre os gera, mas os endpoints que os usam ficam
--   FECHADOS na montagem: a recuperação do fator é pelo administrador, com justificativa (R17, PR 3).
-- * `falhas` e `bloqueado_ate`: o bloqueio da própria biblioteca no login em duas etapas (5 falhas, 15 min). O
--   bloqueio da reverificação com sessão aberta e o do login com senha são NOSSOS, no store do rate limit (Redis).
-- * `usuario.dois_fatores_ativo`: a pessoa concluiu o cadastro do TOTP (o login passa a pedir o código).

ALTER TABLE identidade.usuario ADD COLUMN dois_fatores_ativo boolean NOT NULL DEFAULT false;

CREATE TABLE identidade.dois_fatores (
  id              uuid PRIMARY KEY,
  usuario_id      uuid NOT NULL REFERENCES identidade.usuario (id) ON DELETE CASCADE,
  -- Cifrado pela biblioteca; nunca em claro. Tamanho limitado para barrar gravação anômala.
  segredo         text NOT NULL CONSTRAINT dois_fatores_segredo_check CHECK (length(segredo) BETWEEN 16 AND 1024),
  codigos_reserva text NOT NULL CONSTRAINT dois_fatores_codigos_check CHECK (length(codigos_reserva) BETWEEN 16 AND 8192),
  -- false até a primeira verificação do código: cadastro iniciado e não concluído não vale para o login.
  verificado      boolean NOT NULL DEFAULT false,
  falhas          integer NOT NULL DEFAULT 0 CONSTRAINT dois_fatores_falhas_check CHECK (falhas >= 0),
  bloqueado_ate   timestamptz
);
CREATE UNIQUE INDEX dois_fatores_usuario_idx ON identidade.dois_fatores (usuario_id);
-- A biblioteca declara índice no segredo (busca por segredo não existe no nosso uso; não criamos).

REVOKE ALL ON identidade.dois_fatores FROM PUBLIC;
-- DELETE: a biblioteca troca o cadastro não concluído; a remoção pelo usuário fica fechada na montagem (R17, PR 3).
GRANT SELECT, INSERT, UPDATE, DELETE ON identidade.dois_fatores TO app_auth;

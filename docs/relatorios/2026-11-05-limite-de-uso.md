# Relatório de parada por limite de uso (05/11/2026)

## Estado
- **Na `main`, com parecer do Guardião e CI verde:** #129 a #136.
  - logs de segurança e trava contra dado pessoal em log;
  - revisão interna por público e quadro de prontidão;
  - perfil revogado corta a sessão;
  - MFA nas rotas de poder;
  - CSRF;
  - aviso de área sensível;
  - vínculo cruzado;
  - consulta da trilha;
  - robustez de logs e sessão.
- **Aberto, sem parecer e sem CI conferido:** #137 (alerta de anomalia vira aviso aos admins, migração 0063). Próximos passos:
  1. Parecer do Guardião (atenção à `shape_check` recriada, ao trigger `clinical_notices_guard` e à lista de regras no CHECK).
  2. `espera-ci.sh 137`.
  3. Merge, **conferindo `MERGED` antes** de atualizar a rodada 31 e o quadro de prontidão (E10 → feito).
- Nada fica sem commit.

## O que falta, por dono
- **Nós (sem bloqueio):** a fila em `docs/00-governanca/fila.md`:
  - `origem` no portal;
  - testes de emissão do webhook, das vigilâncias e da exportação;
  - resíduos da trava de logs;
  - checagem de perfil em operações longas;
  - RIPD e pergunta 1.11;
  - `CREATE INDEX CONCURRENTLY` em produção.
- **@Lopesloro:** D4 no #36; merges #118 → #103 → #92 → #86, depois #91 e #104; front (E4, #93 a #102).
- **Sócios:** OK para a proteção da main (aprovação, CODEOWNERS, `enforce_admins`, E2E e Trivy obrigatórios); AWS; provedores de SMS e de e-mail; responsável técnico.
- **Advogado:** D8, D7 e D13. **12/11:** #116.

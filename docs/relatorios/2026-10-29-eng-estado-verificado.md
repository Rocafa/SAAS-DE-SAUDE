# Engenharia: estado verificado dos itens de produção (29/10/2026)

Conferência item por item do checklist da [rodada 7](2026-10-10-rodada-7-necessidades-producao.md) §2.2 e §2.3,
feita contra a `main` em `ac003a8`, com a prova de cada linha. Motivo: o checklist é de 10/10 e é o
documento que diz o que falta para o piloto, mas várias linhas marcadas como ❌ já estão na `main` —
planejar por ele hoje significa trabalhar duas vezes ou deixar de ver o que falta de verdade.

Nada neste relatório muda código. Só diz o que está no disco.

> **Reconferido em 05/11/2026** contra a `main` em `1450470` (rodadas 29, 30 e 31 entraram no meio).
> Mudaram três linhas: **S6** fechou pelo #117 (declaração por rota, não interceptor), **S3** passou a
> ter a cobrança de MFA sem o fator, e **S2** passou a falhar fechado fora de development/test. O
> resto da tabela continua valendo.

## 1. Identidade, acesso e segurança da aplicação (§2.2)

| # | Item | Rodada 7 | Verificado hoje | Prova |
|---|---|---|---|---|
| S1 | Decisão D4 (login próprio × Zitadel/Better Auth) | ❌ | **❌ continua** — é decisão dos sócios, não trabalho de código. Medido no PR #36 | PR #36, memo `D04-autenticacao.md` |
| S2 | Login + sessão (cookie, token curto, refresh rotativo) | ❌ | **🛠️ parcial, e agora falha fechado** — guarda de sessão, provedor **fictício só em development/test** e, fora desses ambientes, `createAuthProvider` **lança e a API não sobe** ("melhor fora do ar do que aberta"). Há teste de contrato para todo provedor novo (`contrato-provedor.test.ts`, #123). Falta o provedor real, que depende da S1 | `apps/api/src/modules/auth/auth-provider.factory.ts`, `sessao.guard.ts`, `dev-session.provider.ts` |
| S3 | MFA obrigatório para profissional e admin | ❌ | **🛠️ a cobrança existe, o fator não** (reconferido em 05/11, depois das rodadas 29–31) — `mfaEm` na sessão, decorador `ExigeMfaRecente` nas rotas de poder, regra por compartimento do prontuário (psicologia exige MFA recente) e recusa registrada no log de segurança. Falta o **fator** (inscrição e verificação de TOTP/WebAuthn), que vem com o provedor real da D4 | `apps/api/src/modules/auth/mfa.ts`, `auth-context.ts:17`, `modules/records/prontuario-regras.ts:39`, `security/log-de-seguranca.ts:48` |
| S4 | RBAC por papel + nota psicológica em compartimento próprio | ❌ | **🛠️ bem mais que isso** — quatro perfis, tabela de permissões por rota, vínculo de cuidado e membros implementados | `apps/api/src/modules/auth/perfis.ts:11` (`PERFIS`), `:18` (`PERMISSOES`), `vinculo-de-cuidado.ts`, `membros.ts` |
| S5 | Criptografia de campo (envelope, DEK por clínica) | ❌ | **✅ na `main`** (PR #35) | `apps/api/src/modules/crypto/field-cipher.ts`, migração 0004 |
| S6 | Auditoria com encadeamento de hash | 🛠️ | **✅ fechado por outro caminho** (reconferido em 05/11) — a cadeia já existia; a cobertura entrou pelo #117 como **declaração obrigatória por rota com prova do compilador**, e não como interceptor global: a trilha é gravada dentro da transação de quem age, então um interceptor do Nest chegaria depois do commit. Issue #105 fechada. Pendentes de lá: R5 (rotas GET) e R6 (condição da D4) | `apps/api/src/modules/audit/audit-chain.ts:7`; #117 (merge `298e537`); discussão em #105 |
| S7 | Rate limit em Redis (era em memória, por instância) | ❌ | **✅ feito** — store compartilhado com fallback declarado em quatro modos | `apps/api/src/security/rate-limit-store.ts:19` (`RateLimitMode`), `:25`, `boot-producao.test.ts` |
| S8 | Pentest externo | ❌ | **❌ continua** — serviço de fora, depende de orçamento | — |
| S9 | Acesso de suporte só por chamado + break-glass auditado | ❌ | **🛠️ parcial** — ator de suporte com pseudônimo e os dois motivos (`pedido_da_clinica`, `break_glass`) implementados e testados; falta o fluxo de chamado | `apps/api/src/modules/audit/ator-suporte.ts:31`, `ator-suporte.test.ts` |
| S11 | E2E do login à evolução no prontuário | ❌ | **❌ no caminho certo** — o E2E do front roda no CI (Playwright, dois tamanhos de tela), mas a ponta do login depende da S1 | `apps/web/e2e/`, check "Playwright (apps/web)" |

## 2. Infraestrutura e operação (§2.3)

| # | Item | Rodada 7 | Verificado hoje | Prova |
|---|---|---|---|---|
| I2 | Terraform em `infra/` | ❌ ("a criar" desde a rodada 1) | **🛠️ existe** — `bootstrap-state`, `staging` e `modules`, com `fmt/validate/tflint/checkov` no CI (pulado nos PRs que não tocam infra) | `infra/terraform/`, check "fmt, validate, tflint e checkov" |
| I3 | Build da API e imagem Docker única, sem root | ❌ ("sem isso não há deploy") | **🛠️ existe** — build por `tsc` no shared e na API, imagem em dois estágios, base distroless `nonroot` e `USER 1000:1000` | `apps/api/Dockerfile:15`, `:50`, `:67`; `packages/shared/package.json` (`build`) |
| I8 | Erro 25006 (banco somente leitura) virar 503 | ❌ | **✅ feito, com teste** | `apps/api/src/lifecycle/all-exceptions.filter.test.ts:35`; `apps/api/src/db/db-errors.ts:47` (`TRANSIENT_SQLSTATES`) |
| I14 | No RDS: `REVOKE TEMPORARY`, `rds.force_ssl`, papéis `app_user`/`app_migrator` | ❌ | **✅ os três, no código do staging** — `REVOKE TEMPORARY` de `PUBLIC` e dos dois papéis, os papéis criados no bootstrap, e `rds.force_ssl = 1` no grupo de parâmetros. Falta só aplicar, porque a conta de produção não existe | `infra/rds/bootstrap.sql:62`, `:63`, `:36`; `infra/terraform/staging/dados.tf:51` |

## 3. O que isto muda no planejamento

Vários itens marcados como bloqueio de piloto já estão prontos (S7, I8, I14 no código) ou muito mais
adiantados do que o checklist diz (S4, I2, I3, S9). Em troca, a lista esconde três buracos reais, que
viraram issue hoje:

1. ~~**Interceptor geral de auditoria** (S6)~~ — **resolvido** pelo #117 em 03/11, com o desenho
   discutido na #105: declaração obrigatória por rota, com prova do compilador, em vez de interceptor.
2. **O fator de MFA** (S3): a cobrança de "MFA recente" já existe nas rotas de poder e no prontuário
   de psicologia; o que não existe é inscrição e verificação de TOTP/WebAuthn — vem com a D4: não começou, e é pré-requisito da garantia de exportação (G2).
3. **Provedor de sessão real** (S2): o que existe é fictício e só liga em development/test — o
   desenho está certo, a implementação depende da D4.

O que **não** é trabalho de engenharia e continua parado nos sócios: S1 (D4), S8 (pentest) e tudo da
§2.1 (jurídico), que depende do advogado (J1).

## 4. Dívida de documentação da §7 (rodada 7)

| Documento | Dono | Estado |
|---|---|---|
| [integracoes.md](../04-arquitetura/integracoes.md) | Engenharia | **Paga neste PR.** Entraram cobrança do WhatsApp por mensagem entregue e em BRL (com a consequência de guardar categoria e custo no `message_log`), Pix Automático e a D5 partida em duas, NFS-e no padrão nacional com o grupo IBSCBS e as três capitais com sistema próprio, seção nova do **Receita Saúde** (arquivo de lote do manual v2.1, sem API), **SNCR** dentro da prescrição com a decisão de não fazer controlados nativos, e TISS **04.03.00** com rotina mensal de versão |
| [03-seguranca-lgpd/README.md](../03-seguranca-lgpd/README.md) | Guardião | Em aberto |
| [05-ia-llm](../05-ia-llm/) | IA | Em aberto |
| [backlog-mvp.md](../02-produto/backlog-mvp.md) | Produto | Em aberto, mas a pergunta já está respondida — ver abaixo |

### A pergunta que a rodada 7 deixou para a rodada 8

> "Não conferi se o importador está como P0 no backlog: verificar na rodada 8."

Conferido: **está**, como `Must`. `HU-MIG-001` (importar pacientes por planilha, 5 pts), `HU-MIG-002`
(importar agenda futura, 3) e `HU-MIG-003` (importador do concorrente A, 8) são `Must`;
`HU-MIG-004` (concorrente B) é `Could` e `HU-MIG-005` (anexos em massa) é `Should`
(`docs/02-produto/backlog-mvp.md:1795`–`1799`).

O outro pedaço daquela linha **continua aberto**: o **arquivo de lote do Receita Saúde** não está no
backlog. O que existe é `HU-FIN-003` — "Recibo para reembolso e IR (Receita Saúde)", 3 pts, `Must`
(`:1747`) — que é o recibo, não o lote. São duas histórias diferentes: uma imprime o comprovante do
paciente, a outra gera o arquivo que o profissional PF sobe no portal da Receita. Decisão de Produto.

## 5. Como conferir

```bash
# a prova de cada linha, do jeito mais curto
rg -n "TRANSIENT_SQLSTATES" apps/api/src/db/db-errors.ts
rg -n "RateLimitMode|instancia-unica" apps/api/src/security/rate-limit-store.ts
rg -n "PERMISSOES" apps/api/src/modules/auth/perfis.ts
rg -n "REVOKE TEMPORARY" infra/rds/bootstrap.sql
rg -n "force_ssl" infra/terraform/staging/dados.tf
rg -ln "Interceptor" apps/api/src   # só um comentário na tenancy: não existe interceptor de auditoria
rg -rli "totp|webauthn" apps/api/src # nenhuma: é o buraco do S3
```

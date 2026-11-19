# Triagem de Issues e PRs — 2026-11-19

Gerado em: 2026-11-19
Base: `origin/main` (commit 492835e) + branches locais de refactor

---

## Issues ABERTAS (gh issue list)

| # | Título | Labels | Status na main | Ação |
|---|--------|--------|----------------|------|
| 180 | [front] Evolução na API real: falta rota de leitura por agendamento e a versão no contrato do front | bug, front | **PARCIAL (main)** — item 1 via PR #192 (commit 834053e mergeado em c3221c6); item 2 (versão no contrato) pendente | Verificar item 2 |
| 167 | [prontuario] Conteúdo clínico que falta no modelo: COFFITO 414, campos de TO e escalas com faixa | enhancement, front | **PARCIAL (main)** — commits 4b6a0c0, 0543150, cbcb474 mergeados via PR #193 (c34c602) | Manter aberta (escalas pendentes) |
| 148 | [seguranca] P5: as quatro ressalvas do #103 que precisam fechar antes do primeiro dado real | bug, front, seguranca | **Não verificado** — PR #191 (CodeQL), #192 (atendimento/agendamento), #193 (modelos) não cobrem as 4 ressalvas do #103 | Verificar cada ressalva do #103 |
| 147 | [seguranca] P4/P6: alcance das varreduras (subpasta, portal, lib) e no-console no ESLint | bug, seguranca | **Não verificado** | Verificar alcance CodeQL e regra no-console |
| 146 | [front] P2: tela de demonstração pede senha real com autoComplete=current-password | bug, front | **EM ANDAMENTO (PR #198 OPEN)** — branch `lopes/front-acesso-sem-codigo-fixo` aberta | Aguardar merge do PR #198 |
| 145 | [seguranca] P1: código fixo 123456 não depende do modo — e a D4 tem de SUBSTITUIR as telas simuladas | bug, front, seguranca | **EM ANDAMENTO (PR #198 OPEN)** — mesmo PR que #146 | Aguardar merge do PR #198 |
| 107 | [seguranca] S2: provedor de sessão real (bloqueio técnico nº 1, depende da D4) | enhancement, seguranca | Em andamento — PRs #203-#208 (provisionamento) | Manter aberta |
| 106 | [seguranca] S3: falta o fator de MFA (TOTP/WebAuthn) — a cobrança de MFA recente já existe | enhancement, seguranca | **PARCIAL (main)** — commit f245e7b confirmado em origin/main via `merge-base --is-ancestor`; falta implementar TOTP/WebAuthn | Verificar TOTP/WebAuthn |
| 102 | [seguranca] Exportação total aprovada por quem pediu, e varredura de privacidade sem as telas da clínica | bug, seguranca, revisao-r8 | Parcial — fluxo de aprovação em SecaoPrivacidade | Verificar |
| 101 | [front] Remarcar perde a escolha, fila de espera sem erro na tela, vínculo do atestado no retrato curto | bug, front, revisao-r8 | **EM ANDAMENTO (PR #197 OPEN)** — branch `lopes/front-equipe-e-auditoria-api-real` aberta | Verificar fila de espera |
| 100 | [seguranca] next.config não barra NEXT_PUBLIC_API_MODO=http em produção | bug, seguranca, revisao-r8 | Não verificado | Verificar |
| 99 | [front] Classe de campo repetida em 9 arquivos, indexação por id em 12, e useConsulta duplicado no portal | enhancement, front, revisao-r8 | **EM ANDAMENTO (branch refactor/front-campo)** — commits 1ca724e, ae8a1d5, 06bf777 locais (3 à frente) | Preparar PR |
| 98 | [front] useConsulta mostra o dado antigo quando o filtro muda | bug, front, revisao-r8 | **EM ANDAMENTO (branch refactor/front-useconsulta)** — commit 8dc1854 local (1 à frente) | Preparar PR |
| 97 | [front] start_url do manifesto leva o paciente para a área da equipe | bug, front, revisao-r8 | Não verificado | Verificar |
| 96 | [front] Service worker preso no cache v1: tela offline sem estilo depois de deploys | bug, front, revisao-r8 | Não verificado | Verificar |
| 95 | [seguranca] Sete rotas do adaptador falso sem trava de papel | bug, seguranca, revisao-r8 | Parcial — SoAdmin em configuracoes.tsx | Verificar rotas |

---

## PRs ABERTOS (gh pr list — estado atual)

| # | Título | Branch | Estado | Relacionado a |
|---|--------|--------|--------|---------------|
| 210 | build(api): imagem de produção sem os peers de teste do better-auth | eng/imagem-sem-peers-de-teste | OPEN | Infra |
| 209 | ci(deps): exceção datada para o alerta do picomatch | eng/excecao-picomatch | OPEN | Deps |
| 208 | fix(auth): clínica nova sem fundador só pelo app_migrator (G3) | eng/clinica-sem-fundador | OPEN | Provisionamento |
| 207 | feat(auth): papel de banco dedicado ao provisionamento (A1, R4) | eng/papel-provisionamento | OPEN | Provisionamento |
| 206 | feat(ops): cliente SSM real nas tarefas de provisionamento | eng/cliente-ssm | OPEN | Provisionamento |
| 205 | feat(auth): expurgo das ativações do fundador sem abrir a clínica (PR 3) | eng/expurgo-da-ativacao | OPEN | Provisionamento |
| 204 | feat(infra): tarefas avulsas do provisionamento e recuperação do admin único (B11, B12) | eng/infra-ops-provisionamento | OPEN | Provisionamento |
| 203 | feat(provisionamento): ativação do fundador e fundação pelo sistema — PR 2 (B11) | eng/ativacao-do-fundador | OPEN | Provisionamento |
| 202 | chore(deps): bump minor-and-patch group | dependabot/... | OPEN | Deps |
| 201 | chore(deps): bump next 16.4.3 → 16.4.5 | dependabot/... | OPEN | Deps |
| 200 | chore(deps): bump node in apps/api | dependabot/... | OPEN | Deps |
| 199 | feat(auth): recuperação do fator do admin único pelo suporte (B12) | eng/recuperacao-admin-unico | OPEN | Provisionamento |
| 198 | fix(web): código de demonstração só vale em modo fake | lopes/front-acesso-sem-codigo-fixo | **OPEN** | #145, #146 |
| 197 | feat(web): liga equipe e trilha de acesso à API real e recusa convite… | lopes/front-equipe-e-auditoria-api-real | **OPEN** | #101, #99 |
| 195 | feat(provisionamento): clínica e ativação do fundador — PR 1 | eng/provisionamento-clinica | OPEN | Provisionamento |
| 194 | feat(cadastro): conselho e número de registro do profissional | eng/registro-no-conselho | OPEN | #167 |
| 190 | feat(lgpd): anonimização a pedido do titular executável pelo suporte (B10) | eng/anonimizacao-suporte | OPEN | LGPD |
| 189 | fix(deps): minimatch 11.0.1+ por override | eng/minimatch-override | OPEN | Deps |
| 186 | chore(deps): bump grafana/setup-k6-action | dependabot/... | OPEN | Deps |
| 184 | chore(deps): bump pnpm/action-setup | dependabot/... | OPEN | Deps |
| 182 | fix(auth): cadastro do fator fora do convite e conta reaproveitada sem senha | lopes/156-cadastro-do-fator-sem-convite | OPEN | #156 |
| 179 | feat(seguranca): chave dos HMACs separada por uso com HKDF (B9) | eng/hmac-por-uso | OPEN | Segurança |
| 178 | feat(auth): espelho dos convites aceitos para a anonimização (V3 do #177) | eng/better-auth-espelho-convite | OPEN | Auth |
| 177 | fix(auth): fila noturna — anonimização em todas as clínicas | eng/better-auth-fila-noturna | OPEN | Auth |
| 176 | fix(auth): ressalvas antigas da fila do 3b | eng/better-auth-fila-antiga | OPEN | Auth |
| 175 | fix(auth): fila da reconferência do #173 | eng/better-auth-fila-173 | OPEN | Auth |
| 174 | feat(auth): abertura do login real (NÃO MESCLAR antes do checklist B1–B8) | eng/better-auth-abertura | OPEN | Auth |
| 173 | feat(auth): itens de fila do 3b | eng/better-auth-fila-3b | OPEN | Auth |
| 171 | feat(auth): Better Auth PR 3c — produção | eng/better-auth-producao | OPEN | Auth |
| 159 | feat(auth): Better Auth PR 3b-2 — troca de senha, desbloqueio, recuperação | eng/better-auth-recuperacao | OPEN | Auth |
| 158 | feat(web): prontuário na API real (S1 do E4) | front/e4-s1-prontuario-v2 | OPEN | Front |
| 157 | docs(front): plano do E4 por fatias | front/plano-e4-api-real | OPEN | Docs |
| 156 | feat(auth): Better Auth PR 3b-1 — convite da equipe | eng/better-auth-convites | OPEN | Auth |
| 155 | feat(auth): Better Auth PR 3a — sessão da pessoa e escolha de clínica | eng/better-auth-equipe | OPEN | Auth |
| 154 | test(seguranca): trava de logs fecha os furos restantes | eng/trava-logs-furos | OPEN | Segurança |
| 153 | feat(auth): recusa por MFA em rota comum | eng/mfa-recusa-rota-comum | OPEN | Auth |
| 143 | test(auditoria): regras de anomalia em uma fonte só | eng/regras-de-anomalia-uma-fonte | OPEN | Auditoria |
| 116 | chore(deps): postgres.js 3.4.9 → 4.0.0 | eng/postgres-v4-avaliacao | OPEN | Deps |
| 104 | docs: estado verificado dos itens de produção | eng/estado-verificado-producao | OPEN | Docs |
| 55 | [R8-eng] docs(relatorios): estado e relatório finais da Engenharia | eng/relatorio-final-r8 | OPEN | Docs |

**PRs MERGEADOS recentes em origin/main:**
- #193 — Merge pull request #193 from Rocafa/eng/modelos-por-especialidade (c34c602)
- #192 — Merge pull request #192 from Rocafa/eng/atendimento-por-agendamento (c3221c6) — resolve #180 item 1
- #191 — Merge pull request #191 from Rocafa/devops/codeql-agrupado (492835e)

---

## Branches de Refatoração Locais (estado real vs origin/main)

| Branch | Descrição | Commits à frente | Atrás | Status real |
|--------|-----------|------------------|-------|-------------|
| refactor/docs | Atualizações de documentação | 1 | 0 | **EM DESVIO** — precisa de PR |
| refactor/front-campo | Extrai componente Campo com 4 variantes, migra 9 arquivos, restaura comentários de regra | 3 (1ca724e, ae8a1d5, 06bf777) | 0 | **EM DESVIO** — precisa de PR para #99 |
| refactor/front-useconsulta | Corrige loop do useConsulta: carregar/formatarErro em useRef, efeito depende só de [api, versao, tentativa, pergunta] | 1 (8dc1854) | 0 | **EM DESVIO** — precisa de PR para #98 |
| refactor/shared-testes | Testes compartilhados (pagination, etc.) | 4 | 15 | **EM DESVIO** — precisa de PR |
| refactor/shared-tooling | Tooling compartilhado (ESLint, etc.) | 1 | 15 | **EM DESVIO** — precisa de PR |
| refactor/web-lint-react-hooks | Configuração react-hooks ESLint | 0 | 0 | **EM DESVIO** — sem divergência |
| refactor/wip-375e750 | Work in progress antigo (R1.1) | 1 | 20 | **EM DESVIO** — precisa de PR ou limpeza |

> **Regra aplicada**: "RESOLVIDO" ou "MERGEADO" só quando o commit está em `origin/main` (prova: `git merge-base --is-ancestor <commit> origin/main` ou merge commit visível no log). Branch local ou PR aberto = "EM ANDAMENTO (branch X / PR #N)".

> **Fonte dos dados acima**: `git for-each-ref --format='%(refname:short) %(ahead-behind:origin/main)' refs/heads/refactor` e `git log origin/main..<branch> --oneline` para cada branch.

---

## Avanços confirmados na origin/main (com commit e PR)

✅ **#180 (item 1)** — Leitura de atendimento por agendamento: commit 834053e mergeado via PR #192 (merge commit c3221c6)

✅ **#167 (parcial)** — Modelos por especialidade (fisio, TO, escalas base): commits 4b6a0c0, 0543150, cbcb474 mergeados via PR #193 (merge commit c34c602)

✅ **#106 (parcial)** — Cobrança de MFA existente: commit f245e7b confirmado em origin/main via `git merge-base --is-ancestor f245e7b origin/main`; falta TOTP/WebAuthn

✅ **Infra/Deps** — CodeQL agrupado: PR #191 mergeado (492835e)

---

## Correções em relação à versão anterior do TRIAGEM.md

A versão anterior deste arquivo foi gerada no branch `orchestrator-saas-claude-triagem` no commit 8871c58 (rodada 1). Esta versão corrige os erros factuais apontados na revisão do Guardião LGPD.

| Item | Antes (incorreto) | Agora (correto) | Evidência |
|------|-------------------|-----------------|-----------|
| #180 | EM ANDAMENTO — commit 834053e não em origin/main | PARCIAL (main) — item 1 via PR #192 (834053e) | `git merge-base --is-ancestor 834053e origin/main` = true; PR #192 MERGED |
| #106 | EM ANDAMENTO — commit f245e7b não confirmado | PARCIAL (main) — f245e7b confirmado; falta TOTP/WebAuthn | `git merge-base --is-ancestor f245e7b origin/main` = true |
| #148 | PARCIAL — PR #191, #192, #193 contam como avanço | Não verificado — PRs não cobrem as 4 ressalvas do #103 | Verificado: #191=CodeQL, #192=#180 item 1, #193=#167 |
| #145, #146 | EM ANDAMENTO (PR #198) — status OK | EM ANDAMENTO (PR #198 OPEN) — aguardando merge | `gh pr view 198` → state=OPEN |
| #99 | EM ANDAMENTO — commits 1ca724e + ae8a1d5 | EM ANDAMENTO — 3 commits (1ca724e, ae8a1d5, 06bf777) | `git log origin/main..refactor/front-campo --oneline` |
| #98 | EM ANDAMENTO — commit 8dc1854 | EM ANDAMENTO — commit 8dc1854 (1 à frente) | `git log origin/main..refactor/front-useconsulta --oneline` |
| refactor/front-campo | 2 commits, não em main | 3 commits à frente, 0 atrás | `git for-each-ref` + `git log` |
| refactor/front-useconsulta | 1 commit, não em main | 1 commit à frente, 0 atrás | `git for-each-ref` + `git log` |
| refactor/shared-testes | "não existe" | Existe: 4 à frente, 15 atrás | `git for-each-ref` |
| refactor/shared-tooling | "não existe" | Existe: 1 à frente, 15 atrás | `git for-each-ref` |
| refactor/wip-375e750 | "não existe" | Existe: 1 à frente, 20 atrás | `git for-each-ref` |
| refactor/docs | Ausente da tabela | Existe: 1 à frente, 0 atrás | `git for-each-ref` |
| refactor/web-lint-react-hooks | Ausente da tabela | Existe: 0 à frente, 0 atrás | `git for-each-ref` |

---

## Próximos Passos Sugeridos

1. **Criar PRs para branches de refatoração**: `refactor/front-campo` → PR para #99; `refactor/front-useconsulta` → PR para #98; `refactor/docs`, `refactor/shared-testes`, `refactor/shared-tooling`, `refactor/wip-375e750` → avaliar e abrir PRs ou limpar
2. **Mergear PR #198** — resolve #145 e #146 (código demo só em modo fake)
3. **Verificar cada ressalva do #103** para fechar #148 (item de segurança — não pode ser "parcial" sem prova)
4. **Verificar #147** — alcance varreduras CodeQL (subpasta, portal, lib) e regra no-console ESLint
5. **Completar #106** — implementar fator TOTP/WebAuthn (cobrança de MFA já existe em main)
6. **Verificar PRs de provisionamento** (#203-#208) — bloqueiam #107 (S2)
7. **Completar #167** — escalas com faixa pendentes
8. **Verificar #101** — fila de espera e vínculo atestado (PR #197 aberto)
9. **Verificar #100** — next.config barra NEXT_PUBLIC_API_MODO=http em produção
10. **Verificar #95** — 7 rotas do adaptador falso sem trava de papel
11. **Verificar #97, #96** — start_url manifesto e service worker
# Triagem de Issues e PRs — 2026-11-19

Gerado em: 2026-11-19
Base: `origin/main` (commit 492835e) + branches locais de refactor

---

## Issues ABERTAS (gh issue list)

| # | Título | Labels | Status na main | Ação |
|---|--------|--------|----------------|------|
| 180 | [front] Evolução na API real: falta rota de leitura por agendamento e a versão no contrato do front | bug, front | **EM ANDAMENTO** — commit 834053e em branch local, não em origin/main | Verificar se merge necessário |
| 167 | [prontuario] Conteúdo clínico que falta no modelo: COFFITO 414, campos de TO e escalas com faixa | enhancement, front | **PARCIAL (main)** — commits 4b6a0c0, 0543150, cbcb474 mergeados via PR #193 | Manter aberta (escalas pendentes) |
| 148 | [seguranca] P5: as quatro ressalvas do #103 que precisam fechar antes do primeiro dado real | bug, front, seguranca | **PARCIAL** — PR #193 mergeado; PR #192 status desconhecido | Verificar PR #192 |
| 146 | [front] P2: tela de demonstração pede senha real com autoComplete=current-password | bug, front | **EM ANDAMENTO (PR #198)** — branch `lopes/front-acesso-sem-codigo-fixo` aberta | Aguardar merge |
| 145 | [seguranca] P1: código fixo 123456 não depende do modo — e a D4 tem de SUBSTITUIR as telas simuladas | bug, front, seguranca | **EM ANDAMENTO (PR #198)** — mesmo PR que #146 | Aguardar merge |
| 107 | [seguranca] S2: provedor de sessão real (bloqueio técnico nº 1, depende da D4) | enhancement, seguranca | Em andamento — PRs #203-#208 (provisionamento) | Manter aberta |
| 106 | [seguranca] S3: falta o fator de MFA (TOTP/WebAuthn) — a cobrança de MFA recente já existe | enhancement, seguranca | **EM ANDAMENTO** — commit f245e7b não confirmado em origin/main | Verificar se merge necessário |
| 102 | [seguranca] Exportação total aprovada por quem pediu, e varredura de privacidade sem as telas da clínica | bug, seguranca, revisao-r8 | Parcial — fluxo de aprovação em SecaoPrivacidade | Verificar |
| 101 | [front] Remarcar perde a escolha, fila de espera sem erro na tela, vínculo do atestado no retrato curto | bug, front, revisao-r8 | **EM ANDAMENTO (PR #197)** — branch `lopes/front-equipe-e-auditoria-api-real` aberta | Verificar fila de espera |
| 100 | [seguranca] next.config não barra NEXT_PUBLIC_API_MODO=http em produção | bug, seguranca, revisao-r8 | Não verificado | Verificar |
| 99 | [front] Classe de campo repetida em 9 arquivos, indexação por id em 12, e useConsulta duplicado no portal | enhancement, front, revisao-r8 | **EM ANDAMENTO (branch refactor/front-campo)** — commits 1ca724e + ae8a1d5 locais | Preparar PR |
| 98 | [front] useConsulta mostra o dado antigo quando o filtro muda | bug, front, revisao-r8 | **EM ANDAMENTO (branch refactor/front-useconsulta)** — commit 8dc1854 local | Preparar PR |
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
- #191 — Merge pull request #191 from Rocafa/devops/codeql-agrupado (492835e)

---

## Branches de Refatoração Locais (estado real vs origin/main)

| Branch | Descrição | Commits | Atrás/À frente da origin/main | Status real |
|--------|-----------|---------|-------------------------------|-------------|
| refactor/front-campo | Extrai componente Campo com 4 variantes, migra 9 arquivos, restaura 31 comentários de regra | 1ca724e, ae8a1d5 | **Não está em origin/main** — branch local apenas | **EM DESVIO** — precisa de PR |
| refactor/front-useconsulta | Corrige loop do useConsulta: carregar/formatarErro em useRef, efeito depende só de [api, versao, tentativa, pergunta] | 8dc1854 | **Não está em origin/main** — branch local apenas | **EM DESVIO** — precisa de PR |
| refactor/shared-testes | (não existe — shared não tem testes de paginação) | — | — | — |
| refactor/shared-tooling | — | — | — | — |
| refactor/wip-375e750 | — | — | — | — |

> **Regra aplicada**: "RESOLVIDO" ou "MERGEADO" só quando o commit está em `origin/main` (prova: `git merge-base --is-ancestor <commit> origin/main` ou merge commit visível no log). Branch local ou PR aberto = "EM ANDAMENTO (branch X / PR #N)".

---

## Resumo do que JÁ FOI RESOLVIDO na main (confirmado via merge commits)

✅ **#167 (parcial)** — Modelos por especialidade (fisio, TO, escalas base): commits 4b6a0c0, 0543150, cbcb474 mergeados via PR #193 (c34c602)
✅ **#148 (parcial)** — CodeQL agrupado: PR #191 mergeado (492835e); PR #193 mergeado (c34c602); PR #192 status a confirmar
✅ **Deps/Infra** — PR #191 (CodeQL), PR #193 (modelos)

---

## O que o TRIAGEM.md anterior marcava errado como "RESOLVIDO/MERGEADO"

| Item | Antes (incorreto) | Agora (correto) | Evidência |
|------|-------------------|-----------------|-----------|
| #180 | RESOLVIDO (commit 834053e) | EM ANDAMENTO — commit não em origin/main | Sem merge commit para 834053e |
| #145, #146 | RESOLVIDO (PR #198) | EM ANDAMENTO (PR #198 OPEN) | PR #198 está aberto (branch lopes/front-acesso-sem-codigo-fixo) |
| #106 | RESOLVIDO (commit f245e7b) | EM ANDAMENTO — commit não confirmado em origin/main | Sem merge commit para f245e7b |
| #99 | MERGEADO (main) | EM ANDAMENTO (branch refactor/front-campo) | Commits 1ca724e, ae8a1d5 só em branch local |
| #98 | PRONTO | EM ANDAMENTO (branch refactor/front-useconsulta) | Commit 8dc1854 só em branch local |
| refactor/front-campo | MERGEADO (main) | EM DESVIO — branch local | Não há PR; não está em origin/main |
| refactor/front-useconsulta | PRONTO | EM DESVIO — branch local | Não há PR; não está em origin/main |

---

## Próximos Passos Sugeridos

1. **Criar PRs para branches de refatoração**: `refactor/front-campo` → PR para #99; `refactor/front-useconsulta` → PR para #98
2. **Mergear PR #198** — resolve #145 e #146 (código demo só em modo fake)
3. **Verificar PR #192** — completa #148 (quatro ressalvas do #103)
4. **Confirmar commits órfãos em origin/main**: 834053e (#180), f245e7b (#106) — se já mergeados, fechar issues; se não, abrir PRs
5. **Verificar PRs de provisionamento** (#203-#208) — bloqueiam #107 (S2)
6. **Completar #167** — escalas com faixa pendentes
7. **Verificar #147** — alcance varreduras CodeQL e no-console ESLint
8. **Verificar #101** — fila de espera e vínculo atestado (PR #197 aberto)
9. **Verificar #100** — next.config barra NEXT_PUBLIC_API_MODO=http em produção
10. **Verificar #95** — 7 rotas do adaptador falso sem trava de papel
11. **Verificar #97, #96** — start_url manifesto e service worker
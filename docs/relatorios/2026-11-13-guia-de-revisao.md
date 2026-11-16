# Guia de revisão para o @Lopesloro — 13/11/2026

> Maestro (@Rocafa). O que está esperando a tua revisão, na ordem que destrava mais, com o tamanho de cada PR e o que já foi conferido. **Todos os PRs abaixo estão com o CI verde.** O Guardião LGPD aprovou todos que tocam dado pessoal. A checagem automática a cada 2 h mescla o que tu aprovares, propaga a `main` e pede a reaprovação quando for preciso.

## 1. Pilha do login real (D4) — o caminho crítico

O #149 já está na `main`. Cada PR abaixo vira PR para a `main` quando o de baixo entra. A proteção descarta a aprovação quando entra commit novo, então os já aprovados **podem pedir reaprovação** depois da propagação; o diff dela é só o merge.

| Ordem | PR | O quê | Tamanho | Situação |
|---|---|---|---|---|
| 1 | #152 | MFA com TOTP, bloqueio 5/15, senha vazada (PR 2) | +1192 / 20 arquivos | **reaprovar**: entrou só o merge do teu #166 e a correção do teste instável do TOTP |
| 2 | #155 | sessão da pessoa e escolha de clínica (PR 3a) | +1062 / 30 | **revisar**: nunca teve tua aprovação |
| 3 | #156 | convite da equipe e cadastro do fator (3b-1) | +757 / 17 | **revisar** |
| 4 | #159 | troca de senha, desbloqueio, recuperação pelo admin (3b-2) | +1370 / 23 | aprovado |
| 5 | #171 | produção: segredos, RIPD, checklist (3c) | +490 / 19 | aprovado |
| 6 | #173 | itens de fila do 3b | +284 / 18 | **revisar** |
| 7 | #175 | fila da reconferência do #173 | +288 / 12 | aprovado |
| 8 | #176 | ressalvas antigas da fila do 3b | +476 / 15 | aprovado |
| 9 | #177 | anonimização em todas as clínicas + teste HTTP do cookie | +314 / 9 | **revisar** |
| 10 | #178 | espelho dos convites aceitos (0073) | +432 / 15 | **revisar** |
| 11 | #179 | chave dos HMACs por uso com HKDF (B9) | +786 / 25 | aprovado |
| 12 | #190 | anonimização a pedido do titular pelo suporte (B10) | +1092 / 15 | **revisar** (comando, Terraform, runbook) |

O #174 (abertura do login) só entra depois do checklist B1–B10 e do parecer final.

## 2. Avulsos para a `main` (independentes da pilha)

| PR | O quê | Tamanho | Por que importa |
|---|---|---|---|
| #192 | `GET /atendimentos/do-agendamento/:id` com a `versao` | +297 / 9 | **destrava a tua fatia S1** (#158 e #180, item 1) |
| #193 | modelos do prontuário v2 (fisio, TO, escalas) | +375 / 8 | **destrava a TO no modo http** (#167, #180 item 4); normas conferidas no site do COFFITO |
| #153 | recusa por MFA em rota comum na trilha | +145 / 4 | R5 do #123 |
| #154 | trava de logs: furos restantes | +373 / 5 | conferida contra a pilha inteira |
| #172 | e2e no fuso da clínica | +21 / 3 | acaba com a falha do e2e à noite |
| #191 | ações do CodeQL num grupo só | +7 / 2 | substitui o #183 e o #185, que quebravam |
| #189 | override do `minimatch` (alerta do Dependabot) | +16 / 2 | **mesclar depois da pilha** (lockfile) |
| #116 | postgres.js 4.0.0 | +56 / 8 | já aprovado; **depois da pilha** (lockfile) |

## 3. Teus PRs que esperam algo de ti

| PR | O que falta |
|---|---|
| #158 | o Guardião aprovou com ressalvas: trocar a mensagem "Use a demonstração" (C1) e o comentário do teste de contrato (R5a). Depois disso eu aprovo |
| #143 | os casos (b) e (d) passam sem provar nada: o `avisos()` lê sem `userId`, e a política só mostra o aviso ao destinatário. Correção sugerida no PR |
| #157 | URL e data nos preços da concorrência; fonte nos números do Reclame Aqui |

## 4. Decisões dos sócios

| Decisão | Voto do @Rocafa | Falta |
|---|---|---|
| D13 — orçamento da AWS | **B**: só o staging até o piloto | o teu voto; destrava o staging (B1, B3, B4, B8, B10) |
| D15 — login real: senha vazada e Redis caído | **D** no piloto; Redis: sem preferência | o teu voto |
| Supervisor do estagiário (COFFITO 414 e 415, art. 1º §2º) | — | **a clínica do piloto tem estagiário atendendo?** Se não tiver, basta uma declaração no termo de adesão |

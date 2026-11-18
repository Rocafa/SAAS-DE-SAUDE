# Guia de revisão para o @Lopesloro — 13/11/2026

## Atualização de 17/11/2026, comece por aqui

**Urgente: o #209 destrava a CI de todos os PRs.** Desde 17/11 às 15:56 UTC, o alerta GHSA-fc5q-39xc-vjpf (picomatch,
alta, ainda **sem versão corrigida**) faz o job "Auditoria de dependências" falhar em qualquer PR. O #209 adiciona uma
exceção que **vence sozinha em 01/12**, porque a CI falha depois dessa data, com a análise de alcance e o parecer do Guardião.

| Ordem | PR | O quê | Tamanho | Guardião | O que fazer |
|---|---|---|---|---|---|
| 1 | #209 | exceção datada para o picomatch (sem correção publicada) | +148 / 4 | aprovado | **revisar**: destrava a auditoria de todos |
| 2 | #189 | minimatch 11.0.1+ por override (Dependabot) | +16 / 2 | — | já aprovado; entra assim que o #209 entrar |
| 3 | #210 | imagem da API sem os peers de teste do better-auth (268 → 82 MB, sai o picomatch) | +71 / 7 | aprovado | **revisar** |
| 4 | #116 | postgres.js 4.0.0, sai o patch da 3.4.9 | +110 / 8 | — (só dependência) | **reaprovar**: a aprovação caiu com o merge da main |
| 5 | #155 | Better Auth PR 3a: sessão e escolha de clínica | +1225 / 30 | aprovado | **revisar**: base de toda a pilha abaixo |
| 6 | #194 | conselho e registro do profissional (COFFITO) | +489 / 17 | aprovado | **reaprovar** |
| 7 | #201 | next 16.4.3 → 16.4.5 no `apps/web` (Dependabot, GHSA-mfr8-8qww-v76h, média) | 2 arquivos | — (só dependência) | **revisar**: CI verde; mexe no lockfile, então entra depois do #210 e do #116 |

**Pilha nova, empilhada na do login** (cada PR mira a branch do PR de baixo e vira PR para a `main` quando ela entra).
Todos têm parecer favorável do Guardião e CI verde, e não há pendência de código:

| PR | O quê | Tamanho |
|---|---|---|
| #195 | provisionamento da clínica, PR 1 (tabela, função e comando) | +1102 / 15 |
| #199 | recuperação do fator do admin único pelo suporte (B12) | +991 / 14 |
| #203 | ativação do fundador e fundação pelo sistema (B11) | +1407 / 13 |
| #204 | Terraform das tarefas avulsas (papéis executor e entrega separados, KMS por fluxo, alertas) | +1638 / 9 |
| #205 | expurgo de 30 dias das ativações, sem abrir a clínica | +388 / 9 |
| #206 | cliente SSM real (SecureString, vencimento de 72 h e 24 h) e runbooks | +572 / 12 |
| #207 | papel `app_provisionamento` dedicado e guarda dos privilégios | +871 / 17 |
| #208 | clínica nova sem fundador só pelo `app_migrator` | +304 / 16 |

**Ação de infraestrutura** quando o #204 entrar: as variáveis dos papéis mudaram de nome (`ops-*-executor` e
`ops-*-entrega`), então o tfvars precisa ser ajustado. A ordem de deploy do provisionamento está no fim do log noturno
(`2026-11-11-log-noturno.md`).

**Conferir no #174:** mudei a trava da CI que proibia `AUTH_PROVIDER`. Ela agora exige uma única definição, dentro da
condição `login_real_habilitado`, com essa variável desligada por padrão. É trava de segurança, então vale o teu olho.

---

(Versão de 13/11 abaixo, mantida para histórico.)

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

## Atualização de 16/11

- **O teu #181 entrou** no branch do #155, com as ressalvas do Guardião corrigidas por cima (R1 a R3) e propagado pela pilha. **O #155 está pronto para a tua aprovação** assim que o #152 entrar.
- **O teu #182: a parte 1 foi vetada pelo Guardião** (liberar o `enable` só com a senha permite tomar a conta). O parecer e o caminho certo estão no PR. **A parte 2 foi aprovada.** Separa ela num PR próprio para o branch do #156, e eu mesclo. O caminho do fundador virou o item **B11** do checklist, e o desenho do provisionamento está com o Guardião (`docs/04-arquitetura/provisionamento-da-clinica.md`).
- **PRs novos para a `main`, todos com o CI verde:**

| PR | O quê | Guardião |
|---|---|---|
| #191 | ações do CodeQL num grupo só (substitui o #183 e o #185) | — |
| #192 | atendimento pelo agendamento, com a `versao` (destrava a tua fatia S1) | aprovado |
| #193 | modelos v2 de fisio e TO (COFFITO 414 e 415, conferidas), escalas com faixa e instrumento explícito | aprovado |
| #194 | conselho e número de registro do profissional, congelados na assinatura; o recibo usa o cadastro | aprovado (o veto caiu em 16/11) |

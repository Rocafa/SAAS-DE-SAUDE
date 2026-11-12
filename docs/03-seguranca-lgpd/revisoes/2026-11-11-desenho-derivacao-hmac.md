# Parecer do Guardião — desenho da separação por uso da `RATE_LIMIT_HASH_KEY` (HKDF)

> 11/11/2026 · Guardião LGPD & Segurança · parecer de **desenho** (sem código), PR #178, branch `eng/better-auth-espelho-convite`.
> Objeto: [`docs/04-arquitetura/derivacao-da-chave-de-hmac.md`](../../04-arquitetura/derivacao-da-chave-de-hmac.md).
> Origens: item 11 de [`2026-11-05-codigo-better-auth-pr1.md`](2026-11-05-codigo-better-auth-pr1.md) e R5 de [`2026-11-05-codigo-better-auth-pr3b1.md`](2026-11-05-codigo-better-auth-pr3b1.md).
> Base: [`prontidao-producao.md`](../prontidao-producao.md) (checklist B1–B8), parecer do #76 (cursor por HKDF).

## Veredito: **APROVADO COM RESSALVAS**

A direção está certa (HKDF-SHA256 por uso, ponto de entrada único, segredo cru deixa de circular, prefixos mantidos). O desenho não pode virar código como está porque **a tabela de usos não bate com o código** (R1) e isso muda a resposta da pergunta 1. As ressalvas abaixo são condição para o PR de código.

## Conferência da tabela contra o código

`grep loadRateLimitHashKey apps/api/src` (fora testes): `app.module.ts:85` (PatientsModule), `boot.ts:31` (Better Auth), `convites.ts:72`, `http-security.ts:36/119`, `log-de-seguranca.ts:175`. Nada fora de `apps/api` (só `.env.example`, `infra.yml` e Terraform de staging, que só injetam o segredo). O que cada um assina, de fato:

| # | Uso real | Entrada do HMAC | Onde fica | Tempo | Na tabela do desenho |
|---|---|---|---|---|---|
| a | Rate limit por IP | IP **cru, sem prefixo** (`rateLimitKey`, `http-security.ts:127`) | Redis `rl:v2:…` | minutos | ok |
| b | Vigilância de leitura (pacientes) e do portal | `usr\u001f…` / `portal\u001f…` com ids de pessoa/clínica — **não é IP** | Redis | minutos | **errado**: chamada de "origem (IP) da vigilância" |
| c | Pseudônimo da origem (`origemDaRequisicao`, `log:`+IP, 16 hex) | IP | CloudWatch (180 d) **e** `identidade.sessao.ip_address` (12 h, via `x-plataforma-origem`, `montagem.ts:63`) **e** entrada dos contadores `login-origem`/`fator-origem` e da vigilância do portal | 180 d | **incompleto**: a tabela atribui o IP da sessão ao `hmacCurto`; na verdade ele é o mesmo valor do log |
| d | Bloqueio 5/15 e reuso do TOTP (`chaveDoBloqueio`, `tipo:valor`) | e-mail, userId, origem (já pseudônimo c), `userId:código` | Redis `bl:v1:…` | ≤ 15 min | ok |
| e | User-agent da sessão (`hmacCurto`, `ua:`) | user-agent | `identidade.sessao.user_agent` | ≤ 12 h | ok, mas só o UA |
| f | E-mail do convite (`hmacDoEmail`, `convite-email:`) | e-mail normalizado | `team_invites.email_hmac` | ≤ 30 d após o estado final | ok (o espelho `identidade.convite_aceito` da 0073 guarda só ids, não é afetado) |

Consequências da correção: o IP da sessão e o log de 180 dias compartilham o mesmo pseudônimo (é intencional, permite ligar sessão a evento de segurança), e esse mesmo valor alimenta contadores de bloqueio. Quem rotacionar a chave de (c) quebra os três ao mesmo tempo; isso tem de estar escrito.

## Respostas às perguntas

**1. Granularidade dos rótulos — decisão: separar.** A origem do log (180 d) **não** pode dividir chave com o rate limit (minutos). Rótulos fechados (union type no código):

| Rótulo | Cobre | Por quê |
|---|---|---|
| `rate-limit` | (a) e (b) | Redis, minutos; rotação sem custo. Entradas já separadas por domínio (IP cru × `usr\u001f`/`portal\u001f`) |
| `origem` | (c): log, `sessao.ip_address`, entrada dos contadores por origem | Única com retenção longa; rotação quebra a correlação de 180 d e deve ser rara e registrada |
| `bloqueio` | (d) | Redis ≤ 15 min; contém HMAC de e-mail |
| `sessao-ua` | (e) | Renomear de `sessao`: o IP da sessão **não** é deste rótulo |
| `convite-email` | (f) | Retenção de dias; rotação afeta convites pendentes |

O ganho real é **rotação independente**, não contenção de vazamento: todas as chaves derivadas vivem no mesmo processo, então um comprometimento da API expõe todas, e um vazamento do segredo-raiz expõe todas também. O texto "vazar uma chave derivada não expõe as outras" deve vir com essa ressalva (R3).

**2. Leitura dupla de 72 h para convites — decisão: desnecessária nesta migração; aprovada como mecanismo para rotações futuras do rótulo `convite-email`, com condições.**
- Se o código entrar antes do login real (pergunta 3), não existe convite real pendente em produção; em staging só há dados fictícios. Basta invalidar e reemitir os fictícios. **Não escrever a leitura dupla agora** (menos código, menos superfície).
- Para rotação futura (`convite-email/v1 → v2`), a leitura dupla é **preferível** a reemitir em massa (reemissão gera novo envio de e-mail e novo tratamento, contrário à minimização), desde que: (i) janela = validade do convite (`expires_at`, 72 h hoje) contada do **fim** do deploy, nunca do início; (ii) só para convites com `created_at` anterior ao corte; (iii) as duas comparações sempre calculadas (sem atalho que diferencie tempo); (iv) em deploy rolante, fazer em duas fases (ler os dois e gravar o antigo → gravar o novo) ou aceitar por escrito a falha dos convites criados/aceitos em versões diferentes; (v) remoção da leitura antiga com data na fila, e antes da remoção conferir `count(*)` de convites pendentes no formato antigo = 0; (vi) teste do aceite nos dois formatos e da recusa após a janela. O runbook de rotação passa a dizer isso, no lugar de "avisar admins e reemitir".

**3. Antes ou depois da abertura do login real — decisão: ANTES, como item do checklist (B9), e antes do B8.** Antes da produção a troca não tem migração de dado real: nenhum convite real, nenhuma correlação de log de pessoa real, nenhum contador a perder. Depois, toda a seção "Migração" do desenho passa a valer para titulares reais. O B8 (fumaça no staging) deve rodar já com as chaves derivadas, para cobrir convite, bloqueio e sessão.

## Ressalvas (condições para o PR de código)

- **R1 — Corrigir a tabela do desenho** conforme a conferência acima (vigilância não é IP; IP da sessão = pseudônimo do log; listar os consumidores de `origemDaRequisicao`).
- **R2 — Versão no `info`, não no `salt`.** O desenho põe `v1` no salt e diz que a rotação por uso troca o rótulo para `v2`: são coisas diferentes. Fixar `salt = "plataforma-saude/hmac"` e `info = "<uso>/v<n>"`, com a versão de cada uso numa constante revisável. Comprimento 32 bytes, como no cursor.
- **R3 — Honestidade sobre a raiz.** Documento e runbook devem dizer que o comprometimento de `RATE_LIMIT_HASH_KEY` (raiz) continua exigindo rotação em bloco, e que a rotação por rótulo serve para trocar um uso sem afetar os outros, não para conter vazamento do processo.
- **R4 — Ponto de entrada único verificável.** `loadRateLimitHashKey` deixa de ser exportada (ou fica só para `rate-limit-store.ts` e seu teste); os parâmetros-padrão `= loadRateLimitHashKey()` em `http-security.ts`, `convites.ts` e `log-de-seguranca.ts` passam a `chaveDeHmac('<uso>')`. Teste que falha se outro arquivo de `src/` importar a raiz. A chave derivada nunca vai para log nem para mensagem de erro.
- **R5 — Testes mínimos:** chaves distintas por rótulo; vetor conhecido (mesma raiz → mesma chave, para não mudar sem querer entre deploys); rótulo fora da lista não compila; boot de produção continua falhando sem a raiz ou com < 32 bytes; a regra C1 do cursor (`PAGINATION_CURSOR_KEY` ≠ `RATE_LIMIT_HASH_KEY`) continua comparando com a **raiz**; `origemDaRequisicao` continua devolvendo `undefined` sem segredo (R9 do #129).
- **R6 — Prefixo para o rate limit por IP.** Hoje a entrada é o IP cru. Com chave própria isso deixa de ser risco de colisão, mas, como defesa em profundidade (item 3 do próprio desenho), usar `ip\u001f` e trocar `rl:v2` por `rl:v3`.
- **R7 — Registro.** Anotar o horário do deploy no registro de incidentes (quebra da correlação do log) mesmo em staging, e atualizar `logs-de-seguranca.md` e o runbook de rotação com os cinco rótulos e o efeito da rotação de cada um.

## Checagens LGPD

- **Base legal / finalidade:** inalteradas (segurança e prevenção à fraude, art. 7º IX e art. 11, II, g, conforme RIPD). Nenhum dado novo é coletado.
- **Minimização:** melhora; reemissão em massa de convites seria pior (R/Q2).
- **Retenção:** inalterada (Redis minutos; sessão 12 h; log 180 d; convite 30 d após estado final).
- **Segredos fora do código:** mantido (Secrets Manager; derivação em memória).
- **Isolamento por tenant / controle de acesso / auditoria:** não afetados; o espelho da 0073 não usa o HMAC.
- **Dados reais:** nenhum no desenho.
- **CFM/ANS/ICP-Brasil:** não se aplicam a este item.

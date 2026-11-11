# Separação por uso da `RATE_LIMIT_HASH_KEY` (desenho para o Guardião)

> 11/11/2026 · Maestro · **desenho aprovado com ressalvas pelo Guardião** (`revisoes/2026-11-11-desenho-derivacao-hmac.md`); falta o código. Origem: item 11 do parecer do código do PR 1 (`revisoes/2026-11-05-codigo-better-auth-pr1.md`) e R5 do código do 3b-1. Este documento descreve o que mudaria, para o Guardião aprovar antes de qualquer código.

## Problema

Um segredo só (`RATE_LIMIT_HASH_KEY`, ≥ 32 bytes, Secrets Manager) assina usos diferentes. Hoje a separação entre eles é só pelo prefixo do texto assinado:

| Uso | Onde | O que fica guardado | Por quanto tempo |
|---|---|---|---|
| Rate limit por IP | `http-security.ts` | chave no Redis | minutos |
| Vigilância de leitura (ids de pessoa e de clínica, prefixos `usr\u001f` e `portal\u001f`; não usa IP) | `PatientsModule` (`hashKey`) | chave no Redis | minutos |
| Origem (IP) no log de segurança, que é **o mesmo pseudônimo** gravado como IP da sessão e usado nos contadores de bloqueio por origem (prefixo `log:`, cabeçalho `x-plataforma-origem`) | `log-de-seguranca.ts` (`origemDaRequisicao`) | campo `origem` no CloudWatch; `identidade.sessao.ip` | 180 dias (log); até 12 h (sessão) |
| Bloqueio 5/15 (e-mail, pessoa, origem) e marca de reuso do TOTP | `chaves-do-bloqueio.ts`, via `boot.ts` | chave no Redis | até 15 min |
| User-agent da sessão | `instancia.ts` (`hmacCurto`, prefixo `ua:`) | `identidade.sessao` | até 12 h |
| E-mail do convite | `convites.ts` (`hmacDoEmail`, prefixo `convite-email:`) | `team_invites.email_hmac` | até 30 dias depois do estado final |

Consequências:
- **Rotação em bloco.** Trocar o segredo afeta todos os usos ao mesmo tempo, inclusive os convites pendentes, que deixam de ser aceitos (runbook de rotação, R5 do 3b-1).
- **Superfície de vazamento.** Um vazamento do segredo expõe todos os usos de uma vez, inclusive a correlação de 180 dias do log.
- **Separação frágil.** Ela depende de nenhum texto de um uso coincidir com o prefixo de outro.

## Proposta

1. **Derivação por uso**, com HKDF-SHA256, no mesmo padrão do cursor de paginação (`cursor-de-paginacao.ts`, aprovado no parecer do #76):
   `chave(uso) = HKDF(segredo, salt = "plataforma-saude/hmac", info = "<uso>/v<n>")`, com a versão no `info` (R2 do parecer), não no salt. São cinco rótulos numa lista fechada no código (resposta 1 do parecer): `rate-limit` (rate limit por IP e as duas vigilâncias), `origem` (log, IP da sessão e entrada dos contadores por origem), `bloqueio`, `sessao-ua` e `convite-email`. O rate limit por IP ganha prefixo próprio (`ip\u001f`, chave `rl:v3` no Redis; R6).
2. **Um só ponto de entrada:** `chaveDeHmac(uso)` em `rate-limit-store.ts`, com cache por processo. Nenhum módulo recebe mais o segredo cru: `loadRateLimitHashKey` passa a ser interna, e um teste falha se outro arquivo importar a raiz (R4).
3. **Prefixos atuais mantidos dentro de cada uso**, como defesa em profundidade.

## Migração (o que muda para dados já gravados)

| Uso | Efeito da troca | Plano |
|---|---|---|
| Redis (rate limit, bloqueio, reuso) | Contadores recomeçam do zero | Aceitar; fazer o deploy fora de horário de pico. O alarme de volume cobre ataque em andamento |
| Log de segurança | Correlação da origem quebra no deploy | Anotar o horário no registro de incidentes, como numa rotação |
| `identidade.sessao` | Os HMACs de IP e user-agent das sessões vivas não batem com os novos | Nada lê esses campos para decidir acesso; eles somem em até 12 h |
| `team_invites.email_hmac` | Convites pendentes deixariam de ser aceitos | **Na primeira troca, nada a fazer:** antes do login real não existe convite real pendente (resposta 2). **Em rotações futuras do `convite-email`:** leitura dupla pelo prazo do convite, contado do fim do deploy, só para convites criados antes do corte, com as duas comparações sempre calculadas, troca em duas fases no deploy rolante, retirada só depois de conferir que não resta convite antigo pendente, e testes nos dois formatos e da recusa depois da janela |

## Quando entra

Antes do login real: item **B9** do checklist (`prontidao-producao.md`), antes do B8 (resposta 3). No deploy, anotar o horário no registro de incidentes e atualizar o runbook de rotação e o `logs-de-seguranca.md` (R7).

## O que ganha

- Cada uso pode ser rotacionado separadamente, trocando o rótulo (`v2`) só daquele uso.
- Vazar uma chave **derivada** não expõe as outras. Mas um vazamento da chave-raiz, ou o comprometimento do processo da API, continua exigindo rotação em bloco (R3): a separação dá rotação independente por uso, não contenção.
- O runbook de rotação fica mais simples: trocar a chave de origem não afeta os convites.

## Testes do PR de código (R5)

Chaves distintas por rótulo; um vetor conhecido; o boot de produção falha sem a raiz ou com menos de 32 bytes; a regra C1 do cursor continua comparando com a raiz; `origemDaRequisicao` sem segredo devolve `undefined`.

## Fora do escopo

`PAGINATION_CURSOR_KEY` (já separada e derivada por HKDF), `BETTER_AUTH_SECRET` (versionado, §13 e runbook) e as chaves do KMS por clínica.

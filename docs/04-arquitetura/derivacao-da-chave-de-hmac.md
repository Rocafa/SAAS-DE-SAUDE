# Separação por uso da `RATE_LIMIT_HASH_KEY` (desenho para o Guardião)

> 11/11/2026 · Maestro · **desenho, sem código ainda**. Origem: item 11 do parecer do código do PR 1 (`revisoes/2026-11-05-codigo-better-auth-pr1.md`) e R5 do código do 3b-1. Este documento descreve o que mudaria, para o Guardião aprovar antes de qualquer código.

## Problema

Um segredo só (`RATE_LIMIT_HASH_KEY`, ≥ 32 bytes, Secrets Manager) assina usos diferentes. Hoje a separação entre eles é só pelo prefixo do texto assinado:

| Uso | Onde | O que fica guardado | Por quanto tempo |
|---|---|---|---|
| Origem (IP) do rate limit e da vigilância | `http-security.ts`, `PatientsModule` (`hashKey`) | chave no Redis | minutos |
| Origem no log de segurança | `log-de-seguranca.ts` | campo `origem` no CloudWatch | 180 dias |
| Bloqueio 5/15 (e-mail, pessoa, origem) e marca de reuso do TOTP | `chaves-do-bloqueio.ts`, via `boot.ts` | chave no Redis | até 15 min |
| IP e user-agent da sessão | `instancia.ts` (`hmacCurto`, prefixo `ua:`) | `identidade.sessao` | até 12 h |
| E-mail do convite | `convites.ts` (`hmacDoEmail`, prefixo `convite-email:`) | `team_invites.email_hmac` | até 30 dias depois do estado final |

Consequências:
- **Rotação em bloco.** Trocar o segredo afeta todos os usos ao mesmo tempo, inclusive os convites pendentes, que deixam de ser aceitos (runbook de rotação, R5 do 3b-1).
- **Superfície de vazamento.** Um vazamento do segredo expõe todos os usos de uma vez, inclusive a correlação de 180 dias do log.
- **Separação frágil.** Ela depende de nenhum texto de um uso coincidir com o prefixo de outro.

## Proposta

1. **Derivação por uso**, com HKDF-SHA256, no mesmo padrão do cursor de paginação (`cursor-de-paginacao.ts`, aprovado no parecer do #76):
   `chave(uso) = HKDF(segredo, salt = "plataforma-saude/hmac/v1", info = uso)`. Os rótulos ficam numa lista fechada no código: `origem`, `bloqueio`, `sessao`, `convite-email`.
2. **Um só ponto de entrada:** `chaveDeHmac(uso)` em `rate-limit-store.ts`, com cache por processo. Nenhum módulo recebe mais o segredo cru: `loadRateLimitHashKey` passa a ser interno.
3. **Prefixos atuais mantidos dentro de cada uso**, como defesa em profundidade.

## Migração (o que muda para dados já gravados)

| Uso | Efeito da troca | Plano |
|---|---|---|
| Redis (rate limit, bloqueio, reuso) | Contadores recomeçam do zero | Aceitar; fazer o deploy fora de horário de pico. O alarme de volume cobre ataque em andamento |
| Log de segurança | Correlação da origem quebra no deploy | Anotar o horário no registro de incidentes, como numa rotação |
| `identidade.sessao` | Os HMACs de IP e user-agent das sessões vivas não batem com os novos | Nada lê esses campos para decidir acesso; eles somem em até 12 h |
| `team_invites.email_hmac` | **Convites pendentes deixariam de ser aceitos** | Leitura dupla por 72 h: o aceite compara o HMAC novo e, se não bater, o antigo (segredo cru com prefixo). Depois de 72 h, a leitura antiga sai num PR próprio. O descarte de 30 dias não depende disso |

## O que ganha

- Cada uso pode ser rotacionado separadamente, trocando o rótulo (`v2`) só daquele uso.
- Vazar uma chave derivada não expõe as outras.
- O runbook de rotação fica mais simples: trocar a chave de origem não afeta os convites.

## Perguntas para o Guardião

1. Os quatro rótulos estão na granularidade certa, ou a origem do log (180 dias) merece um rótulo próprio, separado da origem do rate limit (minutos)?
2. A leitura dupla de 72 h para os convites é aceitável, ou prefere avisar os admins e reemitir os convites, como diz o runbook?
3. Isso entra antes da abertura do login real (checklist B1–B8) ou depois?

## Fora do escopo

`PAGINATION_CURSOR_KEY` (já separada e derivada por HKDF), `BETTER_AUTH_SECRET` (versionado, §13 e runbook) e as chaves do KMS por clínica.

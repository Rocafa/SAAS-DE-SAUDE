# Parecer do Guardião LGPD — PR #136 (eng/robustez-logs-sessao)

**Data:** 04/11/2026 · **Escopo:** `git diff main...eng/robustez-logs-sessao` (8 arquivos) · fecha R4/R7 do parecer do #130 e R7/R8 do parecer do #129.

## Veredito: APROVADO com ressalvas (nenhuma bloqueia o merge)

## O que foi conferido

- **Falha fechada mantida.** Em `perfisDoBanco`, o `.catch` registra `PERFIS_NAO_CONFERIDOS` e **relança** o erro: o guard não devolve `true`, `req.auth` não é preenchido e a rota não executa. Erro de banco indisponível vira 503 genérico no `all-exceptions.filter` (sem detalhe); outro erro vira 500 genérico. O ramo "sem banco fora de dev/test" (R3 do #130) continua lançando.
- **Evento novo no catálogo e sem dado.** `PERFIS_NAO_CONFERIDOS` (alto, imediato) está em `EVENTOS_DE_SEGURANCA` e na tabela de `logs-de-seguranca.md`. Leva só `tenantId` e `userId`, ambos validados como UUID pela allowlist de campos; a mensagem do erro do banco **não** vai para o log.
- **Webhook com `origem`.** `WEBHOOK_ASSINATURA_INVALIDA` passa a levar `origem` = HMAC truncado do IP (`origemDaRequisicao`), nunca o IP em claro.
- **Índice 0062.** `(tenant_id, user_id)` não parcial em `clinic_members`, sem mudar linhas; com o papel de migração. Não mexe em RLS.
- **Testes.** Rodados localmente: `log-de-seguranca.test.ts` + `http-attacks.test.ts`, 55/55 passando. O teste do guard prova a negação (`rejects`) e o evento com os ids. O teste do rate limit prova **um** evento por janela, `contagem: 6` e `origem` em hex de 16 caracteres. RLS não foi rodado (sem Postgres local), e não é preciso para este diff.

## Ressalvas

1. **Ruído de formatação em `sessao.guard.ts`.** Cerca de 85% do diff do guard é reformatação (aspas simples → duplas, quebras de linha), fora do padrão do repo (aspas simples nos outros arquivos, inclusive no `whatsapp.controller.ts` deste PR). Isso esconde a mudança real numa peça de controle de acesso. Recomendo desfazer a reformatação antes do merge, ou num commit separado. Não é defeito de segurança.
2. **Volume do alarme imediato.** Com o banco fora, toda requisição autenticada gera um `PERFIS_NAO_CONFERIDOS` (`error`, imediato): é uma enxurrada no exato momento do incidente. Sugiro `registrarNoMaximoUmaVez` por tenant numa janela de 60 s, como já é feito no `MFA_RECUSADO`. A negação continua por requisição.
3. **Falta teste de emissão no webhook.** A `origem` do webhook não tem teste. A fila já registra isso como pendência (webhook, vigilâncias, exportação). Manter na fila.
4. **`CREATE INDEX` sem `CONCURRENTLY`.** Trava escritas em `clinic_members` enquanto o índice é criado. Hoje o volume é desprezível; em produção com volume, aplicar com `CONCURRENTLY`, como já ficou anotado para a 0061.
5. **O teste do guard não passa pelo filtro.** Ele prova que o erro sobe, mas não prova o 503 de ponta a ponta. O filtro já tem cobertura própria. Opcional: um caso no `http-attacks` com banco simulado fora.

## Pendências que continuam na fila (fora deste PR)

R5 do #130 (nova checagem de perfil em exportação/importação longas); R5 do #129 (IP em claro 6 meses no ALB, **bloqueia produção**); `origem` nos eventos do portal.

## Nota do Maestro (05/11/2026)

- **R1 (feita):** a reformatação saiu. O guard foi refeito sobre a versão da `main` e só tem a mudança real (16 linhas). O mesmo prettier sem configuração tinha posto aspas duplas no `vinculo-cruzado.rls.test.ts` do #134, que também voltou ao padrão do repo (aspas simples).
- **R2 (feita):** `PERFIS_NAO_CONFERIDOS` sai no máximo uma vez por clínica a cada 60 s (`registrarNoMaximoUmaVez`). A negação continua em toda requisição.
- **R3 e R4 (fila):** teste da `origem` do webhook, e `CREATE INDEX CONCURRENTLY` em produção com volume (o mesmo vale para a 0061).
- **R5:** o 503 de ponta a ponta fica coberto pelo filtro de exceções, que já tem teste próprio para banco indisponível.

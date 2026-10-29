# Estado da frente Engenharia — rodada 8 (11 e 12/10/2026)

Atualizado a cada entrega. Ordens vêm do Maestro (`.maestro/ordens-eng.md`), até a ORDEM-008.

## Feito (tudo na `main`)
- **#35 — S5, criptografia de campo por clínica:** migração 0004; destruição em duas fases; tabelas declaradas na guarda de schema; ordem global das travas `audit_chain` → `tenant_keys`.
- **#37 — S6, auditoria encadeada por clínica:** migração 0005 e contrato do metadata.
- **#30 — pendências de produção:** rate limit sem IP em claro e Redis obrigatório em produção.
- **#40 — ações novas na auditoria:** enum + migração 0006, com teste de paridade enum × CHECK.
- **#41 — eventos de chave usam `key_*`.**
- **Item 0 — #31 e #33 rebaseados:** conflito resolvido e lock regenerado.

## Falta
- Com a DevOps: SDK do KMS e IAM (quem cria e destrói chave separado de quem só usa); job de âncora da auditoria em S3 com Object Lock; R5 do rate limit (topologia).
- D7: o prazo de guarda (20 anos prontuário / 5 administrativo, configurável) espera o job de expurgo, que ainda não existe.

## CI da `main`
Parado em 12/10 à noite por cobrança da conta no GitHub Actions: os jobs não iniciam. A bateria completa na `main` (`e24031b`) foi rodada localmente e passou (números no relatório, §5 item 7).

**Resolvido.** Em 29/10 a conta voltou a rodar jobs. Os PRs desta aba ficaram com as execuções antigas marcadas como falha, porque a falha de cobrança marca o job como falho, e não como cancelado; só o `gh run rerun --failed` em cada execução limpa o estado. Refeitas as execuções do #44 ao #47 e do #55: passam 8 de 9 checks, e o único que falha é a **Auditoria de dependências**, por `multer` abaixo de 2.5.0 e por mais duas vulnerabilidades altas e duas críticas que já foram corrigidas na `main`. Ou seja: é atraso da branch, não defeito novo — some ao trazer a `main`.

## Ambiente de teste (sem Docker neste Mac)
Postgres 16.15 nativo em 127.0.0.1:5441 e Redis 8.10 em 6381, com dados em `~/Documents/Dev/projetos/.r8-dados/eng`.

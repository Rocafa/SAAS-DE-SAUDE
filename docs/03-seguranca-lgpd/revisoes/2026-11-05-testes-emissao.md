# Parecer do Guardião LGPD — PR #138 (`eng/testes-emissao-logs`): testes de emissão do log de segurança

- **Data:** 05/11/2026
- **Escopo:** `git diff main...eng/testes-emissao-logs`: 1 arquivo, `apps/api/src/security/emissao-de-eventos.test.ts` (+94). Só teste, sem mudança de código de produção.
- **Fecha:** R8 do parecer do #129 ([log de segurança](2026-11-04-log-de-seguranca.md)) **em parte**, e R3 do #136 ([robustez](2026-11-04-robustez-logs-sessao.md)) **por inteiro** (a origem do webhook).
- **Execução:** `npx vitest run src/security/emissao-de-eventos.test.ts src/security/log-de-seguranca.test.ts` num worktree do branch: **22/22 passam** (2 arquivos).

## Veredito: **APROVADO com ressalvas**

Nada bloqueia. Os 5 testes provam o que dizem. Os dados são todos sintéticos: UUIDs de teste, IP da faixa de documentação TEST-NET-3 (203.0.113.0/24), "Maria" e um CPF fictício só como isca de vazamento, e um segredo `Buffer.alloc(32, 9)`. Não há dado real nem segredo. O R8 continua **aberto em parte** (ver R1 e R2).

## O que os testes provam

| Teste | Prova | Conferido no código |
|---|---|---|
| Webhook com assinatura inválida | `WEBHOOK_ASSINATURA_INVALIDA`, `motivo: whatsapp`, `severidade: alto`, `origem` em hex de 16 caracteres, e o IP não aparece em nenhuma linha de warn/error | `whatsapp.controller.ts:123-127` |
| Leitura da equipe: padrão de páginas | Exatamente 1 `ALERTA_ANOMALIA` (`paginas_de_pacientes`) em 3 leituras, e `TRILHA_NAO_GRAVADA` quando o banco cai: o alerta não some | `vigilancia-de-leitura.ts:146-167` |
| Leitura da equipe: contador fora do ar | `RATE_LIMIT_FAIL_OPEN` aparece 1 vez em 5 leituras | `registrarNoMaximoUmaVez('fail_open:vigilancia_de_leitura', 60_000, …)` |
| Portal: resgate insistente | 1 `ALERTA_ANOMALIA portal_resgate`, 429 nas tentativas 3 e 4, e o id da conta fora do log | `portal-vigilancia.ts:108-116` |
| Exportação que falha | `EXPORTACAO_FALHOU` com `tenantId`, `userId` e `motivo: erro_interno`, e o texto do erro (nome e CPF de isca) não vai para o log | `exports.module.ts:47-49` |

## Ressalvas

- **R1 (fila, fecha o R8):** faltam testes do **rate limit por IP** em `http-security.ts`, que o R8 pedia pelo nome ("testes de emissão do rate limit"):
  - `RATE_LIMIT_EXCEDIDO` sai uma vez só, na requisição `max + 1`, com `origem` em HMAC e sem IP;
  - `RATE_LIMIT_FAIL_OPEN` com `motivo: rate_limit_por_ip`;
  - `CSRF_RECUSADO`, cuja chave de deduplicação já usa a origem.

  O `rate-limit-store.test.ts:145` só confere o texto livre do logger, não a linha JSON.
- **R2 (fila):** o portal só tem teste do resgate. Faltam:
  - `portal_limite_por_conta`;
  - `portal_teto_diario_pedidos`, que alerta uma vez por vínculo a cada 24 h;
  - `RATE_LIMIT_FAIL_OPEN` com `motivo: portal`;
  - `TRILHA_NAO_GRAVADA` quando o `runPortal` falha.

  O `bancoFora.runPortal` já existe no arquivo e nenhum teste o usa. O resgate nunca grava na trilha, então a asserção "nada da conta no log" é fraca. Ela pesa de verdade em `requisicao(contaId, vinculoId)`, onde o `alertar` recebe a conta.
- **R3 (fila, risco de teste instável):** `registrarNoMaximoUmaVez` guarda as últimas emissões num `Map` no nível do módulo, que o `restoreAllMocks` não limpa. O `toHaveLength(1)` do fail-open só passa porque nenhum teste anterior do arquivo usa a chave `fail_open:vigilancia_de_leitura`. Se um teste novo usar essa chave antes, este passa a dar 0. Correção: expor um reset só para teste, ou usar chave e relógio injetáveis (`agora`). Aproveitar e provar que a linha volta a sair depois de 60 s.
- **R4 (fila):** o teste do webhook tem duas folgas:
  - `rejects.toBeDefined()` não confere o status. Trocar por `toMatchObject({ status: 401 })`.
  - A `origem` só é checada por regex, o que não prova que vem do IP. Comparar com `origemDaRequisicao('203.0.113.9')`, ou ver que dois IPs diferentes dão valores diferentes.
- **R5 (fila):** há eventos que já saem nestes cenários e que ninguém confere:
  - na exportação, `TRILHA_NAO_GRAVADA` com `motivo: exportacao_falhou`: o banco falso também derruba o `registrarFalha`;
  - na leitura da equipe, o `motivo: alerta_de_anomalia` de `TRILHA_NAO_GRAVADA`, e que IP e dados de paciente não aparecem.

  A `severidade` só é conferida no webhook. Nos outros testes, conferir `critico` em `TRILHA_NAO_GRAVADA` e `alto` nos demais, porque é a severidade que liga o alarme.
- **R6 (fila):** `capturar()` só espia `Logger.prototype.warn` e `.error`. Um vazamento por `log`, `debug`, `verbose`, `fatal` ou `console.*` passaria sem ser visto pela asserção `not.toContain`. Correção: espiar também esses métodos no `tudo()`.

Fora do escopo deste PR, e anotado para a fila: os outros emissores também não têm teste de emissão. São eles `portal.service.ts` (`PORTAL_RESGATE_RECUSADO`), `nascimento-do-cadastro.ts`, `portal-clinica.service.ts`, `scheduling.service.ts` (`vinculo_cruzado`, `vinculo_autoagendado`) e `records/avisos.ts`.

## Nota do Maestro (05/11/2026)

- **R1 (feita):** testes do fail-open do rate limit por IP (a requisição segue e sai um único `RATE_LIMIT_FAIL_OPEN`, sem o IP) e do `CSRF_RECUSADO` (403, com a origem em HMAC; o `Origin` do atacante não vai para o log). O `RATE_LIMIT_EXCEDIDO` já tem teste na suíte ofensiva, desde o #136.
- **R2 (feita):** no portal, o limite por conta (alerta e, com o banco fora, `TRILHA_NAO_GRAVADA`, exercitando o `runPortal`), o teto diário de pedidos (alerta na primeira vez, 429 sempre) e o fail-open.
- **R3 (feita):** `zerarJanelasDoLog()` antes de cada teste. A contagem exata (`toHaveLength(1)`) não depende mais da ordem.
- **R4 (feita):** o webhook confere o 401 e que a origem é a do IP da requisição.
- **R5 e R6 (fila):** conferir todos os eventos e severidades de cada caminho, e espiar também `log` e `debug`.

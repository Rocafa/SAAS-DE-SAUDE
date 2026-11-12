# Runbook: anonimização da conta da equipe a pedido do titular (B10)

> Desenho: [anonimizacao-pelo-suporte.md](anonimizacao-pelo-suporte.md). Parecer do Guardião: `docs/03-seguranca-lgpd/revisoes/2026-11-12-desenho-anonimizacao-pelo-suporte.md`. Código: `apps/api/src/ops/anonimizar-conta.ts` e `apps/api/src/modules/auth/better-auth/anonimizacao.ts`.

**Quando usar:** uma pessoa da equipe de uma clínica (conta do login) pede a exclusão dos dados dela (LGPD art. 18 IV e VI). Paciente e eliminação de clínica inteira têm fluxos próprios.

**Prazo interno:** **15 dias corridos** do recebimento do pedido, enquanto a ANPD não regulamentar o art. 18 §5 (paralelo ao art. 19 II). O chamado registra as datas de recebido, identidade confirmada, executado e respondido.

## Quem faz

| Papel | O quê |
|---|---|
| **DPO (encarregado)** | recebe o pedido, confirma a identidade, decide se cabe, responde ao titular |
| **Executor** (pessoa da lista `principais_ops_lgpd`, que assume o papel `ops-lgpd` com MFA) | roda a tarefa avulsa do ECS |
| **Conferente** (outra pessoa) | confere o uuid antes de rodar e a saída depois |

Executor e conferente são pessoas diferentes, e os dois nomes vão no chamado operacional.

## Dois registros, separados (R7)

1. **Pedido no canal do DPO:** tem o contato do titular para responder. Retenção na `matriz-retencao.md` (proposta: 5 anos depois do atendimento, prova do art. 37).
2. **Chamado operacional `LGPD-<número>`:** só ids, datas e os nomes de quem executou e conferiu. **Nenhum dado pessoal do titular** (nem nome, nem e-mail).

## Antes de rodar

1. O DPO confere a identidade do titular como no RIPD §5 item 1. O documento é só exibido, nunca copiado.
2. O pedido é de **exclusão/anonimização**, não de acesso ou correção.
3. Não há **bloqueio legal ativo**: ordem judicial, incidente em investigação ou disputa sobre o e-mail. A guarda do prontuário **não** impede, porque o id da conta fica.
4. Se a conta tem **vínculo ativo** com alguma clínica, o titular é avisado de que perde o acesso a todas as clínicas na hora.
5. O conferente confere o uuid da conta com o DPO, sem e-mail nem nome no chamado operacional.

## Rodar

Tarefa avulsa do ECS na definição `<ambiente>-ops-anonimizacao`. O executor assume o papel `ops-lgpd` **com MFA e `--source-identity <seu usuário>`** (obrigatório na confiança do papel, como no break-glass) e roda a tarefa com essa sessão. A prova de quem rodou é o `ecs:RunTask` no CloudTrail, com a identidade de origem. Cada execução gera um alerta no tópico de segurança; um override com variável além de `CONFIRMA_ANONIMIZACAO`, troca de papel ou ECS Exec gera alerta crítico.

```bash
aws sts assume-role --role-arn <arn do papel ops-lgpd> --role-session-name LGPD-<n> \
  --source-identity <seu usuário> --serial-number <arn do seu MFA> --token-code <código>
```

```bash
aws ecs run-task --cluster <cluster> --task-definition <ambiente>-ops-anonimizacao --launch-type FARGATE \
  --network-configuration '<a mesma da API>' \
  --overrides '{"containerOverrides":[{"name":"ops-anonimizacao","command":["--usuario","<uuid>","--chamado","LGPD-<n>","--operador","<uuid do executor>"],"environment":[{"name":"CONFIRMA_ANONIMIZACAO","value":"<uuid>"}]}]}'
```

O programa é fixo no `entryPoint` da tarefa; o override leva **só os argumentos** e a variável `CONFIRMA_ANONIMIZACAO`. O `containerOverrides` fica no CloudTrail: só uuid e número do chamado, **nunca** nome ou e-mail.

**O conferente checa o override no CloudTrail** (evento `RunTask`): só os seis argumentos acima e só a variável `CONFIRMA_ANONIMIZACAO`. Qualquer outra variável (por exemplo `NODE_OPTIONS`) ou argumento fora do formato é incidente de segurança.

## Ler a saída (CloudWatch, prefixo `ops-anonimizacao`)

| Saída | Significa | O que fazer |
|---|---|---|
| `ok <uuid> clinicas=<n>` | anonimizada e conferida no banco | seguir para "Depois" |
| `ok <uuid> clinicas=<n> repetida` | já estava anonimizada; a trilha que faltava foi completada | seguir para "Depois" |
| `trava_incorreta` | `CONFIRMA_ANONIMIZACAO` diferente do `--usuario` | nada foi escrito; conferir o uuid e rodar de novo |
| `uso_incorreto` / `entrada_invalida` | argumento faltando ou fora do formato | nada foi escrito; corrigir |
| `nao_encontrada` | o uuid não é de nenhuma conta | nada foi escrito; voltar ao DPO |
| `conta_de_sistema` | uuid do ator de sistema | erro de digitação; nada foi escrito |
| `erro_parcial_rodar_de_novo` | credenciais apagadas, mas faltou trilha em alguma clínica | rodar de novo o mesmo comando (é idempotente) |
| `conferencia_falhou` / `erro_inesperado` | o estado no banco não é o esperado | abrir incidente; não responder ao titular ainda |

## Depois

1. Responder ao titular dentro do prazo, dizendo o que **fica** e por quê (art. 16 I e art. 18 §4):
   - o **id da conta**, que identifica a autoria do prontuário por 20 anos (CFM 1.821/2007);
   - o **nome e o registro profissional** em cada clínica, dos quais a clínica é a controladora (o pedido sobre eles vai à clínica);
   - os **eventos do log de segurança** até o fim dos 180 dias (Marco Civil).
2. Avisar cada clínica com vínculo (art. 18 §6), só com o id e o fato, sem o motivo do pedido.
3. Fechar o chamado operacional com as datas.

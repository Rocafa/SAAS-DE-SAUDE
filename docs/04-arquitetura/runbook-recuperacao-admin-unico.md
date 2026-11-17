# Runbook: recuperação do fator do admin único pelo suporte (B12)

> Desenho: [recuperacao-do-admin-unico.md](recuperacao-do-admin-unico.md). Parecer do Guardião: `docs/03-seguranca-lgpd/revisoes/2026-11-16-desenho-recuperacao-do-admin-unico.md` (R1 a R10). Código: `apps/api/src/ops/recuperar-admin-unico.ts`, `apps/api/src/modules/auth/better-auth/recuperacao-pelo-suporte.ts`, migração `0077`.

**Quando usar:** o **único** admin de uma clínica perdeu o segundo fator (TOTP) e **ainda sabe a senha**. Só o fator volta: o token exige a senha atual no uso.

**Quando NÃO usar (recuse e encerre o chamado):**
- Há outro admin ativo com fator na clínica: ele emite a recuperação pelo app (#159). O comando recusa com `ha_outro_admin`.
- A pessoa perdeu **senha e fator**: a recuperação completa é **vetada**. O caminho é a conta nova pelo provisionamento (B13).
- Quem pede **não é o titular da conta** (o admin saiu, faleceu ou não responde): isso é troca de admin pela clínica, pelo provisionamento (R9).

## Quem faz (duas pessoas, R6)

| Papel | O quê |
|---|---|
| **DPO** (ou quem ele designar) | confere a identidade do titular, decide se cabe, consulta o log de segurança |
| **Executor** (grupo nominal `ops-recuperacao`, com MFA) | roda a tarefa avulsa do ECS |
| **Entregador** (outra pessoa, nunca o executor) | lê o parâmetro do SSM **uma vez**, entrega o token ao titular e apaga o parâmetro |

Os dois nomes (executor e entregador) vão no chamado.

## Chamado `SUP-<número>`

Só ids, datas e nomes de quem executou e entregou. Registra: tipo de documento conferido (**sem número**), hora da ligação de retorno, resultado da consulta do log de segurança, motivo (lista fechada) e se as sessões foram derrubadas. **Nunca** cópia de documento, nome do titular ou e-mail.

## Conferência de identidade (R1 e R3 do parecer)

1. **A pessoa conferida é o titular da conta**: o nome no documento é o nome da conta. O documento é **só exibido**, nunca copiado (RIPD §5 item 1). Se o titular não é o signatário do contrato, o signatário confirma também, pelo canal do contrato.
2. **Ligação de retorno** só para o telefone do contrato cadastrado **antes** do chamado. Pedido para mudar o contato do contrato no mesmo chamado, ou nos 30 dias anteriores, **suspende** a recuperação até revisão do DPO.
3. **Log de segurança da conta, últimos 7 dias**: `LOGIN_FALHOU`, `MFA_FALHOU`, `MFA_BLOQUEADO`, origens novas. Sinal de ataque: **para** e o caso vai ao DPO.
4. **Roteiro de recusa à pressão** ("é urgente", "sou o dono", "o médico está esperando"): a resposta é o prazo do procedimento, sem exceção. Não há break-glass.

## Motivo e sessões (R5)

`--motivo` da lista fechada: `perdeu_o_aparelho`, `troca_de_aparelho`, `suspeita_de_invasao` ou `conta_bloqueada`. `--derrubar-sessoes` é **obrigatório** em todo motivo, menos `troca_de_aparelho` (C1 do parecer de 17/11): aparelho perdido, conta bloqueada ou suspeita de invasão podem deixar sessão aberta na mão de terceiro. O comando recusa sem ele.

## Rodar

Tarefa avulsa do ECS, definição própria só com `app_auth` e `app_user` (sem `BETTER_AUTH_SECRET`). O executor assume o papel com MFA e `--source-identity <seu usuário>`. O override leva **só** uuids, o chamado e o motivo; a única variável é a trava:

```bash
--overrides '{"containerOverrides":[{"name":"ops-recuperacao","command":["--clinica","<uuid>","--usuario","<uuid>","--chamado","SUP-<n>","--operador","<uuid do executor>","--motivo","perdeu_o_aparelho"],"environment":[{"name":"CONFIRMA_RECUPERACAO","value":"<uuid do usuário>"}]}]}'
```

**Saída** (uma linha): `ok <usuario> expira=<data> sessoes=<n>` ou um código fixo: `ha_outro_admin`, `nao_e_admin`, `conta_inativa`, `clinica_nao_encontrada`, `teto`, `chamado_invalido`, `motivo_invalido`, `derrubar_sessoes_obrigatorio`, `trava_incorreta`, `uso_incorreto`, `erro`. Código diferente de 0 na falha.

**Teto:** uma por clínica a cada 30 dias e duas por pessoa em 12 meses. Acima disso, revisão manual pelo DPO e pelos dois sócios, registrada no chamado com os três nomes (o comando ainda não aceita exceção).

## Entregar

1. O token fica no SecureString `/recuperacao-suporte/<usuario>/entrega` e vale **24 h**.
2. O **entregador** lê o parâmetro uma vez e entrega o token **só ao titular**: pela ligação de retorno (telefone do contrato) ou por vídeo com o titular presente. **Nunca** por e-mail, mensagem ou número informado no pedido.
3. Apaga o parâmetro logo depois. Se a tarefa falhou, o próprio comando já o apagou.
4. Aviso ao signatário pelo canal do contrato: "recuperação de fator emitida, chamado SUP-<n>; se não reconhece, responda" (R8).

**No uso**, o titular entra em `POST /recuperacao/usar` com o token e a senha atual. O TOTP antigo sai, as sessões caem e uma sessão de cadastro de 15 min serve só para cadastrar o TOTP novo. Se a pessoa deixou de ser admin ativo entre a emissão e o uso, o token não vale.

## Prova (R6)

- **Trilha da clínica:** `credential_recovery_issued` com ator **sistema** e `{ op, user_id, kind: 'fator', reason, via: 'suporte', ticket }`. Nunca o operador.
- **Log de segurança:** `RECUPERACAO_PELO_SUPORTE` na emissão (alarme imediato, com operador e chamado) e `RECUPERACAO_USADA` com `motivo: recuperacao_pelo_suporte` no uso.
- **CloudTrail:** o `RunTask` com o principal nominal.

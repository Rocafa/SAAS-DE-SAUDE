# Runbook: troca do admin único que perdeu senha e fator (B13)

> 24/11/2026 · Engenharia · Desenho: [`troca-do-admin-unico.md`](troca-do-admin-unico.md) (v2). Parecer: [`revisoes/2026-11-24-desenho-troca-do-admin-unico.md`](../03-seguranca-lgpd/revisoes/2026-11-24-desenho-troca-do-admin-unico.md). Código: `apps/api/src/ops/trocar-admin-unico.ts`, `apps/api/src/modules/auth/better-auth/troca-do-admin.ts` e `troca-do-admin-na-api.ts`; migração `0082_troca_do_admin_unico.sql`.
>
> **Padrões até a decisão dos sócios** (no código, como constantes com o comentário "padrão até decisão dos sócios"):
> - **P1:** janela de **48 h corridas** (`JANELA_DA_TROCA_HORAS`). O calendário de dias úteis fica para depois da decisão.
> - **P2:** suspender a conta antiga no pedido **só** com `--suspender-conta-antiga` **e** `--motivo suspeita_de_invasao`, e só com a decisão do DPO registrada no chamado.
> - **P5** e **P6** são procedimento, nas seções 2 e 9 abaixo.

## 0. Quando usar

Só quando **todas** valem:
- a clínica tem **um** admin ativo com fator;
- ele perdeu **a senha e o TOTP** (ou não está mais disponível: saiu, faleceu, não responde);
- o pedido chegou **pelo canal do contrato** (`CTR-<n>`).

Não use:
- se há outro admin com fator: ele resolve pelo app (a tarefa recusa com `ha_outro_admin`);
- se o admin só perdeu o fator e sabe a senha: é o B12 ([runbook da recuperação](runbook-recuperacao-admin-unico.md)).

**Nunca:** restaurar a conta antiga, reaproveitar o e-mail antigo, pular ou encurtar a janela, pular uma viva voz, entregar o token por e-mail, mensagem ou pelo canal do pedido, ou pôr dado pessoal em argumento, chamado ou log. Não há break-glass: a resposta à pressão é o prazo do procedimento.

## 1. As pessoas (P3: três pessoas do nosso lado, e o DPO não conta)

| Papel | Papel AWS | Faz |
|---|---|---|
| **DPO** (ou designado) | nenhum | confere a identidade (seção 2), decide se cabe, decide P2 e a retomada de troca suspensa |
| **Executor do pedido** | `<ambiente>-ops-provisionamento-executor` | grava o parâmetro do pedido e roda `--fase pedir` (e `cancelar`) |
| **Executor da emissão** (outra pessoa) | `<ambiente>-ops-provisionamento-executor` | roda `--fase emitir`. A tarefa recusa `mesmo_operador` se for quem rodou o `pedir` |
| **Entregador** (terceira pessoa) | `<ambiente>-ops-provisionamento-entrega` | lê a entrega **uma vez**, entrega o token e apaga. Não roda a tarefa |

Os quatro têm de ser pessoas diferentes, e o `SourceIdentity` de cada uma no CloudTrail tem de bater com o chamado.

## 2. Conferência (DPO)

O chamado `SUP-<n>` guarda só: ids e datas, o **tipo** de documento conferido (sem número), as **horas UTC** das ligações de viva voz e os nomes das pessoas do nosso lado. Nunca cópia de documento, nome do titular ou e-mail.

1. Confirmação **por escrito** do signatário, pelo canal do contrato.
2. **Caso (a), o titular perdeu os dois:** o titular mostra o documento em vídeo. Só exibido, nunca copiado. O nome tem de ser o da conta antiga.
3. **Caso (b), titular indisponível** (`--motivo titular_indisponivel`): a pessoa nova mostra o documento do mesmo jeito, e o signatário a indica por escrito.
   - **P5 (padrão até decisão dos sócios):** se o signatário é o próprio admin que saiu ou faleceu, **só o representante legal da clínica, com poderes comprovados** (contrato social, procuração ou documento equivalente conferido pelo DPO), indica o admin novo. Sem isso, o pedido **para**. O modelo do documento depende do advogado (D8); até lá, o DPO registra no chamado o tipo de documento conferido.
4. **Viva voz (R2), obrigatória duas vezes:** ligação **de retorno** ao telefone do contrato cadastrado **antes** do chamado.
   - a primeira no `pedir` (a hora vai em `--viva-voz`, e vale por até 24 h);
   - a segunda **depois da janela**, antes do `emitir` (a hora tem de ser posterior a `libera_em`).
   - Pedido para mudar o contato do contrato no mesmo chamado, ou nos 30 dias anteriores: **suspende** o pedido até o DPO revisar.
   - Sem provedor de e-mail (D3), a viva voz substitui o aviso ao e-mail antigo. O risco fica aceito até a D3 (RIPD §4/§8).
5. **Log de segurança da conta antiga, últimos 7 dias:** `LOGIN_FALHOU`, `MFA_FALHOU`, `MFA_BLOQUEADO`, `RECUPERACAO_*` e origens novas. **Login completo com sucesso** no período contradiz o "perdi os dois": o pedido para e vai ao DPO.

## 3. T0: `pedir` (executor do pedido)

1. Grave o e-mail **novo** num SecureString, a partir de arquivo, e apague o arquivo:

   ```sh
   printf '{"email":"%s"}' "<e-mail novo>" > /dev/shm/pedido.json
   aws ssm put-parameter --name "/troca-admin/<pedido>" --type SecureString \
     --key-id "alias/<ambiente>-ops-provisionamento" --tier Advanced --no-overwrite \
     --policies '[{"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"<agora + 72 h, ISO>"}}]' \
     --value file:///dev/shm/pedido.json
   shred -u /dev/shm/pedido.json
   ```

2. Rode a tarefa (override só com uuids, códigos, a hora e a lista fechada; `CONFIRMA_TROCA=<pedido>` no ambiente):

   ```sh
   node dist/ops/trocar-admin-unico.js --fase pedir --pedido <uuid> --clinica <uuid> --usuario <uuid da conta antiga> \
     --chamado SUP-<n> --contrato CTR-<n> --motivo <perdeu_senha_e_fator|titular_indisponivel|suspeita_de_invasao> \
     --operador <seu uuid> --viva-voz <hora UTC da 1a ligação, ex. 2026-11-24T14:05:00Z> [--suspender-conta-antiga]
   ```

   Saída: `ok <pedido> libera=<data> sessoes=<n>`. A tarefa apaga o parâmetro do pedido com sucesso ou com falha.

3. **Avisos do T0** (seção 7 do desenho):
   - o signatário, por escrito: "pedido de troca do admin aberto, chamado SUP-<n>; o token só sai depois de <libera>; se não reconhece, responda";
   - o telefone do contrato, na própria ligação de retorno;
   - a conta antiga recebe o aviso no app no próximo login (e o "não fui eu");
   - os outros membros da clínica **não** são avisados na janela; as outras clínicas da conta antiga **nunca** (P4).

| Saída | O que fazer |
|---|---|
| `ha_outro_admin` | o outro admin resolve pelo app (#159) |
| `ha_pedido_pendente` | já há troca ou recuperação do B12 aberta na clínica |
| `teto` | revisão manual (DPO e os dois sócios). O teto **soma** B12 e B13 |
| `email_em_uso` | o e-mail novo é o da conta antiga ou já é de uma conta. Peça outro (P10: só conta nova) |
| `viva_voz_ausente` | sem a ligação, ou hora fora do formato `AAAA-MM-DDTHH:MM[:SS]Z`, futura ou com mais de 24 h |
| `motivo_invalido` | `--suspender-conta-antiga` só com `suspeita_de_invasao` (P2) |
| `parametro_ausente` / `parametro_invalido` | refaça o passo 1 (JSON só com `email`) |

### P2: suspeita de invasão

Com a decisão do DPO registrada no chamado, `--motivo suspeita_de_invasao --suspender-conta-antiga` derruba as sessões da conta antiga e a deixa `suspensa_na_troca` até a conclusão ou o cancelamento (o cancelamento a reativa). **É incidente:** abra-o pelo procedimento de `docs/03-seguranca-lgpd/`. Um golpista com esse motivo tira o titular por até a janela inteira: por isso só com a decisão do DPO.

## 4. Janela (48 h corridas, P1)

Na janela ficam bloqueados: outra troca e a recuperação do B12, a mudança dos contatos do contrato e qualquer token para a conta nova. A conta antiga não é tocada (salvo P2).

Se a conta antiga fizer **login completo** (senha e TOTP) na janela, a troca vai a `suspensa` e sai `TROCA_DO_ADMIN_SUSPENSA` (crítico). Quem tem os dois fatores não é quem disse tê-los perdido: o DPO decide (seção 8).

## 5. Depois da janela: `emitir` (executor da emissão, outra pessoa)

1. **Segunda viva voz** com o telefone do contrato. Se o telefone não confirma ou não reconhece: **não emita**; rode `--fase cancelar --por contrato` (seção 7).
2. Rode:

   ```sh
   node dist/ops/trocar-admin-unico.js --fase emitir --pedido <uuid> --chamado SUP-<n> --operador <seu uuid> \
     --viva-voz <hora UTC da 2a ligação>
   ```

   Saída: `ok <pedido> ativacao expira=<data>`. A tarefa, numa transação: concede **só admin** à conta nova reservada (P8), com ator sistema na trilha; grava o token de ativação de **24 h** (P9); e grava a entrega em `/troca-admin/<pedido>/entrega`.

| Saída | O que fazer |
|---|---|
| `mesmo_operador` | outra pessoa roda o `emitir` (R4) |
| `janela_aberta` | espere `libera` |
| `viva_voz_ausente` | a 2a ligação tem de ser depois de `libera` |
| `ha_outro_admin` | outro admin ganhou fator na janela: a troca foi **cancelada**; ele resolve pelo app |
| `token_vigente` | já há token vivo: não reemita |
| `troca_suspensa` | DPO decide (seção 8) |
| `troca_encerrada` / `troca_vencida` | a troca acabou; um caso novo é pedido novo (o teto conta) |
| `entrega_pendente` | o entregador apaga a entrega antiga **sem ler** e o executor roda de novo |

## 6. Entrega, ativação e conclusão

1. **Entregador:** lê a entrega **uma vez** e apaga (`aws ssm get-parameter --with-decryption` e `aws ssm delete-parameter`). Entrega **só** à pessoa conferida na seção 2, por ligação ao telefone do contrato ou por vídeo. Nunca por e-mail, mensagem ou pelo canal do pedido.
2. **A pessoa** usa `POST /ativacao/usar` com o token, o e-mail novo, nome e senha. A conta nova nasce (só por aqui: R3) e abre a sessão de cadastro de 15 min. **Nada da conta antiga muda neste passo (R1).**
3. **A pessoa cadastra o TOTP.** Na confirmação do código, a troca se **conclui** (R1): a conta nova (admin, agora com fator) revoga todos os perfis da conta antiga **nesta** clínica, grava `admin_replaced`; as sessões e os tokens pendentes da conta antiga caem; sem vínculo restante, a conta antiga vira `substituida` (R5). Sai `ADMIN_SUBSTITUIDO`. Se a conclusão falhar no meio, o job `identidade-expurgo` a refaz no dia.
4. **Confirmação fora de banda** (como no B11): depois de `ADMIN_SUBSTITUIDO`, o entregador confirma com a pessoa e com o signatário que foi ela quem ativou.

**Se o TOTP não for confirmado** na sessão de cadastro, a troca fica `ativada`: a conta antiga continua admin e a clínica nunca fica sem admin com fator. Saída: a **reemissão única** pelo mesmo `--fase emitir`, com nova viva voz e outro operador. Ela sai como `ok <pedido> fator expira=<data>`: um token **só de fator** (24 h), que exige a senha que a pessoa criou (`POST /recuperacao/usar`). Uma segunda falha encerra a troca como `vencida`: o vínculo inerte é revogado e a conta nova sem fator é desligada.

**Se o token de ativação vencer sem uso**, o `emitir` seguinte faz a **única** reemissão (mesma reserva e mesmo vínculo); a seguinte encerra como `vencida`.

## 7. Cancelamento e "não fui eu"

| Canal | Quem | Como |
|---|---|---|
| Contrato (viva voz ou escrito do signatário), ou viva voz do `emitir` que não confirma | executor | `--fase cancelar --pedido <uuid> --chamado SUP-<n> --operador <uuid> --por contrato` |
| Decisão do DPO | executor | o mesmo, com `--por dpo` |
| App, pela conta antiga | o titular legítimo, com MFA recente | `POST /sessao/troca-do-admin/contestar`: troca `contestada`, `TROCA_DO_ADMIN_CONTESTADA` (crítico). **É incidente** |

O cancelamento invalida os tokens da conta nova, revoga o vínculo inerte (ator sistema na trilha) e reativa a conta antiga suspensa por P2. Sai `TROCA_DO_ADMIN_CANCELADA` e `admin_replacement_cancelled` na trilha.

## 8. Troca suspensa

A troca para em `suspensa` pelo login completo da conta antiga. O DPO decide:
- **cancelar** (`--fase cancelar --por dpo`), o caso normal: alguém com os dois fatores apareceu. Investigue como incidente.
- retomar: o banco aceita `suspensa → aguardando` só pelo papel da tarefa, mas **o comando ainda não tem essa fase**. Até lá, cancele e, se couber, abra pedido novo com a revisão do teto.

## 9. Depois da conclusão

- **Login da conta substituída:** `CONTA_SUBSTITUIDA_ENTROU` (crítico, ao DPO), também na trilha da clínica (`replaced_account_login`). Inclui a senha certa de uma conta já `substituida`. **É incidente**: quem tem os fatores da conta antiga não é quem disse tê-los perdido, ou a conta está na mão de terceiro.
- **P6 (padrão até decisão dos sócios), reversão depois da conclusão:** nada se desfaz sozinho. Uma contestação tardia é **incidente**. Quem decide a reversão: **o DPO e os dois sócios**, juntos. Até a decisão, as **sessões da conta nova ficam suspensas** (o operador de banco derruba as sessões dela pelo runbook de incidente, e o fato vai ao chamado). A conta antiga **não** volta a valer (`substituida` é definitiva); se a decisão for reverter, o titular legítimo recebe conta nova por convite de um admin, ou por uma troca nova.
- A conta antiga **não** é apagada nem anonimizada por este fluxo (o id identifica o autor do prontuário). Como `substituida`, ela passa pelo expurgo de 90 dias (senha, TOTP, sessões, e-mail e nome). Anonimização só a pedido do titular, pelo B10.
- Perfis da conta antiga em **outras** clínicas não mudam, e as outras clínicas não são avisadas (P4). Lá, o caminho é convite novo para o e-mail novo.
- A conta nova **não herda** perfis (P8): o admin novo concede pelo fluxo normal.

## 10. Retenção

| Dado | Prazo |
|---|---|
| Linha da troca (ids, códigos, estado, operador do pedido) | 13 meses (o trigger só deixa sair troca encerrada) |
| HMAC do e-mail novo na troca | zerado na emissão ou no encerramento |
| Token de ativação `origem = 'troca'` | 30 dias (sem a exceção A2) |
| Parâmetros SSM | apagados no uso; vencimento de 72 h (pedido) e 24 h (entrega) |
| Log de segurança | 180 dias |

## 11. Infra

Está no Terraform (`infra/terraform/staging/ops-provisionamento.tf`, PR `devops/infra-troca-do-admin`, sobre o #204). A troca **amplia** o provisionamento, sem papel novo:

- **Definição de tarefa** própria, família `<ambiente>-ops-troca-admin` (output `ops_troca_admin_task_definition`), com o entryPoint fixo `/nodejs/bin/node dist/ops/trocar-admin-unico.js`. É outra família só porque o entryPoint fixa o programa (o override troca só os argumentos). Papéis de execução e de tarefa, segredos (`DATABASE_PROVISIONAMENTO_URL` e `RATE_LIMIT_HASH_KEY`), ambiente, grupo de segurança e log group são os do provisionamento; as travas (segredos, ambiente, listas disjuntas) valem para as duas definições, e cada uma exige o entryPoint **exato** do seu programa: a definição da troca não roda o provisionamento, nem o contrário. Log: prefixo `ops-troca-admin/`.
- **RunTask:** cluster e rede do output `ops_provisionamento_rede`; `containerOverrides[0].name = "ops-troca-admin"`, `command` com os argumentos da seção 3 ou 5 (sem `node` nem o script) e `environment = [{ name = "CONFIRMA_TROCA", value = "<pedido>" }]`. Qualquer outra variável, `environmentFiles`, troca de papel ou ECS Exec dispara o alerta crítico `<ambiente>-ops-provisionamento-override-suspeito`; toda execução dispara `<ambiente>-ops-provisionamento-execucao`.
- **SSM:** `/troca-admin/<pedido>` (pedido, 72 h) e `/troca-admin/<pedido>/entrega` (token, 24 h), SecureString Advanced com a chave `alias/<ambiente>-ops-provisionamento`. Nos caminhos da troca o IAM nega `PutParameter` com `Overwrite=true` ou sem política `Expiration`. **O IAM só exige que exista um vencimento; não limita o prazo.** Os 72 h do pedido estão no comando da seção 3 (quem confere é o operador), e os 24 h da entrega estão em `apps/api/src/ops/parametros-ssm.ts` (`VALIDADE_DA_ENTREGA_HORAS.troca`), cobertos pelo teste do cliente SSM.
- **Chave KMS:** a do provisionamento, reaproveitada: quem decifra são os mesmos dois papéis (a tarefa e o entregador), e o IAM separa os caminhos pelo `PARAMETER_ARN` do contexto de cifra. **Desligar ou agendar a exclusão da chave `ops-provisionamento` para os dois fluxos de uma vez** (provisionamento e troca): os pedidos e entregas pendentes dos dois deixam de ser lidos. Num incidente da troca, prefira negar no IAM os caminhos `/troca-admin/*`.
- **IAM:**
  - executor (`ops-provisionamento-executor`): roda as duas definições, grava e apaga o pedido, e **nunca** lê, grava ou apaga a entrega;
  - tarefa: lê e apaga o pedido, grava a entrega e só a apaga se a rodada do `emitir` falhar depois de gravá-la; nunca a lê;
  - entregador (`ops-provisionamento-entrega`): o único que lê a entrega; apaga, e não roda nem grava nada.
  O `emitir` por outra pessoa que não a do `pedir` é garantido no código (`mesmo_operador`), não no IAM: os dois usam o papel executor.
- **Alertas:** leitura ou apagamento de `/troca-admin/*/entrega` (`<ambiente>-ops-provisionamento-entrega`) e entrega vencida sem retirada (`<ambiente>-ops-entrega-vencida`).
- **VPC endpoint SSM:** a política inclui `/troca-admin/*`. Só existe com `endpoint_ssm = true`; sem ele a tarefa falha fechada (`ssm_nao_configurado` ou `erro`).
- Papéis de máquina não rodam a definição da troca nem tocam `/troca-admin/*` (Deny explícito).

Antes da primeira troca real em produção: aprovação dos sócios para o apply, as duas listas de principais preenchidas e disjuntas no tfvars, e `endpoint_ssm = true`.

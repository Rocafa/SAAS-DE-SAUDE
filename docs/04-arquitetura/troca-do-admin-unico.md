# Admin único que perdeu senha e fator: troca por conta nova (B13)

> 24/11/2026 · Engenharia · **desenho v2, sem código.** O Guardião aprovou o v1 com ressalvas: [`revisoes/2026-11-24-desenho-troca-do-admin-unico.md`](../03-seguranca-lgpd/revisoes/2026-11-24-desenho-troca-do-admin-unico.md). Este v2 incorpora as ressalvas R1 a R5 e as decisões do Guardião sobre P3, P4, P7, P8, P9 e P10, marcadas no texto como **[R1]** a **[R5]** e **[P3]** etc. Ficam abertas aos sócios as perguntas P1, P2, P5 e P6 (seção 15). O v1 está no histórico do git. Item **B13** do checklist (`docs/03-seguranca-lgpd/prontidao-producao.md`).
>
> **Base:**
> - resposta 4 do [parecer de 16/11 sobre a recuperação do admin único](../03-seguranca-lgpd/revisoes/2026-11-16-desenho-recuperacao-do-admin-unico.md): recuperação completa **vetada**; caminho decidido: conta nova com outro e-mail, ativada pelo provisionamento, revogação do vínculo antigo e 48 h de espera. Também a R9 do mesmo parecer;
> - [RIPD-identidade](../03-seguranca-lgpd/RIPD-identidade.md) §5 itens 1, 6, 7 e 8, e §5a ("nenhum token restaura os dois fatores");
> - B11: [provisionamento-da-clinica.md](provisionamento-da-clinica.md) e o [runbook do provisionamento](runbook-provisionamento-da-clinica.md);
> - B12: [recuperacao-do-admin-unico.md](recuperacao-do-admin-unico.md) e o [runbook da recuperação](runbook-recuperacao-admin-unico.md);
> - pareceres de 17/11 sobre o código (#195, #199, #203, #205, #206, #207, #208).
>
> **Código lido** (branch `eng/clinica-sem-fundador`, #208):
> - `provisionamento.ts` e `recuperacao-pelo-suporte.ts`;
> - `provedor.ts`: `usarAtivacao`, `consumirAtivacao`, `clinicaLiberada` e o expurgo;
> - `ops/provisionar-clinica.ts`, `ops/recuperar-admin-unico.ts` e `ops/parametros-ssm.ts`;
> - migrações 0069, 0072 e 0076 a 0081.

**Convenção:** **FATO** é o que foi conferido no código, numa migração ou num parecer citado. **ESTIMATIVA** é um número ou uma suposição nossa, sem medição.

## 1. O problema em uma frase

A clínica tem **um só** admin ativo com fator, e ele perdeu **a senha e o TOTP**.

- O B12 não serve: o token de fator exige a senha atual (FATO: `usarRecuperacao`, tipo `fator`).
- A recuperação completa é **vetada**: nenhum token restaura os dois fatores (FATO).

Então a pessoa **não volta** para a conta antiga. Ela recebe uma **conta nova**, com **outro e-mail**, que vira admin da mesma clínica. Há uma espera de **48 h** entre o pedido e a emissão do token. O vínculo antigo só cai quando a conta nova já tem fator **[R1]**.

## 2. Escopo

| Caso | Este desenho? |
|---|---|
| (a) O titular da conta de admin perdeu senha e fator | **Sim** (motivo `perdeu_senha_e_fator`) |
| (b) Quem pede **não é** o titular: o admin saiu, faleceu ou não responde (R9 do B12) | **Sim**, pelo mesmo comando (motivo `titular_indisponivel`), com a conferência do item 3.2. A conta nova é da pessoa nova, nunca "a do antigo admin" |
| Há outro admin ativo com fator | **Não**: ele resolve pelo app (#159). O comando recusa com `ha_outro_admin` |
| O admin ainda sabe a senha e só perdeu o fator | **Não**: é o B12 |
| Conta antiga com suspeita de invasão (alguém trocou a senha e o fator) | **Sim**, com `suspeita_de_invasao` e a seção 6.3. **Também é incidente** (`docs/03-seguranca-lgpd/`) |

## 3. Quem pode pedir e como a identidade é conferida

### 3.1 Quem pede

- **Só pelo canal do contrato** (`CTR-<n>`): o signatário ou o responsável indicado no contrato. Pedido fora desse canal é recusado.
- O caso abre o chamado `SUP-<n>`. O chamado guarda só:
  - ids e datas;
  - o tipo de documento conferido, sem o número;
  - as horas das ligações de viva voz;
  - os nomes das três pessoas da seção 3.3.

  **Nunca** guarda cópia de documento, nome do titular ou e-mail.

### 3.2 Conferência (DPO ou quem ele designar)

1. **Confirmação por escrito do signatário**, pelo canal do contrato (resposta 4).
2. **Caso (a):** o titular mostra o documento em vídeo. O documento é **só exibido**, nunca copiado (RIPD §5 item 1). O nome do documento tem de ser o nome da conta antiga.
3. **Caso (b):** a pessoa nova mostra o documento do mesmo jeito, e o signatário a indica por escrito. Se o signatário é o próprio admin que saiu ou faleceu, ver **P5** (seção 15).
4. **Confirmação de viva voz obrigatória [R2]:** é uma ligação de retorno ao telefone do contrato cadastrado **antes** do chamado, e acontece **duas vezes**:
   - no `pedir`;
   - **de novo** antes do `emitir`, já depois da janela.

   Sem as duas, a tarefa não roda. A hora de cada ligação vai no chamado, e a tarefa exige a confirmação como argumento (`--viva-voz <hora UTC>`, conferida contra a janela). Isso substitui o e-mail antigo como canal de contestação até existir um provedor de e-mail (D3). Pedido para mudar o contato do contrato no mesmo chamado, ou nos 30 dias anteriores, **suspende** o pedido até a revisão do DPO.
5. **Log de segurança da conta antiga, últimos 7 dias:** `LOGIN_FALHOU`, `MFA_FALHOU`, `MFA_BLOQUEADO`, `RECUPERACAO_*` e origens novas. Um **login completo com sucesso** nesse período contradiz o "perdi os dois": o pedido para e vai ao DPO.
6. **Roteiro de recusa à pressão:** a resposta é o prazo do procedimento. Não há break-glass.

### 3.3 Três pessoas do nosso lado, e o DPO não conta [P3, R4]

| Papel | Papel AWS (reaproveitado) | O quê |
|---|---|---|
| **DPO** (ou designado) | nenhum | confere a identidade e decide se cabe. **Não** pode ser nenhum dos três abaixo |
| **Executor do pedido** | `<ambiente>-ops-provisionamento-executor` | grava o pedido no SSM e roda `pedir` (e `cancelar`) |
| **Executor da emissão** (outra pessoa) | `<ambiente>-ops-provisionamento-executor` | roda `emitir`. A tarefa recusa com `mesmo_operador` se for quem rodou o `pedir` **[R4]** |
| **Entregador** (uma terceira pessoa) | `<ambiente>-ops-provisionamento-entrega` | lê a entrega uma vez, entrega o token e apaga. **Não** roda a tarefa |

O operador do `pedir` é guardado na linha `identidade.troca_do_admin` (coluna `operador_pedido`), **só no schema identidade**, nunca na trilha da clínica **[R4]**. A prova continua sendo o `SourceIdentity` no CloudTrail: os três têm de ser diferentes e bater com o chamado.

## 4. Fluxo passo a passo

O fluxo reaproveita, sem caminho paralelo:
- a **tarefa avulsa do ECS** do provisionamento: papel `app_provisionamento` (0080), chave KMS do fluxo, rede própria e alerta em toda execução;
- o **SSM SecureString** com `Expiration` e `Overwrite: false` (`parametros-ssm.ts`);
- os papéis **executor e entrega disjuntos** (#204);
- o **token de ativação de uso único** (`ativacao_do_fundador`, `POST /ativacao/usar`), com o mesmo 404, o contador de falhas, a conferência do e-mail pelo HMAC, a senha conferida contra vazadas e a sessão de cadastro pendente de 15 min (R8 intacta).

O comando novo é `ops/trocar-admin-unico.ts`, com as fases `pedir`, `emitir` e `cancelar`. Cada fase é uma execução da tarefa, com trava própria (`CONFIRMA_TROCA=<pedido>`).

### T0: fase `pedir` (executor do pedido)

1. O executor grava o pedido num SecureString `/troca-admin/<pedido>`: chave do fluxo, camada Advanced, vencimento de 72 h, `--no-overwrite`. O conteúdo é **só** `{"email": "<e-mail novo>"}`, lido de arquivo e apagado com `shred -u`.
2. Roda a tarefa com:
   - `--fase pedir --pedido <uuid> --clinica <uuid> --usuario <uuid da conta antiga>`;
   - `--chamado SUP-<n> --contrato CTR-<n> --motivo <lista fechada>`;
   - `--operador <uuid> --viva-voz <hora UTC>` **[R2]**.

   O override leva só uuids, códigos, a hora e a lista fechada.
3. A tarefa confere, sob a trava consultiva **compartilhada com o B12** (`admin-unico:<clinica>`), nesta ordem:
   1. a clínica existe;
   2. `usuario` é admin ativo dela;
   3. **nenhum outro** admin ativo tem fator verificado (`ha_outro_admin`);
   4. não há troca nem recuperação do B12 pendente na clínica (`ha_pedido_pendente`);
   5. o teto (seção 8);
   6. o e-mail novo **não é** o da conta antiga (`identidade.email_da_conta_confere`, que já existe) **e** não pertence a nenhuma conta (`identidade.conta_por_email`, que já existe). Os dois casos saem `email_em_uso` **[P10: só conta nova]**. **O e-mail antigo nunca é reaproveitado.**
4. Grava `identidade.troca_do_admin` com:
   - estado `aguardando` e `libera_em` (seção 7);
   - o HMAC do e-mail novo (uso `ativacao-email`);
   - o uuid **reservado** da conta nova;
   - `operador_pedido` **[R4]**.
5. Na trilha da clínica, grava `admin_replacement_requested` (ator **sistema**). No log de segurança, emite `TROCA_DO_ADMIN_PEDIDA` com o operador e o chamado. **Apaga o parâmetro do pedido** com sucesso ou com falha.
6. Com `suspeita_de_invasao`, aplica a seção 6.3.
7. Faz os avisos da seção 7.

### Janela

A janela está descrita na seção 7.

### Depois da janela: fase `emitir` (executor da emissão)

1. **Antes** de rodar, uma nova confirmação de viva voz com o telefone do contrato **[R2]**.
2. Roda `--fase emitir --pedido <uuid> --chamado SUP-<n> --operador <uuid> --viva-voz <hora UTC>`. A hora tem de ser **posterior** a `libera_em`.
3. A tarefa confere, sob a mesma trava:
   - o operador é diferente de `operador_pedido` (senão, `mesmo_operador`) **[R4]**;
   - a linha está `aguardando` e `now() >= libera_em` (senão, `janela_aberta`);
   - a troca não foi contestada, suspensa nem cancelada;
   - a conta antiga segue admin ativo;
   - **ainda** não há outro admin com fator. Se houver, sai `ha_outro_admin` e a troca vai a `cancelada`.
4. Numa transação:
   1. concede o perfil **admin** ao uuid reservado, na sessão de sistema, com `member_grant` (ator sistema, `via: 'troca_do_admin'`, `ticket`). Precisa do ramo novo do `clinic_members_guard` (seção 10). **Só admin**: a conta nova **não herda** nenhum outro perfil da antiga **[P8]**;
   2. cria a linha de ativação com:
      - `origem = 'troca'`, o chamado e a troca;
      - o HMAC copiado da troca e `conta_existente = false`;
      - validade de **24 h** **[P9]**.
   3. passa a troca a `emitida` e zera o HMAC dela;
   4. grava o token em `/troca-admin/<pedido>/entrega` pelo `guardarToken`, dentro da transação.
5. Emite `ATIVACAO_EMITIDA` com `motivo: 'troca_do_admin'`.

### Entrega (entregador)

É igual ao passo 4 do runbook do provisionamento: o entregador lê uma vez e apaga. Entrega **só** à pessoa conferida no item 3.2, pela ligação ao telefone do contrato ou por vídeo. **Nunca** por e-mail, por mensagem ou pelo canal de onde veio o pedido.

### Ativação: `POST /ativacao/usar` (a pessoa)

A rota é a que já existe. Para `origem = 'troca'`, `consumirAtivacao` muda em dois pontos:
1. **Conferência do alvo:** em vez de `tenants.founder_user_id = usuario_id` (FATO: `FundadorNaoConfere`), confere que a pessoa tem o vínculo admin ativo da emissão **e** que a troca está `emitida`. **O `founder_user_id` não muda** (FATO: imutável fora da correção sob incidente, 0047/0080).
2. **A conta nasce aqui**, com o uuid reservado. Este é o **único** caminho em que o `usuario_novo` de uma troca nasce **[R3]** (seção 10.2). A troca passa a `ativada`.

A rota abre a sessão de cadastro pendente de 15 min. **Nada da conta antiga muda neste passo [R1].**

### Conclusão: TOTP da conta nova confirmado [R1]

A troca só se conclui quando a conta nova **confirma o TOTP** (o `enable` aceito na sessão de cadastro). No mesmo fluxo da confirmação:

1. **Na clínica**, a conta nova age como ator da sessão: já é admin ativo e agora tem fator, então o `clinic_members_guard` de hoje aceita.
   - Revoga **todos** os perfis da conta antiga **nesta** clínica, com `member_revoke` (`via: 'troca_do_admin'`, `ticket`). A regra "a clínica não fica sem admin ativo" fica satisfeita.
   - Grava `admin_replaced`.
2. **No `app_auth`**:
   - a troca vai a `concluida`;
   - as sessões da conta antiga caem (todas, de qualquer clínica);
   - os tokens pendentes da conta antiga são invalidados;
   - a conta antiga segue a seção 6.
3. Sai `ADMIN_SUBSTITUIDO` no log de segurança.

Se a confirmação do TOTP falhar, a revogação também não acontece: os dois ficam na mesma transação, ou a revogação roda logo depois e é refeita pelo job da seção 10.2 (o detalhe fica para o PR de código).

**Se o TOTP não for confirmado** dentro da sessão de cadastro, a troca fica `ativada`. A conta antiga continua admin, e a clínica nunca fica sem admin com fator. A saída é a **reemissão única** (`--fase emitir` de novo, com nova viva voz e outro operador). Para uma conta `ativada`, a reemissão emite um **token só de fator** (tipo `fator` do #159, `origem = 'suporte'`, com o chamado da troca e 24 h). Ele exige a senha que a pessoa acabou de criar. A conferência `ha_outro_admin` ignora a conta antiga da própria troca. Uma segunda falha encerra a troca como `vencida`: o vínculo inerte é revogado e a conta nova sem fator é desligada.

**Confirmação fora de banda** depois de `ADMIN_SUBSTITUIDO`, como no B11: o entregador confirma com a pessoa e com o signatário.

### Reemissão e vencimento do token

- Se a ativação vence sem uso, a troca vai a `liberada_sem_token` e aceita **uma** reemissão, com a mesma reserva e o mesmo vínculo.
- A segunda falha encerra a troca como `vencida`.
- O vínculo admin do uuid reservado fica **inerte** enquanto a conta não existe. Ele é revogado em `vencida` e em `cancelada` (seção 10.2).

## 5. Cancelamento e "não fui eu"

| Canal | Quem | Efeito |
|---|---|---|
| **Contrato**: viva voz ou escrito do signatário | o executor roda `--fase cancelar --por contrato` | troca `cancelada` e `TROCA_DO_ADMIN_CANCELADA`. Se o token já foi emitido, ele é invalidado e o vínculo inerte é revogado. É incidente |
| **Viva voz antes do `emitir`** [R2] | o telefone do contrato não confirma ou diz que não reconhece | o `emitir` não roda e a troca vai a `cancelada` (`--por contrato`) |
| **App, pela conta antiga** | o titular legítimo, se ainda entra: aviso fixo depois do login e botão "não fui eu" (`POST /conta/troca-do-admin/contestar`, com MFA recente) | troca `contestada`, `TROCA_DO_ADMIN_CONTESTADA` (crítico) e `admin_replacement_contested` na trilha. É incidente |
| **Login completo da conta antiga antes da conclusão** | automático | troca `suspensa` e `TROCA_DO_ADMIN_SUSPENSA` (crítico). O DPO decide |
| **Login completo da conta antiga depois da conclusão** [R5] | automático | `CONTA_SUBSTITUIDA_ENTROU`, alarme **crítico** ao DPO. Quem tem os dois fatores da conta antiga não é quem disse tê-los perdido, ou a conta está na mão de terceiro. É incidente |
| **E-mail antigo** | — | **não existe** até haver provedor de e-mail (FATO: D3 está na fila). O risco fica aceito até a D3 no RIPD §4/§8 **[R2]** |

Depois de `concluida`, nada se desfaz sozinho. Uma contestação tardia é incidente e segue **P6** (seção 15).

## 6. Conta antiga, vínculo antigo e dados pessoais

### 6.1 Vínculo

- O vínculo antigo é **revogado só na conclusão**, com o TOTP da conta nova confirmado **[R1]**. Até lá, a conta antiga segue admin ativo, salvo com `suspeita_de_invasao`.
- Os perfis em **outras** clínicas **não** são tocados, e as outras clínicas **não são avisadas [P4]**. Cada clínica é controladora do próprio vínculo (RIPD §0). Lá, o caminho é o do RIPD §5 item 1: convite novo para o e-mail novo.

### 6.2 A conta antiga em si

- **Não é apagada nem anonimizada** por este fluxo. O id identifica o autor do prontuário por 20 anos (FATO: R18).
- **No último vínculo, ela vira `substituida` [R5]**, quando o fluxo revoga o último ou quando o último cair depois em outra clínica. Para isso, a linha `troca_do_admin` `concluida` marca a conta, e o trigger e o expurgo passam a usar `substituida`, e não `sem_vinculo`, para toda conta com troca concluída. `substituida`:
  - **nunca** volta a valer numa concessão: `sem_vinculo` é reativada pelo trigger da 0069/0071 (FATO), `substituida` não;
  - é recusada pela guarda da 0072 para perfil novo;
  - passa pelo `identidade-expurgo` em 90 dias, que apaga senha, TOTP, sessões e tokens, libera o e-mail e tira o nome.
- **Anonimização** (art. 18) só a pedido do titular, pelo B10.
- O **e-mail antigo** fica preso à conta antiga até o expurgo ou a disputa (RIPD §5 item 3). Este fluxo **nunca** o passa para a conta nova.

### 6.3 Suspeita de invasão

Com `--motivo suspeita_de_invasao`, o `pedir` **derruba as sessões** da conta antiga e a **suspende** até a conclusão ou o cancelamento, como na disputa de e-mail (RIPD §5 item 3). Um golpista que use esse motivo tira o titular legítimo por até a janela inteira. **P2** (seção 15) está com os sócios. A recomendação técnica é exigir a decisão do DPO registrada no chamado antes de rodar.

## 7. A janela

**Para que serve:** dar ao titular legítimo a chance de contestar (resposta 4).

**Tamanho:** 48 h, conferidas pelo CHECK `libera_em >= pedido_em + 48 h`. Se serão corridas ou com um dia útil inteiro é **P1** (seção 15). Se os sócios adotarem a recomendação, a tarefa calcula `libera_em` com o calendário de dias úteis (ESTIMATIVA: até cerca de 96 h num pedido de sexta à noite).

**Bloqueado durante a janela, e até a conclusão:**
- outra troca e a recuperação do B12 (`ha_pedido_pendente`);
- mudança dos contatos do contrato (suspende a troca);
- emissão de qualquer token para a conta nova.

A conta antiga **não** é tocada, salvo com `suspeita_de_invasao`.

**Avisos no T0:**
1. O **signatário**, por escrito pelo canal do contrato: "pedido de troca do admin aberto, chamado SUP-<n>; o token só sai depois de <data>; se não reconhece, responda".
2. O **telefone do contrato**, por viva voz, na própria ligação de retorno do `pedir`. A segunda ligação acontece antes do `emitir` **[R2]**.
3. A **conta antiga**, por aviso no app no próximo login.
4. O **e-mail antigo**: só depois da D3.
5. Os outros membros da clínica **não** são avisados na janela. Na conclusão, recebem só o fato.

## 8. Tetos e limites

| Limite | Valor | Base |
|---|---|---|
| Por clínica, **somando** B12 e B13 | 1 a cada 30 dias | resposta 4 do parecer de 16/11 |
| Por pessoa (conta antiga), somando B12 e B13 | 2 em 12 meses | resposta 3 do parecer de 16/11 |
| Pendentes por clínica | 1 | índice parcial e trava compartilhada |
| Reemissões por troca | 1 (token de ativação ou, se `ativada`, token de fator) | seção 4 |
| Tentativas de e-mail na ativação | 5 | FATO: 0076 |

- Troca contestada, suspensa ou cancelada **conta** para o teto.
- Acima do teto, vale a revisão manual: o DPO e os dois sócios, com `--revisao SUP-<n>`.
- A contagem cruza `recuperacao` (`origem = 'suporte'`) e `troca_do_admin`.
- O teto estourado sai `teto` e gera `TROCA_DO_ADMIN_TETO`.

## 9. Validade do token [P9]

O token vale **24 h** para `origem = 'troca'`. O CHECK da 0076 passa a ser por origem: 72 h para `provisionamento` e 24 h para `troca`.

## 10. O que o banco precisa [P7: ampliar o `app_provisionamento`]

O princípio é o da 0080:
- **Tabelas da clínica:** ramos nos triggers com `pg_has_role(session_user, 'app_provisionamento', 'MEMBER')`, **sem** SECURITY DEFINER (FATO: 0047/0080).
- **Schema identidade:** funções SECURITY DEFINER **estreitas**, pela chave, com `SET search_path = pg_catalog, identidade, pg_temp`.

### 10.1 Tabelas e colunas

- **`identidade.troca_do_admin`** (nova). Colunas:
  - `id` (o pedido), `clinica_id`, `usuario_antigo` e `usuario_novo`;
  - `operador_pedido` **[R4]**;
  - `email_hmac` (zerado na emissão e no encerramento);
  - `motivo`, `chamado` e `contrato`;
  - `pedido_em` e `libera_em`, com CHECK `libera_em >= pedido_em + 48 h`;
  - `estado`: `aguardando`, `emitida`, `liberada_sem_token`, `ativada`, `concluida`, `contestada`, `suspensa`, `cancelada` ou `vencida`;
  - `encerrada_em` e `encerrada_por`;
  - `reemissoes`, de 0 a 1.

  Também tem o CHECK `usuario_novo <> usuario_antigo` e um índice único parcial por clínica com estado não final.
- **`ativacao_do_fundador`:** ganha `origem`, `chamado` e `troca_id`. CHECK de coerência: `origem = 'troca'` exige chamado, troca e `conta_existente = false`. A validade passa a ser por origem.
- **`identidade.usuario`:** `inativa_por` ganha `substituida`.

### 10.2 Triggers

- **Transições de `troca_do_admin` [R3]:** um trigger `BEFORE UPDATE` aceita só o grafo abaixo. Qualquer outra mudança de estado, ou de coluna fora de estado, encerramento, reemissões e `email_hmac` (que só pode ser zerado), sai 42501.

  | Estado de origem | Estados de destino |
  |---|---|
  | `aguardando` | `emitida`, `contestada`, `suspensa`, `cancelada` |
  | `suspensa` | `aguardando` (só com revisão do DPO), `cancelada` |
  | `emitida` | `ativada`, `liberada_sem_token`, `contestada`, `suspensa`, `cancelada` |
  | `liberada_sem_token` | `emitida` (com `reemissoes = 1`), `vencida`, `cancelada` |
  | `ativada` | `concluida`, `contestada`, `suspensa`, `cancelada`, `vencida` (com o token de fator da reemissão vencido) |
  | `concluida`, `contestada`, `cancelada`, `vencida` | **finais**: nenhum |

  O DELETE só vem do expurgo de 13 meses.
- **Nascimento do `usuario_novo` [R3]:** um trigger em `identidade.usuario` (INSERT) recusa criar a conta cujo id é o `usuario_novo` de uma troca, a menos que, na mesma transação, a ativação `origem = 'troca'` daquela troca tenha sido consumida (o `usado_em` gravado nesta transação). Na prática, só `consumirAtivacao` cria essa conta, e um convite, um aceite ou um INSERT avulso com o uuid reservado é recusado. Teste: inserir o uuid reservado fora da ativação sai 42501.
- **`clinic_members_guard`, concessão:** na sessão de sistema, com login membro de `app_provisionamento`, só perfil `admin`, `granted_by` igual ao sentinela, e só para o `usuario_novo` de uma troca `aguardando` com `libera_em <= now()`. A trilha vai no COMMIT: `member_grant` com ator sistema, `via = 'troca_do_admin'`, `ticket` e `member_id`.
- **`clinic_members_guard`, revogação do vínculo inerte:** na mesma sessão e com o mesmo login, só o vínculo do `usuario_novo` de troca `cancelada` ou `vencida`. Na `vencida` depois de `ativada`, a conta nova sem fator também é desligada.
- **Revogação do vínculo antigo:** **sem** ramo novo. Quem revoga é a conta nova, admin com fator, na sessão dela.
- **`substituida` [R5]:** o trigger da 0069/0071, que desliga a conta sem vínculo, usa `substituida` quando há troca `concluida` para a conta. A guarda da 0072 recusa perfil novo para `substituida`.

### 10.3 Funções no schema identidade (SECURITY DEFINER, EXECUTE só para `app_provisionamento`)

- `admins_com_fator(p_ids uuid[]) → int`
- `conta_admin_apta(p_id uuid) → boolean`
- `contagem_admin_unico(p_clinica uuid, p_usuario uuid) → (clinica_30d, pessoa_12m)`
- `derrubar_sessoes_da_troca(p_troca uuid) → int` (só para troca `aguardando` com `suspeita_de_invasao`)

As funções que já existem (`conta_por_email`, `email_da_conta_confere`) cobrem o e-mail.

### 10.4 Grants

| Papel | O quê |
|---|---|
| `app_provisionamento` | `troca_do_admin`: SELECT por coluna (sem `email_hmac`), INSERT e UPDATE só das colunas de estado (o trigger da R3 confere o grafo). `ativacao_do_fundador`: INSERT, como hoje, e UPDATE só de `usado_em`. `recuperacao`: INSERT, só para o token de fator da reemissão de troca `ativada`, com CHECK `origem = 'suporte'` e chamado. As funções do item 10.3 |
| `app_auth` (API) | `troca_do_admin`: SELECT e UPDATE das colunas de estado (contestar, suspender, `ativada` e `concluida`). `usuario.inativa_por` com o valor novo |
| `app_user` | **nada** novo |

A guarda `test/guarda-papeis.rls.test.ts` cobra a lista exata.

## 11. Trilha de auditoria (eventos novos)

**Trilha da clínica:** ator **sistema** nos atos da nossa equipe, **nunca** o operador. O operador fica só na linha do schema identidade **[R4]**, no log de segurança e no CloudTrail.

| `op` | Ator | Metadata (fechada) |
|---|---|---|
| `admin_replacement_requested` | sistema | `{ op, user_id: <antigo>, reason, via: 'suporte', ticket, releases_at }` |
| `member_grant` (emissão) | sistema | `{ op, member_id, user_id: <novo>, role: 'admin', via: 'troca_do_admin', ticket }` |
| `admin_replacement_contested` | a conta antiga | `{ op, ticket }` |
| `admin_replacement_cancelled` | sistema | `{ op, ticket, by }` |
| `member_revoke` (conclusão) | a conta nova | `{ op, member_id, user_id: <antigo>, via: 'troca_do_admin', ticket }` |
| `admin_replaced` | a conta nova | `{ op, user_id: <novo>, replaces: <antigo>, ticket }` |

**Log de segurança** (180 dias):

| Evento | Nível de alarme |
|---|---|
| `TROCA_DO_ADMIN_PEDIDA` | imediato |
| `TROCA_DO_ADMIN_CONTESTADA` | crítico |
| `TROCA_DO_ADMIN_SUSPENSA` | crítico |
| `TROCA_DO_ADMIN_CANCELADA` | — |
| `TROCA_DO_ADMIN_TETO` | — |
| `TROCA_DO_ADMIN_VENCIDA` | — |
| `ATIVACAO_EMITIDA` com `motivo: 'troca_do_admin'` | — |
| `ADMIN_SUBSTITUIDO` | — |
| `CONTA_SUBSTITUIDA_ENTROU` **[R5]** | crítico, ao DPO |

**Códigos de saída da tarefa:**
- `ok`;
- `ha_outro_admin`, `nao_e_admin`, `conta_inativa`, `clinica_nao_encontrada`;
- `ha_pedido_pendente`, `email_em_uso`, `janela_aberta`, `mesmo_operador` **[R4]**, `viva_voz_ausente` **[R2]**, `troca_encerrada`, `teto`;
- `chamado_invalido`, `motivo_invalido`, `trava_incorreta`, `uso_incorreto`;
- `parametro_ausente`, `parametro_invalido`, `entrega_pendente`, `ssm_nao_configurado`, `erro`.

## 12. Retenção

| Dado | Prazo |
|---|---|
| `troca_do_admin` (ids, códigos, estado, operador do pedido) | 13 meses |
| HMAC do e-mail novo na troca | zerado na emissão ou no encerramento |
| Ativação `origem = 'troca'` | a da 0079 (30 dias). A exceção A2 não se aplica |
| Parâmetros SSM | apagados no uso; `Expiration` de 72 h (pedido) e 24 h (entrega) |
| Conta antiga | seção 6.2 |
| Chamado | retenção do suporte, sem cópia de documento |
| Log de segurança | 180 dias |

## 13. O que NÃO fazer

- **Nunca** restaurar senha e fator da conta antiga (veto; RIPD §5a), nem copiar ou migrar o fator antigo.
- **Nunca** reaproveitar o e-mail antigo, nem liberá-lo antes do expurgo ou da disputa.
- **Nunca** revogar o vínculo antigo antes de a conta nova ter o TOTP confirmado **[R1]**.
- **Nunca** pular ou encurtar a janela, nem pular a viva voz **[R2]**.
- **Nunca** deixar a mesma pessoa rodar `pedir` e `emitir` **[R4]**. O DPO não conta como uma das três pessoas **[P3]**.
- **Nunca** criar a conta do `usuario_novo` fora de `consumirAtivacao` **[R3]**.
- **Nunca** dar à conta nova perfil além de admin pelo fluxo de suporte **[P8]**.
- **Nunca** aceitar conta existente como conta nova no v1 **[P10]**.
- **Nunca** avisar outras clínicas pelo fluxo **[P4]**. Incidente segue o seu próprio procedimento.
- **Nunca** entregar o token pelo canal do pedido ou por e-mail.
- **Nunca** mudar o `founder_user_id`, nem pôr o operador na trilha da clínica.
- **Nunca** passar dado pessoal em argumento, ambiente, chamado ou log.
- **Nunca** criar rota pública para a nossa equipe.
- **Nunca** usar dado real em teste ou fumaça.

## 14. Riscos

| Risco | Mitigação | Residual |
|---|---|---|
| Engenharia social contra o suporte | conferência 3.2; escrito do signatário; duas confirmações de viva voz; janela; contestação no app; três pessoas; teto | alto impacto e baixa probabilidade (ESTIMATIVA). O DPO assina no RIPD §8 |
| Sem provedor de e-mail, o titular não tem aviso fora do contrato e do app **[R2]** | viva voz obrigatória no `pedir` e antes do `emitir` | **aceito até a D3** (RIPD §4/§8) |
| Conta antiga invadida | 6.3 e incidente; alarme crítico a qualquer login depois da conclusão **[R5]** | negação de serviço do titular legítimo se o motivo for usado por golpista (P2) |
| A conta nova não confirma o TOTP | a conclusão só acontece com o TOTP **[R1]**, a conta antiga segue admin, e há a reemissão de fator | baixo |
| Conta criada com o uuid reservado por outro caminho | trigger da R3 | baixo |
| Quem entrega poderia ativar no lugar da pessoa | três pessoas; confirmação depois | já no RIPD §8 (B11) |
| Vínculo inerte (uuid sem conta) | sem conta não há login; revogação no encerramento | baixo |
| Continuidade clínica | a autoria fica no id antigo; a conta nova não herda perfis **[P8]**, e o admin novo concede pelo fluxo normal | operacional |

## 15. Perguntas abertas aos sócios (decisão dos sócios)

O Guardião deu a recomendação técnica ao lado de cada uma.

| Pergunta | Recomendação técnica do Guardião |
|---|---|
| **P1.** A janela é de 48 h corridas ou úteis? | 48 h corridas **com pelo menos um dia útil inteiro** |
| **P2.** Com `suspeita_de_invasao`, derrubar as sessões e suspender a conta antiga já no `pedir`? | **Sim**, com a decisão do DPO registrada no chamado |
| **P5.** No caso (b), quando o signatário é o admin que saiu ou faleceu, quem indica o admin novo? | **Só o representante legal, com poderes comprovados.** O modelo depende do advogado (D8) |
| **P6.** Quem decide a reversão depois da conclusão? | **O DPO e os dois sócios**, com as **sessões da conta nova suspensas** até a decisão |

As decisões do Guardião sobre P3, P4, P7, P8, P9 e P10 já estão no texto. O registro completo está no parecer de 24/11.

## 16. Tamanho e divisão (ESTIMATIVA)

Três PRs, empilhados sobre a pilha do provisionamento:

1. **Migração:**
   - `troca_do_admin` e o trigger de transições **[R3]**;
   - o trigger de nascimento do `usuario_novo` **[R3]**;
   - as colunas da ativação e o valor `substituida` **[R5]**;
   - os ramos do `clinic_members_guard`;
   - as funções e os grants;
   - a guarda dos privilégios e os testes RLS.
2. **Tarefa e API:**
   - `ops/trocar-admin-unico.ts`, com `mesmo_operador` e a viva voz;
   - a adaptação de `consumirAtivacao`;
   - a conclusão na confirmação do TOTP **[R1]**;
   - a contestação e a suspensão no login;
   - o alarme `CONTA_SUBSTITUIDA_ENTROU` **[R5]**;
   - o expurgo com `substituida`.

   Testes da v1, mais estes:
   - não concluir sem TOTP;
   - INSERT do uuid reservado recusado;
   - transição inválida recusada;
   - `mesmo_operador`;
   - viva voz ausente;
   - login depois da conclusão.
3. **Terraform, runbook, RIPD e checklist:**
   - Terraform: definição da tarefa e prefixo `/troca-admin/*`;
   - `runbook-troca-do-admin-unico.md`;
   - RIPD: §3, §4, §5 item 8, §5a e §8.

A fumaça do staging (B8) ganha uma troca fictícia de ponta a ponta e uma contestação.

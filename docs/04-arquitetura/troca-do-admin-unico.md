# Admin único que perdeu senha e fator: troca por conta nova (desenho para o Guardião, B13)

> 24/11/2026 · Engenharia · **desenho v1, sem código**, para o parecer do Guardião. Item **B13** do checklist (`docs/03-seguranca-lgpd/prontidao-producao.md`).
> Base: resposta 4 do [parecer de 16/11 sobre a recuperação do admin único](../03-seguranca-lgpd/revisoes/2026-11-16-desenho-recuperacao-do-admin-unico.md) (recuperação completa **vetada**; caminho decidido: conta nova com outro e-mail, ativada pelo provisionamento, revogação do vínculo antigo e 48 h de espera) e a R9 do mesmo parecer; [RIPD-identidade](../03-seguranca-lgpd/RIPD-identidade.md) §5 itens 1, 6, 7 e 8 e §5a ("nenhum token restaura os dois fatores"); [provisionamento-da-clinica.md](provisionamento-da-clinica.md) e [runbook](runbook-provisionamento-da-clinica.md) (B11); [recuperacao-do-admin-unico.md](recuperacao-do-admin-unico.md) e [runbook](runbook-recuperacao-admin-unico.md) (B12); pareceres de 17/11 sobre o código (#195, #199, #203, #205, #206, #207, #208).
> Código lido (branch `eng/clinica-sem-fundador`, topo da pilha, #208): `provisionamento.ts`, `recuperacao-pelo-suporte.ts`, `provedor.ts` (`usarAtivacao`, `consumirAtivacao`, `clinicaLiberada`, expurgo), `ops/provisionar-clinica.ts`, `ops/recuperar-admin-unico.ts`, `ops/parametros-ssm.ts`, migrações 0069, 0072, 0076 a 0081.

**Convenção:** **FATO** = conferido no código, numa migração ou num parecer citado. **ESTIMATIVA** = número ou suposição nossa, sem medição.

## 1. O problema em uma frase

A clínica tem **um só** admin ativo com fator e ele não tem mais **nem a senha nem o TOTP**. O B12 não serve, porque o token de fator exige a senha atual (FATO: `usarRecuperacao`, tipo `fator`). A recuperação completa foi **vetada**: nenhum token restaura os dois fatores (FATO: parecer de 16/11, resposta 4; RIPD §5a). Então a pessoa **não volta** para a conta antiga. Ela recebe uma **conta nova**, com **outro e-mail**, que vira admin da mesma clínica. O vínculo antigo é revogado, e há uma espera de **48 h** entre o pedido e a emissão do token.

## 2. Escopo

| Caso | Este desenho? |
|---|---|
| (a) O titular da conta de admin perdeu senha e fator | **Sim** (motivo `perdeu_senha_e_fator`) |
| (b) Quem pede **não é** o titular: o admin saiu, faleceu ou não responde (R9 do parecer do B12) | **Sim**, pelo mesmo comando (motivo `titular_indisponivel`), com a conferência do item 3.2. A pessoa nova é outra pessoa: a conta nova é dela, nunca "a do antigo admin" |
| Há outro admin ativo com fator | **Não**: ele resolve pelo app (#159). O comando recusa com `ha_outro_admin` |
| O admin ainda sabe a senha e só perdeu o fator | **Não**: é o B12 |
| Conta antiga com suspeita de invasão (alguém trocou a senha e o fator) | **Sim**, com o motivo `suspeita_de_invasao` e o tratamento da seção 6.3, **e** é incidente (`docs/03-seguranca-lgpd/`) |

## 3. Quem pode pedir e como a identidade é conferida

O padrão é o do B12 (runbook da recuperação, R3 do parecer de 16/11), com o reforço que a resposta 4 do parecer pede.

### 3.1 Quem pede

- **Só pelo canal do contrato** (`CTR-<n>`): o signatário ou o responsável indicado no contrato. Pedido por e-mail avulso, mensagem ou telefone fora do contrato é recusado, e a pessoa é orientada a usar o canal do contrato.
- Abre-se um chamado `SUP-<n>`. O chamado leva só ids, datas, o tipo de documento conferido (sem número), as horas das ligações e os nomes de quem executou e de quem entregou. **Nunca** cópia de documento, nome do titular ou e-mail.

### 3.2 Conferência (DPO ou quem ele designar)

1. **Confirmação por escrito do signatário pelo canal do contrato** (exigência da resposta 4). Se o titular da conta antiga **é** o signatário, a confirmação escrita é dele mesmo.
2. **Caso (a), titular:** documento **só exibido** em vídeo, nunca copiado (RIPD §5 item 1). O nome no documento é o nome da conta antiga.
3. **Caso (b), pessoa nova:** documento da pessoa nova exibido do mesmo jeito. A indicação dela como admin vem **por escrito do signatário**. Se o signatário é o próprio admin que saiu ou faleceu, vale o representante legal da clínica que consta do contrato, e o caso vai ao DPO e aos dois sócios antes de seguir (pergunta P5).
4. **Ligação de retorno** só ao telefone do contrato cadastrado **antes** do chamado. Pedido para mudar o contato do contrato no mesmo chamado, ou nos 30 dias anteriores, **suspende** o pedido até a revisão do DPO (igual ao B12).
5. **Log de segurança da conta antiga, últimos 7 dias:** `LOGIN_FALHOU`, `MFA_FALHOU`, `MFA_BLOQUEADO`, `RECUPERACAO_*` e origens novas. Um **login completo com sucesso** nesse período contradiz o "perdi os dois". Nesse caso o pedido para e vai ao DPO.
6. **Roteiro de recusa à pressão:** a resposta é o prazo do procedimento (48 h e mais a entrega), sem exceção. Não há break-glass.

### 3.3 Duas pessoas do nosso lado (FATO: padrão do B11 e do B12)

| Papel | Papel AWS (reaproveitado) | O quê |
|---|---|---|
| **DPO** (ou designado) | nenhum | confere a identidade, decide se cabe, consulta o log |
| **Executor** | `<ambiente>-ops-provisionamento-executor` | grava o pedido no SSM e roda as fases da tarefa. **Não** lê a entrega |
| **Entregador** (outra pessoa) | `<ambiente>-ops-provisionamento-entrega` | lê a entrega uma vez, entrega o token e apaga. **Não** roda a tarefa |

**Recomendação:** quem roda a fase `emitir` não é quem rodou a fase `pedir` (pergunta P3). Com isso, três pessoas diferentes tocam o caso.

## 4. Fluxo passo a passo

O fluxo reaproveita, sem caminho paralelo:
- a **tarefa avulsa do ECS** do provisionamento: papel de banco `app_provisionamento` (0080), chave KMS do fluxo, rede própria, alerta em toda execução;
- o **SSM SecureString** com `Expiration` e `Overwrite: false` (`parametros-ssm.ts`);
- os **papéis executor e entrega disjuntos** (#204);
- o **token de ativação de uso único** (`identidade.ativacao_do_fundador`, `POST /ativacao/usar`), com o mesmo 404, o contador de falhas, a conferência do e-mail pelo HMAC, a senha conferida contra vazadas e a sessão de cadastro pendente de 15 min (R8 intacta).

Comando novo: `ops/trocar-admin-unico.ts`, com três fases. Cada fase é uma execução da tarefa e tem trava própria, como as outras.

### T0: fase `pedir` (executor)

1. O executor grava o pedido num SecureString `/troca-admin/<pedido>` (chave do fluxo, camada Advanced, **vencimento de 72 h**, `--no-overwrite`). O JSON é **só** `{"email": "<e-mail novo>"}`, lido de arquivo e apagado com `shred -u`, como no passo 2 do runbook do provisionamento.
2. Roda a tarefa com `--fase pedir --pedido <uuid> --clinica <uuid> --usuario <uuid da conta antiga> --chamado SUP-<n> --contrato CTR-<n> --motivo <lista fechada> --operador <uuid>` e `CONFIRMA_TROCA=<pedido>`. O override só leva uuids, códigos e a lista fechada.
3. A tarefa confere, sob a trava consultiva **compartilhada com o B12** (`admin-unico:<clinica>`):
   1. a clínica existe;
   2. `usuario` é admin ativo da clínica;
   3. **nenhum outro** admin ativo tem fator verificado (`ha_outro_admin`);
   4. não há troca pendente nem recuperação do B12 pendente na clínica (`ha_pedido_pendente`);
   5. o teto da seção 8;
   6. o e-mail novo **não é** o da conta antiga (`identidade.email_da_conta_confere`, que já existe e responde só sim ou não) **e** não pertence a nenhuma conta (`identidade.conta_por_email`, que já existe). Os dois casos saem `email_em_uso`. **O e-mail antigo nunca é reaproveitado**.
4. Grava a linha `identidade.troca_do_admin` (seção 10): estado `aguardando`, `libera_em = pedido_em + 48 h`, o HMAC do e-mail novo (uso `ativacao-email`, o mesmo da ativação) e o uuid **reservado** para a conta nova.
5. Grava na trilha da clínica `admin_replacement_requested` (ator **sistema**). Emite `TROCA_DO_ADMIN_PEDIDA` no log de segurança, com o operador e o chamado. **Apaga o parâmetro do pedido**, com sucesso ou falha (padrão R9 do B11).
6. Com `suspeita_de_invasao`, derruba as sessões da conta antiga já aqui (seção 6.3).
7. Avisos da seção 7.

Saída: `ok <pedido> libera=<data>` ou um código fixo (seção 11).

### Janela de 48 h

A janela vai de T0 a T0 + 48 h. Está descrita na seção 7.

### T0 + 48 h ou depois: fase `emitir` (executor, de preferência outro)

1. Roda `--fase emitir --pedido <uuid> --chamado SUP-<n>` com `CONFIRMA_TROCA=<pedido>`. **Não** há parâmetro de entrada: o HMAC do e-mail novo já está na linha.
2. A tarefa confere de novo, sob a mesma trava:
   - a linha está `aguardando` e `now() >= libera_em` (antes disso sai `janela_aberta`);
   - não foi contestada, suspensa nem cancelada;
   - a conta antiga segue admin ativo;
   - **ainda** não há outro admin com fator. Se o titular legítimo entrou na janela e nomeou outro admin, a troca deixa de ser necessária e sai `ha_outro_admin`, e a linha vai a `cancelada`.
3. Numa transação:
   1. concede o perfil **admin** ao uuid reservado na clínica, na sessão de sistema, com `member_grant` (ator **sistema**, `via: 'troca_do_admin'`, `ticket`). Hoje a 0078/0080 só aceita a fundação em clínica **vazia**; precisa de um ramo novo no `clinic_members_guard` (seção 10);
   2. cria a linha de ativação em `identidade.ativacao_do_fundador`, com `origem = 'troca'`, o chamado, a troca, o HMAC copiado da troca, `conta_existente = false` e a **validade da seção 9**. O índice "uma ativação pendente por clínica" (FATO: 0076) continua valendo;
   3. passa a troca a `emitida` e zera o HMAC do e-mail na linha da troca (ele fica só na ativação, que o zera no uso, no bloqueio ou no vencimento; FATO: 0079);
   4. grava o token em `/troca-admin/<pedido>/entrega`, dentro da transação, pelo mesmo `guardarToken` do provisionamento (se o banco falhar, o parâmetro é apagado; se a entrega anterior ainda existir, `entrega_pendente`).
4. Emite `ATIVACAO_EMITIDA` com `motivo: 'troca_do_admin'`, o pedido e o chamado.

### Entrega (entregador)

É igual ao passo 4 do runbook do provisionamento:
- o entregador lê uma vez e apaga;
- entrega **só** à pessoa conferida no item 3.2, pela ligação de retorno ao telefone do contrato ou por vídeo com ela presente;
- **nunca** por e-mail, mensagem ou número informado no pedido. O token vai no corpo do POST ou no fragmento (`#`) do link.

### Ativação: `POST /ativacao/usar` (a pessoa)

A rota é a que já existe e funciona como hoje: o mesmo 404, contador por origem, cinco falhas de e-mail bloqueiam, Redis fora dá 503, a senha nova passa pela conferência de vazadas e a conta nasce com o uuid reservado. Mudam só três coisas em `consumirAtivacao`, para `origem = 'troca'`:

1. **Conferência do alvo.** Hoje ela exige `tenants.founder_user_id = usuario_id` (FATO: `provedor.ts`, `FundadorNaoConfere`). Na troca ela passa a ser: a pessoa tem o vínculo admin ativo concedido na emissão **e** a troca está `emitida` (nem contestada, nem suspensa, nem cancelada). É a mesma adaptação que o B12 fez em `usarRecuperacao` (R2 daquele parecer). **O `founder_user_id` não muda**: ele é imutável fora da correção sob incidente (FATO: 0047/0080). O fundador histórico continua sendo o id antigo.
2. **Na mesma transação**, a nova conta, como ator da sessão (ela já é admin ativo, então o `clinic_members_guard` de hoje aceita):
   - revoga **todos** os perfis da conta antiga **nesta** clínica, com `member_revoke` (`via: 'troca_do_admin'`, `ticket`). A regra "a clínica não fica sem admin ativo" é satisfeita, porque o admin novo já existe. **Não precisa de privilégio novo para revogar**;
   - grava `admin_replaced` na trilha.
3. **No `app_auth`, na mesma transação:**
   - a troca vai a `concluida`;
   - as **sessões** da conta antiga caem (todas, de qualquer clínica: a pessoa não as tem mais, e quem as tiver não é ela);
   - os tokens pendentes da conta antiga (recuperação, ativação) são invalidados;
   - o destino da conta antiga segue a seção 6.

Depois, abre a sessão de cadastro pendente de 15 min e a pessoa cadastra o TOTP novo. Por fim, sai `ADMIN_SUBSTITUIDO` no log de segurança.

**Confirmação fora de banda** (como o B11 depois de `FUNDADOR_ATIVADO`): o entregador confirma com a pessoa e com o signatário que foi ela quem ativou. Sem confirmação, o caso é incidente.

### Reemissão e vencimento

- Se a ativação vence sem uso, a troca volta a `liberada_sem_token` e pode ser **reemitida uma vez** (`--fase emitir` de novo), com a mesma reserva e o mesmo vínculo. A segunda falha encerra a troca como `vencida`, e um pedido novo começa do T0.
- O vínculo admin do uuid reservado fica **inerte** enquanto a conta não existe. Ninguém entra com ele: sem conta, não há login, e a 0072 já impede perfil novo em conta anonimizada ou expurgada. Na `vencida` e na `cancelada`, ele é revogado pelo ramo da seção 10.

## 5. Fase `cancelar` e "não fui eu"

| Canal | Quem | Efeito |
|---|---|---|
| **Contrato** (ligação ou escrito do signatário) | o executor roda `--fase cancelar --pedido <uuid> --chamado SUP-<n> --por contrato` | troca `cancelada` e `TROCA_DO_ADMIN_CANCELADA`; se já emitida, o token é invalidado e o vínculo inerte revogado. Vira incidente |
| **No app, pela conta antiga** | o titular legítimo, se ainda entra: aviso fixo na tela depois do login e botão "não fui eu" (`POST /conta/troca-do-admin/contestar`, com MFA recente, R8 das rotas de poder) | troca `contestada`, `TROCA_DO_ADMIN_CONTESTADA` (alarme imediato) e `admin_replacement_contested` na trilha (ator: o titular). Vira incidente |
| **Login completo da conta antiga na janela** (mesmo sem clicar) | automático | troca `suspensa` e `TROCA_DO_ADMIN_SUSPENSA`. Quem diz ter perdido os dois não entra com os dois. O DPO decide se cancela ou se segue (a conta pode estar invadida, ver 6.3) |
| **E-mail antigo** | o titular, por link "não fui eu" | **só quando houver provedor de e-mail** (FATO: D3 está na fila; hoje não há provedor). Até lá, este canal **não existe**, e o desenho não depende dele |

Depois de `concluida`, nada se desfaz sozinho. Uma contestação tardia vai ao DPO e aos sócios como incidente. A reversão segue a correção sob incidente (0042/0047), com chamado próprio (pergunta P6).

## 6. Conta antiga, vínculo antigo e dados pessoais

### 6.1 Vínculo

- **Revogado na ativação**, e não na emissão: a clínica nunca fica sem admin real, e um golpe descoberto entre a emissão e a ativação não tira o acesso do titular legítimo.
- Até a ativação, a conta antiga continua admin ativo (com `suspeita_de_invasao`, ver 6.3).
- Os perfis da conta antiga em **outras** clínicas **não** são tocados: cada clínica é controladora do próprio vínculo (RIPD §0). A pessoa não consegue mais entrar com a conta antiga em lugar nenhum. Nas outras clínicas, o caminho é o do RIPD §5 item 1: convite novo para o e-mail novo, pelo admin de lá.

### 6.2 A conta antiga em si

- **Não é apagada nem anonimizada** por este fluxo. O id identifica o autor do prontuário por 20 anos (FATO: R18, RIPD §3).
- **Sem vínculo restante:** marcada inativa com um motivo novo, `inativa_por = 'substituida'`. Esse motivo **nunca** volta a valer numa concessão, diferente de `sem_vinculo`, que o trigger da 0069/0071 reativa (FATO). A 0072 passa a recusar perfil novo também para `substituida`. Depois de 90 dias, o `identidade-expurgo` apaga senha, TOTP, sessões e tokens, **libera o e-mail** e tira o nome, como já faz com `sem_vinculo` (FATO: RIPD §3). O expurgo precisa passar a incluir `substituida`.
- **Com vínculo em outra clínica:** a conta segue ativa lá, sem sessões. Quando o último vínculo cair, o expurgo de hoje a desliga como `sem_vinculo` (FATO: `provedor.ts`, expurgo). Aqui há uma lacuna: `sem_vinculo` pode ser reativada por concessão, e só a 0072 protege, e só depois do expurgo (pergunta P4).
- **Anonimização** (art. 18) só a pedido do titular, pelo B10, como hoje.
- **O e-mail antigo** fica preso à conta antiga até o expurgo de 90 dias ou a disputa (RIPD §5 item 3). Este fluxo **nunca** o passa para a conta nova (conferência do passo T0.3.6).

### 6.3 Suspeita de invasão

Se a conta antiga pode estar na mão de outra pessoa (alguém trocou a senha e o fator), esperar 48 h com ela ativa favorece o atacante. Com `--motivo suspeita_de_invasao`, a fase `pedir` faz duas coisas:
- derruba as sessões da conta antiga;
- **suspende a conta antiga** até a conclusão ou o cancelamento, com o mesmo efeito da suspensão da disputa de e-mail (RIPD §5 item 3).

O custo é que um golpista que use esse motivo tira o acesso do titular legítimo por até 48 h (negação de serviço). O titular contesta pelo contrato e o DPO desfaz. **Proposta:** esse motivo exige, além da conferência, a decisão do DPO registrada no chamado antes de rodar (pergunta P2). O caso é tratado como incidente desde o T0.

## 7. A janela de 48 h

**Para que serve** (resposta 4): dar ao titular legítimo a chance de contestar.

**O que fica bloqueado na clínica durante a janela, e até a conclusão:**
- outra troca e a recuperação do B12 (`ha_pedido_pendente`, trava compartilhada);
- a mudança dos contatos do contrato, que suspende a troca (item 3.2.4);
- a emissão de qualquer token para a conta nova.

A conta antiga **não** é tocada, a não ser com `suspeita_de_invasao`: o titular legítimo precisa conseguir entrar para dizer "não fui eu".

**Quem é avisado no T0:**
1. O **signatário**, por escrito pelo canal do contrato: "pedido de troca do admin aberto, chamado SUP-<n>; o token só sai depois de <data>; se não reconhece, responda".
2. O **telefone do contrato**, por ligação nossa (o SMS depende do P2 do quadro, que está parado).
3. A **conta antiga**, pelo aviso no app no próximo login (seção 5).
4. O **e-mail antigo**, só quando houver provedor (D3).
5. Os outros membros da clínica, sem perfil admin, **não** são avisados na janela. Na conclusão, recebem só o fato ("o administrador da clínica mudou"), sem motivo, como no B12.

**Tamanho da janela:** 48 h corridas, como decidido no parecer. **ESTIMATIVA:** num fim de semana, 48 h podem cair inteiras sem ninguém olhar o canal do contrato. Pergunta P1: contar 48 h úteis ou exigir que a janela inclua pelo menos um dia útil.

## 8. Tetos e limites

| Limite | Valor | Base |
|---|---|---|
| Por clínica, **somando** B12 e B13 | 1 a cada 30 dias | resposta 4 ("o mesmo teto da pergunta 3, somado") e resposta 3 |
| Por pessoa (a **conta antiga**), somando B12 e B13 | 2 em 12 meses | resposta 3 |
| Pendentes por clínica | 1 (troca ou recuperação do B12) | índice parcial em `troca_do_admin` e trava compartilhada |
| Reemissões por troca | 1 | seção 4 |
| Tentativas de e-mail na ativação | 5, como hoje | FATO: 0076, `falhas` |

- A troca **contestada, suspensa ou cancelada também conta**. Sem isso, um golpista repete o pedido até o titular desistir de contestar. O custo é que uma contestação bloqueia a clínica por 30 dias; acima do teto, vale a revisão manual (DPO e os dois sócios, `--revisao SUP-<n>`, como no B12).
- **A conta nova** não pode ser alvo de B12 nem de B13 nos primeiros 30 dias: o teto por clínica já cobre isso.
- A contagem cruza `identidade.recuperacao` (`origem = 'suporte'`, 13 meses de retenção; FATO: RIPD §3) e `identidade.troca_do_admin`. Acima do teto sai `teto` e `TROCA_DO_ADMIN_TETO` (alarme).

## 9. Validade do token

**Proposta: 24 h para `origem = 'troca'`**, e não as 72 h do fundador. O argumento é o mesmo da resposta 2 do B12: o token abre uma conta de **admin** de clínica que já tem dados de saúde, e a entrega por uma segunda pessoa já foi combinada durante as 48 h. O CHECK da 0076 passa a ser por origem. Se o Guardião preferir 72 h, nada mais muda.

## 10. O que o banco precisa

O princípio é o da 0080: o papel da tarefa recebe só o que usa. Nas **tabelas da clínica**, não há SECURITY DEFINER, e sim ramos nos triggers com `pg_has_role(session_user, 'app_provisionamento', 'MEMBER')`, porque `current_user` dentro de uma função SECURITY DEFINER é o dono dela (FATO: comentário da 0047/0080, "o runtime, mesmo via SECURITY DEFINER, nunca"). No **schema identidade**, há funções SECURITY DEFINER **estreitas**, pela chave, com `SET search_path = pg_catalog, identidade, pg_temp` (FATO: N1 do #207).

### 10.1 Tabelas e colunas

- **`identidade.troca_do_admin`** (nova):
  - colunas: `id` (= uuid do pedido), `clinica_id`, `usuario_antigo`, `usuario_novo` (uuid reservado), `email_hmac` (zerado na emissão e no encerramento), `motivo` (CHECK com a lista fechada), `chamado` (`^SUP-[0-9]{1,7}$`), `contrato` (`^CTR-[0-9]{1,7}$`), `pedido_em`, `libera_em` (CHECK `>= pedido_em + interval '48 hours'`), `estado` (`aguardando`, `emitida`, `liberada_sem_token`, `concluida`, `contestada`, `suspensa`, `cancelada`, `vencida`), `encerrada_em`, `encerrada_por` (`ativacao`, `contrato`, `titular`, `login`, `vencimento`, `ha_outro_admin`) e `reemissoes` (0 a 1);
  - CHECK `usuario_novo <> usuario_antigo`;
  - índice único parcial por `clinica_id` com estado não final.
- **`identidade.ativacao_do_fundador`**: mais `origem` (`provisionamento`, que é o padrão, ou `troca`), `chamado` e `troca_id`. CHECK de coerência: `origem = 'troca'` exige chamado, troca e `conta_existente = false`. A validade passa a ser por origem (seção 9).
- **`identidade.usuario`**: `inativa_por` ganha `substituida` (CHECK da 0072). O trigger de reativação não a toca, e a guarda da 0072 recusa perfil novo para ela.

### 10.2 Clínica (ramos de trigger, sem SECURITY DEFINER)

- **`clinic_members_guard`, concessão:** na sessão de sistema, com o login membro de `app_provisionamento`, só perfil `admin`, `granted_by` igual ao sentinela, e só para o `usuario_novo` de uma troca `aguardando` com `libera_em <= now()` naquela clínica. O trigger lê `identidade.troca_do_admin` por coluna. A trilha vai no COMMIT: `clinic_members_trilha_check` exige `member_grant` com ator sistema, `via = 'troca_do_admin'`, `ticket` e `member_id`.
- **`clinic_members_guard`, revogação do vínculo inerte:** na sessão de sistema, com o mesmo login, só o vínculo do `usuario_novo` de troca `cancelada` ou `vencida` **sem conta** em `identidade.usuario`, com `member_revoke` (ator sistema, `via`, `ticket`).
- A revogação do vínculo antigo **não precisa de ramo novo**: quem revoga é a conta nova, admin ativo, na sessão dela (seção 4).

### 10.3 Funções no schema identidade (SECURITY DEFINER, EXECUTE só para `app_provisionamento`)

- `identidade.admins_com_fator(p_ids uuid[]) → int`: quantos desses ids têm conta ativa e fator verificado. Serve ao `ha_outro_admin` sem dar SELECT em `two_factor_enabled`.
- `identidade.conta_admin_apta(p_id uuid) → boolean`: conta ativa e não `inativa_por`.
- `identidade.contagem_admin_unico(p_clinica uuid, p_usuario uuid) → (clinica_30d int, pessoa_12m int)`: soma `recuperacao` com `origem = 'suporte'` e `troca_do_admin`. Serve ao teto.
- `identidade.derrubar_sessoes_da_troca(p_troca uuid) → int`: só para troca `aguardando` com motivo `suspeita_de_invasao`; apaga as sessões **daquela** conta antiga e devolve quantas.
- As duas que já existem (`conta_por_email`, `email_da_conta_confere`, 0080) cobrem a conferência do e-mail.

### 10.4 Grants

| Papel | O quê |
|---|---|
| `app_provisionamento` | `troca_do_admin`: SELECT por coluna (sem `email_hmac`), INSERT, UPDATE só de `estado`, `encerrada_em`, `encerrada_por`, `reemissoes` e `email_hmac` (para zerar). `ativacao_do_fundador`: o INSERT de hoje cobre as colunas novas, e entra UPDATE só de `usado_em` (para invalidar o token na fase `cancelar`). As funções do item 10.3 |
| `app_auth` (API) | `troca_do_admin`: SELECT e UPDATE de `estado`, `encerrada_em` e `encerrada_por` (contestar, suspender no login, concluir na ativação). `usuario.inativa_por` com o valor novo |
| `app_user` | **nada** novo |

A guarda `test/guarda-papeis.rls.test.ts` passa a cobrar a lista exata (R4 do parecer do expurgo).

**Pergunta para o Guardião (P7):** a alternativa é um papel novo (`app_troca_admin`) em vez de ampliar `app_provisionamento`. Isso deixaria o O1 do #207 (o papel abre o contexto de qualquer clínica) com escopo menor em cada papel, mas exige mais um segredo e mais uma senha no bootstrap. Proponho ampliar, porque o ato é da mesma natureza (dar admin a uma conta que ainda não existe) e a guarda cobra a lista.

## 11. Trilha de auditoria (eventos novos)

**Trilha da clínica** (`audit_log`, encadeada): ator **sistema** nos atos da nossa equipe, **nunca** o operador (Decisão 1 e R2 do B10; R6 do B12).

| `op` | Ator | Metadata (fechada) |
|---|---|---|
| `admin_replacement_requested` | sistema | `{ op, user_id: <antigo>, reason, via: 'suporte', ticket, releases_at }` |
| `member_grant` (emissão) | sistema | `{ op, member_id, user_id: <novo>, role: 'admin', via: 'troca_do_admin', ticket }` |
| `admin_replacement_contested` | a conta antiga | `{ op, ticket }` |
| `admin_replacement_cancelled` | sistema | `{ op, ticket, by }` (`by` é `contrato`, `login`, `vencimento` ou `ha_outro_admin`) |
| `member_revoke` (ativação) | a conta nova | `{ op, member_id, user_id: <antigo>, via: 'troca_do_admin', ticket }` |
| `admin_replaced` | a conta nova | `{ op, user_id: <novo>, replaces: <antigo>, ticket }` |

**Log de segurança** (180 dias), com operador e chamado quando é ato nosso:
- `TROCA_DO_ADMIN_PEDIDA` (alarme imediato, como toda emissão do B12);
- `TROCA_DO_ADMIN_CONTESTADA` (alarme **crítico**);
- `TROCA_DO_ADMIN_SUSPENSA` (crítico);
- `TROCA_DO_ADMIN_CANCELADA`;
- `TROCA_DO_ADMIN_TETO`;
- `TROCA_DO_ADMIN_VENCIDA`;
- `ATIVACAO_EMITIDA` com `motivo: 'troca_do_admin'`;
- `ADMIN_SUBSTITUIDO` (na ativação).

Os eventos de falha da ativação (`ATIVACAO_FALHOU`, `ATIVACAO_BLOQUEADA`) não mudam. Todos os eventos novos entram na lista fechada do `log-de-seguranca.ts`, e o teste "sem `@`" continua valendo.

**CloudTrail:** um `RunTask` por fase com o principal executor, e o `GetParameter`/`DeleteParameter` da entrega com o principal entregador. Os `SourceIdentity` têm de ser diferentes e bater com os nomes do chamado (FATO: padrão do #204).

**Saída da tarefa:** uma linha, `ok ...` ou um código fixo:
- `ha_outro_admin`, `nao_e_admin`, `conta_inativa`, `clinica_nao_encontrada`;
- `ha_pedido_pendente`, `email_em_uso`, `janela_aberta`, `troca_encerrada`, `teto`;
- `chamado_invalido`, `motivo_invalido`, `trava_incorreta`, `uso_incorreto`;
- `parametro_ausente`, `parametro_invalido`, `entrega_pendente`, `ssm_nao_configurado`, `erro`.

Código diferente de 0 na falha, e nunca a mensagem do driver.

## 12. Retenção

| Dado | Prazo |
|---|---|
| `troca_do_admin` (ids, códigos, estado) | 13 meses, como a recuperação do suporte (o teto por pessoa olha 12 meses) |
| HMAC do e-mail novo na troca | zerado na emissão ou no encerramento |
| Linha de ativação `origem = 'troca'` | a da 0079 (30 dias depois de usada ou vencida). A exceção A2 **não se aplica**: a clínica já tem `founder_activated` |
| Parâmetros SSM (pedido e entrega) | apagados no uso, com `Expiration` de 72 h (pedido) e 24 h (entrega) |
| Conta antiga | seção 6.2 (90 dias para as credenciais; o id nunca é apagado) |
| Chamado | retenção própria do suporte, sem cópia de documento |
| Log de segurança | 180 dias. Trilha da clínica: a da `audit_log` |

Tudo isso entra na `matriz-retencao.md` e no RIPD §3.

## 13. O que NÃO fazer

- **Nunca** emitir token que defina senha nova e abra o cadastro do fator para a **conta antiga** (veto; RIPD §5a).
- **Nunca** restaurar, copiar ou migrar o fator antigo, nem o segredo TOTP, para a conta nova.
- **Nunca** reaproveitar o e-mail antigo na conta nova, nem "liberar" o e-mail antigo antes do expurgo ou da disputa para acelerar.
- **Nunca** pular ou encurtar as 48 h, nem por urgência ("o médico está esperando"). Acima do teto, só a revisão manual registrada.
- **Nunca** entregar o token pelo canal de onde veio o pedido, nem por e-mail.
- **Nunca** mudar o `founder_user_id` por este fluxo.
- **Nunca** passar e-mail, nome ou token em argumento, variável de ambiente, chamado ou log.
- **Nunca** pôr o operador na trilha da clínica.
- **Nunca** reativar a conta antiga (`substituida` não volta).
- **Nunca** criar rota pública para a nossa equipe disparar a troca: só a tarefa avulsa (P1 do B10).
- **Nunca** usar dado real em teste ou fumaça: contas e clínicas fictícias (checklist de segurança).

## 14. Riscos

| Risco | Mitigação | Residual |
|---|---|---|
| Engenharia social: o golpista convence o suporte e ganha admin de clínica com dados de saúde | conferência do item 3.2; escrito do signatário; 48 h com aviso a três canais; contestação no app; duas ou três pessoas; teto | **alto impacto e probabilidade baixa** (ESTIMATIVA). O DPO assina no RIPD §8 |
| Conta antiga invadida: o atacante tem os dois fatores e o legítimo não | `suspeita_de_invasao` derruba sessões e suspende no T0 (6.3); incidente | DoS do legítimo se o motivo for usado por golpista. O DPO decide antes |
| Fim de semana: 48 h sem ninguém ler o canal do contrato | P1 | aberto |
| Sem provedor de e-mail, o titular não recebe aviso fora do contrato e do app | três canais restantes; D3 depois | aceito até a D3 |
| Quem entrega o token poderia ativar no lugar da pessoa | o mesmo do B11 (R3): duas pessoas, confirmação depois | já está no RIPD §8 (B11) |
| Vínculo admin de uuid sem conta (inerte) entre a emissão e a ativação | sem conta não há login; revogação no cancelamento ou no vencimento (10.2) | baixo |
| Continuidade clínica: o profissional da conta antiga está ligado em `professionals` ao id antigo | a autoria fica no id antigo (correto). O perfil clínico da conta nova é concedido pelo admin novo, pelo fluxo normal | ver P8 |
| `app_provisionamento` ganha mais poder | só colunas, funções pela chave, guarda de privilégios | P7 |

## 15. Perguntas abertas

**Para os sócios (N0):**
- **P1.** Janela de **48 h corridas** ou **48 h úteis** (ou "pelo menos um dia útil inteiro")? Proposta: úteis, para o aviso ao signatário ter chance real de ser lido.
- **P2.** Com `suspeita_de_invasao`, aceitam o risco de **derrubar e suspender** a conta antiga no T0, sabendo que um golpista pode usar isso para tirar o titular por até 48 h? Proposta: sim, com a decisão do DPO no chamado.
- **P5.** No caso (b), quando o signatário é o próprio admin que saiu ou faleceu, quem pode indicar o admin novo? Representante legal no contrato, procuração, ou só por aditivo assinado? Depende do advogado (D8) e do modelo de contrato.
- **P6.** Contestação **depois** da conclusão: quem decide a reversão e em quanto tempo? Proposta: DPO e os dois sócios, pelo procedimento de correção sob incidente, com prazo de 24 h para a primeira resposta.

**Para o Guardião:**
- **P3.** Exigir que **quem emite** (fase `emitir`) seja outra pessoa, diferente de quem pediu (fase `pedir`), além do entregador? Isso pede uma terceira pessoa na escala.
- **P4.** A conta antiga com vínculo em **outra** clínica fica ativa lá (cada clínica é controladora). Devemos avisar as outras clínicas? Isso revela um fato entre tenants. Ou marcar `substituida` mesmo com vínculos, derrubando o acesso dela em todas? Proposta: não avisar e não marcar, salvo `suspeita_de_invasao` (aí é incidente e o aviso segue o art. 48).
- **P7.** Ampliar `app_provisionamento` ou criar `app_troca_admin`? Proposta: ampliar.
- **P8.** A conta nova deve herdar o vínculo **profissional** (perfis clínicos e a linha em `professionals`) da antiga no caso (a)? Proposta: **não** automaticamente. O admin novo concede pelo fluxo normal, e o registro profissional é religado pela clínica. Isso evita que o fluxo de suporte toque dado da clínica além do perfil admin.
- **P9.** A validade de **24 h** (seção 9) em vez de 72 h está certa?
- **P10.** Conta nova **só** (v1 recusa e-mail de conta existente com `email_em_uso`)? Ou aceitar uma conta existente e ativa de outra clínica, com login completo, como o fundador com conta existente do B11? Proposta: só conta nova no v1. É mais simples e não deixa o caso virar um atalho para uma conta que o golpista controle.

## 16. Tamanho e divisão (ESTIMATIVA)

Grande. São três PRs, empilhados sobre a pilha do provisionamento:
1. **Migração e funções:** `troca_do_admin`, colunas da ativação, `substituida`, ramos do `clinic_members_guard`, funções e grants, guarda dos privilégios e testes RLS (bancada com contas fictícias).
2. **Tarefa e API:** `ops/trocar-admin-unico.ts` (três fases), adaptação de `consumirAtivacao`, rota de contestação, suspensão no login, expurgo com `substituida`, eventos e testes:
   - janela não vencida;
   - outro admin aparece na janela;
   - contestação;
   - login na janela;
   - e-mail antigo recusado;
   - e-mail de conta existente recusado;
   - teto somado com o B12;
   - reemissão única;
   - token de troca não serve para o provisionamento, e vice-versa;
   - mesmo 404;
   - metadata fechada;
   - saída sem dado pessoal.
3. **Terraform** (nova definição de tarefa no `ops-provisionamento.tf`, prefixo `/troca-admin/*` nas políticas, alertas), **runbook** `runbook-troca-do-admin-unico.md`, RIPD (§3, §4, §5 item 8, §5a, §8) e o checklist.

A fumaça do staging (B8) ganha uma troca de conta fictícia de ponta a ponta, com a contestação num segundo caso.

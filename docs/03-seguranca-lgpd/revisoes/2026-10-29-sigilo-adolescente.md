# Parecer do Guardião LGPD: PR #110 (`eng/sigilo-adolescente`)

- **Data:** 29/10/2026
- **Escopo:** `git diff main...eng/sigilo-adolescente` (commit `c065a4d`, 18 arquivos): migração `0056_escopo_e_sigilo_do_adolescente.sql`, `schema.ts`, `responsaveis-regras.ts`, `responsaveis.validation.ts`, `responsaveis.service.ts`, `responsaveis.controller.ts`, `guardians-export.ts`, `tenant-export.ts` (G2 1.20.0), testes (regra, RLS de responsáveis, exportação-cobertura, guarda-schema, exit-guarantee, sessão-tenant), `api-dominio.md` §11, ROPA, `pacote-advogado.md` (1.15) e `fila.md`. Fecha no código a A1 (b) e (c) dos pareceres do #67 ([20/10](2026-10-20-pr67.md), [21/10](2026-10-21-pr67.md)).
- **Testes:** não rodei nada. Postgres não roda localmente; os testes RLS só rodam no CI. Li o diff inteiro e conferi fora dele: `perfis.ts` (quem tem `responsaveis:liberar_informacao_clinica`), o gatilho de decisão da 0031, `app_patient_guardians_eliminate` (0037) e o runner `scripts/migrate.mjs`.

## Veredito: **APROVADO COM RESSALVAS**

Sem bloqueio para o merge: ainda não há consumidor de `podeReceberInformacaoClinica`, e o que foi entregue vai para o lado protetor (padrão `essencial`, pedido de sigilo que anula a marca, exceção por risco só com decisão **posterior** e justificada, pedido sem texto, RLS com restritiva `portal_fora`, banco conferindo autor e perfil, nada se apaga). As ressalvas R1 a R3 têm de estar resolvidas **antes do PR de consumidor** (C3). R4 a R7 podem ir em PR de acompanhamento.

## Conferência

| Item | Situação |
|---|---|
| Base legal | Art. 11, II, "f" e art. 14 (melhor interesse) para a decisão sobre o menor; o pedido de sigilo é registro de conduta clínica (CEM art. 74; CFP art. 13; ECA art. 17). ROPA atualizado. |
| Minimização | Tabela só com ids e datas; o conteúdo fica no prontuário. Trilha só com ids e flags. ✅ |
| Criptografia | Motivo da exceção por risco na justificativa cifrada já existente. Nenhum campo novo em claro com conteúdo. ✅ |
| Isolamento por tenant | FKs compostas `(id, tenant_id)`, RLS `ENABLE` + `FORCE`, política de tenant e restritiva do portal. Teste entre clínicas. ✅ |
| Controle de acesso | Rota com `responsaveis:liberar_informacao_clinica` (só `profissional`) + `exigirConteudoClinico` (vínculo de cuidado). O banco confere perfil `profissional` e autor = sessão. ✅ (ver R2) |
| Auditoria | Criar, revogar e listar auditados; `podeReceberInformacaoClinica` audita escopo e motivo. ✅ |
| Retenção | Pedido nunca se apaga, mas fica fora da eliminação com o prontuário (R3). |
| Segredos e dados reais | Nenhum no diff. ✅ |

## Respostas às perguntas do PR

1. **12 anos e padrão `essencial`:** sim, é o lado protetor enquanto a D8 não responde. `essencial` como padrão e as marcas antigas virando `essencial` estão certos. O piso de 12 anos não desprotege a criança: abaixo de 12 a marca continua dependendo só da decisão do profissional, que pode deixá-la desligada (CEM art. 74 fala em discernimento, não em idade). A pergunta 1.15(a) já cobre a dúvida. Ver R6 sobre registrar isso.
2. **Pedido sem texto:** suficiente e preferível (minimização). Falta só amarrar a prova (R5, opcional).
3. **Mascaramento do motivo:** a ideia está certa, mas o apelido é 1:1 com o pedido, então não esconde nada (R1). Além disso, o profissional **sem** vínculo de cuidado vê o motivo real (R2).
4. **0056 com gatilhos desligados:** aceito. O runner roda cada migração dentro de `sql.begin` (transação), então o `DISABLE`/`ENABLE TRIGGER USER` é atômico: se falhar, nada fica desligado. O `UPDATE` só muda para o valor mais restrito. Os gatilhos de FK são de sistema e continuam ativos. Ver R7 (registro do preenchimento).
5. **C3:** fica **destravada para avaliação** num PR de consumidor, com novo parecer, desde que R1 a R3 estejam resolvidas e o consumidor cumpra as condições do item C3 abaixo.

## Ressalvas

### R1. `restrita_pelo_profissional` é sinônimo exato de "o adolescente pediu sigilo"

- **Onde:** `responsaveis.service.ts` → `motivoVisivel`; `responsaveis-regras.ts` (`MotivoInformacaoClinica`); `api-dominio.md` §11.
- **Problema:** só o pedido de sigilo produz `restrita_pelo_profissional`. Recepção, financeiro e admin veem `recebeInformacaoClinica: true` + `permitida: false` + esse motivo, e concluem com certeza que o adolescente pediu sigilo daquele responsável. É justamente o dado que a recepção pode deixar escapar no balcão para o pai ou a mãe. O mascaramento troca o nome do motivo, mas não esconde a informação.
- **Correção:** para quem não é profissional com vínculo de cuidado, juntar **todos** os motivos negativos com a marca ligada (`adolescente_requer_nova_decisao`, `sem_autorizacao_do_paciente`, `sigilo_pedido_pelo_adolescente`, e também `sem_decisao_do_profissional`) num único motivo genérico (por exemplo `restrita_pelo_profissional`). Assim o motivo deixa de identificar o pedido. Teste: recepção vê o mesmo motivo para um adolescente sem nova decisão e para um adolescente com pedido de sigilo.

### R2. Profissional sem vínculo de cuidado vê o motivo real e a exceção por risco

- **Onde:** `responsaveis.service.ts` → `paraDto` (`motivoVisivel` e `superaSigiloPorRisco` usam só `temPermissao(perfis, 'responsaveis:liberar_informacao_clinica')`).
- **Problema:** a permissão vale para **qualquer** `profissional` da clínica. Listar os pedidos exige vínculo de cuidado (`exigirConteudoClinico`), mas o DTO de responsáveis (`responsaveis:ler`) mostra `sigilo_pedido_pelo_adolescente` e `superaSigiloPorRisco: true` a um profissional que nunca atendeu o paciente. O controle fica incoerente: a mesma informação é negada numa rota e entregue na outra.
- **Correção:** usar o mesmo porteiro de vínculo de cuidado (resultado de `exigirConteudoClinico`, sem lançar erro, ou a função de vínculo de `vinculo-de-cuidado.ts`) para decidir se o motivo real e `superaSigiloPorRisco` aparecem. Sem vínculo, cai na R1. Teste RLS com profissional sem vínculo.

### R3. Pedido específico se perde quando o vínculo é refeito, e fica fora da eliminação

- **Onde:** `0056` (`guardian_link_id` como único alvo do pedido específico); `pedidoDeSigiloDoVinculo`; `app_patient_guardians_eliminate` (0037).
- **Problema:**
  - **Vínculo refeito:** o adolescente pede sigilo em relação a uma **pessoa** (o pai), mas o pedido aponta para o **vínculo**. Se o vínculo for anulado (cadastro errado) ou encerrado e um novo vínculo for criado para a mesma pessoa, o pedido não alcança o novo vínculo. Basta o profissional ligar a marca para a informação voltar a chegar a quem o adolescente excluiu, sem nenhum aviso.
  - **Eliminação:** "nada se apaga" vale durante a guarda. Mas `app_patient_guardians_eliminate` limpa os vínculos e não toca nos pedidos. O fato "este paciente pediu sigilo deste responsável" sobrevive à eliminação do prontuário (20 anos; CFM 1.821/2007; Lei 13.787/2018), sem base para isso (LGPD art. 16).
- **Correção:**
  1. Gravar também `guardian_id` (a pessoa) no pedido específico, com FK composta, e fazer o pedido alcançar **todo vínculo vigente daquela pessoa com o paciente**. Opção mínima: ao criar o vínculo ou ligar a marca para uma pessoa que tem pedido em vínculo anterior, devolver 409 ou exigir a exceção por risco. Teste RLS: anular, recriar e ligar a marca → continua negado.
  2. Incluir os pedidos em `app_patient_guardians_eliminate`: apagar (pela função dona, SECURITY DEFINER, com o gatilho aceitando só esse caminho) ou marcar como eliminados, e contar no retorno. Teste em `guarda-schema`/eliminação.

### R4. Sem teste de que a sessão do portal não lê os pedidos

- **Onde:** `apps/api/test/responsaveis.rls.test.ts`.
- **Problema:** a restritiva `portal_fora` é a garantia de que nem o responsável nem o titular, pelo portal, descobrem o pedido. Ela não tem teste.
- **Correção:** teste com sessão de portal de responsável **e** de titular: `SELECT` devolve 0 linhas, e `INSERT`/`UPDATE` falham.

### R5. Prova do pedido (opcional)

- **Onde:** `adolescent_confidentiality_requests`.
- **Problema:** sem texto está certo. Mas, numa disputa com o responsável, a prova de que o adolescente pediu fica só no prontuário, sem ligação com o registro.
- **Correção (opcional):** campo opcional com o **id** da evolução do prontuário onde o profissional registrou o pedido (sem conteúdo), ou orientação no §11 para registrar o pedido na evolução do mesmo dia.

### R6. Documentar os limites da exceção por risco e do piso de idade

- **Onde:** `api-dominio.md` §11 (A1 c).
- **Problema:** falta deixar claro, para quem implementa o consumidor e para a clínica, que:
  - o pedido de sigilo **nunca** impede a comunicação obrigatória ao Conselho Tutelar nem a notificação compulsória (ECA arts. 13 e 245). Esse dever não passa pela marca;
  - a exceção por risco é por vínculo: superar o sigilo perante um responsável não abre para os outros, e o responsável que é a fonte do risco não deve ser o destinatário;
  - a boa prática é informar o adolescente antes de quebrar o sigilo (CFP art. 13; CEM art. 74), registrando isso na justificativa;
  - abaixo de 12 anos, a proteção é deixar a marca desligada, até a resposta da 1.15(a).
- **Correção:** acrescentar esses quatro pontos ao §11.

### R7. Preenchimento da 0056 fora do histórico

- **Onde:** `0056`, `UPDATE ... SET clinical_info_scope = 'essencial'` com `DISABLE TRIGGER USER`.
- **Problema:** é correto não gerar evento de decisão. Mas a mudança de estado das marcas antigas não fica registrada em lugar nenhum.
- **Correção:** registrar no relatório da rodada (ou num `RAISE NOTICE` com a contagem) quantas marcas foram preenchidas e que o preenchimento foi para o valor mais restrito.

## Condições

- **C1 (merge):** nenhuma condição nova. As do #67 continuam valendo.
- **C2 (fila):** registrar R1 a R7. R1 a R3 ficam marcadas como **pré-requisito do consumidor**.
- **C3 (portal/COM): destravada para avaliação**, com novo parecer, desde que:
  1. R1, R2 e R3 estejam no `main`;
  2. o consumidor use **só** `podeReceberInformacaoClinica`, sem ler `receives_clinical_info` direto, e trate `escopo`;
  3. exista um **catálogo explícito** do que cabe em `essencial` (orientações, cuidados, riscos) e do que só sai em `integral`. Hoje o escopo é um rótulo sem mapa de conteúdo. Sem catálogo, o consumidor entrega só `essencial`, e o que não estiver catalogado conta como `integral`;
  4. a negativa chegue ao responsável sem revelar o motivo (nunca "o adolescente pediu sigilo");
  5. enquanto a D8 / 1.15 não responder, o conteúdo `integral` não seja entregue de forma automática (portal ou mensagem). Ele continua só pelo profissional, fora do canal automático.

---

## Re-revisão (29/10/2026, commit `96921e5`)

- **Escopo:** `git diff c065a4d..96921e5`: migração 0056, `responsaveis-regras.ts`, `responsaveis.service.ts`, `guardians-export.ts`, `schema.ts`, testes (`responsaveis.rls`, `portal.rls`, regra) e `api-dominio.md` §11.
- **Testes:** não rodei nada (Postgres não roda localmente). Conferi os bytes da migração e o estado do CI (`gh pr checks 110`).

### Veredito: **VETADO** (1 bloqueio técnico: a 0056 não executa)

O mérito das correções está certo. Corrigido o B1 abaixo e com o CI verde (RLS, ofensivos, guardas do banco), o PR fica **APROVADO COM RESSALVAS** sem nova rodada de mérito.

### Bloqueio

#### B1. Bloco `DO` da 0056 com um cifrão só: a migração quebra

- **Onde:** `0056_escopo_e_sigilo_do_adolescente.sql`, linhas 35 e 43 (preenchimento com `RAISE NOTICE`, R7).
- **Problema:** o arquivo tem `DO $` … `$;`. Conferido com `od -c`: é `D O ␠ $ \n` e `$ ; \n`. O Postgres só aceita `$$` ou `$tag$`, então é erro de sintaxe. Provavelmente o PowerShell ou o heredoc comeu um dos cifrões. A migração inteira falha, e nenhum teste de banco desta rodada roda. Os jobs com Postgres já falham no PR: "Testes ofensivos", "Resiliência + backup/restauração", "conferência das guardas do banco" e DAST. Sem a 0056 aplicada, nada do que garante o sigilo (RLS `portal_fora`, gatilhos, eliminação) está provado.
- **Correção:** trocar por `DO $$` … `$$;` (ou `$preenche$`). Depois, conferir que os jobs "Isolamento entre tenants (RLS)", "Testes ofensivos" e "conferência das guardas do banco" passam. Vale um `grep -nE '^\s*(DO|AS) \$[^$a-z]'` nas migrações como trava.

### Conferência das ressalvas

| Ressalva | Situação |
|---|---|
| **R1** motivo genérico | ✅ `motivoVisivel(r, marcaLigada, veClinico)`: para quem não tem vínculo de cuidado, toda negativa com a marca ligada vira `restrita_pelo_profissional`. A pendência sai do motivo já mascarado, então também não denuncia o pedido. Teste com recepção vendo `paciente_maior_de_idade` como genérico. Com a marca desligada, `marca_desligada` continua visível. Correto: a marca em si é dado de cadastro e não revela o pedido. |
| **R2** porteiro clínico no DTO | ✅ `veClinico` = permissão `liberar_informacao_clinica` **e** `podeLerConteudoClinico(perfis, calcularVinculoDeCuidado(...))`, o mesmo porteiro da lista de pedidos. `superaSigiloPorRisco` usa o mesmo filtro. Teste com profissional sem vínculo. Observação de desempenho (não de segurança): `calcularVinculoDeCuidado` roda uma vez por vínculo na listagem; dá para calcular uma vez por paciente. |
| **R3** pedido segue a pessoa | ✅ `guardian_id` com FK composta, CHECK de par com o vínculo, e o gatilho confere que o vínculo é do mesmo paciente e da mesma pessoa. A regra, a exceção por risco e o "já vigente" passam a usar a pessoa. Teste encerrando e refazendo o vínculo. |
| **R3** eliminação | ✅ `app_patient_guardians_eliminate` tem o mesmo corpo da 0037 (conferido com `diff`), mais o `DELETE` dos pedidos antes dos vínculos, sob a marca transacional `app.guardians_eliminating` (`tenant:paciente`, local à transação, limpa logo depois). A marca sozinha não abre o `DELETE`: `app_user` não tem esse privilégio, então só a função dona (SECURITY DEFINER, admin ou job, com a RLS forçada) apaga. Teste A4 cobre. |
| **R4** portal | ✅ Teste em `portal.rls` com sessão de responsável e de titular: 0 linhas e inserção recusada. |
| **R5** prova | ⏳ Opcional, na fila e no §11. Aceito. |
| **R6** limites no §11 | ✅ Os 4 pontos estão lá. Complemento menor, sem bloquear: na exceção por risco, o responsável que é a **fonte** do risco não deve ser o destinatário. Acrescentar meia frase ao 2º ponto. |
| **R7** contagem | ✅ no mérito (`GET DIAGNOSTICS` + `RAISE NOTICE`), mas é justamente o bloco quebrado do B1. |

### Condições

- **C1 (merge):** B1 corrigido e CI verde nos jobs com Postgres.
- **C2 (fila):** R5 e o complemento da R6.
- **C3 (portal/COM):** R1 a R3 resolvidas. Fica destravada para avaliação no PR de consumidor, com novo parecer, nas condições 2 a 5 acima.

## Registro do Maestro (29/10/2026)

- B1 da re-revisão corrigido em fce7305: o bloco `DO` da 0056 voltou a usar `$$`. O `replace` do JavaScript tinha trocado `$$` por `$`. A frase da R6 sobre a fonte do risco e o cálculo do vínculo de cuidado uma vez por paciente na listagem entraram no mesmo commit.
- O seed do teste de cobertura do G2 passou a informar a pessoa do vínculo (2901673).
- CI do PR #110 todo verde no head 2901673 (16/16), inclusive Isolamento entre tenants (RLS), Testes ofensivos e conferência das guardas do banco. Pela conferência acima, o veredito passa a **APROVADO COM RESSALVAS**. R5 fica na fila.

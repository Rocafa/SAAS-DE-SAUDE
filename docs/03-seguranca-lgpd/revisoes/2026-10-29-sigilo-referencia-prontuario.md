# Parecer do Guardião LGPD: PR #113 (`eng/sigilo-referencia-prontuario`)

- **Data:** 29/10/2026
- **Escopo:** `git diff main...eng/sigilo-referencia-prontuario` (commit `29e5aa0`, 10 arquivos): migração `0058_sigilo_referencia_no_prontuario.sql`, `schema.ts`, `responsaveis.service.ts`, `responsaveis.validation.ts`, `responsaveis-regras.test.ts`, `guardians-export.ts`, `tenant-export.ts` (G2 1.22.0), `test/responsaveis.rls.test.ts` (describe `0058`), `api-dominio.md` §11 e `fila.md`. Fecha a **R5 (opcional)** do [parecer do sigilo do adolescente](2026-10-29-sigilo-adolescente.md).
- **Testes:** não rodei nada. Não há Postgres local; os testes RLS rodam só no CI. Li o diff inteiro e conferi fora dele: a função da 0056 (diff linha a linha contra a 0058), `encounters` e `encounters_guard` (0012/0015), a RLS e os `REVOKE` de `encounters`, `app_patient_guardians_eliminate` (0056), `listarPedidosDeSigilo` e o DTO do atendimento em `prontuario.service.ts`.

## Veredito: **APROVADO COM RESSALVAS**

Sem bloqueio para o merge, desde que o CI fique verde (inclusive Isolamento entre tenants/RLS). A mudança é pequena e protetora: só um uuid opcional, sem conteúdo, conferido duas vezes (API e banco) e imutável. As ressalvas R1 e R2 são de teste e podem ir neste PR ou no próximo. R3 e R4 são de orientação/documentação e vão para a fila.

## Conferência

| Item | Situação |
|---|---|
| Base legal | A mesma do pedido (registro de conduta clínica: CEM art. 74, CFP art. 13, ECA art. 17; art. 11, II, "f" e art. 14 da LGPD). O id só liga dois registros que já existem na clínica; não cria tratamento novo. ✅ |
| Minimização | Só `encounter_id` (uuid). Nenhum texto, nenhuma cópia da evolução. A trilha grava só o id (`encounter_id`). `bases-legais-e-consentimento.md` ("o pedido guarda só ids e datas") continua verdadeiro. ✅ |
| Criptografia | Nada novo a cifrar (id opaco, sem dado clínico). ✅ |
| Isolamento por tenant | Gatilho filtra `e.tenant_id = NEW.tenant_id`; `NEW.tenant_id` já é amarrado à sessão pela política `tenant_isolation` (WITH CHECK) da tabela; `encounters` tem RLS `FORCE` de tenant; o service filtra por `ctx.tenantId`. Um id de outra clínica cai no mesmo 409. ✅ |
| Controle de acesso | Rota inalterada (só `profissional` com vínculo de cuidado). Atendimento tem de ser do mesmo paciente **e** de autoria do usuário da sessão, na API e no gatilho. ✅ |
| Oráculo | 409 `atendimento_nao_confere` único para inexistente, de outro paciente, de outro autor ou de outra clínica; no banco, a mesma mensagem e `23514` para todos os casos. ✅ (ver R1) |
| Auditoria | `encounter_id` na metadata da criação; listar e revogar já auditados. ✅ |
| Retenção | Atendimento nunca se apaga (gatilho `encounters_no_delete` + `REVOKE DELETE`); o pedido é apagado com os vínculos em `app_patient_guardians_eliminate` (marca transacional da 0056, não alterada). ✅ |
| Exportação (G2) | `encounterId` em `guardians.adolescentConfidentialityRequests[]`, versão 1.22.0 com nota. O export de clínica já leva `encounters`, então a referência fecha dentro do pacote. ✅ |
| Segredos e dados reais | Nenhum no diff; nomes de teste fictícios. ✅ |
| CFM/ANS/ICP-Brasil | Não muda assinatura nem prontuário; a prova continua sendo a evolução (assinada, com hash) do prontuário. ✅ |

## Respostas aos pontos do PR

1. **Minimização:** correta. Era exatamente o que a R5 pedia: o id, não o conteúdo.
2. **O 409 único evita oráculo?** Sim. Nenhum caminho diferencia "não existe" de "existe, mas é de outro profissional/paciente": a consulta do service exige os quatro filtros juntos e o gatilho repete o mesmo `EXISTS`. Os ids são uuid v4 (não enumeráveis). Observação: o oráculo seria pouco valioso de todo modo, porque `prontuario.service.ts` já mostra os **metadados** (id, autor, `restrito`, datas) de atendimentos de psicologia `restrito_ao_autor` a outros profissionais da clínica; o que fica restrito é o **conteúdo**. Pelo mesmo motivo, o `atendimentoId` aparecer na lista de pedidos para outro profissional com vínculo de cuidado não expõe nada além do que ele já vê.
3. **Falta de FK:** aceitável. `encounters` não se apaga e `patient_id`/`author_user_id` são imutáveis (`encounters_guard`), então a referência não fica órfã no ciclo normal; a FK composta exigiria `REFERENCES` e acoplaria a ordem de eliminação dos dois ciclos (pedido x prontuário) sem ganho de proteção. A conferência no gatilho cobre o que a FK cobriria (existência e tenant) e ainda paciente e autor. Se um dia o prontuário for eliminado antes dos vínculos, sobra um uuid sem conteúdo, o que não é dado pessoal útil.
4. **Corrida e permissões do gatilho:** corretas. A função é `SECURITY INVOKER` (não mudou), roda como `app_user`, que tem `SELECT` em `encounters` sob RLS de tenant; `search_path` fixo; `REVOKE ALL ... FROM PUBLIC` mantido. Não há corrida relevante: as colunas conferidas (`tenant_id`, `patient_id`, `author_user_id`) são imutáveis e o atendimento não se apaga, então o `EXISTS` não pode ficar falso entre a conferência e o commit; um `FOR SHARE` seria desnecessário. O diff da função contra a 0056 mostra só os dois acréscimos (conferência na criação e `encounter_id` na lista de imutáveis); nada da 0056 foi perdido. Trigger, RLS, `portal_fora` e grants não foram recriados e continuam valendo.
5. **Exportação G2 e eliminação:** corretas. O campo entra no export com versão nova; a eliminação apaga a linha inteira, inclusive o id.

## Ressalvas

### R1. Teste do caso que importa para o oráculo (pela API)

- **Onde:** `test/responsaveis.rls.test.ts`, describe `0058`.
- **Problema:** o caso "mesmo paciente, atendimento de **outro** profissional" (o da psicologia `restrito_ao_autor`) só é testado direto no banco, com um profissional **sem** vínculo de cuidado. Pela API, ele levaria 403 antes de chegar à conferência, então o 409 único para "outro autor" não está provado no caminho real.
- **Correção:** um segundo profissional **com** vínculo de cuidado com o mesmo adolescente abre o próprio atendimento; profA tenta `{atendimentoId: <atendimento do colega>}` e recebe 409 `atendimento_nao_confere` com corpo idêntico ao do id inexistente. De preferência, também um atendimento da clínica B (mesmo 409).

### R2. Teste de que a revogação continua funcionando com `encounter_id` preenchido

- **Onde:** mesmo describe.
- **Problema:** o teste prova que trocar `encounter_id` falha (42501), mas não que revogar um pedido **com** atendimento ligado ainda passa (o `UPDATE` da revogação leva o `encounter_id` igual).
- **Correção:** `POST .../sigilo/:pedidoId/revogar` no pedido criado com `atendimentoId` → 200, `revogadoEm` preenchido e `atendimentoId` preservado.

### R3. Orientação sobre qual atendimento apontar (fila)

- **Onde:** `api-dominio.md` §11 e, quando houver, a tela.
- **Problema:** o banco aceita qualquer atendimento do mesmo paciente e autor, inclusive um ainda **aberto** (não finalizado) ou de meses antes. Como prova numa disputa, o que vale é a evolução **finalizada** (com hash) do dia do pedido.
- **Correção:** a orientação já escrita ("registrar o pedido na evolução do dia e informar o atendimento") basta por ora; na tela, sugerir por padrão o atendimento do dia e avisar se ele ainda não foi finalizado. Não precisa travar no banco.

### R4. Acesso à prova em disputa (fila, documentação)

- **Onde:** `api-dominio.md` §11 (Limites e deveres) ou `pacote-advogado.md` 1.15.
- **Problema:** se o atendimento apontado for de psicologia `restrito_ao_autor`, só o autor lê a evolução. Numa requisição judicial ou disputa com o responsável, a clínica precisa saber que o caminho é o autor (ou o export da clínica, que leva o conteúdo cifrado com a chave da clínica), e que o pedido em si continua sem texto.
- **Correção:** uma frase no §11 registrando isso. Sem mudança de código.

## Conclusão

APROVADO COM RESSALVAS. Merge liberado com o CI verde. R1 e R2 (testes) neste PR ou no próximo; R3 e R4 na fila. A R5 do parecer de 29/10 passa a **fechada**.

## Nota do Maestro (29/10/2026)

- **R1:** feita. Teste pela API com um segundo profissional que tem vínculo de cuidado com o paciente: apontar para a evolução de profA dá 409 `atendimento_nao_confere`, com corpo idêntico ao do id inexistente. O atendimento de outra clínica cai no mesmo caso do inexistente, porque o RLS o esconde.
- **R2:** feita. Revogar o pedido com atendimento ligado dá 200 e mantém o `atendimentoId`.
- **R3:** na fila (tela).
- **R4:** registrada no §11 do `api-dominio.md`.

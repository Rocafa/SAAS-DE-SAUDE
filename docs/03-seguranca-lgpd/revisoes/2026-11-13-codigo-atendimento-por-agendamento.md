# Parecer do Guardião: código do PR #192 (`GET /atendimentos/do-agendamento/:agendamentoId`, #180 item 1, e R8 do #63)

**Veredito: APROVADO COM RESSALVAS.** Condição para o merge: o job "Isolamento entre tenants (RLS)" e o "Lint, typecheck e testes" ficarem verdes. Os dois estavam *pending* na revisão e não há Postgres local para rodar `test:rls`, então o describe novo **não foi visto passar**.

Branch `eng/atendimento-por-agendamento`, diff `origin/main...HEAD` (5 arquivos, +134/-4). Data: 2026-11-13.

## Conferido e aprovado

| Ponto | Onde | Conclusão |
|---|---|---|
| Perfil não clínico negado antes de consultar | `acesso-clinico.ts:57` (`comNegacaoAuditada`) envolve `prontuario.service.ts:242` | Recepção e financeiro levam 403 auditado antes de qualquer SELECT, inclusive para agendamento inexistente. O teste (`prontuario.rls.test.ts:681-686`) confere +2 negações |
| Porteiro antes da existência do atendimento | `prontuario.service.ts:244-253` | Ordem: agendamento (só id e paciente) → `exigirConteudoClinico` → só depois o SELECT em `encounters`. Profissional sem vínculo recebe o mesmo 403 com ou sem atendimento, e o teste compara os corpos (`:687-690`). O 404 contra 403 revela só que o **agendamento** existe na clínica, o mesmo nível do `abrir` e da agenda. Não revela atendimento nem conteúdo. Aceito |
| Um atendimento por agendamento | `0012_prontuario.sql:71` (`UNIQUE (tenant_id, appointment_id)`) e FK composta `:67` | O `[e]` de `prontuario.service.ts:250` não escolhe entre vários, e o paciente do atendimento é por construção o do agendamento |
| Isolamento por clínica | `prontuario.service.ts:247,253` (`tenantId` explícito) + `lerNaClinica` (RLS) | 404 igual para inexistente e para outra clínica, com o corpo comparado (`:693-697`) |
| MFA e sigilo da psicologia | `prontuario.service.ts:262-263` | `conferirMfaDoRegistro` e `montar` são as mesmas chamadas do `obter` (`:222-223`), na mesma ordem (depois do vínculo, B3). O sigilo tem teste (`:674-679`) |
| Trilha de leitura com atendimento | `prontuario.service.ts:264-275` | `encounter_id`, `appointment_id`, `patient_id`, `version`, `hidden`, `care_basis`. Só ids e códigos. `hidden` já fica fora da visão da clínica (`consulta-trilha.ts:76-80`) |
| Trilha de leitura sem atendimento | `prontuario.service.ts:254-259` | `appointment_id`, `patient_id`, `found:false`, `care_basis`. Nenhum dado pessoal em claro. `found` não está em `CHAVES_VISIVEIS`, então a clínica não vê o campo. Testado (`:663-672`) |
| Validação da entrada | `prontuario.controller.ts:56-57` | `exigirUuid` + query vazia; 400 testado (`:695-696`) |
| Lista de cobertura | `test/cobertura-auditoria/lista.ts:141` | **Aprovo** a inclusão em `AUDITADAS_LEITURA`: a rota grava `Read` nos dois caminhos e nega com trilha |
| Vigilância contada depois da leitura | `prontuario.controller.ts:61,73` | **Sem risco de integridade.** `VigilanciaDeLeituraService.ficha` (`vigilancia-de-leitura.ts:112-120`) só alerta, nunca bloqueia. Ela segue fail-open (`:131-140`) e o `alertar` engole a própria falha (`:163-167`), então não há 500 depois de uma leitura já auditada. A diferença em relação ao histórico (que conta antes, `:127`) é que aqui só a leitura bem-sucedida conta. Isso é aceitável, porque as negações já ficam na trilha |
| Contrato documentado | `docs/04-arquitetura/api-dominio.md:281` | Coerente com o código |

## Ressalvas (não bloqueiam, entram na fila)

| # | Onde | Problema | Correção | Prazo |
|---|---|---|---|---|
| R1 | `prontuario.controller.ts:85-91` | O R8 do parecer do #63 pede a vigilância em `GET /atendimentos/:id` **e** em `/versoes`. Este PR liga só no `:id` e na rota nova; `/versoes` (que devolve **todas** as versões do conteúdo) continua sem contar | Chamar `vigilancia.ficha(ctx, \`prontuario:${pacienteId}\`)` depois de `service.versoes` (o service precisa devolver o paciente ou o controller lê o id do atendimento). Até lá o R8 fica **parcial**, não fechado | Antes do piloto (prazo original do R8) |
| R2 | `test/prontuario.rls.test.ts:652-698` | Nenhum teste prova que o R8 foi ligado: não existe teste de `fichas_distintas` disparado por `GET /atendimentos/:id` ou pela rota nova (os únicos são `vigilancia-pacientes.rls.test.ts:117` e `guias-vigilancia.rls.test.ts:79`). Se alguém apagar as linhas 61 e 73 do controller, nada fica vermelho | Teste com `PATIENT_ANOMALY_DISTINCT_RECORDS` baixo: ler N+1 atendimentos de pacientes distintos e conferir um `anomaly_alert` com `rule: 'fichas_distintas'` e só regra e números | Neste PR ou no próximo |
| R3 | `test/prontuario.rls.test.ts:674-679` | O MFA da psicologia não tem teste na rota nova. Hoje o código é idêntico ao do `obter`, mas a garantia fica só na leitura do código | Caso do autor da psicologia sem MFA recente → 403 `mfa_*` com negação na trilha, e com MFA → 200 com conteúdo | Neste PR ou no próximo |
| R4 | `test/prontuario.rls.test.ts:660` | `versao >= 0` não prova nada além de "é número". A igualdade com o `GET` por id (`:658`) já cobre o que importa | Trocar por `toBe(versão atual conhecida do fixture)` ou remover a linha | Opcional |
| R5 | `prontuario.service.ts:41-54` | A interface nova entrou entre o JSDoc de `AtendimentoDto` (`:42`) e a declaração dele (`:54`), então o comentário do sigilo da psicologia ficou pendurado na interface errada | Mover `AtendimentoDoAgendamentoDto` para depois de `AtendimentoDto` | Cosmético |
| R6 | `prontuario.controller.ts:61` | O caminho `{ atendimento: null }` não conta ficha. A resposta não tem conteúdo clínico e a consulta fica na trilha com `patient_id`, então o risco é baixo. Mesmo assim, uma varredura de agendamentos sem atendimento não acende o alerta | Avaliar contar `ficha` também quando `null` (o vínculo já foi conferido e o paciente é conhecido no service) | Opcional |

## Fora do escopo deste PR

O item 2 do #180 (versão no contrato do front e `salvarRascunho` com `versaoBase` lida) e o item 3 (formato da medida) continuam abertos. O front só pode deixar de recusar com 501 depois que consumir **esta** rota e mandar de volta a `versao` que leu dela.

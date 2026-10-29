# Parecer do Guardião LGPD: PR #111 (`eng/revisao-pai-de-maior`)

- **Data:** 29/10/2026
- **Escopo:** `git diff main...eng/revisao-pai-de-maior` (commit `2808ae5`, 11 arquivos): migração `0057_confirmacao_pai_tutor_de_maior.sql`, `schema.ts`, `responsaveis-regras.ts`, `responsaveis.validation.ts`, `responsaveis.service.ts`, `guardians-export.ts` e `tenant-export.ts` (G2 1.21.0), testes (`responsaveis-regras.test.ts`, `responsaveis.rls.test.ts`), `api-dominio.md` §11 e `fila.md`. Fecha a R4 do [parecer de 29/10 sobre o apoiador](2026-10-29-apoiador.md).
- **Testes:** não rodei nada. Postgres não roda localmente, então os testes RLS só rodam no CI. Li a migração, o serviço, a validação, a exportação e os testes. Também conferi, fora do diff, a eliminação da guarda (`app_patient_guardians_eliminate`, 0056), o CHECK `patient_guardians_eliminated_check` (0034) e a ausência de GRANT por coluna em `patient_guardians`.

## Veredito: **APROVADO** (nenhum bloqueio; as notas N1 e N2 abaixo são informativas e não pedem mudança neste PR)

A R4 está resolvida. A confirmação sai da trilha e passa a ficar no vínculo, com autor e data impostos pelo banco. Um pai/mãe ou tutor vigente de paciente maior, sem confirmação, fica visível como pendência até a recepção encerrar ou confirmar.

## O que foi conferido e está OK

| Ponto | Situação |
|---|---|
| **Integridade da confirmação** | CHECK do par por/quando, e CHECK que limita a `pai_mae`/`tutor`. O gatilho `patient_guardians_adult_confirmed_guard` (invocador, `search_path` fixo, `REVOKE ... FROM PUBLIC`) impõe o usuário da sessão (`app_current_user()`) e a data do banco (`now()`). A confirmação nasce uma vez, não muda de autor e não se desfaz (42501). Os testes RLS cobrem desfazer, trocar o autor e confirmar outro tipo (23514). |
| **Compatibilidade com o que já existe** | A eliminação da guarda (0056) não mexe nas colunas novas, e o gatilho deixa passar o UPDATE que não as altera. `adult_confirmed_by` é o id do usuário da clínica, não dado do responsável, então pode ficar no vínculo eliminado, igual a `ended_by`/`patient_authorized_by`. Não há GRANT por coluna a acrescentar. |
| **Regra da pendência** | `pendenciasDoCadastro`: a pendência só aparece com `menor === false` (data decifrada ou emancipação, via `menorEm`), vínculo vigente, tipo `pai_mae`/`tutor` e sem confirmação. Sem data de nascimento não se presume maioridade (mantido). Representante e curador não entram. O cálculo fica no serviço porque o banco não lê o nascimento cifrado, o que está correto. |
| **Resolução pela recepção** | `PATCH {confirmaPacienteMaior: true}`. O `false` é recusado (400). Outro tipo dá 400, paciente ainda não maior ou sem data dá 409 `paciente_nao_e_maior`, vínculo encerrado dá 409 `vinculo_encerrado` (checagem já existente no `alterar`). Repetir é idempotente e não muda a data. O encerramento com motivo `maioridade` também resolve a pendência (teste RLS). |
| **Trilha (art. 37 LGPD)** | `campos: adult_confirmed` e `adult_patient_confirmed: true` só quando a confirmação de fato acontece. São marcas booleanas, sem conteúdo. |
| **Minimização no DTO** | Só o booleano `confirmadoParaMaior`. O id de quem confirmou não sai na API, só na exportação G2. A pendência não revela nada de clínico nem do sigilo do adolescente. |
| **Portabilidade (G2 1.21.0)** | `adultConfirmedBy`/`adultConfirmedAt` exportados, com a versão e o changelog do schema atualizados. |
| **Base legal** | Não muda: o vínculo de pai/mãe ou tutor de maior **não representa** (portal e lembrete já exigem menor). A revisão reduz o risco de manter um terceiro vinculado sem necessidade (art. 6º, III, necessidade, e art. 6º, V, qualidade dos dados). |
| **Dados fictícios e segredos** | Os testes usam só nomes fictícios. Nenhum segredo ou dado real no diff. |

## Notas (informativas, não bloqueiam)

### N1. Vínculos anteriores à 0057 aparecem como pendentes

- **Onde:** migração 0057 (sem backfill).
- **Efeito:** um pai/mãe ou tutor de maior criado antes da 0057 com `confirmaPacienteMaior` (confirmação só na trilha) vai aparecer com `revisar_pai_mae_tutor_de_maior` e precisa ser confirmado de novo. É o lado seguro, e reconfirmar é barato. O backfill a partir de `audit_log.metadata` não vale a complexidade. Basta citar isso na nota de versão para as clínicas.

### N2. Nome da pendência

- A R4 sugeria `revisar_vinculo_pai_mae_tutor_de_maior`. O PR usa `revisar_pai_mae_tutor_de_maior`, de forma coerente no código, nos testes e no §11. Não há o que mudar.

## Pendências para a fila

- Nenhuma nova. A R4 sai da fila com este PR.

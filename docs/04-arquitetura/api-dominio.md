# API de domínio: pacientes e agenda (rodada 11.1)

> 13/10/2026 · frente Engenharia · branch `eng/rotas-pacientes-agenda` · **sem dado real** (testes geram dados fictícios a cada execução). Passa pelo Guardião LGPD antes do merge.

## 1. Sessão e clínica (porta plugável)

- `AuthProvider` (`apps/api/src/modules/auth/auth-context.ts`) é a porta: recebe os cabeçalhos da requisição e devolve `{ tenantId, userId, perfis }` **guardados no servidor**, ou `null` (401).
- `SessaoGuard` protege toda rota de domínio: sem sessão, 401; perfil sem a permissão da rota (`@Permissao`), 403; rota sem `@Permissao`, 403 (falha fechada).
- **Regra 1 da D4:** a clínica vem só da sessão. Nenhum código lê `x-tenant-id`/`x-clinica-id`; `tenantId` no corpo ou na query é recusado (400, chave desconhecida). Provado em `test/security/sessao-tenant.security.test.ts`.
- Implementação atual: `DevSessionProvider` (token opaco `Authorization: Bearer <43 chars>`, sessão em memória, só o SHA-256 do token é guardado). Só existe fora de produção: com `NODE_ENV=production` a API **não sobe** (sem provedor de login real e sem KMS). Sessões são criadas por código (testes); não há tela de login.

## 2. Perfis e permissões

| Permissão | admin (dono) | profissional | recepcao | financeiro |
|---|---|---|---|---|
| Ler cadastro de pacientes, agenda, profissionais e tipos | sim | sim | sim | sim |
| Cadastrar/alterar paciente | sim | sim | sim | não |
| Inativar paciente | sim | não | sim | não |
| Marcar, remarcar, confirmar, check-in, falta, cancelar | sim | sim | sim | não |
| Marcar "em atendimento"/"atendido" (ou desfazer) | não | sim | não | não |
| Criar profissional e tipo de atendimento | sim | não | não | não |
| **Conteúdo clínico** | não | **só com vínculo de cuidado** | **nunca** | **nunca** |

A última linha não tem rota nesta rodada (não há prontuário), mas a regra já está no código (`podeLerConteudoClinico` em `perfis.ts`, B1 do parecer front-r8): perfil clínico **e** vínculo. Admin que também atende recebe os dois perfis.

## 3. Rotas

Todas exigem sessão. Erros: `400 {message:'Dados inválidos', campos:[...]}` (nomes dos campos, nunca o valor), `401`, `403`, `404` (inexistente e de outra clínica são iguais), `409 {codigo}`; demais erros, `500` genérico.

| Método e rota | Permissão | ApiClinica | Notas |
|---|---|---|---|
| `GET /sessao` | todos | `usuarioAtual` | ids e perfis; o nome do usuário entra com o provedor real |
| `GET /pacientes?busca&situacao&pagina&limite` | pacientes:ler | `listarPacientes` | `limite` ≤ 100 (padrão 50); busca sem acento, 2–80 caracteres; item = `{id, nome, nomeSocial, ativo}` |
| `GET /pacientes/:id` | pacientes:ler | `obterPaciente` | traz CPF, telefone e nascimento decifrados |
| `POST /pacientes` | pacientes:escrever | (cadastro) | obrigatórios: `nome`, `telefone`; opcionais: `nomeSocial`, `cpf` (com DV), `nascimento` |
| `PATCH /pacientes/:id` | pacientes:escrever | (edição) | `null` limpa campo opcional; paciente inativo dá 409 |
| `POST /pacientes/:id/inativar` | pacientes:inativar | — | nunca apaga (retenção) |
| `GET /agendamentos?de&ate&profissionalId&pacienteId` | agenda:ler | `listarAgendamentos` | `de`/`ate` obrigatórios, janela ≤ 31 dias, teto de 1000 linhas (`truncado`) |
| `POST /agendamentos` | agenda:escrever | `criarAgendamento` | `{pacienteId, profissionalId, tipoId, data, hora, encaixe?}`; lotado = 409 `horario_lotado`; `encaixe:true` passa da capacidade |
| `POST /agendamentos/:id/remarcar` | agenda:escrever | `remarcarAgendamento` | devolve `{data, hora}` anteriores; só agendado/confirmado |
| `POST /agendamentos/:id/status` | agenda:escrever (+ agenda:atender) | `alterarStatus` | devolve `{statusAnterior}`; transição inválida = 409 |
| `POST /agendamentos/:id/check-in` | agenda:escrever | — | atalho para `chegou` |
| `POST /agendamentos/:id/cancelar` | agenda:escrever | `removerAgendamento` | não há exclusão: "remover/desfazer" vira cancelar |
| `GET /profissionais`, `POST /profissionais` | cadastros:ler / gerir | `listarProfissionais` | `capacidade` 1–20 (AGD-01.5) |
| `GET /tipos-atendimento`, `POST /tipos-atendimento` | cadastros:ler / gerir | `listarTiposAtendimento` | `minutos` 5–480, `capacidade` 1–20 |

**Capacidade (AGD-01.5):** vagas do horário = menor entre a capacidade do profissional e a do tipo. Contam os agendamentos não cancelados e sem falta que se sobrepõem; a checagem roda sob trava por profissional (duas recepções ao mesmo tempo não estouram a vaga). Encaixe ignora a capacidade e fica marcado.

**Status:** a API fala o vocabulário do front (`agendado`, `confirmado`, `chegou`, `em_atendimento`, `atendido`, `faltou`, `cancelado`) e grava o enum compartilhado (`AppointmentStatus`). Cancelado é final.

**Fuso:** `data`/`hora` em horário de Brasília (UTC−03:00 fixo); a resposta traz também `inicio`/`fim` em UTC.

## 4. Dados, isolamento e auditoria

- Migração `0007_pacientes_e_agenda.sql`: `professionals`, `appointment_types`, `appointments` (RLS FORCE, policy por `app_current_tenant()`, sem DELETE para o runtime, FK compostas `(id, tenant_id)`), e colunas novas em `patients`. Declaradas na guarda de schema.
- `cpf_enc`, `phone_enc`, `birth_date_enc`: só o formato cifrado `v1:` do `FieldCipher` (chave da clínica, AAD amarrando clínica, tabela, coluna e linha). Um `CHECK` no banco recusa valor em claro. A primeira escrita cifrada provisiona a chave da clínica (auditado como `key_provision`).
- Auditoria na mesma transação (sem registro, sem operação): `read`/`create`/`update` com escopo `patients`, `appointments`, `professionals`, `appointment_types`. O metadata leva só ids, contagens, página, nomes de colunas alteradas e transição de status. Nunca nome, CPF, telefone ou termo de busca (teste confere).
- Política de assinatura: escrita segue G1 (bloqueada em `past_due`/`read_only`/`cancelled`); leitura, G4 (janela de saída).

## 5. O que falta para ligar o front

1. **Adaptador HTTP** em `apps/web/lib/api/` implementando `ApiClinica` com `fetch` (credenciais incluídas) e trocar o `fake.ts` por ele. Mapeamentos: `listarPacientes` pagina (o fake devolve tudo); a lista não traz telefone/CPF (tela usa `obterPaciente`); `criarAgendamento` exige `profissionalId` e `tipoId` (o fake tem padrão); `removerAgendamento` = cancelar; `alterarStatus` devolve `{statusAnterior}`; a agenda precisa sempre de `de`/`ate`.
2. **Provedor de login real (D4)** implementando `AuthProvider` (Better Auth recomendado: sessão em cookie `HttpOnly`, MFA por perfil, troca de clínica, nome do usuário em `/sessao`).
3. **Fora desta rodada:** responsáveis do paciente, recibos e pendências do dia, valor do tipo de atendimento, fuso por clínica, busca por CPF (exige índice cego), retirar o DELETE do runtime em `patients` (hoje sem rota; as suítes de segurança e resiliência ainda o usam como sonda), KMS em produção.

## 6. Como verificar localmente

Postgres real com os papéis de `infra/local/postgres-init.sh`, depois:

```bash
pnpm --filter @plataforma/api db:migrate        # DATABASE_MIGRATOR_URL (app_migrator)
pnpm --filter @plataforma/api test:rls          # inclui pacientes-agenda e a guarda de schema
pnpm --filter @plataforma/api test:security     # inclui sessao-tenant (regra 1 da D4)
```

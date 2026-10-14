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
| Marcar "em atendimento"/"atendido" (ou desfazer) | não | só no agendamento **dele** (R1) | não | não |
| Criar profissional e tipo de atendimento | sim | não | não | não |
| **Conteúdo clínico** | não | **só com vínculo de cuidado** | **nunca** | **nunca** |

A última linha não tem rota nesta rodada (não há prontuário), mas a regra já está no código (`podeLerConteudoClinico` em `perfis.ts`, B1 do parecer front-r8): perfil clínico **e** vínculo. Admin que também atende recebe os dois perfis. Atender exige, além do perfil, que o usuário seja o profissional do agendamento (`professionals.user_id`): outro profissional da clínica recebe 403 (R1 do parecer PR #57).

## 3. Rotas

**Regra de URL (V1 do parecer PR #57, vale para toda rota nova):** texto livre e documento **nunca** em path ou query string, porque a URL inteira vai para os logs de acesso do ALB, do WAF (incl. `sampledRequests`), de proxies e de APM, fora do nosso controle de retenção e sem trilha de quem lê. Na URL só entram ids opacos (UUID), datas, enums e paginação; termo de busca, nome, CPF, telefone etc. vão no corpo (`POST .../busca`). Defesa em profundidade no Terraform (#58): `redacted_fields { query_string {} }` no WAF.

Todas exigem sessão. Erros: `400 {message:'Dados inválidos', campos:[...]}` (nomes dos campos, nunca o valor), `401`, `403`, `404` (inexistente e de outra clínica são iguais), `409 {codigo}`; demais erros, `500` genérico.

| Método e rota | Permissão | ApiClinica | Notas |
|---|---|---|---|
| `GET /sessao` | todos | `usuarioAtual` | ids e perfis; o nome do usuário entra com o provedor real |
| `GET /pacientes?situacao&pagina&limite` | pacientes:ler | `listarPacientes` (sem termo) | `limite` ≤ 100 (padrão 50); item = `{id, nome, nomeSocial, ativo}`; `busca` (ou `q`, `termo`, `nome`, `cpf`, `telefone`...) na query = 400 `busca_na_url` |
| `POST /pacientes/busca` | pacientes:ler | `listarPacientes` (com termo) | corpo `{busca, situacao?, pagina?, limite?}`; 200; busca sem acento, 2–80 caracteres; `pagina`/`limite` numéricos, `limite` ≤ 100; auditoria só com contagem, página e "houve busca" |
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
- Migração `0009_patients_sem_delete.sql` (R3): o runtime perdeu `DELETE`/`TRUNCATE` em `patients`; nenhuma tabela da clínica pode ser apagada pela API. A guarda de schema cobra a lista exata.
- Migração `0008_auditoria_tipo_de_ator.sql`: `audit_log.actor_kind` e pseudônimo do suporte (ver [auditoria-encadeada.md](auditoria-encadeada.md) §4c); a trilha vai no pacote G2 (`schemaVersion` 1.2.0).
- `cpf_enc`, `phone_enc`, `birth_date_enc`: só o formato cifrado `v1:` do `FieldCipher` (chave da clínica, AAD amarrando clínica, tabela, coluna e linha). Um `CHECK` no banco recusa valor em claro. A primeira escrita cifrada provisiona a chave da clínica (auditado como `key_provision`).
- Auditoria na mesma transação (sem registro, sem operação): `read`/`create`/`update` com escopo `patients`, `appointments`, `professionals`, `appointment_types`. O metadata leva só ids, contagens, página, nomes de colunas alteradas e transição de status. Nunca nome, CPF, telefone ou termo de busca (teste confere).
- Política de assinatura: escrita segue G1 (bloqueada em `past_due`/`read_only`/`cancelled`); leitura, G4 (janela de saída).

## 5. O que falta para ligar o front

1. **Adaptador HTTP** em `apps/web/lib/api/` implementando `ApiClinica` com `fetch` (credenciais incluídas) e trocar o `fake.ts` por ele. Mapeamentos: `listarPacientes` pagina (o fake devolve tudo); a lista não traz telefone/CPF (tela usa `obterPaciente`); `criarAgendamento` exige `profissionalId` e `tipoId` (o fake tem padrão); `removerAgendamento` = cancelar; `alterarStatus` devolve `{statusAnterior}`; a agenda precisa sempre de `de`/`ate`.
2. **Provedor de login real (D4)** implementando `AuthProvider` (Better Auth recomendado: sessão em cookie `HttpOnly`, MFA por perfil, troca de clínica, nome do usuário em `/sessao`).
3. **Fora desta rodada:** responsáveis do paciente, recibos e pendências do dia, valor do tipo de atendimento, fuso por clínica, busca por CPF (exige índice cego), KMS em produção.

## 6. Como verificar localmente

Postgres real com os papéis de `infra/local/postgres-init.sh`, depois:

```bash
pnpm --filter @plataforma/api db:migrate        # DATABASE_MIGRATOR_URL (app_migrator)
pnpm --filter @plataforma/api test:rls          # inclui pacientes-agenda, guias-pacotes, a guarda de schema e a cobertura G2
pnpm --filter @plataforma/api test:security     # inclui sessao-tenant (regra 1 da D4)
```

## 7. Guias de convênio simples e pacotes de sessões (rodada 13.2, EP-24)

> 14/10/2026 · branch `eng/guias-e-pacotes` (sobre `eng/rotas-pacientes-agenda`) · migração **0011**, empilhada **depois da 0010** (alerta de anomalia). A 0011 não toca o CHECK de `audit_log.action`: usa só `read`/`create`/`update`/`sign` com escopos novos. **Sem XML TISS** (CNV-02/03 ficam na F2). Toca dado sensível: passa pelo Guardião antes do merge.

**Permissões novas** (`perfis.ts`):

| Permissão | admin | profissional | recepcao | financeiro |
|---|---|---|---|---|
| `convenios:ler` (listar convênios) | sim | sim | sim | sim |
| `convenios:gerir` (cadastrar, alterar, inativar) | sim | não | não | não |
| `guias:ler` (guias, saldo, alertas, pacotes, históricos) | sim | sim | sim | sim |
| `guias:gerir` (registrar/alterar/cancelar guia; criar/cancelar pacote) | sim | não | sim | sim |
| `guias:consumir` (consumir, estornar, registrar confirmação do paciente) | sim | sim | sim | sim |
| `guias:faturar` (relatório por convênio) | sim | não | não | sim |

Nenhuma rota devolve conteúdo clínico: guia e pacote não guardam procedimento, diagnóstico nem evolução (minimização; o procedimento/TUSS e a foto da guia ficam para quando houver armazenamento com URL assinada).

**Rotas** (mesmos erros da §3; na URL só ids, datas e números de limiar — `numero`, `senha`, `carteirinha`, `busca`... na query dão `400 {campos:['dado_na_url']}`):

| Método e rota | Permissão | ApiClinica | Notas |
|---|---|---|---|
| `GET /convenios` | convenios:ler | — | `{id, nome, registroAns, valorSessaoCentavos, exigeSenha, exigeAssinatura, validadePadraoDias, ativo}` |
| `POST /convenios`, `PATCH /convenios/:id` | convenios:gerir | — | nome único na clínica (409 `convenio_duplicado`); `registroAns` 6 dígitos; `null` limpa opcional |
| `POST /convenios/:id/inativar` | convenios:gerir | — | bloqueia guia nova (409 `convenio_inativo`); guias ativas seguem até o fim do saldo |
| `GET /convenios/:id/relatorio?de&ate` | guias:faturar | — | janela ≤ 31 dias, por data do atendimento; sessões (nº da guia decifrado, paciente, profissional, assinada, override) e totais (sessões, assinadas, assinaturas pendentes, valor = sessões × valor do convênio); teto 5000 (`truncado`) |
| `GET /guias?pacienteId&convenioId&situacao&pagina&limite` | guias:ler | `listarGuias` | contrato `Guia` do front + `convenioId`, `saldo`, `emissao`, `situacao` (`ativa`/`vencida`/`esgotada`/`cancelada`) e `alertas`; sem senha/carteirinha |
| `GET /guias/alertas?diasVencimento&sessoesRestantes` | guias:ler | — | padrão 7 dias e 1 sessão; itens `{guiaId, pacienteId, convenio, validade, saldo, alertas}` **sem nº da guia** |
| `POST /guias` | guias:gerir | `criarGuia` | `{pacienteId, convenioId, numero, senha?, carteirinha?, sessoesAutorizadas, emissao?, validade?}`; validade padrão do convênio se omitida; senha obrigatória se o convênio exige; nº duplicado no mesmo convênio = 409 `guia_duplicada` (compara sem pontuação/caixa) |
| `GET /guias/:id` | guias:ler | — | detalhe com `senha` e `carteirinha` decifradas e `exigeAssinatura` |
| `PATCH /guias/:id` | guias:gerir | — | `sessoesAutorizadas` (não abaixo das usadas: 409), `validade`, `senha`/`carteirinha` (`null` limpa); número, paciente e convênio não mudam (cancele e registre outra) |
| `POST /guias/:id/cancelar` | guias:gerir | `removerGuia` | nunca apaga; histórico fica |
| `GET /guias/:id/consumos` | guias:ler | — | folha de frequência: consumos, estornos, confirmação e `assinaturaPendente` |
| `POST /guias/:id/consumos` | guias:consumir | — | `{agendamentoId, overrideMotivo?}`; agendamento em chegou/em atendimento/atendido do MESMO paciente; 409 `agendamento_sem_sessao`, `paciente_diferente`, `sessao_ja_consumida` (guia ou pacote), `guia_cancelada`, `guia_sem_saldo`, `guia_vencida` (salvo `overrideMotivo` ∈ `prorrogacao_da_operadora`, `renovacao_em_andamento`, `decisao_da_clinica`, gravado e auditado) |
| `POST /guias/:id/consumos/:consumoId/estornar` | guias:consumir | — | `{motivo}` ∈ `status_corrigido`, `lancamento_errado`, `guia_errada`; devolve o saldo |
| `POST /guias/:id/consumos/:consumoId/assinatura` | guias:consumir | — | `{meio: 'tela'\|'papel', dispositivo?}` (rótulo do aparelho, não do paciente); devolve `{id, assinadaEm, hash}`; uma por consumo (409 `sessao_ja_assinada`); consumo estornado: 409 |
| `GET /pacotes?pacienteId&situacao` | guias:ler | `listarPacotes` | contrato `Pacote` do front + `saldo`, `tipoId`, `validade`, `situacao`, `alertas` (saldo baixo: ≤ 2) |
| `POST /pacotes` | guias:gerir | (`criarSerie` com `pacote`) | `{pacienteId, nome, total, tipoId?, validade?}` |
| `GET /pacotes/:id`, `GET /pacotes/:id/historico` | guias:ler | — | saldo; extrato das sessões que consumiram (e estornos) |
| `POST /pacotes/:id/consumos`, `.../consumos/:consumoId/estornar` | guias:consumir | — | como na guia; 409 `pacote_sem_saldo`, `pacote_vencido`, `pacote_cancelado`, `tipo_diferente` |
| `POST /pacotes/:id/cancelar` | guias:gerir | — | nunca apaga |

**Regras de saldo e concorrência.** Consumo e estorno travam, nesta ordem, o agendamento (`FOR UPDATE`), a guia/pacote (`FOR UPDATE`) e só então gravam a auditoria — a mesma ordem da mudança de status da agenda, então não há ciclo de travas. O banco ainda tem `CHECK (0 <= used_sessions <= authorized/total)` e índice único parcial "um consumo ativo por agendamento" em cada tabela. Teste com 8 consumos simultâneos numa guia de 3 sessões: exatamente 3 passam, o contador fica em 3 e há 3 consumos ativos.

**Estorno automático.** Quando o status do agendamento sai de chegou/em atendimento/atendido para agendado, confirmado, faltou ou cancelado, o consumo (guia ou pacote) é estornado na mesma transação, com motivo `status_corrigido` (HU-CNV-003 "Estorno ao desfazer"). A política "falta sem aviso consome a sessão do pacote" (HU-FIN-004) fica para a configuração da clínica.

**Alertas** (calculados no servidor, nunca no front): `vencida` (validade passou e ainda havia saldo), `vence_em_breve` com `dias` (0 = vence hoje), `ultimas_sessoes` com `restantes`, `esgotada`. A validade vale até o fim do dia no fuso da clínica (UTC−03:00).

**Dados e LGPD.**
- Migração `0011_guias_e_pacotes.sql`: `insurers`, `insurance_guides`, `guide_sessions`, `guide_session_signatures`, `session_packages`, `package_sessions` — RLS FORCE, policy por `app_current_tenant()`, FK compostas `(id, tenant_id)` (inclusive para `appointments`, que ganhou `UNIQUE (id, tenant_id)`), sem DELETE/TRUNCATE para o runtime. Declaradas na guarda de schema e no pacote G2 (`schemaVersion` 1.3.0, ver [garantia-de-saida.md](garantia-de-saida.md)).
- Número da guia, senha de autorização e nº da carteirinha só cifrados (`v1:`, chave da clínica, AAD = clínica + `insurance_guides` + coluna + linha); `CHECK` recusa valor em claro. Duplicidade do número decifra as guias não canceladas do convênio sob a trava do convênio; um índice cego (HMAC por clínica) substitui a varredura quando o serviço de chaves expuser HMAC.
- Confirmação do paciente por sessão (CNV-04.4): registro sem biometria (meio, rótulo do dispositivo, instante, quem registrou) com SHA-256 do registro canônico (`hashDaConfirmacao` em `guias-regras.ts`, recalculável). Tabela **append-only**: o runtime não tem UPDATE nem DELETE (o banco recusa com 42501, testado).
- Auditoria na mesma transação, escopos `insurers`, `insurers.report`, `insurance_guides`, `insurance_guides.alerts`, `guide_sessions`, `guide_session_signatures` (ação `sign`), `session_packages`, `package_sessions`. Metadata só com ids, contagens, `op`, códigos de motivo, `override` e o hash da confirmação — nunca número, senha, carteirinha, nome ou dispositivo (teste confere).
- Correção junto: `auditChainHead` ordenava pelo alias texto de `seq` e devolvia um elo antigo como "último" a partir de 10 eventos (manifesto G2 e âncora).

**Fora desta rodada:** XML TISS, foto da guia (URL assinada), procedimento/TUSS, série recorrente vinculada à guia com aviso de cobertura (AGD-02.4), folha de frequência em PDF, notificações de alerta (só o painel/consulta), cobrança do pacote (FIN-01.8), índice cego do número da guia.

**Testes:** `src/modules/insurance/*.test.ts` (regras e validação) e `test/guias-pacotes.rls.test.ts` (Postgres real: isolamento nas 6 tabelas pela API e pelo RLS, concorrência de guia e de pacote, estorno manual e automático, guia vencida e override, assinatura append-only, alertas, relatório batendo com a contagem no banco, permissões e auditoria sem conteúdo).

# API de domínio: pacientes e agenda (rodadas 11.1 a 13.1)

> 14/10/2026 · frente Engenharia · branches `eng/rotas-pacientes-agenda` e `eng/ressalvas-api-57` · **sem dado real** (testes geram dados fictícios a cada execução). Passa pelo Guardião LGPD antes do merge.

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

### 2a. Vínculo de cuidado (R2 do parecer PR #57)

O vínculo é **calculado no servidor** a partir da agenda da clínica da sessão e **nunca** vem da requisição: não existe parâmetro, cabeçalho ou campo que o conceda, e o tipo `VinculoDeCuidado` é marcado (só `calcularVinculoDeCuidado` o produz). Código: `apps/api/src/modules/auth/vinculo-de-cuidado.ts`.

Há vínculo quando o usuário da sessão é o `user_id` de um profissional **ativo** da clínica e esse profissional tem com o paciente ao menos um agendamento que atende a uma das bases:

| Base | Status do agendamento | Janela (início do agendamento) |
|---|---|---|
| `atendimento` | `em_atendimento` ou `atendido` (só o próprio profissional marca, R1, e só dentro da janela do horário) | início **já ocorrido** (`starts_at <= agora`) e nos últimos **N dias**, N = `tenants.care_link_days` (padrão **90**, teto **180**; migração 0013); depois disso o vínculo **expira** |
| `autoagendamento` | igual a `atendimento`, mas o agendamento foi criado **ou remarcado em qualquer momento** pelo **próprio** usuário-profissional (`created_by`, ou qualquer linha de `appointment_reschedules` com ele — R8 do #61; encaixe incluído) | a mesma; a base fica marcada para a auditoria do acesso clínico e a agenda grava `anomaly_alert` |
| `agenda_do_dia` | `agendado`, `confirmado` ou `chegou`, **nunca** de autoagendamento | de **12 h antes a 12 h depois** de agora (`VINCULO_AGENDA_HORAS`), para o preparo da consulta |

**Vínculo não autodeclarado (V1 do parecer do Guardião sobre o PR #61).** O profissional tem `agenda:escrever` e `agenda:atender`, então podia fabricar o vínculo com qualquer paciente (encaixe consigo mesmo agora, ou consulta futura/retroativa marcada como atendida). Fechado assim:

1. **Janela do atendimento:** entrar em `em_atendimento`/`atendido` só de **30 min antes do início até 60 min depois do fim** (`ATTENDANCE_WINDOW_BEFORE_MIN`/`ATTENDANCE_WINDOW_AFTER_MIN`, tetos 120 e 1440). Fora dela, `409 {codigo:'fora_do_horario'}`. Registro retroativo, se o produto precisar, será fluxo próprio, auditado e sem gerar vínculo.
2. **Início já ocorrido:** a base `atendimento` exige `starts_at <= agora`; uma consulta futura com status clínico (mesmo inserida direto no banco) não dá vínculo.
3. **Autoagendamento:** `appointments.created_by` (migração 0013, imutável por trigger) guarda o usuário que criou. Se é o próprio profissional, não há `agenda_do_dia`; o vínculo só nasce com o atendimento dentro da janela (base `autoagendamento`), e nesse momento a agenda grava, na mesma transação, `anomaly_alert` com `{rule:'vinculo_autoagendado', window_s:86400, threshold, count}` (pacientes distintos nas últimas 24 h; padrão `SELF_SCHEDULED_ALERT_PER_DAY=0`, ou seja, todo caso alerta) e log `ALERTA_ANOMALIA`. Nada de id de paciente no alerta. A criação audita `self_scheduled`.
4. **Remarcação e "Desfazer" não reaproveitam agendamento antigo (V2 da re-revisão do #61; migração 0014):**
   - `remarcar` dá `409 {codigo:'status_nao_permite'}` se o horário atual já passou (início < agora − `ATTENDANCE_WINDOW_BEFORE_MIN`), se o status não é agendado/confirmado ou se o agendamento **já teve** atendimento ou falta (`appointments.reschedule_locked`, trava permanente mantida por trigger); e `409 {codigo:'horario_no_passado'}` se o novo horário está no passado. O que já passou não se remarca: marca-se outro horário. A criação também recusa horário no passado (`horario_no_passado`, R7).
   - As voltas que saem de status clínico ou de falta (`em_atendimento → chegou`, `atendido → em_atendimento`, `faltou → agendado/confirmado`) só valem dentro da janela do horário **original**; fora dela, `409 fora_do_horario`.
   - `appointments.rescheduled_by` guarda o último usuário que remarcou (só muda junto com o horário e nunca volta a NULL, por trigger). Remarcado pelo próprio profissional conta como **autoagendamento**: sem `agenda_do_dia`, base `autoagendamento` depois do atendimento e `anomaly_alert` `vinculo_autoagendado`. A auditoria da remarcação leva `self_rescheduled`. Vale o histórico inteiro: uma remarcação posterior da recepção não apaga a marca (R8). Desde a 0016 o banco confere `created_by` (INSERT) e `rescheduled_by` (remarcação) contra o usuário da sessão travado na transação (`app_set_user`, mesmo desenho do `app_set_tenant`; R9). Desde a 0019 o slot nunca fica livre: transação sem usuário (job do sistema) grava o sentinela de sistema (`app_set_system_user`, UUID nulo), que nenhum trigger aceita como autor (`app_current_user()` = NULL), e um `app_set_user` posterior, inclusive de SQL injetado, dá 42501 (R10).
   - A data real não se perde: com a trava, nem o banco aceita mudar o horário de agendamento que teve atendimento ou falta; e toda mudança de horário grava, pelo próprio banco, uma linha em `appointment_reschedules` (de → para, quem, quando), append-only (o runtime não insere direto, não altera, não apaga), com RLS forçado e exportada no G2.
5. **Janela de continuidade por clínica (R1 do #61):** `GET /clinica/vinculo-de-cuidado` (cadastros:ler) e `PUT /clinica/vinculo-de-cuidado {dias}` (cadastros:gerir, 1..180). Auditado (`scope: tenants`, `{setting:'care_link_days', from, to}`); o banco recusa fora de 1..180 (CHECK).

- Cancelado e falta nunca dão vínculo. Profissional inativado perde o vínculo. Agendamento de **outro** profissional não se transfere.
- Outra clínica nunca dá vínculo: a consulta roda na transação da clínica da sessão (RLS) e também filtra `tenant_id`; o mesmo usuário com sessão em outra clínica não leva o vínculo junto.
- Uso: `exigirConteudoClinico(tx, ctx, pacienteId)` na **mesma transação** que lê o conteúdo e grava a auditoria; sem perfil clínico ou sem vínculo, `403 {codigo: 'sem_vinculo_de_cuidado'}` (o mesmo código nos dois casos). Devolve a base, que a rota clínica grava na auditoria (`care_basis`). Fora de transação: `VinculoDeCuidadoService.temVinculoDeCuidado(ctx, pacienteId)`.
- Equipe do caso (vínculo explícito, registrado e auditado, com validade) entra com a API de prontuário, como terceira base.
- Provas: `test/vinculo-de-cuidado.rls.test.ts` (Postgres real: com vínculo, consulta do dia, sem vínculo na mesma clínica, perfis não clínicos, outra clínica, expirado, cancelado/falta/fora da janela, profissional inativado; V1: encaixe consigo mesmo agora, consulta de amanhã e de 100 dias atrás marcadas como atendidas, bordas da janela, consulta futura `in_progress` inserida no banco, `created_by` imutável, alerta sem dado pessoal; janela por clínica; V2: falta antiga desfeita e remarcada, agendamento esquecido, atendimento antigo levado de volta, remarcar para o passado, remarcação pelo próprio profissional vira autoagendamento com alerta, recepção remarca para hoje e dá agenda do dia, histórico append-only e isolado por clínica) e `agenda-regras.test.ts` (janela, configuração, voltas e remarcação).

## 3. Rotas

**Regra de URL (V1 do parecer PR #57, vale para toda rota nova):** texto livre e documento **nunca** em path ou query string, porque a URL inteira vai para os logs de acesso do ALB, do WAF (incl. `sampledRequests`), de proxies e de APM, fora do nosso controle de retenção e sem trilha de quem lê. Na URL só entram ids opacos (UUID), datas, enums e paginação; termo de busca, nome, CPF, telefone etc. vão no corpo (`POST .../busca`). Defesa em profundidade no Terraform (#58): `redacted_fields { query_string {} }` no WAF.

Todas exigem sessão. Erros: `400 {message:'Dados inválidos', campos:[...]}` (nomes dos campos, nunca o valor), `401`, `403`, `404` (inexistente e de outra clínica são iguais), `409 {codigo}`; demais erros, `500` genérico.

| Método e rota | Permissão | ApiClinica | Notas |
|---|---|---|---|
| `GET /sessao` | todos | `usuarioAtual` | ids e perfis; o nome do usuário entra com o provedor real |
| `GET /clinica/vinculo-de-cuidado` | cadastros:ler | — | `{dias, teto}` da janela de continuidade do vínculo |
| `PUT /clinica/vinculo-de-cuidado` | cadastros:gerir | — | `{dias}` inteiro 1..180; auditado com valor anterior e novo |
| `GET /pacientes?situacao&pagina&limite` | pacientes:ler | `listarPacientes` (sem termo) | `limite` ≤ 100 (padrão 50); item = `{id, nome, nomeSocial, ativo}`; `busca` (ou `q`, `termo`, `nome`, `cpf`, `telefone`...) na query = 400 `busca_na_url` |
| `POST /pacientes/busca` | pacientes:ler | `listarPacientes` (com termo) | corpo `{busca, situacao?, pagina?, limite?}`; 200; busca sem acento, 2–80 caracteres; `pagina`/`limite` numéricos, `limite` ≤ 100; auditoria só com contagem, página e "houve busca" |
| `GET /pacientes/:id` | pacientes:ler | `obterPaciente` | traz CPF, telefone e nascimento decifrados |
| `POST /pacientes` | pacientes:escrever | (cadastro) | obrigatórios: `nome`, `telefone`; opcionais: `nomeSocial`, `cpf` (com DV), `nascimento` |
| `PATCH /pacientes/:id` | pacientes:escrever | (edição) | `null` limpa campo opcional; paciente inativo dá 409 |
| `POST /pacientes/:id/inativar` | pacientes:inativar | — | nunca apaga (retenção) |
| `GET /agendamentos?de&ate&profissionalId&pacienteId` | agenda:ler | `listarAgendamentos` | `de`/`ate` obrigatórios, janela ≤ 31 dias, teto de 1000 linhas (`truncado`) |
| `POST /agendamentos` | agenda:escrever | `criarAgendamento` | `{pacienteId, profissionalId, tipoId, data, hora, encaixe?}`; lotado = 409 `horario_lotado`; `encaixe:true` passa da capacidade |
| `POST /agendamentos/:id/remarcar` | agenda:escrever | `remarcarAgendamento` | devolve `{data, hora}` anteriores; só agendado/confirmado, ainda não passado e nunca atendido/faltado; não para o passado (V2 do #61) |
| `POST /agendamentos/:id/status` | agenda:escrever (+ agenda:atender) | `alterarStatus` | devolve `{statusAnterior}`; transição inválida = 409; `em_atendimento`/`atendido` fora da janela do horário = 409 `fora_do_horario` |
| `POST /agendamentos/:id/check-in` | agenda:escrever | — | atalho para `chegou` |
| `POST /agendamentos/:id/cancelar` | agenda:escrever | `removerAgendamento` | não há exclusão: "remover/desfazer" vira cancelar |
| `GET /profissionais`, `POST /profissionais` | cadastros:ler / gerir | `listarProfissionais` | `capacidade` 1–20 (AGD-01.5) |
| `GET /tipos-atendimento`, `POST /tipos-atendimento` | cadastros:ler / gerir | `listarTiposAtendimento` | `minutos` 5–480, `capacidade` 1–20 |

### 3a. Limite por usuário e alerta de anomalia (R5 do parecer PR #57)

A paginação deixaria um usuário raspar a base inteira. Código: `apps/api/src/modules/patients/vigilancia-de-leitura.ts`. Os contadores ficam no **mesmo store do rate limit por IP** (Redis compartilhado entre instâncias, fallback em memória), com chave HMAC de clínica + usuário (o store nunca vê id em claro).

| Regra | O que conta | Padrão (variável) | Efeito |
|---|---|---|---|
| Limite por usuário | chamadas a `GET /pacientes` + `POST /pacientes/busca` | 60 por minuto (`PATIENT_LIST_USER_MAX`, `PATIENT_LIST_USER_WINDOW_MS`) | `429 {codigo: 'limite_por_usuario'}` com `Retry-After`; outro usuário no mesmo IP não é afetado |
| `paginas_de_pacientes` | chamadas de lista/busca | mais de 40 em 10 min (`PATIENT_ANOMALY_LIST_PAGES`, `PATIENT_ANOMALY_WINDOW_MS`) | alerta |
| `fichas_distintas` | fichas **distintas** abertas (`GET /pacientes/:id`) | mais de 40 em 10 min (`PATIENT_ANOMALY_DISTINCT_RECORDS`) | alerta |
| `limite_por_usuario` | estouro do limite acima | — | alerta |

- **Alerta:** um evento `anomaly_alert` por regra e janela na trilha da clínica (migração `0010_alerta_de_anomalia.sql`), com o próprio usuário como ator e metadata só `{rule, window_s, threshold, count}`. Nunca id de paciente, nome ou termo de busca (teste confere). Grava em transação própria, para ficar mesmo quando a resposta é 429. Log com marcador fixo `ALERTA_ANOMALIA regra=...` para o alarme de operação.
- Store fora do ar: cai para memória; se mesmo assim falhar, a leitura segue com log `RATE_LIMIT_FAIL_OPEN` (mesma política do limite por IP).
- Provas: `test/vigilancia-pacientes.rls.test.ts`.

**Capacidade (AGD-01.5):** vagas do horário = menor entre a capacidade do profissional e a do tipo. Contam os agendamentos não cancelados e sem falta que se sobrepõem; a checagem roda sob trava por profissional (duas recepções ao mesmo tempo não estouram a vaga). Encaixe ignora a capacidade e fica marcado.

**Status:** a API fala o vocabulário do front (`agendado`, `confirmado`, `chegou`, `em_atendimento`, `atendido`, `faltou`, `cancelado`) e grava o enum compartilhado (`AppointmentStatus`). Cancelado é final.

**Fuso:** `data`/`hora` em horário de Brasília (UTC−03:00 fixo); a resposta traz também `inicio`/`fim` em UTC.

## 4. Dados, isolamento e auditoria

- Migração `0007_pacientes_e_agenda.sql`: `professionals`, `appointment_types`, `appointments` (RLS FORCE, policy por `app_current_tenant()`, sem DELETE para o runtime, FK compostas `(id, tenant_id)`), e colunas novas em `patients`. Declaradas na guarda de schema.
- Migração `0009_patients_sem_delete.sql` (R3): o runtime perdeu `DELETE`/`TRUNCATE` em `patients`; nenhuma tabela da clínica pode ser apagada pela API. A guarda de schema cobra a lista exata.
- Migração `0008_auditoria_tipo_de_ator.sql`: `audit_log.actor_kind` e pseudônimo do suporte (ver [auditoria-encadeada.md](auditoria-encadeada.md) §4c); a trilha vai no pacote G2 (`schemaVersion` 1.2.0).
- Migração `0010_alerta_de_anomalia.sql` (R5): ação `anomaly_alert` no CHECK de `audit_log.action` e no enum `AuditAction`. Migração posterior que redefinir esse CHECK precisa manter o valor.
- **Pseudônimo do suporte fora do processo (N1):** porta `PseudonymSigner` (`ator-suporte.ts`). Staging/produção: `KmsPseudonymSigner`, HMAC-SHA256 por `GenerateMac` numa chave HMAC_256 do KMS (`SUPPORT_PSEUDONYM_KMS_KEY_ID`; política dá ao papel da API só `kms:GenerateMac`), com `verificarChave()` (`GenerateMac` + `VerifyMac` numa sonda fixa); a fórmula do pseudônimo não muda. `LocalPseudonymSigner` só em `development`/`test` (lista fechada). Fora deles, sem KMS a API **não sobe** e `SUPPORT_PSEUDONYM_KEY` é recusada. O cliente KMS (`@aws-sdk/client-kms`) entra no Portão A; até lá a interface `KmsMacApi` é mockada nos testes.
- `cpf_enc`, `phone_enc`, `birth_date_enc`: só o formato cifrado `v1:` do `FieldCipher` (chave da clínica, AAD amarrando clínica, tabela, coluna e linha). Um `CHECK` no banco recusa valor em claro. A primeira escrita cifrada provisiona a chave da clínica (auditado como `key_provision`).
- Auditoria na mesma transação (sem registro, sem operação): `read`/`create`/`update` com escopo `patients`, `appointments`, `professionals`, `appointment_types`. O metadata leva só ids, contagens, página, nomes de colunas alteradas e transição de status. Nunca nome, CPF, telefone ou termo de busca (teste confere).
- Política de assinatura: escrita segue G1 (bloqueada em `past_due`/`read_only`/`cancelled`); leitura, G4 (janela de saída).

## 5. O que falta para ligar o front

1. **Adaptador HTTP** em `apps/web/lib/api/` implementando `ApiClinica` com `fetch` (credenciais incluídas) e trocar o `fake.ts` por ele. Mapeamentos: `listarPacientes` pagina (o fake devolve tudo); a lista não traz telefone/CPF (tela usa `obterPaciente`); `criarAgendamento` exige `profissionalId` e `tipoId` (o fake tem padrão); `removerAgendamento` = cancelar; `alterarStatus` devolve `{statusAnterior}`; a agenda precisa sempre de `de`/`ate`.
2. **Provedor de login real (D4)** implementando `AuthProvider` (Better Auth recomendado: sessão em cookie `HttpOnly`, MFA por perfil, troca de clínica, nome do usuário em `/sessao`).
3. **Fora desta rodada:** responsáveis do paciente, recibos e pendências do dia, valor do tipo de atendimento, fuso por clínica, busca por CPF (exige índice cego), KMS em produção.

## 5a. Ressalvas do parecer do PR #57

| # | Situação | Onde |
|---|---|---|
| V1, R1, R3, R6, R7 | resolvidas (rodada 12) | re-revisão do Guardião |
| R2 vínculo de cuidado no servidor | **resolvida** (rodada 13.1) | §2a |
| R4 `usuarioId` do profissional membro da clínica | aberta, com a D4 | — |
| R5 limite por usuário e alerta de anomalia | **resolvida** (rodada 13.1) | §3a |
| N1 segredo do pseudônimo fora da API | **resolvida** (rodada 13.1) | §4 |
| N2 adaptador HTTP só com `POST /pacientes/busca` | aberta, junto do adaptador | — |
| N3 tabela de usuários no pacote G2 | aberta, com a D4 | — |

## 6. Como verificar localmente

Postgres real com os papéis de `infra/local/postgres-init.sh`, depois:

```bash
pnpm --filter @plataforma/api db:migrate        # DATABASE_MIGRATOR_URL (app_migrator)
pnpm --filter @plataforma/api test:rls          # inclui pacientes-agenda, vínculo de cuidado, vigilância, guias-pacotes, a guarda de schema e a cobertura G2
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

Nenhuma rota devolve conteúdo clínico: guia e pacote não guardam procedimento, diagnóstico nem evolução (minimização; o procedimento/TUSS e a foto da guia ficam para quando houver armazenamento com URL assinada). Por isso o porteiro de conteúdo clínico (vínculo de cuidado, §2a) **não se aplica** a estas rotas; se um dia a guia ganhar procedimento/TUSS, esse campo passa por ele.

**Vigilância de leitura (R5, §3a).** As rotas que listam pacientes com identificadores da operadora contam no **mesmo** limite por usuário das listas de pacientes (mesma instância de `PatientsModule`, mesmos contadores): `GET /guias`, `GET /guias/alertas`, `GET /pacotes` e `GET /convenios/:id/relatorio` (429 `limite_por_usuario` e `anomaly_alert`). `GET /guias/:id` (senha e carteirinha decifradas) conta como ficha distinta aberta (`fichas_distintas`). Teste: `test/guias-vigilancia.rls.test.ts`.

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
- Migração `0011_guias_e_pacotes.sql`: `insurers`, `insurance_guides`, `guide_sessions`, `guide_session_signatures`, `session_packages`, `package_sessions` — RLS FORCE, policy por `app_current_tenant()`, FK compostas `(id, tenant_id)` (inclusive para `appointments`, que ganhou `UNIQUE (id, tenant_id)`), sem DELETE/TRUNCATE para o runtime. Declaradas na guarda de schema e no pacote G2 (`schemaVersion` 1.4.0, ver [garantia-de-saida.md](garantia-de-saida.md)).
- Número da guia, senha de autorização e nº da carteirinha só cifrados (`v1:`, chave da clínica, AAD = clínica + `insurance_guides` + coluna + linha); `CHECK` recusa valor em claro. Duplicidade do número decifra as guias não canceladas do convênio sob a trava do convênio; um índice cego (HMAC por clínica) substitui a varredura quando o serviço de chaves expuser HMAC.
- Confirmação do paciente por sessão (CNV-04.4): registro sem biometria (meio, rótulo do dispositivo, instante, quem registrou) com SHA-256 do registro canônico (`hashDaConfirmacao` em `guias-regras.ts`, recalculável). Tabela **append-only**: o runtime não tem UPDATE nem DELETE (o banco recusa com 42501, testado).
- Auditoria na mesma transação, escopos `insurers`, `insurers.report`, `insurance_guides`, `insurance_guides.alerts`, `guide_sessions`, `guide_session_signatures` (ação `sign`), `session_packages`, `package_sessions`. Metadata só com ids, contagens, `op`, códigos de motivo, `override` e o hash da confirmação — nunca número, senha, carteirinha, nome ou dispositivo (teste confere).
- Correção junto: `auditChainHead` ordenava pelo alias texto de `seq` e devolvia um elo antigo como "último" a partir de 10 eventos (manifesto G2 e âncora).

**Fora desta rodada:** XML TISS, foto da guia (URL assinada), procedimento/TUSS, série recorrente vinculada à guia com aviso de cobertura (AGD-02.4), folha de frequência em PDF, notificações de alerta (só o painel/consulta), cobrança do pacote (FIN-01.8), índice cego do número da guia.

**Testes:** `src/modules/insurance/*.test.ts` (regras e validação) e `test/guias-pacotes.rls.test.ts` (Postgres real: isolamento nas 6 tabelas pela API e pelo RLS, concorrência de guia e de pacote, estorno manual e automático, guia vencida e override, assinatura append-only, alertas, relatório batendo com a contagem no banco, permissões e auditoria sem conteúdo).

## 8. Atendimento e prontuário (rodada 14.1, PRO-02.1/02.3/02.6/02.7/03.7/03.8)

> 14/10/2026 · branch `eng/prontuario` (sobre `eng/guias-e-pacotes`) · migração **0012** · fisio/TO e psicologia · **sem IA** · toca dado de saúde: passa pelo Guardião antes do merge.

**Porteiro em tudo.** Toda leitura/escrita de conteúdo clínico chama `exigirConteudoClinico` (§2a) na **mesma transação** que lê/grava e audita; a regra do vínculo não é reimplementada aqui. Perfil não clínico (recepção, financeiro, admin sem perfil `profissional`) recebe `403 {codigo:'sem_vinculo_de_cuidado'}` **antes de qualquer consulta** (nem descobre se o atendimento existe). O guarda HTTP deixa os quatro perfis chegarem à rota (`prontuario:acessar`) só para a tentativa negada ficar na trilha (HU-PRO-006/022). **Abrir atendimento não cria vínculo:** o porteiro roda antes e a abertura não muda o status do agendamento ("em atendimento" continua sendo da agenda, com as regras dela). Consequência da regra do V1 do #61: num autoagendamento com check-in o profissional só abre depois de marcar "em atendimento" na agenda, dentro da janela do horário; a base `autoagendamento` fica na auditoria da abertura (teste em `test/prontuario.rls.test.ts`).

**Negação auditada** (`src/modules/records/acesso-clinico.ts`): o 403 desfaz a transação da operação, então a negação é gravada em transação própria, escopo `clinical_access_denied`, metadata `{op, reason, patient_id?, target_id?}`. Motivos: `sem_vinculo_de_cuidado`, `somente_o_autor`, `sigilo_psicologia`, `nota_de_outro_autor`.

### 8a. Rotas

| Método e rota | Quem | Notas |
|---|---|---|
| `POST /atendimentos` | profissional DO agendamento, com vínculo | `{agendamentoId, modelo?, consentimentoIa?}`; agendamento em chegou/em atendimento/atendido (senão 409 `agendamento_sem_chegada`); modelo padrão pela especialidade; **idempotente** (200 com o já aberto) |
| `GET /atendimentos/:id` | clínico com vínculo | registro atual + adendos; psicologia restrita vem com `conteudoOculto: true, motivoOculto: 'sigilo_psicologia'` |
| `PUT /atendimentos/:id/registro` | autor | `{conteudo, versaoBase}`; cada chamada = **versão nova** (serve ao salvamento automático); `versaoBase` diferente da atual: 409 `versao_desatualizada`; finalizado: 409 `registro_finalizado` |
| `GET /atendimentos/:id/versoes` | clínico com vínculo que pode ver o conteúdo | todas as versões, da 1ª à atual |
| `POST /atendimentos/:id/finalizar` | autor | exige os obrigatórios do modelo (409 `registro_incompleto` com `campos`); grava `signed_version` e `signed_hash` (SHA-256 do registro canônico com o conteúdo **cifrado**, `prontuario-regras.ts`); auditoria `sign` (evento "encounter_record_signed" da HU-PRO-007) |
| `POST /atendimentos/:id/adendos` | clínico com vínculo que pode ver o conteúdo | `{texto}`; só depois de finalizar (409 `registro_nao_finalizado`); autor e data no adendo |
| `GET /pacientes/:id/prontuario?pagina&limite` | clínico com vínculo | histórico do mais recente ao mais antigo, `limite` ≤ 50; qualquer outra chave na query = 400 `dado_na_url`; conta como ficha aberta na vigilância (R5, §3a) |
| `GET`/`POST /pacientes/:id/notas-privadas` | autor (lista só as próprias) | `{texto, atendimentoId?, incluirNaExportacao?}` |
| `GET`/`PATCH /notas-privadas/:id`, `POST /notas-privadas/:id/descartar` | **só o autor** | nota de outro autor = 404 (igual a inexistente) + tentativa auditada |
| `GET`/`PUT /prontuario/configuracao` | admin (`prontuario:configurar`) | `{psicologia: 'restrito_ao_autor' ou 'prontuario_unico'}`; mudança auditada como `permission_change` `{from, to}` |

### 8b. Modelos por nicho (`src/modules/records/modelos.ts`)

Estrutura flexível validada por schema (chave desconhecida, tipo, tamanho, faixa: 400 com o **nome** do campo, nunca o valor). Cada versão grava `template` e `template_version` (PRO-01.4).

| Modelo | Textos (até 20.000 caracteres, com quebra de linha) | Obrigatórios para finalizar | Estruturados |
|---|---|---|---|
| `fisio`, `to` | queixa, avaliacao, conduta, resposta, orientacoes | queixa, conduta | `medidas` (≤ 50): `eva` 0–10 inteiro, `goniometria` 0–360° com rótulo, `forca` MRC 0–5, `perimetria` 0–300 cm com rótulo, `escala` (domínio público, pelo nome); `planoDeSessoes` `{totalSessoes 1–200, frequenciaSemanal? 1–7, metas[≤20] {descricao, progresso 0–100}}` |
| `psicologia` | tema, intervencoes, evolucao, encaminhamentos | tema, evolucao | `planoDeSessoes` |

Ficam para as próximas micropartes: escore automático e catálogo de escalas com licença verificada (HU-PRO-023), anamnese persistente (HU-PRO-006), anexos (HU-PRO-008), editor de modelos (HU-PRO-001) e a ligação do plano com o saldo do pacote (HU-PRO-021; hoje o saldo cai pelo consumo de pacote da §7).

### 8c. Sigilo da psicologia e notas privadas (pergunta 1.11 em aberto ⚖️)

- **Registro de sessão de psicologia** fica no prontuário único do paciente, num **compartimento** (`encounters.compartment = 'psicologia'`). O sigilo é **configurável por clínica** (`clinical_settings.psych_compartment`) porque a 1.11 do [pacote do advogado](../03-seguranca-lgpd/pacote-advogado.md) (Res. CFP 001/2009, art. 6º) não tem resposta:
  - `restrito_ao_autor` (**padrão**, o mais protetor): só o psicólogo autor lê o conteúdo; os demais com vínculo veem só os metadados (`conteudoOculto`);
  - `prontuario_unico`: segue a regra geral (perfil clínico + vínculo).
  Qualquer das respostas do advogado cabe num dos modos, sem migração de dados.
- **O sigilo é do ATENDIMENTO, não da configuração atual (B1 do parecer #63, migração 0015).** Na abertura, o modo vigente é gravado em `encounters.confidentiality`, e `podeVerConteudo` decide só por ele. Trocar a configuração vale **só para atendimentos abertos depois** (a resposta do `PUT /prontuario/configuracao` traz `valeSoParaNovos: true` e a trilha `applies_to: 'new_encounters'`): o registro escrito sob "só o autor lê" continua assim para sempre. O banco recusa abrir o sigilo de um atendimento (`42501`); a única mudança aceita é **restringir** (`prontuario_unico → restrito_ao_autor`), inclusive em finalizado e sem tocar outro campo, que o admin pode pedir na troca com `restringirAnteriores: true` (resposta com `anterioresRestringidos`). Abrir registro antigo ao prontuário único **não existe** até a resposta da 1.11 (se o advogado admitir: fluxo com o autor e auditado). Aviso aos psicólogos da clínica na troca: com o módulo de notificações (fila, antes do piloto com psicologia). Prova: `test/prontuario.rls.test.ts` ("B1: a troca para prontuario_unico NÃO abre os registros antigos").
- **Anotações privadas** (HU-PRO-009) **não são prontuário**: tabela própria (`private_notes`); só o autor lê, altera ou descarta — nem admin, nem outro profissional com vínculo, **nem no modo `prontuario_unico`**. Nunca entram em relatório, IA ou exportação padrão. O ciclo de vida segue as decisões D1–D3 do Guardião (§8e).

### 8e. Notas privadas: descarte, expurgo, desligamento e direito do titular (D1–D3 do parecer #63, migração 0015)

- **D1 — descarte elimina.** `POST /notas-privadas/:id/descartar` troca, no MESMO UPDATE, o conteúdo por uma **lápide cifrada** (cifra de `""` com o mesmo AAD), zera `export_consent` e marca `discarded_at`; a resposta traz `expurgoAte` (+30 dias). A **linha** (metadados) sai por `app_purge_discarded_private_notes()` (SECURITY DEFINER, na clínica do contexto, idempotente): apaga as descartadas há mais de 30 dias, **salvo retenção legal** do paciente (`patients.legal_hold_since`, `PUT /prontuario/pacientes/:id/retencao-legal {referencia}`; retirada por duas pessoas, §8f). O runtime continua sem DELETE e o trigger `private_notes_delete_guard` só deixa apagar linha elegível. Execução: job diário por clínica (`CicloNotasPrivadasService.executarCicloDasNotas`) ou `POST /prontuario/notas-privadas/ciclo` (admin), trilha `{op:'purge', count}`. Backups: expiração de até 12 meses (1.10 c).
  - **Texto da interface (D1.5, quando a tela existir):** o descarte pede confirmação e diz que é **irreversível** e que "o que é clinicamente relevante precisa estar no prontuário; a nota não substitui o registro".
- **D2 — profissional que sai.** `POST /prontuario/profissionais/:id/desligamento` (admin) devolve **só** `{notas, prazo}`: as notas vivas do autor ficam `aguardando_decisao` por **30 dias**, em que ele decide nota a nota **sem vínculo e sem prontuário** (lê, marca para exportar, descarta; incorporar por adendo exige vínculo). Vencido o prazo (`aplicarPrazosDeCustodia`, no mesmo ciclo): nota marcada para exportar → `guarda_clinica` (acompanha o prontuário, piso de 20 anos, **ilegível no aplicativo**, só no G2); autor de **psicologia** (especialidade do profissional) → `lacrada` por **90 dias** para o psicólogo substituto (Código de Ética do Psicólogo, art. 15; a custódia com substituto designado e aceite é o R2, antes do piloto com psicologia); demais (fisio/TO) → **eliminação** (lápide + expurgo da D1). Lacrada sem decisão da custódia em 90 dias → eliminação (a clínica é lembrada do dever de informar o CRP se extinguir o serviço de psicologia). O banco não deixa nota lacrada ou sob guarda voltar a ativa.
- **D3 — o opt-in de exportação não bloqueia o titular nem ordem judicial.** A marcação do autor só decide o **G2 da clínica**. Procedimento, até a rota própria (antes do piloto):
  1. Pedido de acesso do paciente (LGPD art. 18, II, e art. 19) chega à clínica (controladora), que registra o pedido e encaminha ao **autor**; o autor responde em até **15 dias**, fornecendo o conteúdo das notas sobre o titular ou justificando por escrito uma restrição legal (sigilo profissional, se o advogado confirmar na pergunta nova junto da 1.11).
  2. Requisição judicial ou da ANPD: o admin marca a **retenção legal** do paciente (suspende o expurgo) e o autor (ou, desligado, a custódia) fornece o conteúdo pelo mesmo caminho.
  3. Rota a construir: `POST /pacientes/:id/pedidos-de-acesso/:pedido/notas-privadas` (só o autor, ou a custódia), que inclui as notas — **com ou sem** `export_consent` — no pacote do pedido, auditado (`op: 'subject_access'`, contagem, sem conteúdo na trilha). Nada disso passa pelo G2.
- Prova: `test/notas-privadas-ciclo.rls.test.ts` (lápide decifra vazio; expurgo de 31 dias sim, 10 não, retenção legal suspende e libera; idempotente; só a clínica do contexto; runtime sem DELETE; desligamento devolve só a contagem; o autor desligado decide as próprias notas sem vínculo; guarda, lacre e eliminação nos prazos; lacrada não volta a ativa).
- **Exportação G2 (decisão desta rodada).** A clínica é a controladora e o pacote é dela: o **prontuário inteiro** sai (todas as versões e adendos decifrados, inclusive o compartimento de psicologia, que é prontuário; a exportação por administrador não profissional segue a pergunta 2.9 ⚖️). As **notas privadas** só saem com a **decisão expressa do autor** (`incluirNaExportacao`, coluna `export_consent`), como promete a HU-PRO-009; as demais ficam fora e são **contadas** no manifesto (`privateNotesWithheld`), para a clínica saber que existem. A cobertura não fica silenciosa: `private_notes` está em `EXPORTED_TABLES` (exportação parcial) e `test/exportacao-cobertura.rls.test.ts` prova que a nota marcada sai, a não marcada não sai e é contada.

### 8f. Retenção legal, custódia e avisos (R2, R9, R10, R11 e R12 do parecer #63, migração 0017)

- **R10 — retenção legal bloqueia a eliminação.** Com o paciente sob retenção, nenhuma nota privada dele é descartada (lápide) nem tem o texto trocado — pelo autor (409 `retencao_legal`), pelo ciclo automático (os prazos vencidos ficam suspensos e contam em `suspensasPorRetencao`) nem pela custódia. O banco recusa também (trigger `private_notes_guard`, SQLSTATE 55000). O expurgo já era barrado (0015); o prontuário não tem caminho de eliminação nem DELETE.
- **R12 — retenção com referência e retirada por duas pessoas.** `PUT /prontuario/pacientes/:id/retencao-legal {referencia}` (admin) grava `legal_holds` com a referência do processo/ofício **cifrada**. Retirar: `POST .../retencao-legal/retirada {motivo}` (admin A, motivo cifrado) e `POST .../retencao-legal/retirada/aprovacao` (admin B; o mesmo que pediu recebe 409 `mesma_pessoa`). O trigger confere cada etapa contra o usuário da sessão (`app_current_user`, 0016) e B ≠ A; `patients.legal_hold_since` só muda por esse fluxo. Trilha: `legal_hold`/`legal_hold_release_request` com ids, sem texto. Sai no G2 (1.8.0) decifrada.
- **R2 — custódia do psicólogo substituto.** `POST /prontuario/custodias {autorProfissionalId, substitutoProfissionalId}` (admin; ambos psicólogos, substituto ativo, pessoas distintas) → `POST /custodias/:id/aceite` (só o substituto; o banco confere) → `GET /custodias/:id/notas` (só ele lê as lacradas; leitura auditada só com contagem) → `POST /custodias/:id/notas/:notaId/decisao {decisao: guarda_clinica|descartar}`. Na guarda da clínica a nota acompanha o prontuário (piso de 20 anos do último registro; eliminação só com a clínica no G3), ilegível no aplicativo e só no G2. Sem substituto ou sem decisão em 90 dias, o lacre segue a D2 (eliminação), salvo retenção legal.
- **R9 — aviso da troca de sigilo.** `PUT /prontuario/configuracao` grava, para cada psicólogo ativo, um aviso em `clinical_notices` (tipo, modo anterior e novo, contagem de restringidos; nenhum dado de paciente) e responde `psicologosAvisados`. `GET /avisos` lista os do usuário da sessão; `POST /avisos/:id/lido` marca (só o destinatário; o banco confere). Fica fora do G2 (o fato está na trilha).
- **R11 — expurgo.** `app_purge_discarded_private_notes()` com `search_path = pg_catalog, public, pg_temp`; a 0017 falha se o dono for superusuário, BYPASSRLS ou o runtime. A guarda de schema confere isso e que o runtime não tem DELETE/TRUNCATE em notas, prontuário, retenções e custódias.
- Prova: `test/retencao-custodia.rls.test.ts`, `test/prontuario.rls.test.ts` (avisos), `test/guarda-schema.rls.test.ts` (R11).

### 8g. Perfis da clínica no banco (R13 do parecer #63, migração 0020)

- `clinic_members` (usuário × clínica × perfil: `admin`, `profissional`, `recepcao`, `financeiro`, `psicologo`) é mantida pela API: o primeiro admin vem do **fluxo de criação da clínica** (`MembrosService.criarClinica`, 0022), `POST /clinica/membros {usuarioId, perfil}` e `DELETE /clinica/membros/:usuarioId/:perfil` (admin; `GET` lista os ativos). Tudo auditado (`member_found`/`member_grant`/`member_revoke`, só ids e perfil).
- Travas no banco (trigger + RLS forçado, sem DELETE/TRUNCATE): só um admin **ativo nesta tabela** concede ou revoga, sempre como o usuário travado da sessão (`granted_by`/`revoked_by` = `app_current_user()`); ninguém se promove fora da fundação; o sistema (sentinela da 0019) não concede; revogação é única e não se desfaz; o último admin ativo não sai.
- Os triggers conferem o perfil: `legal_holds` (marcar, pedir e aprovar a retirada) exige admin ativo; `note_custodies` exige admin ativo para designar, autor que já foi `psicologo` e substituto `psicologo` ativo (na designação e no aceite); levar a lacrada para `guarda_clinica` exige `psicologo` ativo. A API confere antes (403 `perfil_nao_registrado`, 409 `autor_nao_psicologo`/`substituto_nao_psicologo_ativo`).
- **Fundação (0022, R15 da re-revisão 3).** `tenants.founder_user_id` é gravado na criação da clínica e tem de ser o usuário da sessão; na mesma transação o fundador vira admin (`tenant_create` + `member_found` na trilha) e uma constraint trigger diferida recusa o COMMIT de clínica com fundador sem esse admin. A exceção de fundação de `clinic_members` só vale para o fundador registrado: numa clínica sem membros, um SQL injetado de recepção/financeiro dá 42501. O fundador é imutável para o runtime; clínicas antigas (sem fundador) só ganham o primeiro admin pelo [runbook](runbook-fundador-clinicas-existentes.md) (`app_runbook_registrar_fundador`, papel de operação). Não há mais `POST /clinica/membros/fundador`.
- **Perfil só com trilha (0022).** No COMMIT, toda linha nova de `clinic_members` exige o evento `member_found`/`member_grant` com o `member_id` na trilha, e toda revogação o `member_revoke`: o alarme pedido pelo Guardião virou barreira.
- **Avisos aos demais admins (R13).** Concessão e revogação de perfil (`perfil_alterado`) e pedido/aprovação de retirada de retenção legal (`retencao_retirada_pedida`/`_aprovada`) geram aviso em `clinical_notices` para todos os outros admins ativos (`GET /avisos`). O aviso leva só ids da equipe, o perfil e o id da retenção; cada tipo devolve só os seus campos. A trilha registra `admins_avisados`.
- **No G2 desde o 1.11.0 (R16; 1.9.0 no ramo do prontuário, renumerada no merge com o financeiro).** `clinicMembers` (usuário, perfil, concessão e revogação) e `tenant.founderUserId` saem no pacote: é dado pessoal da equipe da controladora e prova o controle de acesso (LGPD arts. 37 e 46). Risco residual: dois admins em conluio continuam podendo retirar uma retenção, mas agora todos os outros admins são avisados.

### 8d. Dados, integridade e LGPD

- Migração `0012_prontuario.sql`: `clinical_settings`, `encounters`, `clinical_record_versions`, `clinical_addenda`, `private_notes` — RLS FORCE com `app_current_tenant()`, FK compostas com `tenant_id` (o atendimento aponta para `(id, tenant_id, patient_id, professional_id)` do agendamento: paciente e profissional são os do agendamento), sem DELETE/TRUNCATE para o runtime. Declaradas na guarda de schema e no pacote G2 (`schemaVersion` **1.6.0**; 1.7.0 com a 0015). Não toca o CHECK de `audit_log.action`.
- **Nada é apagado nem reescrito.** Versões e adendos: o runtime só tem SELECT/INSERT e um trigger recusa UPDATE/DELETE/TRUNCATE para **qualquer papel**. Atendimento: trigger mantém a identidade imutável, a versão só avança e **finalizado é terminal** (qualquer UPDATE dá `55000`). Versão nova só em atendimento aberto, em sequência e no modelo do atendimento; adendo só em finalizado — os dois checados no banco com `FOR SHARE` no atendimento (sem corrida com a finalização).
- **Cifra:** conteúdo da versão (JSON do modelo), texto do adendo e da nota ficam só no formato `v1:` do `FieldCipher` (chave da clínica; AAD = clínica + tabela + coluna + id da linha; `CHECK app_is_sealed_field`). O hash da finalização usa a cifra, nunca o texto.
- **Auditoria** na mesma transação, escopos `encounters` (create/read/sign), `clinical_records` (update/read, inclusive histórico e versões), `clinical_addenda`, `private_notes`, `clinical_settings` (`permission_change`) e `clinical_access_denied`. Metadata só com ids, versão, modelo, contagens, página, `hidden`, `care_basis` (base do vínculo), `ai_consent` e o hash — nunca texto clínico (o teste procura os marcadores no banco e na trilha).
- **Consentimento de IA** (RIPD do escriba, R12): `encounters.ai_consent` em 3 estados (`nao_informado`, padrão, que **nega**; `informado_nao_recusou`; `recusou`), registrado na abertura. Não há IA nesta rodada; o consentimento duradouro por paciente entra com o escriba.

**Testes:** `src/modules/records/modelos.test.ts` (modelos, faixas, obrigatórios, sigilo, hash) e `test/prontuario.rls.test.ts` (Postgres real: perfis não clínicos e profissional sem vínculo negados e auditados; abrir não cria vínculo; só o profissional do agendamento abre; versões e 409 de versão; validação sem eco; só o autor edita; consulta direta só vê `v1:`; o banco recusa texto em claro, UPDATE/DELETE de versão e DELETE de atendimento; finalizado não edita pela API nem pelo banco; adendo; sigilo da psicologia nos dois modos; notas privadas só do autor, inclusive no modo prontuário único; isolamento pela API e pelo RLS; trilha sem conteúdo). Rotas novas na prova de 401 de `test/security/sessao-tenant.security.test.ts`.

## 9. Financeiro do MVP (rodada 15.2, FIN-01.1 a 01.4 e 01.8)

> 15/10/2026 · branch `eng/financeiro` (sobre `eng/prontuario`) · migração **0018** · **sem PSP de Pix** (D5 pendente: Pix é registrado à mão, `pix_manual`) · recibo em JSON estruturado (PDF depois) · toca dado pessoal com finalidade fiscal: passa pelo Guardião antes do merge.

**Permissões** (`perfis.ts`). Nenhuma rota devolve conteúdo clínico; o profissional não opera o financeiro da clínica (repasse é FIN-03, fora desta rodada).

| Permissão | admin | profissional | recepcao | financeiro |
|---|---|---|---|---|
| `financeiro:ler` (contas a receber, cobrança, caixa, recibos, configuração) | sim | não | sim | sim |
| `financeiro:operar` (lançar/cancelar cobrança sem recebimento, receber, abrir/fechar caixa, emitir recibo) | sim | não | sim | sim |
| `financeiro:estornar` (estornar recebimento, cancelar recibo) | sim | não | não | sim |
| `financeiro:fiscal` (perfil fiscal do profissional PF, insumo do Receita Saúde) | sim | não | não | sim |
| `financeiro:configurar` (texto neutro, emitente, tipo padrão) | sim | não | não | não |

**Rotas** (mesmos erros da §3; na URL só ids, datas e enums — `nome`, `cpf`, `pagador`, `descricao`, `busca`... na query dão `400 {campos:['dado_na_url']}`; valores sempre em **centavos inteiros**):

| Método e rota | Permissão | Notas |
|---|---|---|
| `GET`/`PUT /financeiro/configuracao` | ler / configurar | `{descricaoRecibo, atendimentoPadrao: 'pf'\|'pj', emitenteNome, emitenteCnpj, mostrarRegistroConselho}`; padrão `"Atendimento"`, `pj`, conselho oculto; texto com CID ou termo de diagnóstico/condição = 400 `descricaoRecibo` (sem eco) |
| `GET`/`PUT /financeiro/profissionais/:id/perfil-fiscal` | fiscal | `{cpf, registroConselho}` do profissional que atende como **pessoa física**; o GET devolve só `temCpf` |
| `POST /financeiro/cobrancas` | operar | `{agendamentoId \| pacoteId, valorCentavos, vencimento?, atendimentoPor?, profissionalId?, pagador?: {nome, cpf?}}`; exatamente um alvo (400 `alvo`); paciente e profissional vêm do agendamento; `pf` exige profissional; 409 `cobranca_ja_lancada`, `agendamento_cancelado`, `pacote_cancelado`, `sessao_de_pacote` (sessão que consumiu pacote não gera cobrança avulsa, FIN-01.8) |
| `GET /financeiro/contas-a-receber?de&ate&situacao&pacienteId&profissionalId` | ler | por **vencimento**, janela ≤ 31 dias; `situacao` ∈ `em_aberto` (padrão), `pagas`, `canceladas`, `todas`; itens com `descricao` neutra, `situacao` (`aberta`/`parcial`/`paga`/`cancelada`) e totais; teto 2000 (`truncado`); conta no limite por usuário (R5) |
| `GET /financeiro/cobrancas/:id` | ler | com os recebimentos (e se foram estornados) |
| `POST /financeiro/cobrancas/:id/cancelar` | operar | `{motivo}` ∈ `lancamento_errado`, `cortesia`, `atendimento_nao_realizado`, `cobranca_duplicada`; com recebimento vivo: 409 `cobranca_com_recebimento` |
| `POST /financeiro/cobrancas/:id/recebimentos` | operar | `{forma, valorCentavos?, caixaId?}`; `forma` ∈ `dinheiro`, `cartao_credito`, `cartao_debito`, `pix_manual`, `transferencia`, `convenio` (aceita `cartao`/`pix` do front); sem valor recebe o saldo; parcial permitido; 409 `valor_acima_do_saldo`, `cobranca_quitada`, `cobranca_cancelada`, `caixa_fechado`, `caixa_ambiguo` |
| `POST /financeiro/recebimentos/:id/estornar` | estornar | `{motivo, caixaId?}` ∈ `lancamento_errado`, `devolucao_ao_pagador`, `pagamento_nao_compensado`, `forma_errada`; estorno **total**, no caixa aberto de agora; devolve o saldo e cancela o recibo vivo (`reciboCancelado`); 409 `recebimento_ja_estornado` |
| `POST /financeiro/caixas` | operar | `{turno: 'manha'\|'tarde'\|'noite'\|'unico', trocoInicialCentavos?}`; sempre no dia de **hoje** (fuso da clínica); 409 `caixa_ja_aberto` |
| `GET /financeiro/caixas?data` | ler | caixa do dia (padrão hoje): turnos com recebido e estornado por forma, dinheiro esperado e totais do dia |
| `GET /financeiro/caixas/:id`, `POST /financeiro/caixas/:id/fechar` | ler / operar | fechar: `{dinheiroContadoCentavos}`; grava o esperado (troco + dinheiro recebido − dinheiro estornado neste caixa) e devolve `diferencaCentavos` (negativo = falta); fechado é terminal |
| `POST /financeiro/recebimentos/:id/recibo` | operar | emite (200, **idempotente**: recibo vivo volta igual); 409 `recebimento_estornado`, `recebimento_de_convenio` (operadora não recebe recibo de paciente) |
| `GET /financeiro/recibos?de&ate&pacienteId` | ler | emitidos no período (≤ 31 dias), **sem nome nem CPF** |
| `GET /financeiro/recibos/:id` | ler | recibo estruturado: `numero`, `emitente` (`pj`: clínica + CNPJ; `pf`: profissional + CPF, registro no conselho só se configurado), `pagador`, `beneficiario` (nome e CPF inteiros: exigidos para IR/reembolso), `valorCentavos`, `forma`, `dataPagamento`, `descricao` neutra, `pendencias`, `situacao`, `cancelamento`; conta como ficha aberta (R5) |
| `POST /financeiro/recibos/:id/cancelar` | estornar | `{motivo}` ∈ `dados_incorretos`, `emitido_por_engano`, `recebimento_estornado`; registro próprio; o número não é reaproveitado (reemitir gera número novo) |
| `POST /financeiro/receita-saude/lotes` | fiscal | corpo `{profissionalId, de, ate}` (≤ 31 dias, por **data do pagamento**); ver abaixo |

**Mapeamento do front** (`apps/web/lib/api/cliente.ts` da branch do #45): `registrarPagamento(agendamentoId, forma)` = `POST /financeiro/cobrancas {agendamentoId, valorCentavos}` + `POST .../recebimentos {forma}` (o valor ainda não vem do tipo de atendimento); o `Recibo` do front corresponde ao recebimento (`id`, `agendamentoId`, `pacienteId`, `data`, `valorCentavos`, `forma`); `removerRecibo` = estornar (não há exclusão); `listarRecibos` = `GET /financeiro/recibos`.

**Receita Saúde (D14 pendente): insumo, não o arquivo oficial.** O layout oficial do arquivo de integração está no Manual do Receita Saúde v2.1 (perguntas 24 e 25), que **não está no repositório**. Não inventamos layout: a rota devolve o **insumo estruturado** (`formato: 'plataforma-saude/receita-saude-insumo'`, `versao: '0.1.0'`, `oficial: false`, `dependeDe: ['D14', 'manual_receita_saude_v2.1_perguntas_24_25']`, `lacuna`) com o emitente PF (nome, CPF, registro) e, por recebimento, data do pagamento, valor, pagador e beneficiário (nome e CPF), texto neutro, número do recibo interno (se houver) e pendências (CPF faltando). Entram só cobranças `pf` do profissional, recebimentos vivos (sem estorno) e fora de `convenio`. **Lacuna a fechar:** conversor para o layout oficial depois de validar o manual com um contador; a promessa comercial continua "gera o lote para o Receita Saúde", nunca "emite sozinho" (D14). A exportação de CPFs em lote é auditada como `export` (`receita_saude.batch`: só profissional, contagens e dias) e conta no limite por usuário.

**Privacidade** (bases-legais l.32; parecer front-r8 G2):
- Cobrança e recibo **nunca** levam tipo de atendimento, especialidade, procedimento ou diagnóstico: a descrição é só o texto configurado pela clínica (padrão `"Atendimento"`) e não existe texto livre por cobrança. A validação recusa CID e termos de condição (lista mínima em `financeiro-regras.ts`); especialidade continua possível se a clínica escolher (é a controladora), mas nunca é o padrão.
- O registro no conselho (ex.: CRP) revela a profissão: só entra no recibo com `mostrarRegistroConselho: true`.
- Financeiro e recepção não leem prontuário (403 do porteiro, testado); as rotas do financeiro não consultam tabela clínica.
- Auditoria só com ids, códigos, contagens e booleanos: **nunca** valor, nome, CPF, texto do recibo nem data (o teste procura CPFs, nome do pagador, texto e valores na trilha).

**Dados e integridade** (migração `0018_financeiro.sql`):
- Tabelas `finance_settings`, `professional_fiscal_profiles`, `cash_sessions`, `charges`, `payments`, `payment_reversals`, `receipt_counters`, `receipts` e `receipt_cancellations`: RLS FORCE com `app_current_tenant()`, FK compostas com `tenant_id`, sem DELETE/TRUNCATE para o runtime e trigger que recusa DELETE/TRUNCATE para qualquer papel. Declaradas na guarda de schema e no pacote G2 (`schemaVersion` **1.9.0**, que junta o 1.8.0 da 0017 com o financeiro, em `data.finance` e `manifest.counts.finance`, com CPFs e o retrato do recibo decifrados). Não toca o CHECK de `audit_log.action`.
- **Quem lança é o usuário da sessão (0016):** gatilhos `zz_*_ator` conferem com `app_current_user()` as colunas `created_by`/`cancelled_by` (cobrança), `received_by`, `reversed_by`, `issued_by`, `cancelled_by` (recibo), `opened_by`/`closed_by` (caixa) e `updated_by` (configuração e perfil fiscal); outro usuário, ou transação sem usuário, dá `42501`. Por isso a 0018 depende da 0016.
- **Nada se apaga:** recebimento, estorno, recibo e cancelamento de recibo são append-only (runtime só SELECT/INSERT; trigger recusa UPDATE/DELETE para qualquer papel). Cobrança: identidade imutável por trigger, cancelada é terminal, `CHECK 0 <= paid_cents <= amount_cents`, e cancelar exige `paid_cents = 0`. Uma cobrança viva por agendamento/pacote (índice único parcial).
- **Caixa:** um por (dia, turno); fechado é terminal (trigger, `55000`). Recebimento e estorno só entram em caixa aberto: trigger com `FOR SHARE` na linha do caixa, que espera um fechamento em curso (`FOR UPDATE`) e relê. O fechamento soma tudo o que entrou e nada entra depois.
- **Recibo sem buraco:** o número sai de `receipt_counters` (`INSERT ... ON CONFLICT DO UPDATE last_number + 1`, que trava a linha da clínica) na **mesma transação** do INSERT do recibo, e o rollback devolve o número. Triggers: o contador só avança de 1 em 1 e o recibo só entra com o número recém-entregue (`23514`); `UNIQUE (tenant_id, number)`. Numeração por clínica.
- **Cifra:** CPF do pagador terceiro (`charges.payer_cpf_enc`), CPF do profissional PF e o retrato do recibo (JSON) ficam só no formato `v1:` (chave da clínica; AAD = clínica + tabela + coluna + linha). O recibo é um **retrato** do momento da emissão: mudar o cadastro ou o texto depois não muda o recibo emitido.
- **Ordem das travas:** agendamento/pacote (só no lançamento) → cobrança (`FOR UPDATE`) → caixa (`FOR SHARE`) → contador → auditoria. O fechamento só trava o caixa. A retenção fiscal de 5 anos (matriz-retencao) fica para o job de retenção; nada é eliminado nesta rodada.

**Testes:** `src/modules/finance/financeiro-regras.test.ts` (texto neutro, situação, validação, caixa, pendências) e `test/financeiro.rls.test.ts` (Postgres real): lançamento e recebimento parcial/total; sessão de pacote; texto neutro recusando CID/condição e sem tipo, especialidade ou conselho; estorno que devolve o saldo e cancela o recibo; recibo de convênio recusado; retrato imutável e cifrado, com UPDATE/DELETE recusados pelo banco; **12 emissões paralelas com números consecutivos e um rollback sem buraco**; número fora de sequência e contador que pula recusados; numeração por clínica; caixa com conferência e diferença, e caixa fechado recusando lançamento pela API e pelo banco; contas a receber com janela e `dado_na_url`; insumo do Receita Saúde só com PF vivo fora de convênio e `oficial: false`; permissões; financeiro/recepção sem prontuário; isolamento pela API e pelo RLS nas 9 tabelas; trilha sem CPF, nome, texto ou valor. Cobertura G2 em `test/exportacao-cobertura.rls.test.ts`; rotas novas na prova de 401 de `test/security/sessao-tenant.security.test.ts`.

**Fora desta rodada:** PSP de Pix e baixa automática (D5), NFS-e (atendimento PJ), PDF do recibo, preço por tipo de atendimento e cobrança automática ao concluir (FIN-01.1, "pendências"), parcelamento planejado do pacote, taxas por forma (líquido), sangria, repasse (FIN-03), layout oficial do Receita Saúde (D14 + manual), linha própria no ROPA (Guardião) e job de retenção fiscal.

### 9a. Ressalvas do parecer do #65 (migração 0021)

- **R1 — emitente PF não arbitrário.** Cobrança `pf` exige perfil fiscal do profissional **com CPF** (409 `profissional_sem_perfil_fiscal`). No agendamento, o profissional é o do agendamento. No pacote (que não tem profissional): ou todas as sessões já consumidas (≥1) são dele, ou quem lança é o próprio profissional (usuário vinculado) — senão 409 `profissional_nao_e_do_pacote`. O trigger `charges_emitente_coerente` confere o mesmo para qualquer papel.
- **R2 — conselho por recibo.** `POST /financeiro/recebimentos/:id/recibo {incluirRegistroConselho?: boolean}` (padrão **falso**). `mostrarRegistroConselho` da clínica só habilita a opção (pedir sem habilitar: 409 `registro_conselho_nao_habilitado`). Fica gravado no retrato; a trilha leva `council_shown`.
- **R5 — insumo do Receita Saúde mínimo (versão 0.2.0).** Itens: `reciboNumero`, `dataPagamento`, `valorCentavos`, `pagador`, `beneficiario`, `pendencias`; emitente: `nome`, `cpf`. Sem descrição livre, ids internos nem registro no conselho. Continua dentro da plataforma (não é o arquivo de envio; D14).
- **R7 — retenção fiscal.** Política `fiscal_retention_policy` (interna; piso de 5 anos no CHECK): **proposta** de 5 anos contados de 1º/1 do ano seguinte ao pagamento, **a confirmar com o contador** (`confirmadaPeloContador: false`). `GET /financeiro/retencao-fiscal` mostra a política; `POST /financeiro/retencao-fiscal/execucao` (admin) ou o job do sistema (`RetencaoFiscalService.executarComoSistema`) chamam `app_fiscal_retention_run()`, que apaga o retrato cifrado do recibo (`content_enc` → NULL, `fiscal_purged_at`) e o pagador da cobrança quitada/cancelada. Idempotente; paciente sob retenção legal fica intacto; sem parâmetro de data — os triggers conferem prazo e retenção contra o relógio do banco. Recibo eliminado: 409 `recibo_eliminado_por_retencao_fiscal`; no G2 (1.10.0) sai com `content: null` e `fiscalPurgedAt`.
- **R13 (re-revisão) — profissional fixado na venda do pacote (0023).** `POST /pacotes` aceita `profissionalId` (opcional, ativo). Com ele: a cobrança do pacote é desse profissional (padrão quando o corpo não diz; outro dá 409 `profissional_nao_e_do_pacote`) e a PF já sai na venda, sem esperar sessão; o consumo só aceita agendamento dele (409 `profissional_diferente`). O banco confere os dois (trigger, 42501). Troca: `POST /pacotes/:id/profissional {profissionalId, motivo}` (motivo do enum `profissional_desligado`/`pedido_do_paciente`/`lancamento_errado`/`fixar_pacote_antigo`), gravada em `package_professional_changes` (append-only, autor = sessão) na mesma transação — o UPDATE sem o registro é recusado — e auditada (`professional_change`, só ids e motivo). Recusada (409 `pacote_com_cobranca_pf`) enquanto houver cobrança PF viva do pacote em nome de outro profissional: o recibo e o Receita Saúde seguem o profissional da venda. Pacote antigo sem profissional continua na regra da R1 até ser fixado (`fixar_pacote_antigo`). G2 1.12.0: `sessionPackages[].professionalId` e `packageProfessionalChanges`.
- **R3 — paciente menor sem pagador.** Sem pagador informado e com o paciente menor de 18 anos na data do pagamento (data de nascimento cifrada; sem data, não se presume), o recibo e o item do Receita Saúde saem com a pendência `pagador_responsavel` (o paciente fica como pagador presumido). Maioridade em `IDADE_MAIORIDADE` (CC art. 5º).
- **R4 — termos sensíveis.** Lista mínima ampliada (CID com separador, TDAH, bipolar, esquizofrenia, TOC, gestante/pré-natal, demência, álcool etc.); continua barreira mínima. `GET /financeiro/configuracao` devolve `avisoDescricao` para a tela (o texto vai para empregador, plano e Receita).
- **R8 — Pix manual.** Recebimento por `pix_manual`/`transferencia` devolve `aviso` (`AVISO_PIX_MANUAL`: não descrever o atendimento na mensagem do banco) para a tela; o onboarding repete (docs/02-produto/plano-piloto.md §5, etapa 8). Quando houver PSP (D5), a descrição do QR será o texto neutro da clínica.
- **R9 — `paid_cents` coerente.** Nasce 0 e só muda para a soma dos recebimentos não estornados; recebimento ou estorno sem o `paid_cents` correspondente é recusado no COMMIT (constraint trigger adiado).
- **R10 — numeração.** O contador nasce em 1 e, no COMMIT, `last_number` = quantidade = maior número de recibos da clínica (1..n sem buraco).
- **R11 — `search_path` fixo** nas funções de trigger da 0018.
- **R14 (re-revisão 2) — cobrança PF de pacote tem UM emitente e só cobre sessões dele (0025).** Regra: (1) a cobrança PF de pacote (fixado ou não) é recusada se houver sessão **viva** do pacote consumida por agendamento de outro profissional (409 `pacote_com_sessoes_de_outro_profissional`; banco 42501). Com sessões de dois profissionais, o pacote sai como PJ ou se estornam antes as sessões do outro. (2) `fixar_pacote_antigo` é recusado se houver sessão viva de profissional diferente do novo (mesmo 409; banco 55000). A troca comum (desligamento, pedido do paciente, lançamento errado) segue possível, porque (1) impede a PF inexata depois dela. (3) Havendo cobrança PF viva do pacote em nome de P, só agendamento de P consome (409 `profissional_diferente`; banco 42501), também em pacote não fixado.
- **R15 (re-revisão 2) — agendamento com profissional e paciente imutáveis (0025).** Trigger `appointments_partes_imutaveis` recusa (42501), para qualquer papel, mudar `appointments.professional_id` ou `patient_id`. A API nunca os altera (trocar de profissional = cancelar e criar outro agendamento); assim os checks de consumo e de cobrança, que rodam no INSERT, não são contornados depois.
- **R17 (re-revisão 3) — sessão de pacote imutável, salvo o estorno (0029).** Trigger `package_sessions_so_estorno` (BEFORE UPDATE, qualquer papel): a única mudança aceita é o estorno, de `reversed_at` NULL para preenchido, **uma vez só**, com `reversed_by` = usuário da sessão (`app_current_user()`; sem usuário, recusa) e motivo da lista; `reversed_at` é gravado com o relógio do banco. `package_id`, `appointment_id`, `consumed_*` e o próprio estorno não mudam depois (42501). DELETE já era revogado (0011). Assim um SQL injetado não desfaz o estorno de uma sessão de outro profissional nem troca agendamento ou pacote para contornar os checks de INSERT da 0023/0025.
- **R16 (re-revisão 2) — termos proibidos normalizados.** Antes de testar a lista, o texto passa por NFKC, perde os caracteres de formatação e de largura zero (`\p{Cf}`) e os preenchedores invisíveis, e tem os espaços Unicode colapsados (o texto gravado não muda). O CID com separador vale em qualquer caixa e aceita espaço, `.`, `-`, `/` e `_` entre os caracteres (`f 32`, `F/32`, `F_32`, `F<U+200B>32`, `Ｆ３２`); "2 x 10" continua aceito.
- Prova: `test/financeiro.rls.test.ts` (blocos R1, R2, R5, R7, R9/R10).

## 10. Importador de planilha (rodada 17.3, MIG-01.1, MIG-01.2, MIG-02.1, MIG-02.2 e parte técnica da MIG-02.4; G8)

> 16/10/2026 · branch `eng/importador` (sobre `eng/financeiro`) · migração **0024** · **sem dado real** (testes geram CSV fictício a cada execução) · toca dado pessoal: passa pelo Guardião antes do merge. Importadores de concorrentes (MIG-01.3/01.4), anexos e histórico de agenda ficam para depois.

**Escopo do MVP.** Planilha genérica de **pacientes** e de **agenda futura**, em **CSV UTF-8** (separador `;`, `,` ou TAB; CRLF ou LF; BOM aceito). **XLSX não é aceito (415 `formato_nao_suportado`)**: a biblioteca madura de leitura (SheetJS) não recebe correção no npm desde 0.18.5 (CVE-2023-30533 e CVE-2024-22363 abertas lá), e as alternativas descompactam ZIP e interpretam XML vindos do arquivo enviado (bomba de descompressão, entidades XML) com árvore grande de dependências. Nenhuma dependência nova: `pnpm audit` não muda. A tela orienta "Salvar como CSV UTF-8".

**Pré-requisitos do piloto (plano-piloto §4, passo 5), fora do código:** DPA aceito (D8/LGP-01.4; ainda não há registro no sistema), canal de transferência cifrado (o envio é HTTPS para a API, sem e-mail nem pasta compartilhada) e migração só a partir da onda 3 (M4).

### 10a. Fluxo e rotas (todas `importacao:gerir`, só **admin**)

`recebido → validado → simulado → aplicado → desfeito`; de recebido/validado/simulado, `expirado` quando o arquivo bruto vence.

| Método e rota | O que faz |
|---|---|
| `GET /importacoes/termo` | versão vigente do termo de migração (`mig-02.4-v1`), formatos, limites e campos por tipo |
| `POST /importacoes?tipo=pacientes\|agenda&termo=<versão>` | corpo cru `text/csv` (≤ 5 MiB, ≤ 10.000 linhas, ≤ 60 colunas, célula ≤ 1.000 caracteres). **Sem `termo`: 409 `termo_de_migracao_obrigatorio`**; versão antiga: 409 `termo_desatualizado`. Grava o lote com o **aceite (versão, quem, quando)** e o arquivo bruto **cifrado**. Devolve o cabeçalho (só na resposta) e o mapeamento sugerido. Latin-1/UTF-16: 400 `codificacao_invalida`; acima do teto: 413 |
| `GET /importacoes`, `GET /importacoes/:id` | lotes (situação, contagens, expiração e descarte do arquivo bruto) |
| `PUT /importacoes/:id/mapeamento` | `{mapeamento: {campo: índiceDaColuna}}`; guarda só o **índice**, nunca o texto do cabeçalho (numa planilha sem cabeçalho ele seria dado). Volta o lote para `recebido` |
| `POST /importacoes/:id/validar` | formato com as **regras do cadastro e da agenda**: CPF com DV, telefone brasileiro, nascimento 1900..hoje (AAAA-MM-DD ou DD/MM/AAAA), data/hora, obrigatórios (pacientes: nome e telefone; agenda: data, hora, profissional, tipo e o paciente por CPF ou nome), CPF repetido no arquivo, nome + nascimento repetidos (aviso), fórmula em célula de texto (erro: não entra) |
| `POST /importacoes/:id/simular` | **dry-run**: resolve contra o cadastro e diz o que **seria** criado/ignorado, sem gravar paciente nem agendamento. CPF já cadastrado = `ja_cadastrado` (ignorado; **nada é sobrescrito**); nome igual sem CPF = aviso `possivel_duplicado`; menor de 18 anos pelo nascimento = aviso `menor_sem_responsavel` (R5: o cadastro ainda não tem responsável legal); agenda: `paciente_nao_encontrado/ambiguo/inativo`, `profissional_*`, `tipo_*`, `horario_no_passado` (só agenda futura), `agendamento_duplicado_no_arquivo`, `ja_agendado` e `horario_lotado` (capacidade AGD-01.5, contando o banco e as linhas anteriores do arquivo). Devolve `resumoHash` |
| `GET /importacoes/:id/divergencias?formato=json\|csv` | relatório da rodada corrente; o valor da célula é relido do arquivo bruto (se ainda existir) e **neutralizado** (`'` antes de `= + - @ TAB CR`); o CSV também passa por `toCsv` |
| `POST /importacoes/:id/aplicar` | `{resumoHash}` da simulação aprovada (outro: 409 `simulacao_nao_aprovada`). Recalcula o plano na transação, sob a trava da agenda de todos os profissionais; se o cadastro mudou desde o dry-run, 409 `simulacao_desatualizada` e nada é gravado (G8). Pacientes em blocos de 500 com a **mesma cifra/normalização do cadastro** (`PatientsService.prepararInsercao`); agendamentos um a um por `SchedulingService.criarNaTransacao` (todas as regras da agenda, `created_by` = usuário da sessão travado). Livro do lote, auditoria e **descarte do arquivo bruto no mesmo commit** |
| `POST /importacoes/:id/desfazer` | apaga o que o lote criou pela função `app_undo_import_batch` **enquanto nada foi usado**; senão 409 `importacao_em_uso` com `motivos` só em contagens: `em_atendimento` (status além de agendado/confirmado, ou atendimento aberto), `prontuario` (nota privada, retenção legal), `financeiro` (cobrança, guia, pacote, consumo), `agenda_nova` (agendamento do paciente fora do lote), `alterado_depois` (paciente/agendamento editado ou remarcado depois do aplicar). FK de qualquer tabela nova que aponte para o registro também bloqueia |

Erros sem valor de campo (só códigos e nomes). Na URL só ids, o tipo e a versão do termo; o conteúdo vai no corpo, que não entra em log de acesso. O serviço não tem logger.

### 10b. Dados, LGPD e banco (migração 0024)

- `import_batches`: lote, aceite do termo (`term_version`, `term_accepted_by` = `created_by`, `term_accepted_at`), mapeamento por índice, contagens, `simulation_hash`, datas de cada etapa, `raw_expires_at` (CHECK ≤ `created_at` + 7 dias; `created_at` no futuro é recusado) e `raw_discarded_at` (evidência do descarte). Trigger: só **admin ativo em `clinic_members`** (0020), como usuário da sessão travado, cria, aplica e desfaz (sem o registro: 403 `perfil_admin_nao_registrado`); termo e identidade imutáveis; só as transições do fluxo; terminal é terminal.
- `import_raw_files`: o arquivo bruto **só cifrado** (`v1:`, chave da clínica, AAD = clínica + `import_raw_files` + `content` + lote; CHECK recusa claro), SHA-256 para integridade, mesma expiração do lote. Runtime: só SELECT/INSERT. **Descarte**: `app_purge_import_raw_files()` (SECURITY DEFINER, `search_path` fixo, dono sem superpoder, idempotente) apaga o vencido ou de lote aplicado/encerrado, marca `expirado` o lote que venceu antes de aplicar, registra `raw_discarded_at` e apaga divergências de rodadas antigas. Roda no aplicar, oportunisticamente em toda operação do importador e pela rotina diária por clínica (`ImportacaoService.expurgar`; o agendador entra com a infraestrutura de jobs). Vida configurável por `IMPORT_RAW_TTL_HOURS` (1..168, padrão 168). Destruir as chaves da clínica (G3) também torna o bruto ilegível.
- `import_issues`: divergências **só em código** (linha, campo, código, gravidade), por rodada; append-only.
- `import_batch_records`: livro do lote (entidade, id criado, linha), append-only, só aceita linha com o lote em aplicação; base do desfazer e da proveniência.
- RLS FORCE nas quatro, FK compostas com `tenant_id`, sem DELETE/TRUNCATE para o runtime (a guarda de schema cobra, inclusive as duas funções SECURITY DEFINER).
- **Auditoria sem conteúdo** (escopo `import_batches`, `op` = `map`/`validate`/`dry_run`/`report`/`apply`/`undo`/`raw_discarded`; a criação leva `term_version`, linhas e bytes); pacientes criados: um evento `create` por bloco de 500 (`patients`, `import_batch_id`, `created`); agendamentos: o evento normal da agenda com `import_batch_id`.
- Duplicado por CPF: decifra os CPFs da clínica na transação (não há índice cego de CPF; quando o serviço de chaves expuser HMAC, um índice cego por clínica substitui a varredura).
- **G2 (`schemaVersion` 1.13.0, `data.imports`):** entram `import_batches` (prova da instrução do controlador e do descarte) e `import_batch_records` (proveniência). Ficam **fora**, com motivo em `EXPORT_EXCLUDED_TABLES`: o arquivo bruto (cópia transitória do que a própria clínica enviou; exportá-lo esticaria a vida dele além dos 7 dias) e as divergências (diagnóstico refeito a cada rodada, só códigos; os totais estão no lote).
- Provas: `src/modules/imports/importacao-regras.test.ts` e `test/importador.rls.test.ts` (Postgres real: termo obrigatório, formato/tamanho, só admin na API e no banco, dry-run sem gravar, aplicar só com o hash aprovado, simulação desatualizada, duplicados, fórmula recusada na leitura e neutralizada no relatório JSON/CSV, bruto cifrado e intocável pelo runtime, descarte ao aplicar, expiração idempotente, desfazer e bloqueios, agenda futura com capacidade, isolamento entre clínicas pela API e pelo RLS, auditoria sem conteúdo).

**Fora desta rodada:** XLSX, importadores de concorrentes, histórico de agenda, anexos, registro do aceite do DPA no sistema, agendador da rotina de expurgo, painel de migração assistida (MIG-02.3).

### 10c. Correções do parecer do importador (rodada 18, migração 0026; R6 b removida na rodada 19, migração 0030)

- **V1 — desfazer só pela marca imutável do lote.** `patients.import_batch_id` e `appointments.import_batch_id` (FK composta para o lote) são gravados **só no INSERT**, só com o lote da clínica em aplicação (`simulado`, tipo coerente: `pacientes` → pacientes, `agenda` → agendamentos) e por admin da sessão; depois são **imutáveis** para qualquer papel (trigger `import_provenance_guard`, 42501). `app_undo_import_batch` e `app_import_batch_blockers` usam **só** `import_batch_id = lote`; o livro (`import_batch_records`) virou proveniência e só aceita registro que exista com a marca do próprio lote. Teste RLS: SQL injetado (admin ou recepção) põe paciente antigo e o agendamento dele no livro, ou tenta marcá-los com o lote: recusado; aplicar + desfazer mantém os dois. G2 1.14.0 leva `importBatchId` em pacientes e agendamentos.
- **R8:** `import_reject_mutation()` com `search_path` fixo.
- **R1 — plano amarrado ao mapeamento e ao arquivo.** `hashDoPlano` inclui o mapeamento canônico (campos em ordem) e o SHA-256 do arquivo bruto (conferido contra o conteúdo decifrado; divergente = 409 `arquivo_divergente`). No banco (`import_batches_guard`): mudar `column_mapping` exige voltar a `recebido` com `simulation_hash` nulo, e depois de aplicado não muda; qualquer UPDATE do lote exige admin da sessão, salvo o formato exato do expurgo (vencido → `expirado`; `raw_discarded_at` preenchido com o arquivo vencido ou o lote encerrado), que o job do sistema usa.
- **R2 — rotina diária de descarte.** `ImportacaoService.expurgoDiario(clinicas)` roda como **job do sistema** (sem usuário: slot travado com o sentinela da 0019), **uma transação por clínica** (RLS), chama `app_purge_import_raw_files()` e audita só a contagem (ator `sistema`, `op = raw_discarded`). É **idempotente** (segunda execução no dia: 0). Devolve `{clinicas, arquivosDescartados, atrasados, alarme, clinicasComAtraso}`, em que `atrasados` = arquivos brutos vencidos há mais de 24 h **depois** do expurgo; `alarme = true` dispara o alerta. Teste RLS com duas clínicas.
  - **Como agendar (produção):** EventBridge Scheduler, `cron(0 6 * * ? *)` (03:00 de Brasília), dispara uma tarefa ECS com a mesma imagem da API e o papel de runtime (`app_user`, sem BYPASSRLS), que lê a lista de clínicas **ativas** do catálogo de assinaturas (o mesmo das demais rotinas diárias: ciclo das notas privadas e retenção fiscal) e chama `expurgoDiario`. Saída com `alarme = true` publica no tópico SNS de alertas de LGPD (on-call + DPO) e a métrica `ImportRawOverdue` no CloudWatch (alarme se > 0 por 1 período). Falha da tarefa também alarma. Reexecutar no mesmo dia é seguro.
  - **R4 — texto do termo versionado.** O texto v1 está em `docs/03-seguranca-lgpd/termo-migracao.md` (⚖️ rascunho para o advogado) e em `src/modules/imports/termo-migracao.ts` (um teste exige que sejam idênticos). `GET /importacoes/termo` devolve `texto` e `textoSha256`; o lote grava `term_sha256` (obrigatório no lote novo, imutável; trigger) e o DTO devolve `termo.textoSha256`. G2 1.14.0 leva `termSha256`. Mudou o texto: nova versão.
- **R6 — arquivo de outra clínica.**
  - (a) `POST /importacoes/:id/aplicar` exige `{resumoHash, clinicaConfirmada}`: o admin digita o **nome** da clínica (comparado sem caixa, acento e espaços extras) ou o **CNPJ** do emitente configurado no financeiro (só dígitos). Diferente: 409 `clinica_nao_confirmada`. O lote grava `origin_confirmed_at`/`origin_confirmed_by` (DTO `origemConfirmadaEm`; G2 1.14.0); o banco recusa aplicar sem a confirmação, só a aceita no próprio aplicar pelo usuário da sessão, e ela não muda depois. A tela mostra o nome da clínica de destino em destaque (termo, item 2).
  - (b) **Removido na rodada 19 (migração 0030, V2 da re-revisão de 19/10).** O alerta de CPFs já importados em outra clínica (contagem com limiar) era um **oráculo entre controladoras**: 4 CPFs sabidamente importados em outra clínica + 1 CPF alvo respondiam, com certeza, se o alvo é paciente de outro lugar (dado referente à saúde; sem base no art. 11, fora das instruções da controladora, art. 39; incidente, art. 48). Trocar por sim/não não resolve. Opção (a) do parecer: o cliente não recebe **nenhum** sinal sobre outras clínicas. Saíram `app_import_cpfs_em_outras_clinicas`, `app_import_register_cpf_fingerprints`, a tabela `import_cpf_fingerprints` (DROP limpo; era a única FK em CASCADE para `patients`), a variável `IMPORT_CPF_FP_KEY`, o campo `cpfsEmOutraClinica` do dry-run e `other_clinic_cpfs` da trilha. Ficam a confirmação (a), a checagem de duplicidade **dentro** da própria clínica e o termo. Teste RLS: a simulação do mesmo lote responde **exatamente igual** (corpo inteiro, inclusive `resumoHash`, e o evento `dry_run` da trilha) antes e depois de outra clínica importar os mesmos CPFs.
  - **Regra para a frente (FK para `patients`/`appointments`).** Toda FK nova para essas tabelas é `RESTRICT`/`NO ACTION` ou a tabela entra em `app_import_batch_blockers`; com CASCADE fora dos bloqueios, o desfazer apagaria sem aviso o que veio depois (responsáveis, portal etc.). A 0030 confere isso no catálogo ao migrar, e `test/importador.rls.test.ts` lê `pg_constraint` e falha com a lista das FK fora da regra (hoje: nenhuma em CASCADE/SET NULL).
- **R2 (continuação) — até o agendamento existir, o importador fica desligado em produção:** `IMPORTADOR_HABILITADO` (em `NODE_ENV=production` o padrão é desligado; novos lotes dão 409 `importador_desligado`). Ligar só depois do primeiro ciclo do agendador com `alarme = false` registrado.

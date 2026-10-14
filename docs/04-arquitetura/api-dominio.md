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
| `autoagendamento` | igual a `atendimento`, mas o agendamento foi criado pelo **próprio** usuário-profissional (`created_by`, encaixe incluído) | a mesma; a base fica marcada para a auditoria do acesso clínico e a agenda grava `anomaly_alert` |
| `agenda_do_dia` | `agendado`, `confirmado` ou `chegou`, **nunca** de autoagendamento | de **12 h antes a 12 h depois** de agora (`VINCULO_AGENDA_HORAS`), para o preparo da consulta |

**Vínculo não autodeclarado (V1 do parecer do Guardião sobre o PR #61).** O profissional tem `agenda:escrever` e `agenda:atender`, então podia fabricar o vínculo com qualquer paciente (encaixe consigo mesmo agora, ou consulta futura/retroativa marcada como atendida). Fechado assim:

1. **Janela do atendimento:** entrar em `em_atendimento`/`atendido` só de **30 min antes do início até 60 min depois do fim** (`ATTENDANCE_WINDOW_BEFORE_MIN`/`ATTENDANCE_WINDOW_AFTER_MIN`, tetos 120 e 1440). Fora dela, `409 {codigo:'fora_do_horario'}`. Registro retroativo, se o produto precisar, será fluxo próprio, auditado e sem gerar vínculo.
2. **Início já ocorrido:** a base `atendimento` exige `starts_at <= agora`; uma consulta futura com status clínico (mesmo inserida direto no banco) não dá vínculo.
3. **Autoagendamento:** `appointments.created_by` (migração 0013, imutável por trigger) guarda o usuário que criou. Se é o próprio profissional, não há `agenda_do_dia`; o vínculo só nasce com o atendimento dentro da janela (base `autoagendamento`), e nesse momento a agenda grava, na mesma transação, `anomaly_alert` com `{rule:'vinculo_autoagendado', window_s:86400, threshold, count}` (pacientes distintos nas últimas 24 h; padrão `SELF_SCHEDULED_ALERT_PER_DAY=0`, ou seja, todo caso alerta) e log `ALERTA_ANOMALIA`. Nada de id de paciente no alerta. A criação audita `self_scheduled`.
4. **Janela de continuidade por clínica (R1 do #61):** `GET /clinica/vinculo-de-cuidado` (cadastros:ler) e `PUT /clinica/vinculo-de-cuidado {dias}` (cadastros:gerir, 1..180). Auditado (`scope: tenants`, `{setting:'care_link_days', from, to}`); o banco recusa fora de 1..180 (CHECK).

- Cancelado e falta nunca dão vínculo. Profissional inativado perde o vínculo. Agendamento de **outro** profissional não se transfere.
- Outra clínica nunca dá vínculo: a consulta roda na transação da clínica da sessão (RLS) e também filtra `tenant_id`; o mesmo usuário com sessão em outra clínica não leva o vínculo junto.
- Uso: `exigirConteudoClinico(tx, ctx, pacienteId)` na **mesma transação** que lê o conteúdo e grava a auditoria; sem perfil clínico ou sem vínculo, `403 {codigo: 'sem_vinculo_de_cuidado'}` (o mesmo código nos dois casos). Devolve a base, que a rota clínica grava na auditoria (`care_basis`). Fora de transação: `VinculoDeCuidadoService.temVinculoDeCuidado(ctx, pacienteId)`.
- Equipe do caso (vínculo explícito, registrado e auditado, com validade) entra com a API de prontuário, como terceira base.
- Provas: `test/vinculo-de-cuidado.rls.test.ts` (Postgres real: com vínculo, consulta do dia, sem vínculo na mesma clínica, perfis não clínicos, outra clínica, expirado, cancelado/falta/fora da janela, profissional inativado; V1: encaixe consigo mesmo agora, consulta de amanhã e de 100 dias atrás marcadas como atendidas, bordas da janela, consulta futura `in_progress` inserida no banco, `created_by` imutável, alerta sem dado pessoal; janela por clínica) e `agenda-regras.test.ts` (janela e configuração).

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
| `POST /agendamentos/:id/remarcar` | agenda:escrever | `remarcarAgendamento` | devolve `{data, hora}` anteriores; só agendado/confirmado |
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

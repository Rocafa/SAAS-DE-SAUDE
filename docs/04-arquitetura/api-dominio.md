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

## 8. Atendimento e prontuário (rodada 14.1, PRO-02.1/02.3/02.6/02.7/03.7/03.8)

> 14/10/2026 · branch `eng/prontuario` (sobre `eng/guias-e-pacotes`) · migração **0012** · fisio/TO e psicologia · **sem IA** · toca dado de saúde: passa pelo Guardião antes do merge.

**Porteiro em tudo.** Toda leitura/escrita de conteúdo clínico chama `exigirConteudoClinico` (§2a) na **mesma transação** que lê/grava e audita; a regra do vínculo não é reimplementada aqui. Perfil não clínico (recepção, financeiro, admin sem perfil `profissional`) recebe `403 {codigo:'sem_vinculo_de_cuidado'}` **antes de qualquer consulta** (nem descobre se o atendimento existe). O guarda HTTP deixa os quatro perfis chegarem à rota (`prontuario:acessar`) só para a tentativa negada ficar na trilha (HU-PRO-006/022). **Abrir atendimento não cria vínculo:** o porteiro roda antes e a abertura não muda o status do agendamento ("em atendimento" continua sendo da agenda, com as regras dela).

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
- **Anotações privadas** (HU-PRO-009) **não são prontuário**: tabela própria (`private_notes`); só o autor lê, altera ou descarta — nem admin, nem outro profissional com vínculo, **nem no modo `prontuario_unico`**. Nunca entram em relatório, IA ou exportação padrão. "Excluir" = descartar (`discarded_at`): some da API, a linha cifrada fica (o runtime não tem DELETE). O destino da nota descartada e da nota de profissional desligado segue o RIPD (pendente do Guardião, cenário 3 da HU-PRO-009).
- **Exportação G2 (decisão desta rodada).** A clínica é a controladora e o pacote é dela: o **prontuário inteiro** sai (todas as versões e adendos decifrados, inclusive o compartimento de psicologia, que é prontuário; a exportação por administrador não profissional segue a pergunta 2.9 ⚖️). As **notas privadas** só saem com a **decisão expressa do autor** (`incluirNaExportacao`, coluna `export_consent`), como promete a HU-PRO-009; as demais ficam fora e são **contadas** no manifesto (`privateNotesWithheld`), para a clínica saber que existem. A cobertura não fica silenciosa: `private_notes` está em `EXPORTED_TABLES` (exportação parcial) e `test/exportacao-cobertura.rls.test.ts` prova que a nota marcada sai, a não marcada não sai e é contada.

### 8d. Dados, integridade e LGPD

- Migração `0012_prontuario.sql`: `clinical_settings`, `encounters`, `clinical_record_versions`, `clinical_addenda`, `private_notes` — RLS FORCE com `app_current_tenant()`, FK compostas com `tenant_id` (o atendimento aponta para `(id, tenant_id, patient_id, professional_id)` do agendamento: paciente e profissional são os do agendamento), sem DELETE/TRUNCATE para o runtime. Declaradas na guarda de schema e no pacote G2 (`schemaVersion` **1.4.0**). Não toca o CHECK de `audit_log.action`.
- **Nada é apagado nem reescrito.** Versões e adendos: o runtime só tem SELECT/INSERT e um trigger recusa UPDATE/DELETE/TRUNCATE para **qualquer papel**. Atendimento: trigger mantém a identidade imutável, a versão só avança e **finalizado é terminal** (qualquer UPDATE dá `55000`). Versão nova só em atendimento aberto, em sequência e no modelo do atendimento; adendo só em finalizado — os dois checados no banco com `FOR SHARE` no atendimento (sem corrida com a finalização).
- **Cifra:** conteúdo da versão (JSON do modelo), texto do adendo e da nota ficam só no formato `v1:` do `FieldCipher` (chave da clínica; AAD = clínica + tabela + coluna + id da linha; `CHECK app_is_sealed_field`). O hash da finalização usa a cifra, nunca o texto.
- **Auditoria** na mesma transação, escopos `encounters` (create/read/sign), `clinical_records` (update/read, inclusive histórico e versões), `clinical_addenda`, `private_notes`, `clinical_settings` (`permission_change`) e `clinical_access_denied`. Metadata só com ids, versão, modelo, contagens, página, `hidden`, `care_basis` (base do vínculo), `ai_consent` e o hash — nunca texto clínico (o teste procura os marcadores no banco e na trilha).
- **Consentimento de IA** (RIPD do escriba, R12): `encounters.ai_consent` em 3 estados (`nao_informado`, padrão, que **nega**; `informado_nao_recusou`; `recusou`), registrado na abertura. Não há IA nesta rodada; o consentimento duradouro por paciente entra com o escriba.

**Testes:** `src/modules/records/modelos.test.ts` (modelos, faixas, obrigatórios, sigilo, hash) e `test/prontuario.rls.test.ts` (Postgres real: perfis não clínicos e profissional sem vínculo negados e auditados; abrir não cria vínculo; só o profissional do agendamento abre; versões e 409 de versão; validação sem eco; só o autor edita; consulta direta só vê `v1:`; o banco recusa texto em claro, UPDATE/DELETE de versão e DELETE de atendimento; finalizado não edita pela API nem pelo banco; adendo; sigilo da psicologia nos dois modos; notas privadas só do autor, inclusive no modo prontuário único; isolamento pela API e pelo RLS; trilha sem conteúdo). Rotas novas na prova de 401 de `test/security/sessao-tenant.security.test.ts`.

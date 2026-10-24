# Revisão LGPD e segurança: importador de planilha (PR #66, `eng/importador`)

> Revisor: agente `guardiao-lgpd` (N1, veto) · Data: 2026-10-16 · Rodada 17
> Base: [checklist-pr.md](../checklist-pr.md), [papeis-controlador-operador.md](../papeis-controlador-operador.md), [bases-legais-e-consentimento.md](../bases-legais-e-consentimento.md), [dpa-minuta.md](../dpa-minuta.md), [retencao-e-descarte.md](../retencao-e-descarte.md), `plano-piloto.md` §5 (passo 5) e o parecer do [PR #5](2026-10-08-pr5.md) (P3: migração só depois de DPA, termo, canal cifrado e descarte em ≤ 7 dias).
> Escopo: `git diff 0aa82c0..origin/eng/importador` (`5f199ba`, 20 arquivos, migração `0024`). Lidos por inteiro: `0024_importador.sql`, `importacao.service.ts`, `importacao-regras.ts` (campos, mapeamento e hash do plano), as rotas e permissões de `importacao.controller.ts`, a detecção de ZIP em `importacao.validation.ts`/`planilha-csv.ts`, `import-export.ts` e `api-dominio.md` §10. Dos testes, só os títulos de `importador.rls.test.ts`.

## Veredito: **VETADO** (1 bloqueante, V1, de correção curta)

O desenho está certo em quase tudo:
- só CSV (XLSX recusado pelo tipo e pela assinatura `PK\x03\x04`, sem dependência nova);
- aceite versionado do termo, gravado com quem aceitou e quando;
- arquivo bruto **só cifrado** (CHECK), com AAD amarrada ao lote, expiração ≤ 7 dias no banco e runtime sem UPDATE ou DELETE;
- divergências guardadas só como código;
- mapeamento por índice de coluna, nunca pelo texto do cabeçalho;
- dry-run sem gravar;
- aplicar recalcula o plano e exige o mesmo hash;
- descarte do bruto no commit do aplicar;
- admin conferido no banco (`clinic_members`);
- RLS FORCE com FK compostas nas quatro tabelas;
- trilha só com ids e contagens;
- minimização forte: só 5 campos de paciente, nada clínico.

O veto vem de uma única função: o **desfazer apaga pacientes e agendamentos a partir de um livro que o runtime consegue escrever**.

## 1. Achados

### 🔴 Bloqueante

**V1. O desfazer vira um caminho de DELETE em `patients`/`appointments` para registros que NÃO vieram do lote.**
- **Onde:** `0024`: `import_batch_records_guard` e `app_undo_import_batch`.
- **O furo:**
  - `app_user` tem INSERT em `import_batch_records` (só UPDATE, DELETE e TRUNCATE foram revogados).
  - O guard aceita qualquer `record_id` enquanto o lote está `simulado`. Não confere que o registro foi criado pelo lote nem na transação do aplicar, e nem que existe.
  - `app_undo_import_batch` é SECURITY DEFINER e apaga `patients`/`appointments` pelo livro.
- **Burla (modelo de ameaça do projeto: SQL injetado de qualquer perfil, como nas 0009, 0016 e 0020):**
  1. Com um lote da clínica em `simulado`, inserir no livro `(entity='patient', record_id=<paciente antigo>)` e `(entity='appointment', record_id=<agendamento futuro dele>)`.
  2. O admin aplica e, depois, desfaz (por exemplo, porque importou o arquivo errado).
  3. `app_import_batch_blockers` só barra o que tem atendimento, prontuário, financeiro, agenda fora do livro ou edição posterior. Um paciente só com cadastro e agenda futura passa.
  4. O paciente antigo e os agendamentos dele são **apagados**.
- **Por que bloqueia:** isso reabre exatamente o que a 0009 fechou ("uma injeção apagar paciente sem agendamento"). A eliminação passa a ser irreversível e sem trilha por paciente, porque o evento `undo` só leva contagens.
- **Correção (uma das duas, com teste RLS da burla acima):**
  - (a) Colunas `import_batch_id` em `patients` e `appointments`: gravadas só no INSERT, imutáveis (trigger para qualquer papel) e aceitas só se o lote estiver `simulado`. O desfazer apaga `WHERE import_batch_id = p_batch`, e o livro vira só proveniência.
  - (b) No `import_batch_records_guard`, exigir que o registro exista e tenha `created_at = now()`, ou seja, que tenha sido criado na mesma transação do aplicar. Tornar `created_at` imutável em `patients` e `appointments`. No `app_undo_import_batch`, apagar só onde `created_at = applied_at` do lote.

  Recomendo a (a).

### 🟡 Ressalvas
| # | Onde | Problema | Correção e prazo |
|---|---|---|---|
| R1 | `0024` `import_batches_guard` e `hashDoPlano` | O hash do plano **não amarra o mapeamento**. Para pacientes, as ações são só `[linha, criar\|ignorar]`. O guard aceita UPDATE de `column_mapping` (e de `simulation_hash`) com o lote ainda `simulado`, por qualquer perfil. Um UPDATE direto, por exemplo trocar a coluna de `nome` com a de `nomeSocial`, mantém o mesmo hash, e o admin aplica um plano diferente do que viu. O G8 não fica garantido no banco | Pôr no hash o `column_mapping` canônico e o `sha256` do bruto. No guard: mudança de `column_mapping` força `status = 'recebido'` e `simulation_hash = NULL`, e qualquer UPDATE do lote exige admin da sessão. **Antes da 1ª importação real** |
| R2 | §10b ("agendador entra com a infraestrutura de jobs") | **Ainda não existe a rotina diária.** O descarte só acontece quando alguém da clínica usa o importador de novo. O lote abandonado mantém o bruto cifrado além dos 7 dias. A API não o lê depois do vencimento, mas ele continua guardado, e o compromisso do plano do piloto e do termo ("descarte evidenciado em ≤ 7 dias") não se cumpre | Agendador que rode `app_purge_import_raw_files()` em todas as clínicas pelo menos 1×/dia, com alarme se algum `import_raw_files.expires_at < now() - 24h`. Até lá, o importador fica **desligado em produção** (feature flag). **Antes da 1ª importação real** |
| R3 | `cifrar`, com a DEK da clínica | O "descarte comprovado" só apaga a linha. Cópias do bruto ficam no WAL, nos snapshots e no backup do RDS pelo prazo de retenção do backup (R7 do #58), legíveis com a DEK da clínica, que continua viva | *Crypto-shredding* por lote: uma chave de dados própria por lote, embrulhada pela DEK da clínica e guardada no lote. O expurgo destrói a chave embrulhada. Assim `raw_discarded_at` passa a significar "ilegível em qualquer cópia". Alternativa: declarar no termo e no ROPA o prazo do backup como prazo máximo real. **Antes da 1ª importação real** |
| R4 | `TERMO_MIGRACAO_VERSAO = 'mig-02.4-v1'` | **O termo não tem texto.** O aceite grava uma versão sem conteúdo publicado, então a "instrução do controlador" (LGPD art. 39) não é verificável | Escrever o termo v1 em `docs/03-seguranca-lgpd/termo-migracao.md`, com o conteúdo da seção 2 abaixo, e servir o texto (ou o hash dele) em `GET /importacoes/termo`. O aceite grava a versão, que aponta para esse texto. Revisão do advogado (`pacote-advogado.md`). **Antes da 1ª importação real** |
| R5 | `CAMPOS.pacientes` | **Menores e responsáveis.** O paciente menor (pela data de nascimento) entra sem responsável, e o cadastro não tem esse campo. É o mesmo problema da R3 do #65, agora em escala | Aviso `menor_sem_responsavel` no dry-run (só código) e pendência no cadastro. Quando o cadastro ganhar o responsável (nome, CPF, vínculo), o importador ganha as colunas, com as mesmas regras. **Antes do piloto com pediatria/TO infantil** |
| R6 | processo | **Arquivo de outra clínica por engano.** O sistema não tem como detectar, e o isolamento impede, com razão, comparar entre clínicas. O desfazer resolve só enquanto nada foi usado | (a) Na tela do termo e do dry-run, mostrar o nome da clínica de destino em destaque e pedir que o admin o confirme ao aplicar. (b) Runbook de incidente: importação errada que não se desfaz mais segue o `plano-resposta-incidentes.md` (avaliação do art. 48 pela clínica controladora) e é eliminada pelo papel de operação, com chamado e trilha. (c) A trilha do lote (`import_batch_records`) é a base para saber quem foi afetado. **Antes da 1ª importação real** |
| R7 | WBS MIG-02.4 | O critério diz "brutos descartados em ≤ **30** dias", e o plano do piloto e este PR dizem ≤ 7 | Corrigir a WBS para ≤ 7 dias. **Junto do merge** |
| R8 | `import_reject_mutation()` | É a única função nova sem `SET search_path` (mesmo padrão da R11 do #65) | `SET search_path = pg_catalog, public`. **Junto da correção do V1** |
| R9 | `cpfsDaClinica` | Decifra **todos** os CPFs da clínica a cada validação e a cada aplicar. Não é furo, porque fica dentro da clínica e na transação, mas aumenta a exposição em memória e o custo | Índice cego por clínica (HMAC no KMS), como o próprio §10b prevê. **Antes do GA** |

### 🟢 Conferido e aprovado
- **Só admin, conferido no banco.** Criar, aplicar e desfazer exigem `app_user_has_role(v_user,'admin')` com o usuário travado da sessão. Recepção, profissional e financeiro recebem 403 em todas as rotas (testado).
- **Bruto.** Só cifrado (CHECK `app_is_sealed_field`), com AAD = clínica + tabela + coluna + lote. Nasce só com o lote `recebido` e a mesma expiração, não muda, e só a função de expurgo apaga. Lote "no futuro" é recusado, e a expiração passa pelo CHECK duplo (lote e arquivo). A API recusa abrir o arquivo vencido.
- **XLSX recusado** pelo `content-type` e pela assinatura ZIP, sem nenhuma biblioteca de descompactação: evita bomba ZIP e XXE. Latin-1 e UTF-16 dão 400. Os limites são 5 MiB, 10 mil linhas, 60 colunas e 1.000 caracteres por célula.
- **Fórmulas.** São recusadas na leitura (erro) e neutralizadas no relatório JSON e CSV.
- **Divergências.** São gravadas só como código. O valor da célula aparece **só na resposta** ao admin da própria clínica, relido do bruto enquanto ele existir. Não vai para tabela nem para log.
- **Dry-run e aplicar.** O dry-run não grava paciente nem agendamento. O aplicar trava a agenda de todos os profissionais e refaz o plano. Se o cadastro mudou, dá 409 sem gravar. Nada é sobrescrito: CPF já cadastrado é ignorado.
- **Desfazer.** É bloqueado por atendimento, prontuário (nota ou retenção legal), financeiro, agenda nova ou edição posterior, e qualquer FK nova também bloqueia. Os motivos voltam só em contagem. *Depende do V1.*
- **Funções SECURITY DEFINER.** Têm `search_path` fixo com `pg_temp` por último, recusam rodar sem contexto, e a migração falha se o dono for superusuário, BYPASSRLS ou `app_user`.
- **Auditoria.** Registra cada etapa (`map`, `validate`, `dry_run`, `report`, `apply`, `undo`, `raw_discarded`) com ids e contagens. A criação leva só `term_version`, linhas e bytes, e o teste procura nome, CPF, telefone e fórmula na trilha. O serviço não tem logger.
- **Isolamento.** O lote de A dá 404 para B pela API, e B não lê nem grava nas quatro tabelas pelo RLS (testado).
- **G2 1.13.0.** Leva o lote (com o aceite do termo e a evidência do descarte) e o livro. Deixa de fora o bruto e as divergências, com motivo: é correto, porque exportar o bruto esticaria a vida dele.
- **Agenda só futura.** O passado fica no sistema antigo e não cria vínculo de cuidado aqui.
- **Sem dado real.** Os testes geram CSV fictício a cada execução, e nenhum segredo foi adicionado.

## 2. Decisões do Guardião (perguntas da rodada)

**2.1 Base legal da migração.**
- **Controladora:** a clínica. **Nós:** operadora (art. 5º, VII; art. 39).
- A importação é a **continuação do mesmo tratamento**, sob as mesmas bases que a clínica já usa para cada dado:
  - cadastro e agenda: art. 7º, V (execução do contrato de prestação de serviço de saúde);
  - dado de saúde, quando houver: art. 11, II, "f" (tutela da saúde) e art. 11, II, "a" (obrigação legal de guarda do prontuário).
- **Não se pede consentimento novo ao paciente**, porque trocar de operador não muda a finalidade. A clínica atualiza o próprio aviso de privacidade (art. 9º) para citar a plataforma como operadora.
- **Nossa legitimidade** vem do DPA (`dpa-minuta.md`) mais o termo de migração. O termo é a **instrução documentada** para esta operação (art. 39), e por isso tem de ter texto (R4).
- **Conteúdo mínimo do termo v1:**
  - a clínica declara que é a controladora dos dados do arquivo e que eles são de pacientes **dela**;
  - declara que obteve o arquivo do sistema anterior pelos meios do próprio contrato com aquele fornecedor;
  - finalidade única: carregar o cadastro e a agenda da clínica;
  - campos aceitos (só os 5 de paciente e os 6 de agenda; colunas excedentes são descartadas com o bruto);
  - orientação de exportar só as colunas necessárias, sem evolução clínica, CID ou anexo;
  - prazo do bruto (≤ 7 dias, com o prazo do backup informado, R3);
  - proibição de qualquer outro uso por nós (inclusive estatística, benchmarking e treino de IA);
  - desfazer e o seu limite;
  - responsabilidade da clínica pela exatidão (art. 6º, V);
  - canal de incidente.

**2.2 O sistema anterior é "outro operador"?** Sim: é operador da **mesma** controladora. Nós não recebemos dado **do concorrente**. Recebemos **da clínica**, que tirou a cópia do sistema dela.
- Não há compartilhamento entre operadores nem transferência que exija base própria.
- **Regras:**
  - nunca pedir arquivo ou acesso direto ao fornecedor anterior em nome da clínica sem instrução escrita dela;
  - nunca guardar credenciais do sistema anterior;
  - o importador de concorrente (MIG-01.3/01.4) que fizer coleta automatizada com login da clínica passa por nova revisão;
  - eliminação da base no sistema anterior é assunto entre a clínica e o fornecedor (cabe uma orientação no termo, não uma obrigação nossa).
- **Os dados que vieram do concorrente nunca são usados para inteligência de mercado.** Ninguém olha o formato do arquivo para "aprender" sobre o concorrente com dado de paciente. O mapeamento sugerido usa só sinônimos genéricos de cabeçalho, o que está correto.

**2.3 Descarte comprovado.** Hoje a prova é `raw_discarded_at` mais o evento `raw_discarded` na trilha e no G2. É evidência suficiente **de que a linha saiu**. Para ser comprovado de fato, faltam:
- a rotina que garante o prazo (R2);
- a ilegibilidade das cópias de backup (R3).

**2.4 Menores e responsáveis.** O importador não piora o cadastro, mas também não pode esconder o problema: a R5 pede aviso no dry-run. A base legal para menor continua no art. 11, II, "f" (tutela da saúde) e na guarda. O art. 14, §1º (consentimento dos pais) só se aplica a tratamento baseado em consentimento, o que não é o caso aqui.

**2.5 Arquivo de outra clínica por engano.** Ver a R6. Se acontecer, o incidente é **da clínica controladora que enviou** (ela tratou dado que não é dela). Para a clínica dona do dado, o caso é de acesso indevido. A plataforma notifica a controladora sem demora indevida (DPA) e oferece a eliminação com evidência. O livro do lote e o G2 dão a lista dos afetados sem reabrir o bruto.

**2.6 Logs.** Adequados:
- trilha sem conteúdo;
- serviço sem logger;
- conteúdo só no corpo da requisição, nunca na URL (a URL leva só tipo e versão do termo);
- erros só com código.

Pendência fora do código: confirmar no ALB e no WAF de produção que o corpo nunca é registrado. Hoje não é, porque o WAF só registra cabeçalhos e a `query_string` é redigida (R1 do #58).

## 3. Checklist de PR
| # | Resposta | Nota |
|---|---|---|
| Base legal | Sim, com R4 | Continuidade do tratamento da controladora; falta o texto do termo (instrução, art. 39) |
| Minimização | Sim | 5 campos de paciente, sem dado clínico; colunas excedentes só no bruto, por até 7 dias |
| Consentimento | N/A | Sem consentimento novo (mesma finalidade); a clínica atualiza o aviso de privacidade |
| Criptografia em repouso e em trânsito | Parcial | Bruto e campos cifrados; o descarte não alcança o backup (R3); TLS herdado |
| Isolamento por tenant | Sim | RLS FORCE em 4 tabelas, FK compostas, AAD com a clínica; testado |
| Controle de acesso | **Não** | Admin conferido no banco, mas o desfazer apaga pelo livro forjável (V1), e o lote aceita UPDATE de mapeamento por qualquer perfil (R1) |
| Auditoria | Sim | Ids e contagens; sem conteúdo (testado) |
| Retenção e descarte | Parcial | Prazo ≤ 7 dias no banco; sem agendador (R2); backup (R3) |
| Segredos e dados reais fora do git | Sim | CSV fictício gerado no teste |
| CFM/ANS/ICP-Brasil | N/A | Não importa prontuário, guia nem documento assinado nesta rodada |

## 4. Para virar APROVADO COM RESSALVAS
1. Corrigir o V1 (opção (a) recomendada), com teste RLS da burla da seção 1: livro forjado com paciente antigo + aplicar + desfazer, e o paciente antigo tem de continuar existindo.
2. R8 junto.
3. Registrar R1–R7 e R9 na fila com os prazos. R1, R2, R3, R4 e R6 são **condição da 1ª importação real** (onda 3). Até lá, o importador fica desligado em produção.
4. Merge **depois** de #63 e #65 (numeração 0022–0024 e G2 1.13.0) e com o CI verde.

## Re-revisão (19/10/2026)
Base: `origin/eng/importador` em `eb0c326` (migração 0026). **Veredito: VETADO.** A V1 foi resolvida, mas a R6(b) abriu um vazamento novo (V2).

**V1: resolvida.** `import_batch_id` só entra no INSERT, com lote `simulado` do tipo certo e admin da sessão, e depois não muda mais (trigger vale para qualquer papel). O livro só aceita registro que já carrega a marca do próprio lote. `app_undo_import_batch` apaga só `WHERE import_batch_id = lote`. Tentei de novo três caminhos, e todos falham:
- pôr a marca num paciente antigo com UPDATE (é imutável);
- forjar o livro (exige a marca);
- reinserir o id de um paciente antigo (PK).

A única tabela com `ON DELETE CASCADE` para `patients` é `import_cpf_fingerprints`. **Regra para a frente:** toda FK nova para `patients` ou `appointments` (por exemplo, responsáveis, portal) tem de ser `RESTRICT` ou entrar em `app_import_batch_blockers`. Se for CASCADE, o desfazer apaga junto, sem aviso, o que veio depois.

**R1, R2, R4 e R6(a): atendidas.** Situação de cada uma:
- R1: o hash cobre o mapeamento e o SHA-256 do bruto; remapear exige voltar a `recebido`; só admin altera o lote, salvo o formato exato do expurgo.
- R2: o importador fica desligado em produção salvo `IMPORTADOR_HABILITADO=true`.
- R4: `term_sha256` é obrigatório e imutável. O texto continua ⚖️ (pendente do advogado).
- R6(a): o admin digita o nome ou o CNPJ da clínica, e a confirmação fica imutável.

**V2 (🔴, nova): a R6(b) é um oráculo entre controladoras.** `app_import_cpfs_em_outras_clinicas` devolve a contagem exata quando há 5 ou mais coincidências e elas somam pelo menos 20% do arquivo. A burla:
1. O atacante monta uma planilha com 4 CPFs que ele sabe estarem importados em outra clínica (a segunda clínica que ele administra, uma clínica parceira em conluio ou os CPFs de familiares) e mais 1 CPF alvo.
2. Simula a importação.
3. Se a resposta for 5, o alvo é paciente de outra clínica. Se for 0, não é.

O oráculo responde sobre um CPF por vez e com certeza. Trocar a contagem por "há indícios: sim/não" **não resolve**: o oráculo está no cruzamento do limiar, e 1 bit por consulta basta. Ser paciente de uma clínica (às vezes de psicologia ou psiquiatria) é dado referente à saúde. Contar isso a outra controladora:
- não tem base legal (art. 11);
- foge das instruções da controladora dona do dado (art. 39, a plataforma é operadora);
- é comunicação que configura incidente (art. 48).

**Decisão:** o cliente não pode receber **nenhum** sinal sobre outras clínicas. Duas opções:
- **(a) Remover a R6(b)** (recomendado). Saem a função, a tabela `import_cpf_fingerprints` e `IMPORT_CPF_FP_KEY`. Ficam a R6(a), a checagem de duplicidade **dentro** da própria clínica e o termo.
- **(b) Alerta só interno.** Acima do limiar, um evento sem CPF e sem id de paciente vai para a fila de segurança da plataforma. O fluxo do usuário não muda em nada: nem retenção, nem atraso, nem mensagem. A revisão é humana, feita pelo encarregado, que contata as clínicas fora do produto. Exige cláusula no DPA (segurança do tratamento, arts. 46 e 47) e entrada no ROPA.

Em qualquer das duas, um teste RLS tem de provar que a resposta da simulação é idêntica com e sem coincidência em outra clínica.

**Para virar APROVADO COM RESSALVAS:**
- a V2 corrigida, pela opção (a) ou (b), com o teste acima;
- as condições anteriores mantidas (R3, R5, R7 e R9 na fila; R1–R4 e R6 antes da 1ª importação real; merge depois de #63 e #65; CI verde).

## Re-revisão 2 (20/10/2026)

Revisado: `origin/eng/importador` em `1649d69` (`git diff eb0c326..1649d69`, migração 0030).

**Veredito: APROVADO COM RESSALVAS.** A V2 está fechada pela opção (a).

Conferido, tentando burlar:
- **Oráculo removido:** a 0030 apaga as duas funções e a tabela `import_cpf_fingerprints` (DROP limpo). No código saíram `IMPORT_CPF_FP_KEY`, `chaveImpressaoCpf`, `impressao()`, `cpfsEmOutraClinica()`, o campo do dry-run, `other_clinic_cpfs` da trilha e as entradas no G2 e na exportação. Fora a 0026 (histórico), a 0030, as revisões e o teste que confere a remoção, não sobrou nenhuma referência na árvore.
- **Teste:** a simulação do mesmo lote dá corpo idêntico (`toStrictEqual`, inclusive `resumoHash`) e evento `dry_run` idêntico antes e depois de B importar e aplicar os mesmos CPFs. Outro teste confere no catálogo que a função e a tabela sumiram.
- **Canais laterais:** nenhum encontrado.
  - Duplicidade: `cpfsDaClinica` decifra só os CPFs da própria clínica (filtro `tenant_id` mais RLS). O aviso `ja_cadastrado` só considera a clínica.
  - Unicidade: o CPF fica só cifrado, com chave por clínica, sem índice único nem índice cego. Nenhum erro de unicidade depende de outra clínica.
  - Tempo de resposta: a simulação não faz nenhuma consulta entre clínicas, então o tempo depende só do cadastro da própria clínica.
- **Regra das FK:** o bloco `DO` da 0030 recusa FK para `patients`/`appointments` em CASCADE/SET NULL/SET DEFAULT fora de `app_import_batch_blockers`. O teste lê o catálogo, com sanidade contra lista vazia. Hoje nenhuma FK fica fora da regra.

Ressalvas (operacionais, não bloqueiam):
- **R10:** apagar `IMPORT_CPF_FP_KEY` do cofre e dos ambientes onde foi criada e registrar o descarte. As impressões que sobrarem em backup somem no ciclo normal de retenção dos backups.
- **R11:** a regra das FK só é conferida na 0030 e no teste. Toda migração nova com FK para `patients`/`appointments` tem de passar pelo teste do catálogo (ele roda no CI, então basta não removê-lo).

Condições que continuam: R3, R5, R7 e R9 na fila; R1–R4 e R6 a antes da 1ª importação real; merge depois do #63 e do #65; CI verde.

## Conferência das ressalvas (22/10/2026)

Revisado: `git diff 1649d69..origin/eng/importador` (migração 0035, `scripts/migrate.mjs`, `importacao-regras.ts` e o teste, `importador.rls.test.ts`, WBS e `api-dominio.md`).

**Veredito: APROVADO COM RESSALVAS** (mantido). R7 e R11 resolvidas, R5 resolvida na parte do importador. Aceito o que ficou de fora, com as condições abaixo.

Resolvidas:
- **R11:** a 0035 cria `app_assert_regra_fk_desfazer()` (`SET search_path`, `REVOKE ... FROM PUBLIC`) e o runner a chama **dentro** da transação de cada migração, antes de gravar em `schema_migrations`. Uma FK em CASCADE/SET NULL/SET DEFAULT fora de `app_import_batch_blockers` derruba a migração inteira. O teste prova três coisas: o runtime não executa a função, a FK em CASCADE é recusada e a tabela não fica no banco (rollback).
  - *Observação, sem prazo:* a função procura o nome da tabela no **texto** da função de bloqueios. Um nome que só aparece num comentário dela passaria. Hoje não há esse caso, e quem revisa a migração vê. Se um dia a função de bloqueios for reescrita, melhor trocar por uma lista explícita de tabelas.
- **R5 (parte do importador):** o aviso `menor_sem_responsavel` sai no validar e no simular (`planejarPacientes` reusa `validarPacientes`). Ele leva só linha, campo e código, sem valor, e não impede a linha de entrar. O teste cobre a véspera e o dia dos 18 anos.
  - Uma limitação aceita: a data de "hoje" é a UTC. Entre 21h e 24h de Brasília, na véspera do aniversário, o aviso pode errar por um dia. Como é só aviso, fica assim.
  - Fica **aberta** a outra parte: quando o cadastro ganhar o responsável legal (#67), o importador recebe as colunas do responsável com as mesmas regras. Prazo mantido: antes do piloto com pediatria ou TO infantil.
- **R7:** a WBS MIG-02.4 agora diz ≤ 7 dias após o envio, com expiração no banco. Bate com o `IMPORT_RAW_TTL_HOURS` (1 a 168 h).

Aceito ficar de fora:
- **R10** (apagar `IMPORT_CPF_FP_KEY` do cofre): é tarefa de infra, não de código. Na árvore, a chave só aparece em comentário da 0026 e da 0030. Condições:
  - a tarefa entra na fila com dono (`devops-ci`) e prazo antes da 1ª importação real;
  - o descarte fica registrado com data, ambientes e quem apagou;
  - a chave não pode ser reaproveitada para outro HMAC.
- **R3** (crypto-shredding por lote) **e R9** (índice cego com HMAC no KMS): os prazos já eram os do parecer, R3 antes da 1ª importação real e R9 antes do GA. Aceito porque o importador nasce **desligado** em produção. Conferi `loadImportacaoConfig`: com `NODE_ENV=production`, só liga com `IMPORTADOR_HABILITADO=true` explícito, e um valor inválido derruba o boot. Condições:
  - **Corrigir a regra de ligar.** Hoje `api-dominio.md` diz que basta o 1º ciclo do agendador com `alarme = false`. Isso permitiria ligar sem a R3. A regra tem de exigir **R1–R4 e R6 fechadas**, a R3 incluída (ou a alternativa da R3: o prazo do backup declarado como prazo máximo no termo e no ROPA), e o registro do Guardião na fila. Corrigir no próximo PR que tocar o importador e antes de qualquer `IMPORTADOR_HABILITADO=true` em produção.
  - A R9 entra no checklist do GA. Até lá, `cpfsDaClinica` continua decifrando só dentro da clínica e da transação, como conferido.

Condições que continuam:
- R1–R4 e R6 fechadas antes da 1ª importação real;
- R5 (colunas do responsável) antes do piloto com pediatria;
- R9 antes do GA;
- merge depois do #63 e do #65;
- CI verde, inclusive o teste da R11 com `DATABASE_MIGRATOR_URL`.

## Conferência (rodada 22)

- **Revisado:** `origin/eng/integracao-r19` (PR #73, `f00bccc`). Commits da R3/R9: `e1e52ea`, `ad041dd`, `59e037f`, `659d668`, `f00bccc`. Commits da R5: `ad95e35` a `1688a54`. Li:
  - as migrações `0046_importador_r3_r9_chaves.sql` e `0048_importador_responsaveis.sql`;
  - `crypto/disposable-keys.ts`, `kms-key-provider.ts` e `crypto.module.ts`;
  - `patients/cpf-indice-cego.ts` e `patients.service.ts`;
  - `imports/importacao.service.ts`, `importacao-regras.ts`, `jobs/registro-de-jobs.ts` e `tenant-export.ts`;
  - os testes `key-providers.test.ts`, `cpf-indice-cego.test.ts`, `importador.rls.test.ts` (R3/R9), `importador-responsaveis.rls.test.ts` e a guarda de schema;
  - `api-dominio.md` §12c e §12d.

  Li o código e os testes, **sem executá-los**. O Maestro informa, no `f00bccc`: turbo 12/12, `test:rls` 566/566 e `test:security` 81 ok, com 7 pulados (Redis real).

### Veredito: **APROVADO COM RESSALVAS.** R3, R5 e R9 aceitas. Antes de `IMPORTADOR_HABILITADO=true`, faltam duas correções curtas de código (R3-a e R3-b).

**R3 — chave própria do lote, em vez da DEK embrulhada pela chave da clínica: aceito, e é melhor que o pedido.** O executor tem razão. A DEK embrulhada pela chave da clínica ficaria no mesmo banco e no mesmo backup que o bruto, e a chave da clínica, ainda viva, abriria o backup: isso não seria crypto-shredding. Só uma chave mestra destruível por conta própria garante "ilegível em qualquer cópia".

Conferido:
- **Vínculo com a clínica.** A chave do lote leva a tag `tenant_id`, e a DEK fica amarrada à clínica pelo `EncryptionContext` e pela AAD (clínica + tabela + coluna + lote).
- **Tabela `import_batch_keys`.** Tem RLS FORCE e `portal_fora`. O runtime só tem SELECT e INSERT. O ciclo `active → destroying → destroyed` só anda como dono (`app_running_as_owner`), com CHECK de coerência e lápide (sem DELETE nem TRUNCATE).
- **Bruto novo.** Um trigger recusa bruto sem a chave ativa do próprio lote.
- **Expurgo.** Apaga a DEK embrulhada **na mesma transação** que apaga o bruto. Se o recebimento falhar, a chave que ficou órfã é destruída.
- **Destruição.** `destroyMasterKey` é idempotente (`PendingDeletion` conta como feito).
- **Trilha e exportação.** A trilha leva só contagens, e a tabela fica fora da exportação, com justificativa.
- **Testes.** Provam que a cópia de backup (cifra + DEK embrulhada) não abre depois do aplicar nem depois do TTL, e que destruir um lote não afeta outro.
- **Janela de 7 dias do KMS.** É aceitável: durante ela a chave já não abre, e só o `CancelKeyDeletion` a traria de volta (ver R3-b).

- **R3-a (corrigir antes de ligar).** `destruirChavesDescartadas` chama o KMS **dentro** da transação do expurgo e repassa o erro. Uma falha do KMS (falta de permissão no IAM, *throttling* ou indisponibilidade) causa três problemas:
  1. desfaz o `DELETE` do bruto e o `wrapped_key = NULL`, e o bruto vencido fica no banco além do TTL, contra a R2 e a R7;
  2. derruba **todas** as operações do importador da clínica, porque todas começam por `expurgarNaTransacao` (inclusive o recebimento e o aplicar de outro lote);
  3. o job diário falha naquela clínica sem alarme próprio.

  Correção:
  - destruir no KMS **depois** de gravar o expurgo, ou capturar o erro chave a chave, deixando a linha em `destroying`; o bruto e a DEK embrulhada já saíram, e a próxima rodada tenta de novo;
  - no `expurgoDiario`, devolver `chavesPendentes` (chaves em `destroying` há mais de 24 h, pelo índice `import_batch_keys_pending_idx`) e contá-las no `alarme`;
  - teste com um provedor que falha em `destroyMasterKey`: o bruto é apagado, a chave fica `destroying` e o alarme acende; na rodada seguinte, com o provedor de volta, a chave termina `destroyed`.
- **R3-b (corrigir antes de ligar; é o que permite ao devops escrever o IAM).** A chave do lote nasce com a **mesma** descrição e as mesmas tags da chave mestra da clínica, e o IAM não tem como distinguir as duas. Com `kms:ScheduleKeyDeletion` "condicionado à tag `tenant_id`", a API também poderia agendar a exclusão das chaves das **clínicas**. E não dá para negar `kms:CancelKeyDeletion` e `kms:EnableKey` só às chaves de lote.

  Correção:
  - `createMasterKey` recebe a finalidade e grava as tags `purpose=import_batch` e `batch_id` (só ids), com uma descrição própria;
  - no IAM:
    - `CreateKey` condicionado a `aws:RequestTag/purpose`;
    - `ScheduleKeyDeletion` da API só com `aws:ResourceTag/purpose = import_batch`;
    - *deny* explícito de `CancelKeyDeletion` e `EnableKey` nessas chaves, com alarme no CloudTrail;
  - atualizar a lista de permissões no §12d.
- *Observação:* `enableKeyRotation` numa chave que vive no máximo 7 dias não faz nada. Pode sair e poupar uma chamada.

**R9 — índice cego do CPF por clínica: aceito.**
- **Construção.** HMAC-SHA256 com separação de domínio, sobre uma chave aleatória de 32 bytes, por clínica e versionada, guardada só cifrada pela chave da clínica. Destruir as chaves da clínica (G3) destrói o índice junto.
- **Sem sinal entre clínicas.** O índice não é único e nunca compara clínicas: a chave é outra e o RLS limita a busca. O teste prova que o mesmo CPF dá índices diferentes em clínicas diferentes, e o oráculo da V2 não volta.
- **Busca.** Confirma decifrando só o paciente que casou, o que derruba índice forjado e colisão.
- **Índice desatualizado.** O gatilho `patients_cpf_bidx_stale` garante índice ausente, nunca índice errado.
- **Rotação.** O banco recusa destruir uma versão com paciente indexado nela.
- **Trilha e log.** A trilha leva só contagens e versões, e o teste confere que nenhum CPF vai para stdout ou stderr.
- **Resíduo aceito.** Dentro da clínica, o índice revela quais pacientes compartilham CPF, o que a clínica já sabe.
- *Observação (antes do GA):* os pacientes anteriores à 0046 só ganham índice pelo passo 2 do runbook (`reindexar`), que não tem script nem job. Até rodar, a busca continua decifrando esses pacientes, como antes. Entregar o script do runbook e rodá-lo uma vez por clínica existente antes do GA. Uma base nova não tem pendentes.

**Dedup de responsáveis, que continua decifrando (0048): aceita até o GA.** A decifração acontece só dentro da clínica e da transação, sem log, como a 0048 entregou. O motivo técnico procede: `guardians_guard` e `updated_at` fariam a reindexação contar como `alterado_depois`. A proposta do §12d está correta: mesma chave, domínio `guardians.cpf:v1:`, exceção no guarda só para as colunas do índice e reindexação cobrindo as duas tabelas. Prazo: o mesmo da R9 nos pacientes, antes do GA.

**R5 — responsáveis no lote (0048, G2 1.18.0): aceito, R5 fechada.**
- **Quem pode ser vínculo.** Pai/mãe e tutor só para paciente menor, pela data de nascimento; sem data, não se presume. Curador só para paciente maior, com a referência da decisão e o escopo (os dois cifrados).
- **Pagador.** Só de menor. Na curatela, o vínculo entra **sem** pagador, com o aviso `pagador_exige_ciencia_do_paciente` (A7 do #67). O tipo `representante` não vem pela planilha.
- **Marca clínica proibida no banco.** O guarda recusa vínculo do lote com `receives_clinical_info`, decisão ou justificativa.
- **Marca `import_batch_id`.** Gravada só no INSERT, com lote `simulado` de pacientes e por admin da sessão, e imutável depois. O vínculo do lote só pode ser de paciente do mesmo lote.
- **Desfazer.** Apaga, pela marca, só os vínculos, o histórico deles e as pessoas criadas pelo lote. Os gatilhos "nada se apaga" só abrem com `app.import_undo_batch` igual à marca. Uma GUC forjada pelo runtime não basta, porque ele não tem DELETE nessas tabelas (o teste prova). A pessoa que já existia fica, com o vínculo e o histórico dela.
- **Bloqueios.** `responsavel_em_uso` (recebimento, portal, WhatsApp e paciente de fora) e `responsavel_novo` estão corretos.
- **Sem dado pessoal no hash nem na trilha.** O hash do plano e a trilha não levam CPF nem nome.
- **Isolamento.** O teste entre clínicas passa.
- *Observações, sem bloqueio:*
  - O curador de paciente sem data de nascimento é aceito. Como a decisão judicial é exigida, aceito também, mas vale um aviso `curatela_sem_data_de_nascimento` para a recepção conferir.
  - Os bloqueios por recebimento, portal e WhatsApp não têm teste próprio no desfazer: só o de paciente de fora tem. Acrescentar um caso, por exemplo um pagamento com `guardian_payer_link_id` do lote.

**Pode ligar em produção? Quanto ao código, ainda não.** Faltam a R3-a e a R3-b. Corrigidas e conferidas pelo Guardião, o código fica pronto para ligar. Continuam valendo as condições fora do código já registradas:
- KMS ligado (Portão A);
- IAM do devops com as tags da R3-b;
- 1º ciclo do agendador com `alarme = false`;
- R10 registrada;
- registro do Guardião na fila.

## Conferência R3-a/R3-b (23/10/2026)

- **Revisado:** `git diff f00bccc..origin/eng/integracao-r19` (PR #73, ponta `e281e88`; commits `320825a`, `331cc2a`, `f0df78b`, `cf41025`, `e281e88`). Li `importacao.service.ts`, `importacao-regras.ts`, `key-provider.ts`, `kms-key-provider.ts`, `disposable-keys.ts`, `registro-de-jobs.ts`, os testes `key-providers.test.ts`, `importacao-regras.test.ts`, `importador.rls.test.ts`, `importador-responsaveis.rls.test.ts` e `retencao-custodia.rls.test.ts`, o §12d e o §14 do `api-dominio.md`, `ambientes-e-devops.md` e o runbook do fundador. Li **sem executar**. O Maestro informa `test:rls` 570/570 (três vezes) e `test:security` 81 ok.

### Veredito: **APROVADO.** R3-a e R3-b fechadas. Pelo código, o importador pode ser ligado em produção quando as condições de infra estiverem cumpridas.

**R3-a — KMS fora da transação do expurgo: fechada.**
- `expurgarNaTransacao` só chama `app_purge_import_raw_files()`: apaga o bruto e a DEK embrulhada e marca `destroying`. Nenhuma chamada ao KMS fica dentro da transação.
- Toda escrita do importador passa por `escrever()`: commit primeiro, `destruirChavesPendentes` depois. Essa função nunca lança (erro do KMS por chave, erro do banco no bloco todo), deixa a chave em `destroying` e fecha como `destroyed` só as que o provedor confirmou, numa transação curta com trilha só de contagem (`batch_keys_destroyed`). A falha do KMS não desfaz o descarte nem derruba o recebimento ou o aplicar de outro lote.
- Retomada: até 20 chaves por operação do usuário; o job `importador-expurgo` esvazia a fila em blocos. O laço termina, porque para quando não destrói nenhuma ou quando há falha. A destruição é idempotente (`PendingDeletion` conta como feito).
- Alarme: `chavesPendentes` conta as chaves em `destroying` há mais de 24 h e entra em `alarme`/`clinicasComAtraso`. O log `CHAVE_LOTE_PRESA` leva só o id da clínica e a contagem. O filtro de métrica e o alarme estão pedidos ao IaC (`ambientes-e-devops.md` e §14, item 2).
- O teste "R3-a" prova o que foi pedido: com o provedor falhando, o bruto sai, a chave fica `destroying` com `wrapped_key` nulo, outro recebimento dá 201, a chave presa há 25 h acende o alarme e `CHAVE_LOTE_PRESA` (sem nome, telefone, lote nem ARN), e com o KMS de volta ela termina `destroyed` e o alarme apaga.
- Resíduo aceito: entre o expurgo e o sucesso no KMS, uma cópia de backup anterior ao expurgo ainda abre com a chave mestra viva. A janela é limitada e alarmada em 24 h.

**R3-b — chave de lote separável no IAM: fechada.**
- `createMasterKey(tenantId, finalidade)`: a chave da clínica nasce com `purpose=tenant_data` e rotação; a do lote, com `purpose=import_batch`, `batch_id` (só id), descrição própria e **sem** rotação. As tags vão na criação, como exige `aws:RequestTag`. `DisposableKeys` sempre passa `import_batch`. O teste com o KMS falso confere tags, descrição e que só a chave da clínica liga rotação.
- O §12d e `ambientes-e-devops.md` têm a política completa: `CreateKey`/`TagResource` condicionados a `aws:RequestTag/purpose` e a `aws:TagKeys`; `ScheduleKeyDeletion` só em `purpose=import_batch`; `EnableKeyRotation` só em `tenant_data`; *deny* de `CancelKeyDeletion`/`EnableKey` nas chaves de lote, salvo *break-glass*, com alarme no CloudTrail; *deny* de `UntagResource` e da troca de `purpose`. Isso fecha o risco de a API agendar a exclusão da chave de uma clínica.

**Demais itens: aceitos.**
- R5: o aviso `curatela_sem_data_de_nascimento` (só aviso, sem valor) tem teste. O teste de bloqueio do desfazer por recebimento com `guardian_payer_link_id` do lote dá `responsavel_em_uso` e não apaga nada. Os dados de teste são fictícios.
- Runbook (O-R22a/b do #63): o texto sobre o mestre do RDS e as sugestões `app_operador` e pgaudit (`log_parameter = off`, sem `write` no papel de runtime) estão corretos. São de devops e devem estar prontos antes do GA.
- Teste instável: a trilha agora é ordenada por `seq`. É só o teste; a trilha não mudou.

**Observações, sem bloqueio (antes do GA):**
1. Se a transação do `receber` cair e o KMS também falhar ao destruir a chave recém-criada, a chave fica órfã no KMS, sem linha para retomar e sem log (`.catch(() => undefined)`). Não há dado em risco: nenhum cifrado foi gravado. Logar `CHAVE_LOTE_ORFA` (só clínica) ou varrer, pelo IaC, as chaves `purpose=import_batch` `Enabled` há mais de 8 dias.
2. Se a chave ficar em `destroying` por mais de 7 dias depois de o KMS já ter agendado a exclusão (por exemplo, o banco falhou ao fechar a linha), o KMS apaga a chave e `describeKey` passa a dar `NotFound`. `destroyMasterKey` lança e a chave fica presa para sempre, com o alarme aceso. O alarme acende, então nada falha em silêncio, mas convém tratar `NotFound`/`KMSInvalidStateException` em `PendingDeletion` como feito.
3. `CHAVE_LOTE_KMS_FALHOU` descarta o motivo. Logar só o nome da classe do erro (`AccessDenied`, `Throttling`), sem mensagem nem ARN, ajudaria o on-call a separar IAM de indisponibilidade.

**Pode ligar em produção?** **Pelo código, sim.** Ligar `IMPORTADOR_HABILITADO=true` depende só das condições fora do código:
- KMS ligado (Portão A);
- IAM, *key policy* e SCP com as regras da R3-b, conferidos pelo Guardião no plano do Terraform;
- alarmes `CHAVE_LOTE_PRESA` e CloudTrail (`CancelKeyDeletion`/`EnableKey`) criados;
- 1º ciclo do agendador com `alarme = false`;
- R10 registrada;
- registro do Guardião na fila.

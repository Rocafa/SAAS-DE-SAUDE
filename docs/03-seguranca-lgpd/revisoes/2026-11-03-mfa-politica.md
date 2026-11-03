# Parecer do Guardião LGPD: PR #123, política de MFA independente do provedor (issue #106, S3)

- **Data:** 03/11/2026
- **Branch:** `eng/mfa-politica` (commit `a801293`)
- **Base:** regra 2 do memo [D04-recomendacao.md](../../00-governanca/memos/D04-recomendacao.md); [requisitos-tecnicos-seguranca.md](../requisitos-tecnicos-seguranca.md) §1, §4 e §5; [dpa-minuta.md](../dpa-minuta.md) cláusula 16.2; LGPD arts. 6º VII/VIII e 46.
- **Verificação:** `npx vitest run src/modules/auth` deu 13/13 verdes; `tsc --noEmit` limpo. O `test/mfa.rls.test.ts` não rodou (não há Postgres local).

## Veredito: **VETADO**

O desenho está certo: a obrigatoriedade fica no servidor, no `SessaoGuard`, antes de qualquer leitura, e não depende do provedor. O provedor só informa `mfaEm`. Data no futuro falha fechado, e a sessão fictícia continua presa a development/test (`auth-provider.factory.ts`).

Dois problemas impedem o merge: a lista de perfis contraria um requisito MUST, e o guard tira da trilha tentativas que hoje são auditadas.

## Bloqueios (corrigir neste PR)

### B1. A recepção precisa ser obrigada a usar MFA
- O requisito diz: "MFA obrigatório para todos os perfis com acesso a C3/C4 e para administradores" (`requisitos-tecnicos-seguranca.md` §4, **MUST**).
- A recepção acessa dado **C3**. Ela lê e escreve agenda (profissional e especialidade), cadastro de paciente com CPF, dados de menores e emancipação, responsáveis e convênio/guias.
- Ela também tem `financeiro:ler` e `financeiro:operar`, ou seja, recebe dinheiro, abre caixa e emite recibo. Por isso também se encaixa em "perfis financeiros" da regra 2 do memo.
- A justificativa do PR, "não vê conteúdo clínico **nem dado financeiro**" (comentário em `mfa.ts` e §17 de `api-dominio.md`), é **falsa** diante de `perfis.ts`.
- **Correção:** incluir `recepcao` em `PERFIS_COM_MFA_OBRIGATORIO`. Na prática, todos os perfis da clínica passam a ser obrigados. Ajustar o comentário, o §17 e os testes (`mfa.test.ts` e `mfa.rls.test.ts`, onde a recepção sem MFA hoje passa).
- Recepção sem MFA só seria aceitável se o perfil deixasse de tocar C3 e financeiro. Hoje não é o caso, e mudar isso exigiria alterar o requisito com aprovação dos sócios.

### B2. A recusa por MFA nas rotas sensíveis precisa ir para a trilha
- Hoje, uma tentativa de ler a nota privada de outro autor gera 404 e uma linha `clinical_access_denied` na trilha (HU-PRO-006/022, `acesso-clinico.ts`).
- Com o PR, a mesma tentativa feita com MFA antigo morre no guard com `403 mfa_recente_obrigatorio` e **não deixa rastro**.
- Esse é justamente o caso de sessão roubada (MFA feito há horas) tentando abrir o conteúdo mais sensível. O alerta de "leituras anômalas" (§5) fica cego para ele.
- **Correção:** nas rotas marcadas com `@ExigeMfaRecente()`, gravar a recusa (`mfa_obrigatorio` ou `mfa_recente_obrigatorio`) na trilha antes de lançar o 403.
  - Usar a clínica e o usuário da sessão, em transação própria, com escopo próprio (sugestão: `mfa_step_up_denied`).
  - O metadata leva só ids: rota (template, sem valores), `patient_id`/`custody_id` quando houver e o código da recusa. **Nunca** gravar `mfaEm` em claro nem o conteúdo.
  - Teste RLS: recusa por MFA em `/notas-privadas/:id` deixa uma linha na trilha.
- Nas rotas comuns, o `mfa_obrigatorio` pode esperar a D4 (ver R5).

## Ressalvas (não bloqueiam este PR; cada uma tem prazo)

| # | Ressalva | Prazo |
|---|---|---|
| **R1** | **Exportação total (G2): janela de 5 min, não 15.** A cláusula 16.2 da minuta de DPA promete ao cliente "autenticação em dois fatores feita nos últimos 5 minutos". O §17 diz que a rota "nasce marcada" com a janela padrão de 15 min, o que quebra a promessa contratual. Fazer `@ExigeMfaRecente({ janelaMs })` aceitar janela por rota e usar 5 min na exportação, ou levar aos sócios e ao advogado a troca do DPA para 15 min. Corrigir o texto do §17. | Antes da rota HTTP da G2 |
| **R2** | **MFA recente nas operações irreversíveis ou de poder** (só falta o decorator na rota): eliminação (`POST /pacientes/:id/responsaveis/eliminacao`) e descarte (`POST /responsaveis/descarte`) de responsáveis; retirada da retenção legal e a aprovação dela (`/prontuario/pacientes/:id/retencao-legal/retirada[/aprovacao]`); importação (`POST` de aplicar e desfazer em `/importacoes/:id/...`); `POST /suporte/autorizacoes` (abre acesso externo); `POST`/`DELETE /clinica/membros` (concede e retira perfil); `PUT /prontuario/configuracao` (sigilo da psicologia), ciclo das notas, desligamento de profissional e designação de custódia; atendimento do titular (`POST /clinica/portal/solicitacoes/:id/...`); `POST /financeiro/receita-saude/lotes` (CPFs em lote) e via oficial do recibo (CPF completo). | Antes do primeiro dado real (Portão B). De preferência já na próxima rodada, porque é trabalho mecânico |
| **R3** | **Prontuário de área sensível com MFA recente condicional.** A regra 2 pede MFA recente "para abrir prontuário sensível". Exigir isso em `GET /pacientes/:id/prontuario` e `GET /atendimentos/:id` para qualquer registro obrigaria o profissional a repetir o MFA a cada 15 min o dia todo, um atrito que leva a contornos. O recomendado: exigir MFA recente **quando** o atendimento ou a seção pertence ao compartimento de psicologia/área sensível. Para isso o serviço precisa receber `mfaEm` (hoje `RequestContext` não carrega o campo) e expor um `exigirMfaRecente(ctx)`, chamado depois do porteiro do vínculo e auditado como em B2. Atendimento comum fica só com MFA de sessão. | Antes do Portão B |
| **R4** | **Teste de inventário das rotas marcadas.** Um teste que percorre os controllers e compara a lista de handlers com `MFA_RECENTE_KEY` contra uma lista esperada, para que tirar o decorator de uma rota quebre o CI. Hoje a custódia não tem nenhum teste RLS de MFA. | Junto com R2 |
| **R5** | **Trilha dos eventos de MFA com o provedor real (D4):** cadastro e remoção de fator, verificação ok e falha, bloqueio após 5 falhas em 15 min (Redis), **reset com justificativa obrigatória** e quem fez, recusa `mfa_obrigatorio` em rota comum (com amostragem ou agregação por sessão, para não inundar a trilha) e alerta ao admin no reset. | PR de integração da D4 |
| **R6** | **Contrato do adaptador real.** `mfaEm` vem **somente** da sessão guardada no servidor e é atualizado no step-up. Nunca vem de cabeçalho, corpo ou claim não verificado. Sem informação do provedor, vale `null` (falha fechado), ao contrário do padrão "agora" da sessão fictícia. Trocar de clínica, de perfil ou de senha zera ou reavalia o MFA. Incluir um teste de contrato para todo `AuthProvider`: sem fator, `mfaEm === null`. | PR de integração da D4 |
| **R7** | **Sessão fictícia com MFA "agora" por padrão:** aceitável. O provider só sobe em development/test e há teste de que produção lança erro. O risco é a suíte esconder regressões de MFA, e por isso os testes de rota sensível devem passar `mfaEm` explícito, como o `mfa.rls.test.ts` já faz. Registrar no §17 que esse padrão **não** é contrato para o provedor real (ver R6). | Junto com B1 |
| **R8** | **`GET /sessao` com `mfaEm`:** aceitável. É dado pessoal do **próprio** usuário (horário em que se autenticou), devolvido a ele mesmo na própria sessão. Não é dado de paciente e não serve para enumerar contas. Por minimização, prefira devolver `mfaRecenteAte` (ISO) ou um booleano, que é o que o cliente precisa. O campo nunca vai para logs técnicos (§5), nem esta resposta. Hoje, admin, profissional e financeiro sem MFA recebem 403 até no `/sessao`. O cliente se orienta pelo `codigo`, o que é suficiente; só não pode haver caminho em que o 403 vire tela em branco. | Opcional; antes da tela de login real |

## Itens conferidos sem achado
- **Data no futuro:** recusada na janela recente (falha fechado). Na obrigatoriedade simples, uma data no futuro conta como "fez MFA". Isso é aceitável, porque a presença do fator é o que importa ali. Com o provedor no mesmo processo (Better Auth), não há diferença de relógio. Se a D4 for Zitadel, tolerar no máximo 30 s.
- **Ordem no guard:** sessão (401), depois permissão (403), depois MFA (403). A recusa vem antes de qualquer leitura. A clínica continua vindo só da sessão (regra 1).
- **Isolamento por clínica, criptografia, segredos, dados reais:** o PR não toca nesses pontos. Os testes usam dados fictícios (`Paciente Ficticia MFA`, telefone 119000000xx).
- **Portal do paciente:** usa `PortalGuard` e continua fora desta política, como manda a regra 5 do memo.

## O que vai para a trilha agora × o que espera a D4
- **Agora (B2):** recusa por MFA nas rotas com `@ExigeMfaRecente()`, depois nas rotas de R2 e na checagem condicional de R3.
- **D4 (R5):** os eventos do próprio fator (cadastro, verificação, falha, bloqueio, reset com justificativa), a recusa em rota comum e o alerta de reset.

## Nota do Maestro (03/11/2026)

- **B1 (feita):** `recepcao` entrou em `PERFIS_COM_MFA_OBRIGATORIO`, agora com todos os perfis. O comentário, o §17 e os testes foram ajustados.
- **B2 (feita):** em rota com `@ExigeMfaRecente`, o `SessaoGuard` grava a recusa na trilha antes do 403. A linha tem ação `read`, escopo `mfa_denied` e metadata `{ op: "<Controller>.<handler>", reason, target_id? }`, na clínica da sessão. Se a gravação falhar, a recusa continua e o log não leva dado. Teste RLS confere a linha e confere que a recusa em rota comum não grava.
- **R1 (feita):** a janela é por rota (`@ExigeMfaRecente(janelaMs)`), e a exportação total usa `MFA_RECENTE_EXPORTACAO_MS` (5 min).
- **R2 (feita):** o decorator foi posto em todas as rotas listadas, 24 no total, contando notas privadas e custódia.
- **R3:** está na fila, antes do Portão B.
- **R4 (feita):** a análise anota os decorators nossos (`marcas`), e a lista fechada `ROTAS_COM_MFA_RECENTE` quebra o CI se alguém tirar ou puser o decorator sem atualizar a lista. A custódia ganhou teste RLS de MFA.
- **R5 e R6:** estão na fila, como condição da D4.
- **R7 (feita):** os testes de rota sensível passam `mfaEm` explícito, e o §17 diz que o padrão da sessão fictícia não vale para o provedor real.
- **R8 (feita):** `GET /sessao` devolve só `mfaRecenteAte`.

## Re-revisão do Guardião (03/11/2026, commit `e7a8c4c`)

### Veredito: **APROVADO com ressalvas.** O veto está levantado.

**Verificação:** `npx vitest run src/modules/auth test/cobertura-auditoria` deu 34/34 verdes e o `tsc --noEmit` está limpo. O `mfa.rls.test.ts` não rodou (não há Postgres local); a confirmação dele fica com o CI.

- **B1 (resolvido):** `PERFIS_COM_MFA_OBRIGATORIO` agora tem os quatro perfis. O comentário e o §17 estão corretos.
- **B2 (resolvido):** a recusa em rota com `@ExigeMfaRecente` é gravada antes do 403, na clínica da sessão.
  - O metadata leva só ids: `op` (Controller.handler, até 64 caracteres), `reason` e `target_id` (só se for UUID). Não vai `mfaEm` nem conteúdo.
  - Se a gravação falhar, a recusa continua (falha fechado), e o log leva só o nome do erro.
  - A recusa em rota comum não grava, como pedia R5.
- **R1 (resolvido):** janela por rota, e a exportação total usa `MFA_RECENTE_EXPORTACAO_MS` (5 min), o que fecha com a cláusula 16.2 do DPA.
- **R2 e R4 (resolvidos):** são 24 rotas, presas à lista fechada `ROTAS_COM_MFA_RECENTE`, conferida pelo teste de cobertura. A custódia ganhou teste RLS. A lista confere com R2.
- **R7 e R8 (resolvidos).**

### Risco da gravação antes do 403 (pergunta do Maestro)
- **Contenção na cadeia da trilha (real, limitada):** a trilha é encadeada com `pg_advisory_xact_lock('audit_chain:' || tenant_id)` (migração 0005). Toda linha de recusa disputa o mesmo lock que **todas** as gravações auditadas daquela clínica. Uma sessão válida, ou um cliente com bug que repete a chamada em laço, consegue:
  - deixar lentas as escritas legítimas da própria clínica;
  - inflar a trilha, que tem retenção longa (§5: até 20 anos para o acesso a prontuário).
- **Por que não bloqueia:** exige uma sessão autenticada daquela clínica, então não há vetor anônimo, e o 401 vem antes. O efeito fica restrito à própria clínica, porque o lock é por tenant e o RLS isola. A transação é curta. E não há dado real antes do Portão B.
- **Não inverter a ordem:** responder o 403 antes e gravar depois, de forma assíncrona, perderia a garantia de que a tentativa ficou registrada. A ordem atual está certa.

### Novas ressalvas
| # | Ressalva | Prazo |
|---|---|---|
| **R9** | **Limitar a gravação de recusas por MFA.** Gravar no máximo 1 linha `mfa_denied` por (usuário, `op`, `reason`) a cada 60 s, com contador no Redis e chave prefixada pela clínica. As repetidas dentro da janela incrementam um contador, que vai em `metadata.repeticoes` na próxima linha gravada. Junto disso, colocar rate limit por sessão nas rotas sensíveis, por exemplo 30 recusas por minuto, e depois 429. Um volume anômalo de `mfa_denied` dispara o alerta do §5. Teste: 100 recusas seguidas geram ≤ 2 linhas. | Antes do Portão B (junto com o rate limit do Redis da regra 4) |
| **R10** | **O cliente evita a recusa:** o front usa `mfaRecenteAte` para pedir o código **antes** de chamar a rota sensível. Assim, o uso legítimo não gera linhas `mfa_denied`, e a trilha fica com o sinal útil (sessão roubada) em vez de ruído. Atenção: `mfaRecenteAte` usa a janela padrão de 15 min, então a tela da exportação (5 min) precisa sempre pedir o código de novo. | Na ligação das telas com a API |

**R3, R5 e R6** continuam como condição antes do Portão B e da integração da D4, sem mudança.

### R9 (03/11/2026)

**Feita.** O `SessaoGuard` conta as recusas no store do rate limit, com chave em hash e janela de 60 s. A primeira recusa por usuário, rota e motivo vai para a trilha. Acima de 20 recusas do usuário na janela, a resposta é `429 limite_de_recusas_mfa` e entra um único `anomaly_alert` (`mfa_recusas_por_usuario`). Se o store estiver indisponível, a linha é gravada. Teste RLS: 23 tentativas geram 20 respostas 403 e 3 respostas 429, uma linha de recusa e um alerta.

**R9 conferida (03/11/2026, PR #124, commit `afc8eaa`): DE ACORDO.** Na janela de 60 s, cada usuário grava 1 linha por rota e motivo, o que dá no máximo cerca de 48 linhas/min por usuário. Acima de 20 recusas, a resposta vira 429 e sai 1 `anomaly_alert` por janela. A chave do contador vai em sha256 e é prefixada pela clínica. Se o store cair, a linha é gravada e o 429 não acontece: a trilha continua garantida, só o limite fica suspenso. Notas que não bloqueiam: (a) as repetições dentro da janela não deixam os `target_id` seguintes nem o contador `repeticoes` na trilha; o alerta cobre o volume, mas registrar a quantidade de alvos distintos fica para R5. (b) O teste R9 pode falhar de vez em quando: o `MemoryRateLimitStore` usa uma janela fixa compartilhada entre chaves, e o laço pode atravessar a virada da janela. Para estabilizar, injetar o relógio ou um store próprio no teste.

_Nota do Maestro sobre o teste da R9: a janela do contador em memória começa na primeira recusa do arquivo (teste B2), e o R9 roda segundos depois. O vitest recarrega o módulo por arquivo, então o contador não é compartilhado. Cruzar a virada exigiria 60 s entre os dois testes. Aceito como está._

### R3 (03/11/2026)

**Feita em `eng/mfa-psicologia`.**

- O `RequestContext` ganhou `mfaEm`, vindo da sessão. Nos jobs fica ausente e conta como sem MFA.
- `exigeMfaRecente(registro)` vale para o compartimento de psicologia.
- Em `obter`, `salvar`, `finalizar`, `adendo` e `versoes` de atendimento de psicologia, sem MFA recente a resposta é `403 mfa_recente_obrigatorio`. A recusa é auditada por `comNegacaoAuditada`, que passou a aceitar os motivos `mfa_*`.
- No histórico, o atendimento de psicologia vem oculto (`motivoOculto: mfa_recente_obrigatorio`), sem 403, e o resto aparece.
- Teste RLS em `test/mfa-psicologia.rls.test.ts`.
- A área sensível do profissional (`sensitive_area`) fora da psicologia, se o Guardião quiser incluir, fica para uma ressalva nova.

**R3 conferida (03/11/2026, PR #125, commit `bdd2dbe`): VETADO, com uma correção de ordem.**
- **De acordo:** `mfaEm` chega ao `RequestContext`; sem sessão (jobs), conta como sem MFA, o que falha fechado. A checagem vale em ver, salvar, finalizar, adendo e versões. No histórico, o registro de psicologia vem oculto (`motivoOculto: mfa_recente_obrigatorio`) e o resto aparece. Os motivos `mfa_*` são auditados como `clinical_access_denied`.
- **B3 (bloqueia): a checagem de MFA roda cedo demais e revela o compartimento.** Em `obter`, `salvar`, `finalizar`, `adendo` e `versoes`, `conferirMfaDoRegistro` roda **antes** de `exigirConteudoClinico`. Um profissional **sem vínculo de cuidado** e com MFA antigo recebe `mfa_recente_obrigatorio` num atendimento de psicologia e `sem_vinculo_de_cuidado` num atendimento geral. Ou seja, descobre pela resposta que aquele paciente faz psicoterapia, um dado C4 que hoje ele não consegue obter. A trilha também grava o motivo errado. **Correção:** chamar `conferirMfaDoRegistro` depois de `exigirConteudoClinico` e, onde houver, depois de `podeVerConteudo`/`sigilo_psicologia` (adendo e versões). Assim, só quem já poderia ver o conteúdo é perguntado pelo MFA. Teste RLS: um profissional sem vínculo, com MFA antigo, recebe `sem_vinculo_de_cuidado` tanto em psicologia quanto em atendimento geral.
- **`POST /atendimentos` (abrir psicologia):** não precisa exigir MFA recente. Abrir não lê conteúdo, o DTO devolvido já sai oculto sem MFA recente e o primeiro `salvar` vai exigir. De acordo como está.
- **Área sensível fora da psicologia:** hoje o modelo só tem os compartimentos `geral` e `psicologia` (`RECORD_COMPARTMENTS`), então não há outra área a marcar agora. **R11:** quando surgir compartimento sensível novo (por exemplo psiquiatria, saúde sexual/IST, sigilo de adolescente no registro), ele entra em `exigeMfaRecente` no mesmo PR que o criar. Um teste deve falhar se `RECORD_COMPARTMENTS` ganhar valor sem decisão explícita de MFA. Prazo: junto com cada compartimento novo.
- **R12:** a exportação total (G2) e qualquer job que monte o prontuário rodam sem `mfaEm` e, por isso, **ocultariam a psicologia sem avisar**. O pacote da G2 precisa de um caminho próprio, autorizado pelo MFA de 5 min da rota (com aprovação do RT), que não passe por `montar`/`historico`. Ou, no mínimo, precisa de um teste de que o pacote sai completo e marcado no manifesto. Prazo: antes da rota da G2.

#### Nota do Maestro sobre a R3 conferida (03/11/2026)

- **B3 (feita):** `conferirMfaDoRegistro` passou para depois de `exigirConteudoClinico` e das travas de autor e de sigilo, nas 5 operações. Também só confere quem pode ver o conteúdo (`podeVerConteudo`). Teste RLS: o profissional sem autoria nem vínculo recebe a mesma resposta com MFA antigo e com MFA recente, e nunca um código `mfa_*`.
- **R11 (feita):** `MFA_RECENTE_POR_COMPARTIMENTO` é tipado pelo enum, então compartimento novo sem decisão não compila. O teste confere a lista contra `RECORD_COMPARTMENTS`.
- **R12:** a exportação lê as tabelas direto. O teste estático (`mfa-compartimentos.test.ts`) impede `tenant-export.ts` de depender da regra de tela. A rota HTTP da G2 com 5 min está na fila.
- **`POST /atendimentos`:** fica sem MFA recente, como o parecer aceitou.

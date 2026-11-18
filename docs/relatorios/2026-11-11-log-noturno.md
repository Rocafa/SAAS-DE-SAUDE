# Log noturno: 10 para 11/11/2026

> Maestro, trabalhando sozinho enquanto os sócios dormem. Branch `eng/better-auth-fila-noturna`, sobre o #176. Cada entrada traz o horário (UTC-3), o que foi feito e o resultado. Regras seguidas: sem merge sem a aprovação do outro sócio, sem `--admin`, sem mexer nas configurações do repositório nem da conta, e o Guardião revisa antes de pedir a revisão do sócio.

## Plano da noite

1. **G3 completa:** a anonimização zera o HMAC dos convites aceitos pela conta em **todas** as clínicas, não só nas que têm vínculo e na de origem.
2. **R4 do 3a:** teste pela HTTP de que a resposta leva só o `Set-Cookie` da sessão.
3. **Marca de reuso no login** gravada antes da conferência: estudar se dá para mover sem abrir corrida.
4. Conferir as aprovações do @Lopesloro e mesclar o que estiver aprovado (sem `--delete-branch` quando houver PR em cima).
5. Abrir o PR, passar pelo Guardião, corrigir o que ele apontar e atualizar este log.

## Entradas
- **G3 completa:** a anonimização passa por todas as clínicas pela lista do agendador. Teste na bancada com um convite aceito numa clínica de onde a pessoa já saiu.
- **R4 do 3a:** teste HTTP com o `SessaoGuard` real, cobrindo a rota comum (um `Set-Cookie`, só o da sessão, com os atributos) e a rota de polling (nenhum `Set-Cookie`).
- **Marca de reuso no login:** analisei e mantive a ordem atual (arquitetura §14.8). Mudar abriria a corrida do código repetido.
- Verificação local: `tsc`, `eslint` e 1133 testes de unidade passando. A bancada RLS roda no CI.
- **Guardião vetou o #177 (V1):** o `withTenant` recusa o `USUARIO_SISTEMA`, então o laço novo nunca rodava. O CI confirmou, com falha no RLS. Corrigido com o usuário de sistema dos jobs, mais o evento por clínica que falha, a trilha com ator sistema, a lista compartilhada e as notas na arquitetura (V2 e V3).
- **Reconferência do #177:** aprovado, valendo com o CI verde. Corrigi R1 (comentário do `withTenant` fora do lugar) e R2 (alarme por clínica limitado a um por minuto).
- **CI do #177:** falhou por falta de conexões (`PoolExhaustedError`) em todos os testes depois do R4. O app de teste do R4 fechava, ao terminar, a conexão compartilhada da bancada (o `TenantDatabase` fecha o handle no shutdown). Agora o R4 usa uma conexão só dele.
- **CI do #177 verde (16/16)** depois da correção da conexão. Revisão pedida ao @Lopesloro.
- **Aprovações:** nenhuma nova do @Lopesloro. Nada foi mesclado; o #166 continua aprovado por mim, à espera do merge dele.

## Resumo da noite

| PR | Situação |
|---|---|
| #175 (fila do #173) | Guardião aprovado com ressalvas corrigidas, CI 16/16, aguardando o sócio |
| #176 (ressalvas antigas e R3/R5 do 3a) | Guardião aprovado com ressalvas corrigidas, CI verde, aguardando o sócio |
| #177 (fila noturna) | Vetado (V1) e corrigido; reconferência aprovada; CI 16/16; aguardando o sócio |

## Parei aqui porque

A pilha já tem 11 PRs em cima do #149, todos esperando a revisão do @Lopesloro. O que sobra na fila é desenho ou depende de terceiros, e acrescentar mais código em cima da pilha só aumentaria o que ele precisa revisar:
- **Função estreita para a anonimização (V3 do #177):** o `team_invites` tem RLS forçado; para isso, é preciso um índice interno mantido por gatilho, como a 0043. É desenho para o Guardião.
- **Derivação de chaves por uso (HKDF) da `RATE_LIMIT_HASH_KEY`:** muda todos os HMACs gravados, então precisa de um plano de migração.
- **Conta do fundador no provisionamento:** entra no desenho do provisionamento.
- **D15 (B2 e queda do Redis):** decisão dos sócios.
- **B3, B4, B5 e B8:** dependem de AWS, advogado e encarregado.

## Para os sócios ao acordar

1. @Lopesloro: revisar a pilha de baixo para cima (#149 primeiro), além do #153, do #154 e do #172. Mesclar o #166.
2. Os dois: decidir o D15 (`docs/00-governanca/memos/D15-login-real-egresso-e-falha-do-redis.md`).

## Continuação (pedido de seguir até o reset)

- Deixei uma retomada agendada para 04:20 (`retomar-plataforma-saude-madrugada`), salva no modo sem pedir permissão, para não travar como a das 03:45 de ontem.
- **V3 do #177 (função estreita):** migração 0073 com o espelho `identidade.convite_aceito` (só ids, trigger em `team_invites`, padrão da 0064). A anonimização lê daí só as clínicas da pessoa e apaga as linhas no fim; a varredura de todas as clínicas saiu. Fica num PR separado em cima do #177, que já estava aprovado.
- **Guardião vetou o #178 (V1):** o espelho ficava guardado enquanto a conta existisse, mas só tem uso por 30 dias. Corrigido: o trigger apaga a linha quando o HMAC é zerado, e entraram os testes de retenção, de falha no meio e de que o `app_user` não lê o espelho (V2).
- **#178:** reconferência aprovada e CI 16/16. Revisão pedida ao @Lopesloro. Fila: teste em que só uma clínica do espelho falha; apagar o espelho quando a clínica for eliminada.
- **Fila do #178 (teste):** só uma das clínicas do espelho falha. A outra é limpa, a que falhou continua no espelho e a nova tentativa esvazia.
- **V3 do #178:** a eliminação de clínica ainda não existe no código (depende do D8). O requisito de apagar os espelhos `identidade.convite_aceito` e `identidade.vinculo` entrou na `fila.md`, ao lado do G4.
- CI do #178 verde (16/16) com o teste novo.
- **Desenho para o Guardião:** `docs/04-arquitetura/derivacao-da-chave-de-hmac.md`, sobre a separação por uso da `RATE_LIMIT_HASH_KEY` com HKDF. Inclui o plano de migração, com leitura dupla de 72 h para os convites, e três perguntas. Ainda sem código.
- **Desenho do HKDF:** aprovado com ressalvas. A tabela de usos foi corrigida (a vigilância usa ids; o IP da sessão é o pseudônimo do log), ficaram cinco rótulos com a versão no `info`, e a leitura dupla só vale para rotações futuras. Virou o item **B9** do checklist, antes do B8. O código fica para a próxima rodada.
- **Código do B9 (eng/hmac-por-uso):** `chaveDeHmac(uso)` por HKDF com cinco rótulos; todos os usos passaram a ela; o IP do rate limit ganhou prefixo próprio e a chave `rl:v3`; o user-agent da sessão tem chave própria. Testes: chaves distintas, vetor conhecido, produção sem raiz e nenhum arquivo de `src` importando a raiz. Runbook, `logs-de-seguranca.md` e checklist atualizados. 1137 testes de unidade passando.
- **Guardião vetou o #179:** faltavam dois testes (origem em produção sem raiz; rótulo fora da lista) e o user-agent podia cair em silêncio na chave do bloqueio. Corrigido, junto com N1 a N4. 1139 testes de unidade passando.
- **#179:** reconferência aprovada e CI 16/16. Revisão pedida ao @Lopesloro. O B9 do checklist fica pronto quando a pilha for mesclada.

## Resumo da continuação (até cerca de 03:30)

| PR | O que faz | Situação |
|---|---|---|
| #177 | Anonimização nas clínicas onde a pessoa saiu e teste HTTP do cookie | Vetado, corrigido e aprovado; CI 16/16 |
| #178 | Espelho dos convites aceitos (0073), que tira a varredura de todas as clínicas | Vetado (retenção), corrigido e aprovado; CI 16/16 |
| #179 | Chave dos HMACs separada por uso com HKDF (item B9 do checklist) | Desenho aprovado; código vetado, corrigido e aprovado; CI 16/16 |

- O memorando D15 e o desenho do HKDF estão prontos. O checklist ganhou o item B9.
- Uso do limite ficou em 67%. Parei de empilhar código e atualizei a retomada das 04:20: ela só faz merges, se houver aprovação, e confere conflitos.
- **Para os sócios:** o @Lopesloro revisa a pilha a partir do #149, e os dois decidem o D15.

## Retomada das 04:20

- Conferi os 17 PRs (pilha #149 → #179, os avulsos #153, #154 e #172, o #174 e o #166). Nenhum foi aprovado pelo @Lopesloro, então não houve merge.
- Todos estão `MERGEABLE`, sem conflito com a base. Não precisei mexer em nenhuma branch.
- O #166 (do sócio) continua aprovado por nós; o merge é dele. O #174 segue travado até o checklist B1–B9.
- Não empilhei código novo. A fila que sobrou depende do D15, de AWS ou do advogado.

## Rodada da tarde (11/11, a partir das 18:57)

O limite de 5 h zerou (2% usado; 26% na semana). Continuo sem empilhar código na pilha do login e uso o tempo para destravar o sócio.

- **Pilha (#149 → #179) e avulsos (#153, #154, #172):** nenhum aprovado pelo @Lopesloro; todos `MERGEABLE`. Nada a mesclar.
- **#169 (nosso, sobre a branch do #166):** o CI falhou no Trivy por duas CVEs do zlib (76844 e 85091). A correção (#163) entrou na `main` depois que a base do #169 foi criada. O Trivy do #179 passou hoje, então resolve sozinho quando o #166 for mesclado e o #169 apontar para `eng/better-auth-base`. Não mexi na branch do sócio.
- **#170 (nosso, sobre a branch do #158):** o e2e "horário ocupado" falhou às 22:31 de Brasília, quando a data em UTC já é o dia seguinte. É o bug de fuso que o #172 corrige. Pedi nova execução só do job que falhou, num horário em que as duas datas coincidem.
- **#143 (do sócio), revisão comentada, sem aprovar:** os casos (b) e (d) da R5 passam sem provar nada. O helper `avisos()` lê `clinical_notices` sem `userId`, e desde a 0040 essa leitura só mostra os avisos endereçados a quem está na sessão (`notices_recipient_select`), então o resultado é sempre `[]`. O caso (a), que ficou como `todo`, provavelmente tem a mesma causa: o fundador também é admin. Mandei a correção: conferir o número que a função devolve e ler os avisos como cada destinatário.
- **#157 (do sócio), revisão comentada, sem aprovar:** o plano do E4 está pronto. A leitura da concorrência precisa de URL e data nos preços e de fonte para os números do Reclame Aqui (regra 6 do `AGENTS.md`); sugeri também arredondar o valor do caso individual da Feegow.
- **#158 (do sócio, prontuário no front):** enviado ao Guardião (dado de saúde).
- **#151 (Dependabot, 11 atualizações menores, CI verde):** entra **depois** da pilha do login. Os dois mexem no lockfile, e mesclar o #151 antes obrigaria a refazer o lockfile da pilha inteira.
- **#170:** a nova execução passou. A falha era só o fuso, e o #172 corrige a causa.
- **Conferência extra do #143:** o teste da `main` (`vinculo-cruzado.rls.test.ts`) lê os avisos pela rota `GET /avisos` como o admin, então a funcionalidade da 0063 está provada. O verde falso é só do teste novo do #143.
- **#104 (do sócio, só documentação): aprovado.** A aprovação de 03/11 tinha caído quando a branch foi atualizada, e o pedido dele de 05/11 estava sem resposta. Duas notas sem bloqueio (a S1 já foi decidida pelo #142; uma frase antiga sobrou). O merge é dele.
- **#55 (do sócio, relatório histórico da rodada 8): aprovado**, com uma nota (o item 4 da §5 contradiz a tabela).
- **Pedidos do sócio que dependem do Matheus:** fechar o #36 (PoC da D4, já decidida) e os #45, #46 e #47 (superados pelo #86, já na `main`). Não fechei, porque o pedido veio num comentário do PR e não de você.
- **#158 (do sócio, prontuário no front): o Guardião VETOU** (`revisoes/2026-11-11-codigo-front-prontuario-158.md`). O sigilo está certo, mas duas rotas não funcionam contra a API real, e conferi as duas no código:
  - V1: `obterRegistroDoAgendamento` chama `GET /atendimentos/:id` com o id do agendamento, recebe sempre 404 e abre vazio um registro que já existe;
  - V2: o `PUT` vai sem `versaoBase`, então todo salvamento leva 400;
  - V3: os mocks aceitam corpos que a API recusa (verde falso).
  Os detalhes foram para o PR.
- **#116 (postgres.js 4.0.0, aprovado pelo sócio, liberado a partir de 12/11): fica para depois da pilha do login.** Ele troca o driver e mexe no `pnpm-lock.yaml`, como o #149. Mesclar o #116 antes obrigaria a refazer o lockfile e o CI nas 12 branches da pilha, e misturaria duas mudanças grandes no mesmo intervalo. O patch da 3.4.9 continua cobrindo o bug.
- **Retomada agendada para 12/11 às 07:00** (`retomar-plataforma-saude-12-11`). Ela mescla só o que o @Lopesloro aprovar, resolve conflitos nos nossos PRs e reconfere o #143, o #157 e o #158 se ele tiver respondido. Desta vez a tarefa ficou no modo de permissão padrão e pode parar pedindo aprovação. Para rodar sem pausas, ajuste o modo na tarefa, no app.
- Nenhum código novo empilhado. Uso: 2% da janela de 5 h no início desta rodada; 26% na semana.
- **#36, #45, #46 e #47 fechados**, sem merge e com as branches preservadas. O pedido foi do @Lopesloro, num comentário de 05/11, e o Matheus autorizou. O #36 era a PoC da D4, decidida pelo #142. O #45, o #46 e o #47 entraram na `main` pela pilha integrada do #86. Deixei um comentário com o motivo em cada um.
- **Ensaio do merge completo** ([relatório](2026-11-11-ensaio-de-merge.md)). Juntei sobre a `main` a pilha inteira, os avulsos #153, #154 e #172, o #166 e o #169. Tipos, lint e testes de unidade da API (1147) e do front (412) estão verdes. Dois achados:
  - a trava de logs do #154 reprovava o log do job da plataforma, que vem da pilha. Corrigi no próprio #154 (`192c707`) e mandei para conferência do Guardião;
  - o #166 conflita com a pilha em dois arquivos. O conflito é simples, e a resolução está no relatório e foi comentada no #166.
- **Guardião aprovou o ajuste da trava no #154**, com uma ressalva que não bloqueia: liberar `v` no arquivo inteiro é largo demais. **Pendência para depois da pilha:** extrair `contagensParaLog(resultado): string` no `executor-de-jobs.ts`, liberar só esse nome e tirar `v` e `resultado` da lista. O adendo do Guardião foi commitado no parecer do #154.

## Retomada de 12/11 (a partir das 13:40)

- A tarefa agendada das 07:00 não deixou registro: não rodou (app fechado ou parada em pedido de permissão).
- **O @Lopesloro revisou a pilha na noite de 11/11:** aprovou o #149, #152, #159, #171, #175, #176 e #179, e mesclou o #166 e o #169 na base.
- **#149 MESCLADO na `main`** (`fe98353`, 12/11 13:41). É a base do login real com Better Auth. Antes do merge, redirecionei o #152 para a `main`; a branch não foi apagada.
- **#152 em conflito com a `main`**, como o ensaio tinha previsto (o #166 e o PR 2 mexem no mesmo ponto). Resolvi com a mesma solução do ensaio (`a2661f1`): tipos, lint e 1128 testes de unidade verdes. Como a `main` descarta a aprovação quando entra commit novo, **o #152 precisa ser reaprovado**.
- **Propagação pela pilha:** levei a correção de branch em branch, até o #179 e também o #174. Dois tropeços, os dois corrigidos:
  - no #159 o conflito era só de import;
  - o script que juntava os imports descartou o `auditLog` onde a branch já importava `tenants` do mesmo módulo (#176 a #179). O typecheck do topo pegou o erro, que corrigi no #176 (`import { auditLog, tenants }`) e propaguei.
  - No topo: tipos e lint limpos, 1142 testes de unidade verdes. Nenhuma branch ficou com marcador de conflito.
- **#152:** CI 16/16 verde depois da resolução. A única pendência é a nova aprovação do @Lopesloro, que pedi no PR com a explicação. Deixei dito também que, à medida que cada PR passar a apontar para a `main`, o #155, o #156, o #173, o #177 e o #178 vão precisar da revisão dele.
- **Alerta do Dependabot na `main`** (GHSA-g3hv-75wg-m249, gravidade média): `minimatch` 10.2.6, menor que a 11.0.1 corrigida, com risco de negação de serviço. Vem só do ESLint e do typescript-eslint, que são ferramentas de desenvolvimento e não entram na imagem da API. Não é urgente. Resolver depois da pilha (atualização do ESLint ou override), junto com o #151.
- **#170 fechado** (era nosso; branch preservada). Ficou superado: o sócio tirou o salvamento do modo http no #158 (`e7fd34a`), então não há mais medida a corrigir. O que o #170 apontava ficou registrado no comentário de fechamento, para quando o salvamento voltar.
- **#158, reconferência do Guardião: veto retirado, APROVADO COM RESSALVAS.** V1, V2 e V3 foram resolvidos de verdade. Antes do merge, sem nova conferência, faltam:
  - C1: a mensagem "Use a demonstração" empurra evolução real para o modo fake;
  - R5a: um comentário de teste ficou desatualizado.
  
  Comentei no PR e aprovo quando ele subir os dois. As ressalvas R2 a R4 e N2 ficaram na issue #180.
- **#143 e #157:** o sócio ainda não mexeu desde as nossas revisões.
- **Checagem automática a cada 2 h** (`pilha-login-a-cada-2h`, das 08:00 às 22:00). Ela mescla o que o sócio aprovar, traz a `main` para o PR de cima, roda tipos, lint e testes, e pede a nova aprovação. A tarefa de 12/11 às 07:00, que não rodou, foi desligada para não duplicar.
- **#189 aberto: override do `minimatch` para 11.0.1 ou acima** (alerta do Dependabot GHSA-g3hv-75wg-m249). O pacote vulnerável vem só do ESLint. O ESLint 10 funciona com a 11: o lint passa 4/4 e uma sonda com erro continua reprovada. Tipos limpos e testes verdes (API 1122, web 411). Como mexe no lockfile, entra depois da pilha, antes do #116 e do #151.
- **Checagem a cada 2 h recriada** (`pilha-login-merges-2h`), agora salva no modo que não pede permissão e já com o #189 na ordem de merge. A anterior foi apagada.

## Continuação de 12/11 (14:30)

- O sócio ainda não fez nada novo. O #152 espera a reaprovação.
- **Teste instável do TOTP achado e corrigido.** O CI do #159 falhou no "login com TOTP" (`INVALID_CODE`). A causa estava no teste, não no login: o `proximoCodigo` da bancada entregava 0, +1 e -1 relativos à hora da chamada. Quando a janela de 30 s virava no meio do teste, o "-1" caía no código já usado no cadastro, e a proteção contra reuso recusava, corretamente. A chance era de uns 7%. O teste de reuso tinha o risco inverso: supunha que o código do período atual era o do cadastro. Correção no #152:
  - o helper passa a guardar os períodos usados e o último código entregue;
  - não entrega o código do período anterior nos 3 s finais da janela;
  - o teste de reuso repete exatamente o último código.
  
  Propaguei pela pilha (um conflito de justaposição no #156, resolvido). O topo passa em tipos e lint, e só esse arquivo usa o gerador de TOTP.
- **Avulsos #153, #154 e #172 atualizados com a `main`** (que já tem o #149). Sem conflito. Tipos, lint e testes passam nos três (1122, 1127 e 1122). Estão prontos para quando o sócio aprovar.
- **#152:** CI 16/16 verde com a correção do TOTP. Continua esperando a reaprovação.
- **#159 falhou de novo, agora por um caso que a minha correção abriu.** Num teste com três verificações seguidas, quando a terceira caía nos últimos 3 s da janela, o helper recusava o código do período anterior e ficava sem código livre. Corrigido no #152: nesse caso o helper espera a janela virar (no máximo 3 s), e no período seguinte o +1 está livre. Propaguei pela pilha sem conflito, e o topo passa no typecheck.
- **15:01 — CI verde em todos os 14 PRs** (pilha #152 → #179 e avulsos #153, #154 e #172), inclusive o RLS do #159 com a correção do TOTP. Nenhuma falha. Tudo está pronto para mesclar e só falta a aprovação do @Lopesloro:
  - reaprovar o #152;
  - aprovar o #153, o #154 e o #172;
  - revisar o #155, o #156, o #173, o #177 e o #178.
  
  A checagem a cada 2 h mescla o que ele aprovar.

## Checagem de 12/11 16:15

- Nenhum merge. O #152 continua sem a reaprovação (REVIEW_REQUIRED). Os avulsos #153, #154, #172 e o #189 também esperam aprovação. CI verde em todos.
- #158, #143 e #157: o sócio não subiu commit novo. Nada a aprovar.
- **#151 foi fechado pelo próprio Dependabot** (12/11 10:29): "as dependências podem ser atualizadas de outro jeito". Sai da fila do lockfile. Ficam o #189 e depois o #116 (que está DIRTY e vai precisar da `main`).
- **#174 estava vermelho no `terraform fmt`**: espaço a mais no alinhamento de `api_ambiente_obrigatorio` no `staging/app.tf`. Corrigi só o espaço (`1b3f34c`). O #174 continua fora da ordem até o checklist B1–B9.
- **D15, voto do Matheus (12/11):** pergunta 1, opção **D** (abrir o piloto sem a conferência de senha vazada, com a decisão escrita; A ou C antes da venda aberta); pergunta 2, sem preferência. Registrei no memorando e no item B2 do checklist. Falta o voto do @Lopesloro.
- **Roteiro do teste de fumaça do login no staging (B8)** em `docs/04-arquitetura/roteiro-fumaca-login-staging.md`. São 14 passos, com as rotas reais da pilha, o resultado esperado e a evidência de cada um, só com contas fictícias e sem segredo em print ou log. Fica um ponto em aberto: como o convite e a recuperação chegam no staging depende do provedor de e-mail. O checklist aponta para o roteiro. Vou mandar o Guardião conferir.
- **O Guardião conferiu o roteiro do B8: aprovado com ressalvas** (vale como roteiro; não aprova a abertura). Ele corrigiu no próprio roteiro o que não batia com o código:
  - nomes da trilha: `member_invite`, `member_grant` e `session_logout_global`;
  - depois do logout global, a rota responde 401;
  - o evento de conta sem vínculo só sai no job;
  - o convite e a recuperação **não dependem de e-mail**: o token volta para o admin.
  
  Ele também acrescentou passos: o job de expurgo, a troca da versão do segredo (B1), o `verify-full` nos dois papéis, os atributos do cookie e os convites reemitidos depois do B9. E proibiu print, HAR e PR com token ou `totpURI`. Ficam em aberto: a anonimização (só pelo procedimento de suporte), o voto do D15, a queda do Redis (opcional) e uma segunda clínica fictícia.
- **Ressalva do Guardião sobre a trava de logs: resolvida sem PR novo.**
  - No #155, onde nasce o job da plataforma, o texto das contagens passou a sair de `contagensParaLog`, que usa o mesmo filtro da trilha e tem teste. Propaguei pela pilha sem conflito; o topo passa em tipos e testes.
  - No #154, a trava não libera mais `resultado` nem `v`. O autoteste da liberação por arquivo usa agora um caso que continua existindo.
  - Conferi a trava nova contra o código do #155: 9/9. Assim ela fica certa em qualquer ordem de merge.
- **Lacuna achada: nada no código chama `anonimizarConta`.** O RIPD diz que o suporte roda a anonimização a pedido do titular, mas não há rota, comando nem job, então um pedido do art. 18 não teria como ser atendido. Escrevi o desenho em `docs/04-arquitetura/anonimizacao-pelo-suporte.md`: um comando operacional avulso no ECS, com duas pessoas, um chamado `LGPD-` e uma trava de confirmação, cuja saída traz só ids e contagens, e o chamado e o operador na prova. Mandei para o Guardião antes de qualquer código.
- **Guardião aprovou o desenho da anonimização com ressalvas**: comando avulso no ECS, sem break-glass. Quem roda é provado pelo CloudTrail e por um grupo IAM nominal com MFA. A trilha da clínica leva o chamado `LGPD-` com ator sistema, mas não o operador. Entra **antes da abertura, como B10**. O parecer apontou defeitos no próprio `anonimizarConta`:
  - a trilha registra o titular como ator;
  - repetir duplica a trilha;
  - um id inexistente "anonimiza" sem erro;
  - a falha numa clínica interrompe as outras.
  
  Também faltam: a conferência no banco em vez do `GET /sessao`, a saída só com código fixo, a tarefa sem `BETTER_AUTH_SECRET`, o prazo interno de 15 dias e o aviso às clínicas (art. 18 §6). Criei o B10 no checklist. Próximo passo: o código.
- **CI de toda a pilha verde depois da refatoração da trava** (12 PRs, zero falhas).
- **B10, código da anonimização pelo suporte**, na branch `eng/anonimizacao-suporte`, empilhada sobre o #179:
  - `anonimizacao.ts` recebe só os dois bancos e é idempotente: uma trilha por clínica, o evento só na primeira vez e `ANONIMIZACAO_REPETIDA` depois. Recusa conta inexistente sem evento. Cada clínica fica isolada, e o erro vem no fim. A trilha tem ator sistema e leva o chamado, nunca o operador.
  - Comando `ops/anonimizar-conta.ts`: trava de confirmação antes de escrever, saída de uma linha pelo Logger com código fixo, conferência no banco antes de dizer `ok`.
  - Log de segurança: o evento `ANONIMIZACAO_REPETIDA` e os campos `chamado` e `operador`.
  - Runbook novo, RIPD §5 e §5a, e o prazo do registro do pedido na matriz de retenção (5 anos, proposta).
  - Tipos, lint e 1149 testes de unidade verdes; os testes de RLS rodam no CI.
  - Ponto a confirmar com o Guardião: o `user_id` do titular entra na metadata da trilha. Sem ele, a prova não diz quem foi anonimizado.
  - O Terraform da tarefa avulsa (papel próprio, só os segredos de banco, grupo `ops-lgpd` com MFA) está com o agente de devops.
- **#190 aberto (B10), empilhado sobre o #179.** O Terraform da tarefa avulsa ficou pronto (`ops-anonimizacao.tf`):
  - papéis próprios, só os segredos de banco, com `precondition` contra qualquer outro;
  - grupo de rede sem Redis;
  - grupo `ops-lgpd` com MFA;
  - Deny explícito nos papéis de máquina.
  
  Como esta máquina não tem Terraform, quem valida é o CI. Ficam em aberto: SSO × usuário IAM (I1), overrides não limitados pelo IAM (CloudTrail e conferência a dois) e o alerta de uso do `RunTask`. O código foi para a revisão do Guardião.
- **Código do #190 revisado pelo Guardião: APROVADO COM RESSALVAS**, todas na infra. Ele aceitou o `user_id` do titular na metadata.
  - **R-A, achado importante, já corrigido:** a imagem é distroless e já começa com o `node`. O `command = ["node", "dist/main.js"]` da **tarefa da API no `app.tf`** virava `node node dist/main.js`, e a **API do staging não subiria** no primeiro dia. Corrigi a API (`["dist/main.js"]`) e a tarefa nova (programa fixo no `entryPoint`; o RunTask só troca os argumentos).
  - O checkov reprovava o grupo de rede da tarefa como "não ligado", mas ele é usado só no RunTask. Pulei a regra com o motivo escrito, no padrão do projeto.
  - Runbook: o override leva só os argumentos, o nome do contêiner foi corrigido, e o conferente checa o override no CloudTrail.
  - R-B (alarme a cada execução) e R-C (papel com MFA e `SourceIdentity` no lugar do grupo IAM) estão com o agente de devops.
- **#190:** o agente de devops fez a R-B (alertas por execução do `RunTask`, crítico se o override trouxer outra variável, troca de papel ou ECS Exec) e a R-C (o grupo virou o papel `ops-lgpd`, com MFA e `SourceIdentity`). O runbook foi atualizado. O fmt do Terraform pegou o alinhamento no `app.tf`, que corrigi. **CI do #190: 16/16 verde.**
- **18:10 — 92% do limite de 5 h.** Tudo commitado e enviado (16 worktrees conferidos). Relatório da rodada: [2026-11-12-rodada-36.md](2026-11-12-rodada-36.md). Retomada agendada para depois do reset.

## Checagem de 12/11 18:15

- Nada mudou: nenhum PR aprovado (#152, #153, #154, #172, #189 em REVIEW_REQUIRED, CI verde); o sócio não subiu commit no #158, #143 nem #157.

## Checagem de 12/11 21:20

- Nenhum merge: o #152 segue em REVIEW_REQUIRED (CI 16/16 verde). Os de cima (#159, #171, #175, #176, #179) têm aprovações antigas, de 11/11, mas só entram depois do #152.
- Avulsos #153, #154, #172 e #189: REVIEW_REQUIRED, CI verde. Nada a fazer.
- O sócio não subiu commit no #158, #143 nem #157. Nada para aprovar.
- **Novo: o CI do #174 (abertura) falhou** no job do Terraform, na trava do `api_segredos_obrigatorios`: "DATABASE_URL fora de api_segredos_obrigatorios" (run 43301229429, depois do merge das 20:31). O #174 não entra antes do B1–B9, então não bloqueia a pilha. Fica para a próxima rodada de trabalho.
- O #151 (Dependabot) foi fechado pelo próprio bot às 13:29 de 12/11. Sai da fila do passo 5; ficam #189 e #116.

## Checagem de 12/11 22:13

- Nada mudou desde as 21:20: nenhum PR aprovado, o sócio não subiu commit, e o #174 segue com o Terraform falhando.

## 13/11 (00:00)

- A retomada das 18:45 de 12/11 não rodou (parou pedindo permissão). As checagens de 2 em 2 h rodaram (18:15, 20:14 e 22:13), sem nada novo: o @Lopesloro não mexeu desde 11/11 à noite.
- O limite zerou: 12% da janela, 46% na semana.
- **Reconferência do #190 pedida ao Guardião** (R-A, R-B e R-C da infra).
- **Dependabot:** chegaram o #183 a #186 (ações) e o #188 (17 dependências). O #151 foi fechado pelo próprio Dependabot.
  - O #183 e o #185 falhavam no CodeQL: cada um subia só o `init` ou só o `analyze`, e os dois precisam estar na mesma versão.
  - Abri o **#191**, que sobe os dois juntos e cria o grupo `codeql` no `dependabot.yml` para isso não se repetir. Ele substitui o #183 e o #185.
  - O #184 e o #186 (ações) estão verdes. O #188 mexe no lockfile e fica para depois da pilha, junto com o #189 e o #116.
- **#190 aprovado pelo Guardião na reconferência (13/11):** R-A, R-B, R-C e R-D atendidas. Ficam em aberto, sem bloquear:
  - a ordem e o tamanho do `command` não são conferidos pelo EventBridge (risco baixo com o `entryPoint` fixo; dá para fechar depois com uma Lambda);
  - o SSO pode não conseguir assumir o papel com MFA, o que bloqueia e não abre; testar no primeiro uso, e em staging está aceito.
  
  Corrigi a N1: o runbook usa a rede própria da tarefa (output `ops_anonimizacao_rede`). O B10 no checklist passou a "código no #190, Guardião aprovado, CI verde; falta o sócio e a prova no staging".
- **D13, voto do Matheus (13/11): opção B** (só o staging até o piloto, ≈ US$ 180–260/mês, estimativa). Registrei no memorando e pedi o voto do @Lopesloro. Com a decisão, o staging destrava as provas B1, B3, B4, B8 e B10.
- **#192 aberto (para a `main`, fora da pilha): leitura do atendimento pelo agendamento** (item 1 da #180, que saiu do veto do Guardião ao #158). A rota `GET /atendimentos/do-agendamento/:agendamentoId` devolve o atendimento com a `versao` que o salvar exige, ou `null` se ainda não foi aberto.
  - Valem as mesmas regras do `GET` por id. O porteiro do vínculo roda antes de revelar se há atendimento. A trilha de leitura é gravada também sem atendimento.
  - De carona, fecha a R8 do #63: esta rota e o `GET /atendimentos/:id` passam a contar na vigilância de leitura.
  - Tipos, lint e 1122 testes de unidade verdes; cobertura da auditoria OK. Mandei para o Guardião.
  - É isto que destrava a fatia S1 do front do sócio.
- **#192 (atendimento pelo agendamento): o Guardião aprovou com ressalvas, e resolvi todas as necessárias.**
  - A rota `/versoes` também conta na vigilância, então a R8 do #63 fica completa nas três rotas de leitura.
  - Bancada nova prova o alerta `fichas_distintas` em cada uma das três rotas.
  - A rota nova entrou nos testes de MFA da psicologia.
  - Ajustes menores feitos. A R6, opcional, ficou de fora: o caso `null` não tem conteúdo e já fica na trilha.
- **#193 aberto (para a `main`): modelos do prontuário v2, a parte da API da #167**, que assumi na própria issue.
  - **Fisio:** diagnóstico e prognóstico, exames (COFFITO 414 art. 1º §1º IV e V) e próximos passos.
  - **TO:** modelo próprio (objetivo, atividades, desempenho, nível de assistência, plano; COFFITO 415). Registro aberto na versão 1 é finalizado pela regra da versão 1.
  - **Escalas:** faixa própria para Barthel, MIF (total, motora e cognitiva), Berg e NPRS. A COPM ficou fora (licença), e a psicologia continua sem instrumento.
  - **Guardião: aprovado.** Corrigi as duas condições: a versão do modelo num teste de bancada e as subescalas da MIF.
  - Ficam para depois: o supervisor do estagiário, o campo `instrumento` explícito e as medidas próprias da TO.
- **Desenho do supervisor do estagiário** (último item de backend da #167; COFFITO 414 art. 2º §1º), em `docs/04-arquitetura/supervisor-do-estagiario.md`, no branch do #193.
  - O cadastro ganha a marca de estagiário e o supervisor obrigatório.
  - O supervisor fica congelado no atendimento, entra no hash da finalização e na trilha.
  - Estagiário sem supervisor ativo não abre atendimento.
  - Ficaram quatro perguntas, entre elas se o supervisor precisa cofinalizar e como fica a psicologia. Mandei para o Guardião, sem código ainda.
- **Supervisor do estagiário: o Guardião VETOU o desenho v1, e com razão.** Ele conferiu no site oficial do COFFITO: a regra está no **art. 1º §2º** da Res. 414/2012 (o "art. 2º §1º" da #167 não existe) e exige a **assinatura** do supervisor, não só a identificação.
  - Confirmei por conta própria, na mesma fonte, que os incisos IV e V usados no #193 estão certos.
  - Corrigi a citação no PR #193 (com URL e data) e na #167.
  - Reescrevi o desenho como v2: cofinalização com segundo hash, CREFITO no cadastro, aceite do supervisor, vínculo "supervisão" só nos atendimentos do estagiário, trilha, exportação e retenção.
  - **Decisão dos sócios antes do código: a clínica do piloto tem estagiário atendendo?** Se não tiver, basta uma declaração no termo de adesão e um item no checklist, e o código entra antes da segunda clínica.
- **Conferi a Res. COFFITO 415/2012 (TO) no site oficial** (https://www.coffito.gov.br/nsite/?p=3178, 13/11/2026). Isso **corrigiu um erro meu no #193**: a TO também exige exames complementares (IV) e diagnóstico e prognóstico (V), e eu não tinha posto esses campos.
  - Acrescentei os dois na TO v2, com teste.
  - Desempenho e nível de assistência ficaram como escolha de produto, sem atribuir à norma.
  - A regra do supervisor (art. 1º §2º) é a mesma na TO, então o desenho v2 vale para fisio e TO.
  - O PR #193 e o desenho estão atualizados com URL e data.
- **#192:** o RLS falhou porque a rota nova não tinha "plano" no teste de auditoria de leitura (R4 do #119), que exige para cada rota auditada um caso que prove a linha de leitura. Acrescentei o plano. Os outros testes novos (vigilância e MFA) passaram.
- **CI:** #193 16/16 verde (com a TO corrigida). #191 15/15 verde: o CodeQL volta a funcionar com o `init` e o `analyze` na mesma versão.
- **#192: CI 16/16 verde** com o plano da auditoria de leitura.
- **Guia de revisão para o @Lopesloro** (`docs/relatorios/2026-11-13-guia-de-revisao.md`): os PRs abertos na ordem que destrava mais, com tamanho e situação, mais as três decisões pendentes (D13, D15 e o estagiário do piloto). O link foi para o #152.
- **#194 aberto (para a `main`): conselho e número de registro do profissional** (0074; COFFITO 414 e 415, art. 1º §1º VIII).
  - O cadastro da API não tinha onde guardar o CREFITO, que as normas exigem e o documento precisa. A tela já esperava o campo.
  - Migração com lista fechada de conselhos, formato restrito e os dois campos juntos ou nenhum.
  - Rota de admin com MFA. A trilha leva o conselho, nunca o número.
  - Exportação G2 1.25.0. Testes de unidade (1124) e bancada nova.
  - Também é pré-requisito do supervisor do estagiário. Mandei para o Guardião.
- **#194: o Guardião VETOU** (B1). O número novo sobrescrevia a identificação das evoluções já assinadas.
  - **Correção (0075):** o conselho e o número ficam **congelados no atendimento na assinatura, gravados pelo próprio banco** (trigger na transição para "assinado"). Antes de assinar, esses campos ficam nulos; depois, nada os altera.
  - O DTO e a exportação passaram a trazer o registro da assinatura, e há um teste de bancada que muda o cadastro depois de assinar.
  - Também resolvidas: o número exige ao menos um dígito, o COREN entrou na lista, e a documentação foi para a tabela certa.
  - Ficam anotados: o perfil fiscal tem outro campo de registro, a unificar, e o aviso ao profissional quando o número mudar. Pedi a reconferência.
- **#194, reconferência: o Guardião aprovou a correção do B1** (o banco congela o registro na assinatura), **mas achou um bloqueante novo (B2) criado por mim.** Ao editar a migração 0074 por um comando de shell, o `$` da expressão regular se perdeu e o SQL quebrou: o `db:migrate` do CI falharia.
  - Reescrevi a 0074 inteira pelo editor, sem passar pelo shell.
  - Fixei o código de erro esperado no teste do atendimento aberto.
  - Acrescentei um teste que restringe o sigilo de um atendimento já assinado sem mexer no registro congelado.
  - Anotei que os atendimentos assinados antes da 0075 ficam com o registro nulo.
  - Esta máquina não tem Postgres, então só o CI prova as migrações. Estou esperando o resultado.
  - **Lição:** SQL e código com `$` ou crase não se editam por `sed`/`node -e` no shell. Usar o editor ou um script `.mjs`.
- **#194: CI 16/16 verde** no commit corrigido (a migração 0074 passa no CI).
- **96% do limite de 5 h.** Tudo commitado e enviado. Relatório: [2026-11-13-rodada-37.md](2026-11-13-rodada-37.md). Retomada agendada para depois do reset (05:10).

## Checagem de 13/11 08:14

- Nenhum merge possível: o #152 (base da pilha) segue sem aprovação do @Lopesloro (BLOCKED), CI 16/16 verde no 5daf777.
- Os avulsos #153, #154 e #172 também esperam aprovação. CI verde.
- O sócio não subiu commit no #158, #143 nem #157 desde 12/11 17:00. Não aprovei nada.
- O #174 segue com uma falha de CI (Terraform) e fica fora até o checklist B1–B9.
- O #116 ficou DIRTY (conflito com a main); só entra depois da pilha, junto com o #189. O #151 continua fechado.

## Checagem de 13/11 10:14

- Nada mudou desde 08:14: o #152 segue sem aprovação (BLOCKED), CI verde; nenhum merge possível.

## Checagem de 13/11 12:13

- Nada mudou desde 10:14: o #152 segue sem aprovação (BLOCKED); avulsos e PRs do sócio sem novidade; nenhum merge.

## Checagem de 16/11 14:59

- Nada mudou desde 13/11 12:13: o #152 segue sem aprovação (BLOCKED), CI verde; avulsos e PRs do sócio sem novidade; nenhum merge.

## 16/11 — o Matheus voltou

- Desde 12/11 nada novo entrou na `main` além do #149. As retomadas agendadas (13/11, 05:10) e as checagens de 2 em 2 h não acharam aprovação nova.
- **Achado: o @Lopesloro abriu o #181 e o #182 na noite de 12/11, direto nos branches do #155 e do #156.** São as ressalvas pelas quais ele segurou a aprovação desses dois. Eu não tinha visto, e a pilha travou nisso. Pelo precedente do #169, quem mescla é o dono do branch de destino (nós).
  - **#181** (logout que não vira 500 se a trilha falhar; `mfa_em` só com a linha do fator): CI verde.
  - **#182** (fundador e membro adicionado ficavam em 403 permanente sem cadastrar o TOTP): o CI falha no teste da R8. A mudança libera o cadastro do fator para quem só tem a senha e ainda não tem fator, e isso abre tomada de conta por quem roubou a senha.
  - Mandei os dois ao Guardião antes de mesclar.
- **#194: veto retirado pelo Guardião (16/11).** A 0074 reescrita é válida, e o CI passou 16/16. Ficam pendências que não bloqueiam, anotadas no parecer: o teste da exportação com o registro congelado, o caso `had_registration: true` e as ressalvas R1, R3 e R5.
- **Guardião sobre os PRs do sócio:** o #181 foi **aprovado com ressalvas**; no #182, a **parte 1 foi vetada** (liberar o cadastro do fator só com a senha permite tomar a conta) e a parte 2 foi aprovada (conta reaproveitada sem senha).
- **#181 mesclado** no branch do #155. Corrigi por cima a R1 (a leitura das clínicas no logout também não vira 500) e propaguei até o #190. No caminho:
  - um conflito de item de lista no log de segurança (`teto_diario` × `trilha_do_fator`), resolvido mantendo os dois, com um resolvedor que só aceita conflito de item;
  - o #181 passou a exigir o motivo na trilha das sessões, e a troca de senha (#159) chamava sem ele. Corrigi com `pela_pessoa` e propaguei.
  - Topo da pilha: tipos e lint limpos, 1153 testes de unidade verdes.
- **#182:** pedi mudanças, com o parecer e o caminho certo (token de cadastro do fator no provisionamento do fundador; recuperação de fator para o membro adicionado). Sugeri separar a parte 2 num PR próprio, que eu mesclo.
- **Item B11 no checklist da abertura:** primeiro fator de quem não nasce de convite, sem afrouxar a R8. O fundador recebe um token de cadastro no provisionamento, e o membro adicionado recebe a recuperação de fator do admin. Depende do desenho do provisionamento (`criarClinica` ainda não tem chamador, então hoje ninguém fica preso).
- **#194, pendências do parecer resolvidas:** um teste da troca de número (a trilha marca `had_registration: true`, sem o número) e um teste da exportação total com o registro congelado na assinatura. O CI está rodando.
- **#194: CI 16/16 verde** com os testes novos da troca de número e da exportação.
- **#181, ressalvas R2 e R3 (no branch do #155, propagadas pela pilha):** o alarme `TRILHA_NAO_GRAVADA` do fator agora diz se a linha perdida era a do cadastro (`trilha_do_cadastro_do_fator`) e se o desfazer do MFA também falhou (`mfa_sem_trilha`, o pior caso). O topo passa no typecheck.
- **#194, mais ressalvas resolvidas:**
  - **R1:** o recibo passa a usar o registro do cadastro do profissional, e o campo do perfil fiscal fica como legado (o recibo já emitido não muda). Com teste de bancada.
  - **R5:** o admin pode apagar um registro informado errado (os dois nulos). Com testes de unidade e de bancada.
  - A R3 (o profissional ver o próprio registro e ser avisado da troca) fica na fila: precisa de um tipo novo de aviso.
- **Desenho do provisionamento da clínica (B11)** em `docs/04-arquitetura/provisionamento-da-clinica.md`, enviado ao Guardião.
  - O pedido de provisionamento guarda o e-mail cifrado e só entra por uma rota interna.
  - O comando avulso no ECS recebe só o id do pedido, então nada de e-mail vai para o CloudTrail. Ele cria a conta sem senha nem fator, chama o `criarClinica` e emite um token de ativação de uso único, com validade de 72 h.
  - A ativação abre a sessão de cadastro pendente de 15 min (senha nova e TOTP), sem afrouxar a R8.
- **#193:** a medida de escala aceita `instrumento` explícito (lista fechada: Barthel, MIF total, motora e cognitiva, Berg, NPRS). Ele vence o rótulo, e o rótulo fica livre; sem o campo, o rótulo continua como reserva. 16 testes do modelo verdes.
- **Provisionamento: o Guardião aprovou o desenho com ressalvas (R1 a R10)**, e reescrevi como v2:
  - o e-mail entra por um parâmetro cifrado do SSM e fica só em HMAC;
  - a conta nasce na ativação (e o fundador que já tem conta faz login completo);
  - o token é entregue por uma segunda pessoa;
  - a rota de ativação devolve o mesmo 404 do convite, bloqueia na 5ª falha e falha fechada sem Redis;
  - a regra do D15 vale para a senha nova;
  - o importador só roda depois da confirmação da ativação.
  
  Isso virou condição do B8. **Lacuna nova: B12**, o admin único que perde o fator, que vai precisar de um procedimento operacional.
- **Provisionamento, PR 1** (tabela `ativacao_do_fundador`, função, comando, eventos e testes) **passado ao agente de engenharia**, no branch `eng/provisionamento-clinica`, empilhado sobre o #190. A rota de ativação, o ajuste da 0022 e o Terraform ficam para os PRs 2 e 3.
- **CI verde em toda a pilha (#152 a #179, #190) e no #194**, depois da entrada do #181 e das correções R1 a R3. Nenhuma falha.
- **Desenho do B12** (o admin único que perde o fator) em `docs/04-arquitetura/recuperacao-do-admin-unico.md`, enviado ao Guardião. É um comando no padrão do B10, só quando não há outro admin com fator. Usa a identidade conferida pelo contrato, o mesmo token do #159 entregue por uma segunda pessoa e um teto de uma recuperação por clínica a cada 30 dias.
- **B12, parecer do Guardião:** a recuperação só do fator foi **aprovada com ressalvas**, e a recuperação completa (senha e fator) foi **vetada**, porque nenhum token restaura os dois.
  - Ele corrigiu a minha descrição do #159: o token vale 15 min, o teto é por quem emite, e o uso exige que quem emitiu seja admin ativo. Por isso o token do suporte precisa de `origem` e `chamado` e de um ajuste no `usarRecuperacao`.
  - Validade de 24 h, opção `--derrubar-sessoes`, teto também por pessoa e alarme em toda emissão.
  - **Item B13 novo:** quem perdeu senha e fator recebe conta nova pelo provisionamento, com o vínculo antigo revogado e 48 h de espera.
- **#195 aberto (PR 1 do provisionamento, B11), empilhado sobre o #190.** O código veio do agente de engenharia:
  - migração 0076 `ativacao_do_fundador`, sem e-mail (só o HMAC) e com o token só em hash;
  - função idempotente pelo id do pedido;
  - comando avulso que lê o e-mail e o nome do SSM, apaga o parâmetro e grava o token num segundo parâmetro;
  - eventos `CLINICA_PROVISIONADA` e `ATIVACAO_EMITIDA`.
  
  Tipos, lint e 1163 testes de unidade verdes. Mandei ao Guardião. Ficam para os PRs 2 e 3: a rota de ativação, o ajuste da 0022 (ator sistema), o cliente SSM real (o pacote não está instalado), o expurgo e o Terraform.
- **#195: CI 16/16 verde e o Guardião aprovou com ressalvas.** A tarefa não roda em ambiente nenhum até o cliente SSM entrar, e é isso que impede o veto.
  - **C1 (alta, primeira coisa da próxima rodada):** o fundador que já tem conta vira admin com vínculo ativo no provisionamento, antes de ativar. Um e-mail errado que caia na conta de outra pessoa daria admin a ela. Correção: a sessão recusa a clínica com ativação pendente para aquela pessoa, ou o vínculo nasce bloqueado.
  - C2 a C4 bloqueiam só o PR que ligar o SSM: o ator sistema da R7, a reemissão depois do expurgo e o IAM e a expiração do parâmetro de entrega.
  - A1 a A3 são pequenos (HMAC próprio `ativacao-email`, conferir o e-mail da conta existente ao repetir, `pedido` nos eventos).
- **89% do limite de 5 h às 19:00.** Tudo commitado e enviado. Retomada agendada para depois do reset (19:55).
- **#195, C1 corrigida:** a lista e a escolha de clínica recusam a clínica com ativação ainda não usada para aquela pessoa, então o fundador com conta existente só entra depois de ativar. Com teste de bancada. A reconferência do Guardião fica para depois do reset.

## Checagem de 16/11 16:13

- Nada mudou desde 14:59: o #152 segue sem aprovação (BLOCKED); avulsos e PRs do sócio sem novidade; nenhum merge.

## Checagem de 16/11 18:20

- **#152 entrou na main** às 16:27 (merge feito pelo @Lopesloro). A branch `eng/better-auth-mfa` ficou de pé.
- **#155 redirecionado para a main** e com a main mesclada, sem conflito. Tipos, lint e 1138 testes verdes. Push feito e comentário pedindo nova aprovação.
- **#172:** estava aprovado mas BEHIND. Trouxe a main, bateria verde, push e comentário pedindo nova aprovação.
- #153 e #154 seguem sem aprovação. #158, #143 e #157 sem mudança do sócio.
- #189 aprovado, mas só entra depois da pilha. #116 em conflito (DIRTY). #151 foi fechado pelo Dependabot em 12/11.

## Checagem de 16/11 20:16

- **#172 entrou na main** (aprovado, CLEAN, CI 13 verdes e 3 pulados). Merge sem `--delete-branch`, conferido MERGED.
- **#155:** trouxe a main de novo, sem conflito. Tipos, lint e 1138 testes verdes. Push e comentário pedindo nova aprovação. Segue sem aprovação.
- #153 e #154 sem aprovação (BEHIND). #158, #143 e #157 sem mudança do sócio.
- #189 aprovado, espera a pilha. #116 segue em conflito (DIRTY).

## Checagem de 16/11 22:14

- Nada mudou desde 20:16: o #155 segue sem aprovação (BLOCKED); avulsos, PRs do sócio e #189/#116 iguais; nenhum merge.

## 17/11 (00:00)

- **O @Lopesloro mesclou o #152 na `main`** (MFA real com TOTP, PR 2 do login) e aprovou o #191, o #192, o #193 e o #194. O #172 entrou na `main`, mesclado pela checagem automática. Ele também mesclou o #196, uma correção dele, no branch do provisionamento.
- **#191 a #194:** ficaram atrás da `main`. Trouxe a `main` (só o merge), o que derrubou as aprovações, e pedi a reaprovação no #155. Mesclo quando o CI passar e ele reaprovar.
- **#155** agora aponta para a `main` e espera a aprovação dele.
- PRs novos do sócio para a `main`: #197 (equipe e trilha de acesso na API real) e #198 (código de demonstração só no modo fake). Vou revisar.
- **#197 e #198 do sócio: aprovados por nós**, depois de o Guardião aprovar com ressalvas (parecer `revisoes/2026-11-17-codigo-197-198-do-socio.md`). As ressalvas para depois ficaram nos PRs:
  - #197: a trilha mostra só 12 meses sem avisar quando não trunca;
  - #198: a exportação em modo http deveria responder 501.
  
  Os dois mexem em linhas vizinhas de `configuracoes.tsx`, então o segundo a entrar terá conflito.
- **#195, A1 a A3 feitos:** chave própria `ativacao-email`, o e-mail conferido ao repetir depois de falha parcial e o `pedido` nos dois eventos. 1166 testes de unidade verdes. Falta a reconferência do Guardião sobre a C1 e o A1 a A3.
- **#195, reconferência do Guardião (17/11): aprovado com ressalvas.** A C1 está resolvida de verdade: nenhuma rota dá acesso à clínica antes de ativar. A1 e A3 estão resolvidas.
  - Corrigi as duas sobras: a escolha automática de clínica ignora a pendente, e entrou o teste do A2 (outro e-mail ao repetir dá `parametro_invalido`).
  - C2 a C4 continuam bloqueando o PR que ligar o SSM e o PR 2.
- **#155 atualizado com a `main`** (sem aprovação a perder) e a pilha inteira propagada, até o #195, sem conflito.
- **Erro meu, corrigido em seguida:** o commit das sobras da C1 subiu com 4 testes de unidade quebrados no `provedor.test.ts`. Eu tinha encadeado o commit num `grep` da saída do vitest, e não no código de saída dele. A consulta nova virou um método próprio, com dublê nesses testes; agora o vitest sai com 0 (1166 verdes). **Regra mantida:** o commit depende do `exit` do vitest, nunca de um `grep` da saída.
- **B12 (recuperação do admin único) passado ao agente de engenharia**, no branch `eng/recuperacao-admin-unico`, sobre o provisionamento, com o escopo fechado pelo parecer: migração 0077, função com teto e ator sistema, ajuste no `usarRecuperacao`, comando avulso, testes e runbook. A recuperação completa (vetada) ficou de fora.
- **#192 MESCLADO na `main`** (`c3221c6`): o atendimento pelo agendamento, com a `versao`, destrava a fatia S1 do front do sócio.
  - O #191 e o #193 ficaram atrasados e foram atualizados.
  - O #194 teve conflito de testes com o #192 (dois `describe` novos no mesmo ponto). Resolvi mantendo os dois; o primeiro resolvedor perdeu o fechamento `});`, que corrigi. O vitest saiu com 0.
  - Pedi de novo a aprovação do sócio, sugerindo mesclar um por vez (#194, #193, #191), porque cada merge derruba a aprovação dos outros.
- **#199 aberto (B12, recuperação do fator do admin único)**, empilhado sobre o #195. O código veio do agente de engenharia: migração 0077, tetos com trava, token do suporte de 24 h só para o fator, uso só se a pessoa ainda é admin, comando avulso e runbook. Mandei ao Guardião.
- **#199: o Guardião aprovou com ressalvas.** Corrigi a C1: `--derrubar-sessoes` passou a ser obrigatório em todo motivo, menos a troca planejada de aparelho, com teste e runbook atualizados. A C2 é esperar o CI. A1 a A5 ficam anotadas (evento na compensação, testes de concorrência). O parecer foi commitado.
- **#199, A2:** se a compensação não conseguir anular o token do suporte, sai `TRILHA_NAO_GRAVADA` com o motivo novo `recuperacao_nao_anulada`, com alarme imediato, em vez de engolir o erro. O vitest saiu com 0.
- **#193 MESCLADO na `main`** (modelos v2 de fisio e TO, escalas com faixa e instrumento explícito). O sócio tinha reaprovado.
- **#191 e #194 atualizados** com a `main` (a aprovação caiu de novo). Pedi para ele aprovar um de cada vez: #194, depois #191.
- **#199:** o RLS falhou por causa da minha C1. Duas bancadas usavam "perdeu o aparelho" sem derrubar as sessões, o que agora é recusado. Passaram a usar "troca de aparelho". O CI está rodando de novo.
- **#191 MESCLADO na `main`**: o CodeQL volta a funcionar com o `init` e o `analyze` juntos. Fechei o #183 e o #185 do Dependabot, que ele substitui.
- **#199: CI verde.** Falta só o sócio (ele depende do #195 e do resto da pilha).
- **#194 atualizado** de novo com a `main`. É o último da leva e espera a aprovação do sócio.
- **#155 atualizado com a `main`** (com o #191 a #193) e a pilha inteira propagada, até o #199, sem conflito. Topo: tipos e lint limpos e vitest saindo com 0 (1178 verdes).
- **RIPD de identidade atualizado no #199** (R10 dos pareceres do B11 e do B12). §3: prazos do token do suporte (13 meses) e da ativação do fundador. §5: procedimentos do fundador (B11), do admin único (B12) e de quem perdeu senha e fator (B13). §8: dois riscos novos para o encarregado assinar.
- **Provisionamento PR 2** (rota de ativação do fundador, ajuste da 0022 para o ator sistema e a C3) **passado ao agente de engenharia**, no branch `eng/ativacao-do-fundador`, sobre o #199.
- **#203 aberto (provisionamento PR 2, B11)**, empilhado sobre o #199. O código veio do agente de engenharia: migração 0078 (fundação pelo sistema só com `via` e `contract`), rota pública `POST /ativacao/usar` (mesmo 404, bloqueio na 5ª falha, 503 sem Redis, conta nova e conta existente) e a C3. O vitest saiu com 0 (1178). Mandei ao Guardião.
- **Dependabot novo:** #200 (imagem do Node na API, digest; não mexe no lockfile e pode entrar antes), #201 (Next 16.4.5) e #202 (18 dependências). O #201 e o #202 ficam para depois da pilha, junto com o #188, o #189 e o #116, por causa do lockfile.
- **#203: o Guardião aprovou com ressalvas.** R4, R5, R7/C2 e C3 estão conformes. Resolvi o que era condição do merge:
  - **T1:** as asserções genéricas viraram códigos específicos (42501 com a regra da trilha, `conta_existente_exige_login`, `credenciais_invalidas`). A corrida confere que o perdedor recusou com 404 e que há um só `founder_activated`.
  - **A4:** o e-mail tomado por outra conta sai como `email_em_uso` no log, com a resposta ainda no mesmo 404.
  - O vitest saiu com 0.
  - Ficam para o PR 3: A1 (papel de banco próprio para a tarefa), A2 (o expurgo não pode apagar ativação nunca usada, senão a C1 cai), A3 e os testes da T2.
- **Dois agentes em paralelo:** o de devops escreve o Terraform das tarefas avulsas do provisionamento e da recuperação do admin único (branch `eng/infra-ops-provisionamento`), no padrão do B10. O de testes escreve a lista T2 do parecer do #203, no próprio branch do #203.
- **#203, testes T2 escritos pelo agente de testes:** 16 de unidade no controller (404, 503, token só no corpo, campo extra recusado) e 5 casos de bancada (fundador revogado, login de outra conta, teto por origem, C1 depois do bloqueio, escolha automática mantida). Nenhum revelou defeito. O vitest saiu com 0 (1194). A bancada roda no CI.
- **#204 aberto (Terraform das tarefas do provisionamento e da recuperação)**, empilhado sobre o #203. Feito pelo agente de devops no padrão do B10: KMS por fluxo, papéis `ops-*` com MFA, separação entre quem provisiona e quem entrega, endpoint SSM e alertas. O vencimento do parâmetro entra com o cliente SSM real. Mandei ao Guardião.
- **#203 verde.** **#174:** a trava do infra.yml lia `api_segredos_obrigatorios` numa linha só, e o `concat(...)` do login real quebrou isso. Agora ela lê o bloco inteiro; testei localmente com os 4 segredos.
- **PR 3 do provisionamento iniciado** com o agente de engenharia, na branch `eng/expurgo-da-ativacao` sobre o #203. Escopo: expurgo de 30 dias das ativações, A2(a) (nunca apagar uma ativação não usada de clínica sem `founder_activated`) e os testes da T2.
- **Guardião no #204: APROVADO COM RESSALVAS.** O merge está liberado; a primeira execução real fica bloqueada até C1 a C3. C1: o mesmo papel roda a tarefa e lê a entrega. C2: falta o vencimento no SSM. C3: faltam os runbooks. Parecer commitado na branch do #204. O devops está corrigindo C1 e as recomendações (Deny de Get na tarefa da recuperação, endpoint SSM condicional, `principais_humanos`). C2 e C3 ficam para o PR do cliente SSM.
- **#204 corrigido (95202d5).** C1: papéis `ops-*-executor` e `ops-*-entrega`, com uma precondition que exige listas disjuntas. Alerta a cada leitura da entrega; o de mesmo SourceIdentity exigiria Lambda e foi justificado no parecer. Endpoint SSM condicional (`endpoint_ssm`, default false), Deny de leitura na tarefa da recuperação, `ops-*` em `principais_humanos`. O terraform não está instalado aqui; quem valida é o CI. **Atenção, sócios:** as variáveis mudaram de nome, então o tfvars precisa ser ajustado.
- **#204 com CI verde (15/15) depois das correções**, inclusive fmt, validate, tflint e checkov.
- **#174, segunda trava:** a trava proibia AUTH_PROVIDER sempre, mas o 3c o define de propósito sob `login_real_habilitado`. Agora ela exige uma única definição, dentro da condição, com a variável `default = false`; a PORTAL_AUTH_PROVIDER continua proibida. **Os sócios e o Guardião devem conferir:** é uma mudança de trava de segurança.
- **#174 com CI verde (16/16)** depois das duas correções de trava.
- **#205 aberto (PR 3, expurgo das ativações)** sobre o #203. A2(a) fechada: uma ativação não usada só sai com `founder_activated` na trilha; se a leitura da trilha falhar, a linha fica. Migration 0079 (só `GRANT DELETE` ao app_auth). O HMAC do e-mail das vencidas é anulado e sai o evento ATIVACAO_VENCIDA. 5 testes RLS; unit 1194 e RLS 885/885 com exit 0. Ficam de fora: cliente SSM (C4), runbook, papel dedicado (A1) e reemissão. Achado lateral: `provisionamento.rls.test.ts` não roda duas vezes no mesmo banco (hash fixo), problema que já existia. Mandei ao Guardião.
- **Guardião no #205: VETADO só por falta de testes.** O código fecha a A2. V1: nenhum teste passa pela falha de leitura da trilha. V2: o teste dos 30 dias passaria mesmo sem o corte. R1: a ativação de clínica nunca ativada fica sem prazo e precisa entrar no RIPD. R2: a linha retida por falha de leitura precisa de um evento. Mandei à engenharia. Também: o `provisionamento.rls.test.ts` passa a usar hash aleatório, e a engenharia valida em duas rodadas antes do commit.
- **#205 respondido** (`da0041b`). Testes novos: V1 (falha de leitura da trilha) e V2 (29 dias fica, 31 sai). Ressalvas atendidas: R1 (RIPD §3), R2 (evento `TRILHA_NAO_LIDA`) e R3 (a segunda rodada não repete `ATIVACAO_VENCIDA`). Unit 1194, RLS 886/886, exit 0. O teste do hash do provisionamento foi corrigido (`c4a7145`) e passou em 2 rodadas seguidas. Falta: reconferência do Guardião no #205, R4 (guarda dos grants do app_auth) e A1 (papel app_provisionamento). O V1 tem uma janela pequena de instabilidade, se um expurgo de outro arquivo rodar ao mesmo tempo.

## Parada por limite de uso (17/11)
Pendente para a próxima sessão:
1. Reconferência do Guardião no #205.
2. Sócios: aprovar o #194 e o #155; conferir a mudança na trava do `AUTH_PROVIDER` no #174; ajustar o tfvars aos papéis novos do #204.
3. PR do cliente SSM: C2 (vencimento) e C3 (runbooks) do #204, e ligar o `endpoint_ssm`.
4. A1 (papel dedicado) e R4 do #205.
5. Dependabot depois da pilha; #182 parte 2; votos de D13 e D15.
- **Retomada depois do limite.** Pedi ao Guardião a reconferência do #205. O #195 caiu no teste de resiliência por tempo (3,1 s contra o teto de 2 s no `statement_timeout`, instabilidade da máquina do CI); rodei de novo só o job que falhou. O #197 e o #198 são do sócio, que faz o merge.
- **Guardião reconferiu o #205: APROVADO.** Os testes de V1 e V2 quebram se o código regredir; R1 a R3 feitos. Ficam abertos: R4 (guarda dos grants), R5/A1 (papel dedicado) e R6 (não bloqueia): o V1 pode dar vermelho falso quando outro arquivo roda o expurgo em paralelo; correção possível com advisory lock no expurgo ou `fileParallelism: false`. Parecer commitado.
- **R6 adiado:** um advisory lock no expurgo exigiria reorganizar o job, que hoje não é uma transação só; fica no backlog. **PR do cliente SSM iniciado** com a engenharia: C4, o vencimento C2 (72 h e 24 h, Advanced) e os runbooks C3. Branch `eng/cliente-ssm` sobre o #205.
- **#195 verde (16/16) depois de rodar de novo** o teste de resiliência: era instabilidade de tempo no CI.
- **#206 aberto (cliente SSM real)** sobre o #205: SecureString com a KMS do fluxo, Advanced, Expiration 72 h/24 h, Overwrite false com o código novo `entrega_pendente`. A correção da recuperação vem junto: a rodada recusada não apaga mais a entrega anterior. Runbooks em docs/04-arquitetura. Unit 1217, RLS 886, exit 0. Falta o alerta de expiração no EventBridge (Terraform). O merge depende do #204 com `endpoint_ssm=true`. Mandei ao Guardião.
- **#204: entrou o alerta de entrega vencida** (EventBridge `Parameter Store Policy Action`/Expiration → SNS de segurança), cobrindo os dois fluxos. Fecha a parte de alerta do C2.
- **Guardião no #206: APROVADO COM RESSALVAS** (rodou 40/40 testes do cliente e das tarefas). C1 corrigida por mim no runbook: no `entrega_pendente`, a decisão sai do log. Se há `RECUPERACAO_PELO_SUPORTE`, entrega-se normalmente e não se roda de novo (evita `teto`). Custo das 2 chaves KMS citado. Para a 1ª execução real faltam: merge e apply do #204 com `endpoint_ssm=true`, uma rodada de cada fluxo em staging com dado fictício e a volta ao Guardião.
- **#204 verde (15/15) com o alerta de entrega vencida**, inclusive checkov.
- **#206 verde (17/17)**, com RLS, Build, Carga e Playwright: era o que faltava para o Guardião. A pilha de identidade e operação (#203, #204, #205, #206) está pronta, com parecer e CI verde. Depende só do merge da base (#155 → ...) e da aprovação do sócio.
- **A1 e R4 iniciados** com a engenharia, na branch `eng/papel-provisionamento` sobre o #206: papel `app_provisionamento` dedicado e guarda automatizada dos privilégios do app_auth e do app_provisionamento.
- **#207 aberto (A1 e R4)** sobre o #206. Migration 0080: `app_provisionamento` LOGIN NOINHERIT com grants mínimos; só ele funda clínica pela sessão de sistema. Guarda `guarda-papeis.rls.test.ts` com a lista exata, que se testa com um grant a mais. Unit 1217, RLS 899/899, exit 0. **Ordem de deploy:** segredo `banco-app-provisionamento` no dados.tf, depois bootstrap (que exige `APP_PROVISIONAMENTO_PASSWORD`), depois a 0080. Fica aberto: clínica sem fundador na sessão de sistema passa sem trilha. Mandei ao Guardião.
- **#204: a infra do A1 entrou.** Segredo `banco-app-provisionamento` (senha efêmera, mesmo padrão do app_auth); a tarefa usa só DATABASE_PROVISIONAMENTO_URL e RATE_LIMIT_HASH_KEY (precondição R8 com 2). O deploy do #204 depende da 0080 do #207.
- **#204 verde (15/15) com a infra do A1.** **Guardião no #207: APROVADO COM RESSALVAS.** G1 (antes do merge): a guarda não vê PUBLIC nem o privilégio efetivo. G2: o Terraform já está feito no #204. G3: clínica sem fundador bloqueia a primeira clínica real; fica para um PR próprio, com o risco no RIPD. Recomendações: tirar o SELECT na coluna email; tolerar o master do RDS; conferir os membros do app_auth. Parecer commitado; mandei à engenharia.
- **#207 respondido (a3f4835):** G1 com privilégio efetivo e autotestes com PUBLIC; email e ativo fora do SELECT (duas funções que só aceitam o e-mail como chave); tolerância ao master do RDS; membros do app_auth; G3 e O1 no RIPD. RLS 911/911, exit 0. Em reconferência com o Guardião.
- **Guardião reconferiu o #207: APROVADO** (rodou 34/34 no Postgres local). Funções SECURITY DEFINER com search_path fixo e EXECUTE só do app_provisionamento; não dão para enumerar e-mails. Apliquei N1 (só tolera o ADMIN OPTION com concedente superusuário) e N2 (`pg_temp` no search_path); a engenharia valida e commita. Seguem: G2 antes do go-live (feito no #204) e G3 antes da 1ª clínica real.
- **#207: N1 e N2 commitados (9b945bb).** Banco recriado do zero, RLS 911/911, exit 0. A pilha de identidade e operação (#203 a #207) está toda com parecer favorável do Guardião.
- **G3 iniciado** com a engenharia, na branch `eng/clinica-sem-fundador` sobre o #207: clínica nova sem fundador só pelo app_migrator; os helpers de teste passam pelo caminho permitido.
- **#208 aberto (G3)** sobre o #207. Migration 0081: o trigger da fundação recusa com 42501 uma clínica sem fundador fora do app_migrator. Helper `apoio-clinica.ts` e 9 testes ajustados. Unit 1217+412, RLS 912, exit 0; o `backup-restore.mjs` foi ajustado sem rodar. Mandei ao Guardião.
- **Guardião no #208: APROVADO.** Tentou contornar no Postgres local com SET ROLE, SET SESSION AUTHORIZATION e SECURITY DEFINER do migrator, e tudo foi recusado (o trigger usa session_user). RLS 71/71 e security 47/47 nos testes afetados. UPDATE e DELETE já cobertos. O helper não chega à produção. Recomendações que não bloqueiam: R1 (conferir a mensagem do erro e testar o caso SECURITY DEFINER), R2 (chamado e operador na criação à mão), R3 (nenhum papel do runtime como membro do app_migrator). Parecer commitado.
- **#208: R1, R2 e R3 feitos (9d4a0b1).** RLS 914, exit 0. A pilha #203 a #208 está toda aprovada pelo Guardião, sem pendências de código, e espera a base (#155 e #194, aprovação do sócio).
- **#207 e #208 caíram no autoteste das guardas do banco:** o `verificar-guardas.sh` não passava APP_PROVISIONAMENTO_PASSWORD ao bootstrap. Corrigido no #207 e propagado ao #208 por merge; CI rodando.
- **Segunda causa no autoteste das guardas:** no PG16, o ALTER ROLE do app_provisionamento declarava NOBYPASSRLS, o que só um papel com BYPASSRLS pode fazer (o master do RDS também não poderia). Removido do ALTER; o CREATE já nega o atributo e a guarda confere. **#207 e #208 verdes (16/16).** Esse erro também quebraria o bootstrap no RDS real.
- **R6 iniciado:** os testes do expurgo das ativações passam a usar o relógio injetado adiantado (linhas recentes), sem corrida com os expurgos de outros arquivos. Depois, cascata #205 → #206 → #207 → #208.
- **R6 não aplicado, decisão do Maestro.** A engenharia mostrou que adiantar o relógio piora a corrida: o expurgo varre o banco inteiro e apagaria sessões e HMACs vivos de outros arquivos. As alternativas (`fileParallelism: false` na suíte RLS inteira, ou limitar o expurgo a ids em produção) custam mais que o risco, que é só um vermelho falso raro, nunca um verde falso. Fica documentado: se o V1 do #205 falhar no CI, rode de novo o job; se virar frequente, serializar só os 3 arquivos que expurgam.

## Estado ao fim da rodada (17/11)
- **Pilha de identidade e operação pronta:** #203 (ativação), #204 (Terraform), #205 (expurgo), #206 (cliente SSM), #207 (papel app_provisionamento) e #208 (clínica sem fundador). Todos têm parecer favorável do Guardião e CI verde. Não há pendência de código.
- **Bloqueado em pessoas:**
  1. O sócio precisa aprovar o #155 e o #194, a base da pilha.
  2. Conferir a trava do AUTH_PROVIDER no #174.
  3. Ajustar o tfvars aos papéis `ops-*-executor`/`-entrega` do #204.
  4. Votar D13 e D15; decidir sobre o estagiário; separar a parte 2 do #182.
- **Ordem de deploy do provisionamento:**
  1. Terraform do #204 com `endpoint_ssm=true`.
  2. Bootstrap com APP_PROVISIONAMENTO_PASSWORD.
  3. Migrations até a 0081.
  4. Imagem nova.
  5. Uma rodada de cada fluxo em staging com dado fictício.
  6. Volta ao Guardião.
- **Backlog:** R6 (decidido acima); Dependabot (#188, #189, #116, #201, #202) depois da pilha.

## Checagem de 17/11 08:14

- Nada mudou: o #155 segue sem aprovação (BLOCKED); #153 e #154 sem aprovação; #158, #143 e #157 sem commit novo do sócio; #189 espera a pilha; nenhum merge.

## Checagem de 17/11 10:14

- Nada mudou: #155 segue BLOCKED sem aprovação; #153, #154, #158, #143 e #157 sem novidade; nenhum merge.

## Checagem de 17/11 12:13

- Nada mudou: #155 e #194 seguem BLOCKED sem aprovação; #153, #154, #158, #143 e #157 sem novidade; nenhum merge.

## Checagem de 17/11 14:13

- Nada mudou: #155 e #194 seguem BLOCKED sem aprovação; #153, #154, #158, #143 e #157 sem novidade; nenhum merge.
- **Novo bloqueio na CI de todos os PRs:** o GHSA-fc5q-39xc-vjpf (picomatch, alta) foi atualizado hoje às 15:56 UTC para `<= 4.0.7`, sem correção. Ele vem só do ferramental (vitest, vite, tinyglobby, fdir). Preparei a exceção `eng/excecao-picomatch`: `auditConfig.ignoreGhsas`, o documento `excecoes-de-auditoria.md` com FATO e fonte, e um passo na CI que falha depois de 01/12 ou com GHSA não documentado. Audit local com exit 0. Mandei ao Guardião antes do PR. Também atualizei o #189 (minimatch, aprovado), o #153 e o #154; o #189 caiu justamente nesse audit.
- **Guardião vetou a exceção do picomatch** porque o FATO estava errado: o picomatch ESTÁ na imagem (peers do better-auth via `pnpm deploy --prod`), embora não seja alcançável. A data também estava fixa no ci.yml. Corrigi as duas coisas: o texto agora diz "presente, não alcançável", e a data vem de uma linha `<!-- vence: GHSA data -->` por exceção, lida pela CI (testei data válida, vencida e ausente). **PR #209** aberto para a main, em reconferência. Pendência que não bloqueia: tirar da imagem os ~268 MB de dependências de teste.
- **#209 aprovado pelo Guardião** (veto levantado; ele rodou a trava localmente). Fechei também as duas recomendações finais: teto de 31 dias para a data de vencimento (2099 falha) e dono e prazo para os 268 MB (Maestro e DevOps, 01/12). **CI verde (17/17), inclusive a auditoria.** Falta a aprovação do sócio; depois disso o #189 e todos os PRs voltam a passar no audit.
- **Imagem enxuta iniciada** com o DevOps (`eng/imagem-sem-peers-de-teste`, a partir da main): tirar da imagem de produção os peers de teste do better-auth (~268 MB, com o picomatch junto).
- **#210 aberto (imagem enxuta):** `.pnpmfile.cjs` tira do better-auth os peers opcionais next, react, react-dom e vitest. Deploy de 268 MB e 209 pacotes passou a 82 MB e 160, sem vitest, vite, next, playwright ou picomatch. A API sobe e o /health responde ok. Imagem (build, Trivy, SBOM e fumaça) verde; a auditoria falha até o #209 entrar. Mandei ao Guardião, porque o hook roda em toda instalação.
- **Guardião no #210: APROVADO.** O hook não acessa rede, arquivos nem variáveis de ambiente, mexe só no better-auth e é protegido pelo pnpmfileChecksum. Nenhum caminho importado pela API usa os peers removidos. Parecer commitado. Pendências depois do merge: registrar o tamanho real da imagem Linux e o SBOM sem o picomatch; refazer a checagem a cada atualização do better-auth. Espera a aprovação do sócio (e o #209 antes, para a auditoria).
- **#116 (postgres.js v4) retomado** com a engenharia: o prazo de 12/11 passou. Merge da main, escolha da versão (a 4.0.0 cumpre as 2 semanas; a 4.1.0 e a 4.1.1 ainda não), compatibilidade do drizzle, e RLS, segurança e resiliência locais.
- **#116 atualizado (d3d94f1):** postgres.js fixado em `~4.0.0` (a única versão com 2 semanas de maturidade; a 4.1.x não corrige nada que nos afete e fica para depois de 19/11 e 25/11, com fonte na §8.1). Drizzle 0.45.4 compatível. Localmente: unit 1133+412, RLS 787, security 92, resiliência 26, exit 0. CI verde, exceto a auditoria (picomatch, #209). A aprovação antiga caiu com o push; precisa de nova aprovação do sócio.
- **Guia de revisão atualizado** (seção de 17/11 no topo de `2026-11-13-guia-de-revisao.md`): a ordem para o sócio (#209 primeiro, porque destrava a auditoria de todos; depois #189, #210, #116, #155 e #194), a pilha nova #195 a #208 com tamanhos, a ação do tfvars e a trava do #174.

## Checagem de 17/11 16:13

- Nada mudou: #155, #194, #209, #210, #116, #153 e #154 seguem BLOCKED sem aprovação; #189 aprovado, mas espera a pilha e o #209; #158, #143 e #157 sem commit novo; nenhum merge.

## Checagem de 17/11 18:13

- Nada mudou: #155, #194, #209, #210, #116, #153 e #154 seguem BLOCKED sem aprovação; #189 aprovado, esperando a pilha e o #209; #158, #143 e #157 sem commit novo; nenhum merge.

## Checagem de 17/11 20:13

- Nada mudou: #155, #194, #209, #210, #116, #153 e #154 seguem BLOCKED sem aprovação; #189 aprovado, esperando a pilha e o #209; #158, #143 e #157 sem commit novo; nenhum merge.

### 18/11 00:19 UTC — conferência

- Sem notificações novas. #209, #210, #116, #155 e #194 seguem esperando a aprovação do @Lopesloro; o #189 está
  aprovado e espera o #209 (auditoria). Nenhum merge possível sem a revisão do sócio.
- Sem trabalho de código pendente que não dependa dessas aprovações. Próximo passo: mesclar na ordem do guia
  (`2026-11-13-guia-de-revisao.md`) assim que as aprovações chegarem.
- Alertas abertos na `main`: GHSA-g3hv-75wg-m249 (minimatch, médio; resolvido pelo #189) e GHSA-mfr8-8qww-v76h
  (next 16.4.3, médio; o Dependabot abriu o #201, com CI verde). Médios não bloqueiam a auditoria (só alto e
  crítico). O #201 entrou no guia como item 7, depois do #210 e do #116, por causa do lockfile.

## Checagem de 17/11 22:13

- Nada mudou: #155, #194, #209, #210, #116, #153, #154 e #201 seguem BLOCKED sem aprovação; #189 aprovado, esperando a pilha e o #209; #158, #143 e #157 sem commit novo; nenhum merge.

### 18/11 00:30 UTC — tfvars do #204 documentado

- O `staging.tfvars` fica fora do git, então o ajuste dele não vai em commit. Em vez disso, o passo 3 de
  `docs/04-arquitetura/infra-staging.md` (branch do #204, a43b744) agora lista as cinco variáveis `principais_ops_*`,
  a regra de listas disjuntas entre executor e entrega e o `endpoint_ssm = true`. Os PRs acima do #204 recebem isso
  quando a pilha for propagada.
- Vigia em segundo plano: a cada 5 min confere a aprovação e o merge dos PRs abertos; ao mudar algo, eu retomo.

## Checagem de 18/11 08:13

- Nada mudou: #155, #194, #209, #210, #116, #153, #154 e #201 seguem BLOCKED sem aprovação; #189 aprovado, esperando a pilha e o #209; #158, #143 e #157 sem commit novo; nenhum merge.

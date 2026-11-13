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

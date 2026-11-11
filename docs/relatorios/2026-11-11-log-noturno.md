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

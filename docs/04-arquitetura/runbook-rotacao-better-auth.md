# Runbook: rotação do segredo do login (Better Auth)

> D4, 3c; B1 do parecer do 3c parcial; R9 do parecer do código do #152. A troca de segredo **não** pode apagar o TOTP de ninguém.

## Como funciona

- `BETTER_AUTH_SECRET` é o segredo **legado**: decifra o que foi cifrado antes das versões.
- `BETTER_AUTH_SECRETS=<nova>:<valor>,<antiga>:<valor>`: a **primeira** versão cifra o que é novo; as demais só decifram (`segredos.ts`).
- O segredo do TOTP cifrado com uma versão leva o número dela, e a biblioteca escolhe a chave certa ao decifrar. Há teste de rotação em `segredos.test.ts`.
- Cookies e sessões são assinados com a versão atual. **Toda sessão cai na rotação** (cada pessoa entra de novo, com senha e TOTP). Programar fora do horário de atendimento.

## Passo a passo (staging primeiro, depois produção)

1. Gerar o valor novo com 64 caracteres aleatórios, fora do git.
2. `aws secretsmanager put-secret-value --secret-id <nome>/better-auth-secrets --secret-string '{"segredos":"2:<novo>,1:<atual>"}'`. A primeira rotação usa como "1" o valor atual do `BETTER_AUTH_SECRET`.
3. `terraform apply -var better_auth_segredos_versionados=true`, depois forçar o deploy do ECS.
4. Conferir: login com TOTP cadastrado antes, recuperação de senha (que decifra o TOTP fora do login) e cadastro novo (que já sai na versão 2).
5. **Só depois** de nenhum TOTP depender da versão antiga, retirar a versão do fim da lista. Até haver o job de recifragem (fila), isso significa manter as versões antigas.
6. Registrar a rotação no relatório da rodada, com data e quem fez.

## Rotação da `RATE_LIMIT_HASH_KEY` (R5 do código do 3b-1)

A mesma chave assina três coisas: a origem em HMAC do log de segurança e do rate limit, as chaves do bloqueio 5/15 e o HMAC do e-mail dos convites (`convite-email:`). Trocar a chave tem três efeitos:

- **Convites pendentes deixam de valer.** O aceite compara o HMAC do e-mail digitado com o gravado, e os dois passam a divergir. O aceite responde 404. Antes de trocar, avise os admins e reemita os convites pendentes depois da troca (eles vencem em 72 h de qualquer forma).
- **Os contadores de bloqueio recomeçam do zero**, porque a chave do contador muda. Não troque a chave durante um ataque em andamento.
- **A correlação da origem no log** se quebra no momento da troca. Anote o horário da troca no registro de incidentes.

**Desde o B9 (11/11/2026), há separação por uso.** Cada finalidade usa uma chave derivada da raiz por HKDF-SHA256 (`chaveDeHmac`, em `rate-limit-store.ts`), com cinco rótulos: `rate-limit`, `origem`, `bloqueio`, `sessao-ua` e `convite-email`.
- **Rotacionar UM uso:** subir a versão dele em `VERSOES_DE_HMAC` num PR, por exemplo `origem: 2`. Só aquele uso muda, e os efeitos acima valem só para ele. Para `convite-email`, siga a leitura dupla do desenho (`derivacao-da-chave-de-hmac.md`).
- **Vazamento da raiz ou da API:** rotação em bloco, ou seja, trocar a `RATE_LIMIT_HASH_KEY`, com os três efeitos acima ao mesmo tempo.
- **No deploy do B9:** os contadores do Redis recomeçam (as chaves passam a `rl:v3`), a correlação da origem no log quebra e as sessões vivas ficam com o HMAC antigo até vencerem (no máximo 12 h). Anote o horário no registro de incidentes.

## Vazamento do segredo

Mesmo passo a passo, com urgência. A versão vazada continua só para decifrar até a recifragem; as sessões caem na hora (passo 3).

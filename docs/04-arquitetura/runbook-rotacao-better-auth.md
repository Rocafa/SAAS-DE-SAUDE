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

## Vazamento do segredo

Mesmo passo a passo, com urgência. A versão vazada continua só para decifrar até a recifragem; as sessões caem na hora (passo 3).

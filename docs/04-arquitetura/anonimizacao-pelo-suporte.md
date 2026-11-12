# Anonimização a pedido do titular: como o suporte executa (desenho para o Guardião)

> 12/11/2026 · Maestro · **desenho, sem código.** Origem: o RIPD de identidade (§5, item 2) diz que "o suporte roda `anonimizarConta` (sem rota pública)", mas **nada no código chama esse método**: não há rota, comando nem job. A conferência do roteiro do B8 (12/11) deixou isso em aberto. Sem um caminho, um pedido do titular (LGPD art. 18, IV e VI) não tem como ser atendido no prazo.

## O que já existe

- `BetterAuthProvider.anonimizarConta(userId)` (`provedor.ts`): troca e-mail e nome por marcadores, apaga senha, TOTP, sessões e tokens de recuperação, marca a conta `inativa_por = 'anonimizada'`, zera o HMAC dos convites nas clínicas do espelho (0073) e grava o evento `CONTA_ANONIMIZADA` e a trilha `account_anonymized` em cada clínica.
- O padrão de procedimento operacional do [runbook do fundador](runbook-fundador-clinicas-existentes.md): papel de operação, duas pessoas, chamado na trilha.

## Proposta

1. **Um comando operacional, não uma rota.** É um script de uma execução só (`apps/api/src/ops/anonimizar-conta.ts`), rodado como tarefa avulsa do ECS no ambiente, com a mesma imagem e os mesmos segredos da API. Ninguém acessa o banco à mão.
   - Entrada: `--usuario <uuid>`, `--chamado LGPD-<número>` e `--operador <uuid da pessoa da nossa equipe>`.
   - Exige `CONFIRMA_ANONIMIZACAO=<uuid do usuário>` repetido no ambiente da tarefa, como trava contra erro de digitação.
   - Saída: só `ok`, o id e quantas clínicas foram tocadas. Nunca o nome, o e-mail ou outro dado.
2. **A prova leva o chamado e o operador.** Hoje a trilha `account_anonymized` leva só o ator de sistema. Proposta: incluir `chamado` e `operador` na metadata da trilha e no evento, com o formato fechado (`LGPD-\d{1,7}` e uuid).
3. **Antes de rodar (fora do sistema):**
   - o DPO confirma a identidade do titular e que o pedido é de **anonimização**, não de acesso ou correção;
   - o DPO confere que a pessoa não tem obrigação de guarda que impeça (o prontuário continua com o id do autor por 20 anos: R18);
   - uma segunda pessoa confere o uuid.
4. **Depois:** responder ao titular dentro do prazo, guardar a referência do chamado (sem copiar dado pessoal para o chamado) e conferir que `GET /sessao` da conta passa a dar 401.
5. **Teste:** bancada RLS com conta fictícia: o comando sem a confirmação recusa; com a confirmação, anonimiza; repetir é idempotente (não falha nem duplica a trilha); o chamado com formato errado recusa.

## Perguntas para o Guardião

1. O comando como tarefa avulsa do ECS, com duas pessoas e um chamado, é suficiente? Ou prefere uma rota interna de plataforma com MFA e break-glass?
2. Incluir `chamado` e `operador` na trilha da clínica está certo? Ou isso deveria ficar só no evento do log de segurança?
3. Isso entra antes da abertura do login real (como item B10 do checklist) ou pode vir logo depois?

## Fora do escopo

A exclusão de **paciente** (portal) e a eliminação da clínica inteira (D8): são fluxos próprios.

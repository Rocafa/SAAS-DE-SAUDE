# Provisionamento da clínica e primeiro fator do fundador (desenho para o Guardião)

> 16/11/2026 · Maestro · **desenho, sem código.** Origem: item **B11** do checklist da abertura (`prontidao-producao.md`) e parecer de 16/11 sobre o #182. Hoje `MembrosService.criarClinica` existe (0022: o fundador nasce admin na mesma transação), mas **nada o chama**. Por isso não há como uma clínica real nascer com login real, e o fundador não teria como cadastrar o TOTP sem afrouxar a R8.

## Requisitos

1. Uma clínica nasce **depois do contrato assinado**, por ação nossa. No piloto não há cadastro aberto ao público.
2. O fundador nasce **admin** (0022) e **sem senha nem fator**.
3. O primeiro acesso dele usa um **token de ativação de uso único**, que:
   - abre a sessão de cadastro pendente de 15 min (a mesma do convite, R8);
   - pede a senha nova e, na mesma sessão, o TOTP.

   Quem tem só a senha continua sem cadastrar autenticador.
4. Nenhum dado pessoal do fundador (nome, e-mail) vai para argumentos de tarefa, CloudTrail ou log.

## Proposta

**1. Pedido de provisionamento (tabela `identidade.pedido_de_provisionamento`)**
- Campos: id, nome da clínica, e-mail do fundador cifrado (envelope, como os outros dados de identidade), contrato (referência `CTR-<n>`), quem pediu, quando e situação.
- Quem cria é a **nossa equipe**, por uma rota interna de plataforma com MFA, fora das rotas da clínica. Essa rota é a única porta para o e-mail entrar.

**2. Comando operacional** `ops/provisionar-clinica.ts`, no mesmo padrão do B10:
- tarefa avulsa do ECS, com papel `ops-provisionamento` (MFA e `SourceIdentity`) e só os segredos de banco;
- recebe **só o id do pedido** (`--pedido <uuid>`, sem e-mail no CloudTrail) e uma trava de confirmação.

Ele faz:
1. cria a conta do fundador em `identidade.usuario`, sem senha e sem fator;
2. chama `criarClinica` com essa conta (o tenant e o fundador como admin nascem na mesma transação, 0022);
3. emite o **token de ativação** (hash guardado, como o do convite; validade de 72 h; uso único);
4. marca o pedido como `provisionado`.

**Saída:** só o id da clínica e o id do pedido. O token **não** sai no log. Ele é entregue pelo mesmo canal do convite: e-mail transacional quando houver provedor; até lá, uma tela interna mostra o link **uma vez** a quem pediu.

**3. Ativação** (`POST /ativacao/usar`, pública e com rate limit, como `/recuperacao/usar`)
- token válido → define a senha (com a conferência de senha vazada, conforme o D15) → abre a sessão de cadastro pendente de 15 min → `two-factor/enable` e `verify-totp` → sessão com MFA.
- Token vencido ou já usado → 410. A nossa equipe reemite pelo pedido, e a reemissão invalida o anterior.

**4. Trilha e eventos**
- Na clínica: `tenant_create`, `member_found` (já existem) e `founder_activated`.
- No log de segurança: `CLINICA_PROVISIONADA` e `FUNDADOR_ATIVADO`, só com ids.

**5. Retenção**
- O pedido fica pelo prazo do contrato. O e-mail cifrado é apagado depois da ativação, porque a conta já tem o próprio e-mail.
- O token vencido sai no expurgo diário (`identidade-expurgo`).

## Perguntas para o Guardião

1. A rota interna de plataforma (nossa equipe, com MFA) para criar o pedido está certa, ou o e-mail deveria entrar só pela tela do contrato, fora da API da clínica?
2. 72 h de validade e uso único para o token de ativação: está bom? Deve haver aviso à nossa equipe quando ele vencer sem uso?
3. A senha nova e o TOTP na mesma sessão de 15 min bastam, ou o fundador deve confirmar algo do contrato (o número `CTR-`) na ativação?
4. Entra antes do B8 (a fumaça do staging já pede "clínica criada pelo fluxo de provisionamento")?

## Fora do escopo

Cadastro aberto ao público (self-service), cobrança e assinatura do SaaS, e a migração de dados (o importador já existe).

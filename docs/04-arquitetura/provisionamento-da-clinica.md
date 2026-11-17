# Provisionamento da clínica e primeiro fator do fundador (desenho v2)

> 16/11/2026 · Maestro · **desenho v2, sem código**, refeito sobre o parecer do Guardião (aprovado com ressalvas, `revisoes/2026-11-16-desenho-provisionamento-da-clinica.md`; R1 a R10 abaixo). A v1 está no histórico do git. Item **B11** do checklist (`prontidao-producao.md`), condição do **B8**.

## Por quê

`MembrosService.criarClinica` (0022) não tem chamador. Por isso nenhuma clínica real nasce com login real, e o fundador não teria como cadastrar o TOTP sem afrouxar a R8 (parecer de 16/11 sobre o #182).

## Fluxo

**1. Provisionar** (nossa equipe, depois do contrato `CTR-<n>` assinado)
- Uma pessoa do grupo IAM nominal `ops-provisionamento` (MFA e `SourceIdentity`; R7) grava o e-mail do fundador num parâmetro **SecureString** do SSM e roda a tarefa avulsa do ECS `ops/provisionar-clinica.ts`, com `--pedido <uuid>`, `--contrato CTR-<n>` e a trava `CONFIRMA_PROVISIONAMENTO`. **Nenhum dado pessoal vai para argumentos ou para o CloudTrail.**
- A tarefa:
  1. lê o parâmetro, guarda só o **HMAC** do e-mail e apaga o parâmetro;
  2. reserva o uuid da conta, ou reconhece a conta que já existe;
  3. chama `criarClinica` (ator **sistema**, `via: 'provisionamento'`, contrato na metadata; R7, com ajuste da conferência da 0022);
  4. cria a linha `identidade.ativacao_do_fundador`: hash do token, HMAC do e-mail, contrato, 72 h, uso único, `falhas` (R1);
  5. grava o token num **segundo** parâmetro SecureString.
- Saída: `ok <clinica> <pedido>` ou um código fixo. A tarefa é idempotente (R8).

**2. Entregar** (R3)
- **Outra pessoa** de `ops-provisionamento` lê o parâmetro do token uma vez, entrega ao fundador fora de banda (canal combinado no contrato, nunca o e-mail em claro junto do link) e apaga o parâmetro.
- O token vai no corpo do POST ou no fragmento (`#`) do link.
- **Risco residual (o DPO assina):** quem entrega poderia ativar no lugar do fundador. Mitigações:
  - duas pessoas, uma que provisiona e outra que entrega;
  - confirmação fora de banda depois de `FUNDADOR_ATIVADO`;
  - **o importador só roda depois dessa confirmação**.
  
  O risco some com o provedor de e-mail.

**3. Ativar** (`POST /ativacao/usar`, pública; R4)
- **Mesmo 404** para token inválido, vencido, usado ou com e-mail errado (nada de 410).
- Rate limit da borda, CSRF e origem, como na recuperação.
- Contador por origem e por ativação: na 5ª falha, o token é invalidado (`ATIVACAO_BLOQUEADA`).
- Redis fora: 503, falha fechada.
- O consumo é atômico.
- **Conta nova** (R2): o fundador digita o e-mail (conferido contra o HMAC), o nome e a senha nova (R5: a mesma `conferirSenhaVazada` dos outros caminhos; senha vazada **não** consome o token). A conta nasce nesse momento e abre a sessão de cadastro pendente de 15 min → TOTP.
- **Conta existente** (R2): login completo (senha e TOTP), sem senha nova e sem sessão de cadastro. Conta anonimizada ou expurgada nunca é reaproveitada.
- A transação confere que a conta é o `founder_user_id` da clínica do token e que ainda é admin ativo; se não for, 404 (R8).
- No máximo uma ativação pendente por clínica.

**4. Reemitir:** só antes da ativação, invalidando a anterior (`ATIVACAO_REEMITIDA`). Depois da ativação, nunca. Quando o token vence sem uso, a equipe é avisada (`ATIVACAO_VENCIDA`).

## Eventos, trilha e retenção (R6, R9)

- **Eventos:** `CLINICA_PROVISIONADA` (com o operador), `ATIVACAO_EMITIDA`, `ATIVACAO_REEMITIDA`, `ATIVACAO_FALHOU`, `ATIVACAO_BLOQUEADA`, `ATIVACAO_VENCIDA` e `FUNDADOR_ATIVADO`.
- **Trilha da clínica:** `tenant_create` e `member_found` (ator sistema), `factor_enrollment_issued` e `founder_activated`. **Nunca** o id do operador.
- **Retenção:**
  - o token (só o hash) fica 30 dias depois de vencer ou ser usado e depois cai no expurgo diário (`identidade-expurgo`, 0079);
  - exceção (A2 do parecer de 17/11): a linha **não usada** de clínica sem `founder_activated` na trilha nunca é apagada. É a pendência que mantém a clínica fora da lista e da escolha do fundador com conta existente; apagá-la daria a clínica a quem nunca ativou. Ela fica sem prazo, até a ativação ou o encerramento do contrato (RIPD-identidade §3); se a leitura da trilha falhar, a linha também fica e sai `TRILHA_NAO_LIDA`;
  - o HMAC do e-mail é zerado na ativação, no bloqueio ou no vencimento (o expurgo zera e emite `ATIVACAO_VENCIDA`);
  - os parâmetros SSM são de vida curta.

## Testes

A lista da R9: fundador novo e existente, e-mail errado e bloqueio, mesmo 404, senha vazada sem consumir o token, Redis fora, reemissão, idempotência, metadata fechada, saída sem dado pessoal e parâmetro apagado mesmo na falha.

## Lacuna nova: B12

O **admin único que perde o fator depois de ativar** não tem outro admin que emita a recuperação. Vira o item **B12** do checklist: um procedimento operacional no padrão do B10, com verificação da identidade pelo contrato, duas pessoas e chamado.

## Tamanho

Grande. Divido em três PRs:
1. tabela, tarefa e Terraform (`ops-provisionamento`);
2. rota de ativação, conta nova e existente, e o ajuste da 0022;
3. RIPD, checklist e o procedimento do B12.

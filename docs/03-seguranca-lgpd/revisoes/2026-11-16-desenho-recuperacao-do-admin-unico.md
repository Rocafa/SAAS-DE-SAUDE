# Parecer do Guardião — desenho da recuperação do admin único pelo suporte (B12)

> 16/11/2026 · Guardião LGPD & Segurança · parecer de **desenho** (sem código), branch `eng/hmac-por-uso`.
> Objeto: [`docs/04-arquitetura/recuperacao-do-admin-unico.md`](../../04-arquitetura/recuperacao-do-admin-unico.md).
> Base: R10 do [parecer do provisionamento](2026-11-16-desenho-provisionamento-da-clinica.md); [parecer do B10](2026-11-12-desenho-anonimizacao-pelo-suporte.md) (R1 a R5); [`RIPD-identidade.md`](../RIPD-identidade.md) §5 e §5a; código do #159 (`apps/api/src/modules/auth/credenciais.ts`, `better-auth/provedor.ts`, `db/identidade.ts`).

## Veredito: **APROVADO COM RESSALVAS** (só a recuperação do **fator**). A recuperação **completa** (pergunta 4) é **VETADA** como proposta.

O caminho está certo: comando avulso no padrão do B10, só quando não há outro admin, e o token que exige a senha atual (a recuperação de fator mantém um fator de posse do lado da pessoa). O desenho não vira código como está, porque **descreve errado o #159** em três pontos (R1) e, sem mudança, o token emitido pelo suporte **seria recusado no uso** (R2). Também faltam a defesa contra engenharia social (R3), a regra das sessões e do vínculo (R5), a prova (R6) e a retenção (R7).

## Conferência no código (#159)

- **Validade do token: 15 minutos, não 72 h.** `emitirRecuperacao` grava `expiraEm = now() + interval '15 minutes'` (`provedor.ts:464`). As 72 h do desenho são as do token de ativação do provisionamento, não as do #159.
- **O uso confere quem emitiu.** `usarRecuperacao` chama `vinculoEAdminSeguemAtivos(clinicaId, usuarioId, criadoPor)` (`provedor.ts:495`, `:577-589`): o `criado_por` precisa ser **admin ativo na clínica**. Um token com `criado_por = SYSTEM_ACTOR_ID` (ou o id do operador, que não tem vínculo) volta `invalido`. O "`POST /recuperacao/usar`, que já existe" do item 4 **não funciona sem mudança**.
- **Teto do #159 é por emissor, não por clínica.** `TETO_DIARIO_DE_RECUPERACOES = 10` conta por `criado_por` em 24 h, sob trava consultiva por emissor. Não cobre o suporte.
- **Trilha real:** `credential_recovery_issued` com `user_id`, `kind` e `reason` (lista fechada `MOTIVOS_DE_RECUPERACAO`), ator = admin que emitiu (`credenciais.ts:76-80`). O desenho fala em `factor_recovery_issued`. No uso, o evento de segurança é fixo `RECUPERACAO_USADA` com `motivo: 'recuperacao_pelo_admin'` (`provedor.ts:569`).
- **Sessões:** só caem **no uso** (`tx.delete(sessao)`, `provedor.ts:565`), na mesma transação que apaga o TOTP e consome o token; os outros pendentes da pessoa (de qualquer clínica) são invalidados. Na emissão, nada muda nas sessões.
- **Uso de tipo `fator`:** exige `senhaAtual`, passa pelo bloqueio de login (pessoa e origem, falha fechado) e abre a sessão de cadastro pendente de 15 min (R8 do provisionamento intacta).

## Respostas às perguntas

**1. A conferência (contrato, documento exibido, ligação de retorno) basta? Decisão: basta para o fator, com os reforços da R3.** O que segura o risco é que o token de fator **não substitui a senha**: quem engana o suporte ainda precisa da senha do admin. O ponto fraco é o caso em que o atacante **já tem a senha** (phishing) e só falta o fator; é exatamente o perfil de quem liga para o suporte dizendo que "perdeu o celular". Por isso a conferência precisa ser da **pessoa titular da conta** (não só de "alguém do contrato"), a ligação de retorno vai a um número **já cadastrado antes do pedido**, e o token nunca é entregue pelo canal de onde veio o pedido.

**2. Token do #159 ou tipo próprio? Decisão: mesma tabela e mesmo `tipo = 'fator'`, com origem própria.** Um tipo novo duplicaria o caminho de uso (bloqueio, consumo atômico, queda das sessões, sessão de cadastro), que é o que está testado. A separação de provas vem de colunas, não de tabela:
- `identidade.recuperacao` ganha `origem` (`'admin' | 'suporte'`, padrão `'admin'`) e `chamado` (só `SUP-<n>`, nulo quando `origem = 'admin'`, com `check`). `criado_por = SYSTEM_ACTOR_ID` quando `origem = 'suporte'`.
- `usarRecuperacao`: com `origem = 'suporte'`, troca a conferência do emissor por "a pessoa **segue admin ativo** na clínica do token" (se perdeu o perfil admin entre a emissão e o uso, `invalido`). Com `origem = 'admin'`, nada muda.
- Evento de uso por origem: `RECUPERACAO_USADA` com `motivo: 'recuperacao_pelo_suporte'` e o chamado.
- Validade: 15 min é inviável com entrega por segunda pessoa; 72 h é demais para um token que, com a senha, devolve a conta de **admin**. **24 h** para `origem = 'suporte'`, com o parâmetro SSM apagado na entrega e agendado para o vencimento (como a R3 do provisionamento).

**3. Teto de um por 30 dias por clínica? Decisão: certo, com dois acréscimos.** (a) Teto também **por pessoa**: duas em 12 meses para o mesmo usuário; a terceira é revisão manual. (b) **Toda** emissão pelo suporte gera alarme (não só o teto): é operação rara e cada ocorrência deve ser vista por alguém que não a executou. A revisão "DPO e dois sócios" acima do teto fica registrada no chamado, com os três nomes, e o comando só a aceita com `--revisao SUP-<n>` apontando o chamado da revisão.

**4. Recuperação completa (senha e fator) pelo mesmo comando? Decisão: VETADA.** Um token que define senha nova **e** abre o cadastro do fator restaura os dois fatores a partir só da conferência humana. Isso contraria o RIPD-identidade §5 item 1 ("nenhum admin resolve sozinho", convite novo com outro e-mail) e o controle do §5a "Nenhum token restaura os dois fatores", que tem teste. Duas pessoas e confirmação por escrito reduzem o erro do operador, mas **não** a engenharia social bem feita, e o resultado seria uma conta de admin com acesso aos dados de saúde da clínica inteira. O caminho para o admin único sem senha e sem fator é o do RIPD §5 item 1 adaptado:
- a pessoa ganha **conta nova** com **outro e-mail**, pelo fluxo de ativação do provisionamento (token de ativação, R1 a R9 daquele parecer), como **admin** da mesma clínica;
- a conta antiga tem o vínculo revogado pelo mesmo comando (histórico clínico e trilha continuam no id antigo; o e-mail antigo só se libera pela disputa ou pelo expurgo de 90 dias);
- conferência reforçada: signatário do contrato confirma **por escrito pelo canal do contrato**, duas pessoas do nosso lado, e **espera de 48 h** entre o pedido e a emissão, com aviso ao signatário e ao telefone do contrato (a espera dá ao titular legítimo a chance de contestar);
- o mesmo teto da pergunta 3, somado.
Isso é outro item: registrar como **B13** no checklist e desenhar em separado (o B12 cobre só o fator).

## Ressalvas (condições para o PR de código)

- **R1 — Corrigir o desenho.** 15 min (não 72 h) no #159; o uso hoje confere o emissor; o teto do #159 é por emissor; a trilha é `credential_recovery_issued` com `kind`/`reason`. Reescrever os itens 3, 4 e 5 com os fatos.
- **R2 — Origem no token e uso adaptado** (resposta 2). Testes: (a) token de suporte usado com o usuário ainda admin ativo → abre sessão de cadastro; (b) usuário rebaixado ou desligado entre emissão e uso → `invalido`; (c) token de admin continua exigindo emissor admin; (d) `origem = 'suporte'` sem `chamado` não entra (check do banco); (e) token de suporte vence em 24 h.
- **R3 — Engenharia social contra o suporte.** Procedimento escrito (runbook) com:
  - a pessoa conferida é **o titular da conta** (nome do documento = nome da conta, conferido pelo operador sem copiar); se o titular não for o signatário, o signatário confirma também pelo canal do contrato;
  - ligação de retorno **só** ao telefone do contrato cadastrado **antes** do chamado; pedido para mudar o contato do contrato no mesmo chamado (ou nos 30 dias anteriores) **suspende** a recuperação até revisão do DPO;
  - token entregue **só** ao titular, pela ligação de retorno ou por vídeo em que ele está presente, nunca por e-mail, mensagem ou número informados no pedido;
  - antes de emitir, o operador consulta o log de segurança da conta (últimos 7 dias): `LOGIN_FALHOU`, `MFA_FALHOU`/`MFA_BLOQUEADO`, origens novas. Sinal de ataque → a emissão para e o caso vai ao DPO;
  - roteiro de recusa para pressão ("urgência", "sou o dono", "o médico está esperando"): a resposta é o prazo do procedimento, sem exceção; não há break-glass (como no B10).
- **R4 — Comando no padrão do B10.** Grupo IAM nominal `ops-recuperacao` com `aws:MultiFactorAuthPresent` e `SourceIdentity`; o papel da API sem `iam:PassRole`/`ecs:RunTask` nesta definição; definição de tarefa e papel próprios **só com `app_auth` e `app_user`** (sem `BETTER_AUTH_SECRET`: a emissão não precisa dele; extrair a emissão para função que receba só os dois bancos). `containerOverrides` só com uuids e `SUP-<n>`. Conferências no banco, sob trava consultiva **por clínica** (`recuperacao-suporte:<clinica>`), na ordem: clínica existe; usuário com vínculo **admin ativo**; conta ativa (não `inativa_por`); **nenhum outro** admin ativo com `twoFactorEnabled`; teto. Saída só com códigos fixos (`ha_outro_admin`, `nao_e_admin`, `teto`, `trava_incorreta`, `chamado_invalido`, `erro`), código ≠ 0 na falha, nunca pilha ou mensagem do driver. Na emissão, invalidar pendentes da pessoa (como o #159).
- **R5 — Sessões e vínculo.** O vínculo **não muda** na recuperação de fator (a pessoa continua admin; a conferência de "admin ativo" é na emissão e no uso). As sessões caem **no uso** (já é assim). Na emissão, o comando aceita `--derrubar-sessoes`, **obrigatório** quando o motivo for `suspeita_de_invasao` ou o aparelho foi **roubado** (celular furtado com sessão aberta é acesso de admin na mão de terceiro); com `perdeu_o_aparelho`/`troca_de_aparelho`, opcional e decidido com o titular. Motivo da lista fechada `MOTIVOS_DE_RECUPERACAO` (sem texto livre).
- **R6 — Prova.** Duas pessoas distintas: quem roda (`ops-recuperacao`) e quem entrega (lê o SSM uma vez e apaga), com os dois nomes, o tipo de documento conferido (sem número), a hora da ligação de retorno e o resultado da consulta da R3 **no chamado**. Na clínica: `credential_recovery_issued` com ator **sistema**, metadata fechada `{ op, user_id, kind: 'fator', reason, via: 'suporte', ticket: 'SUP-<n>' }`, sem id do operador (Decisão 1, R2 do B10). No log de segurança: `RECUPERACAO_PELO_SUPORTE` (emissão) e `RECUPERACAO_USADA` com `motivo: 'recuperacao_pelo_suporte'` (uso), com o operador e o chamado. CloudTrail do `RunTask` com o principal nominal. Teste: metadata só com essas chaves; `actor_kind = 'sistema'`.
- **R7 — Retenção.** SSM `SecureString` (KMS própria) apagado na entrega e agendado para o vencimento; apagado também quando a tarefa falha. Linha de `identidade.recuperacao` segue a retenção que já existe para a tabela (incluir as colunas novas na `matriz-retencao.md`). Log de segurança e saída da tarefa: 180 dias. Chamado: retenção própria do suporte, sem cópia de documento. Trilha da clínica: a da `audit_log` (encadeada).
- **R8 — Avisos.** Na emissão, aviso ao signatário pelo canal do contrato ("recuperação de fator emitida, chamado SUP-<n>; se não reconhece, responda"). Os outros membros: só o fato, como no desenho. No uso, o aviso já existente da troca de credencial (`credential_changed` nas outras clínicas da pessoa) fica.
- **R9 — Fora do escopo, sem atalho.** Se quem liga **não é** o admin (o admin saiu da clínica, faleceu, não responde), isto **não** é recuperação: é troca de admin pela clínica, que segue o provisionamento (novo admin, conta própria) com a conferência reforçada da resposta 4. O operador recusa e encerra o chamado quando o pedido não é do titular.
- **R10 — RIPD e checklist.** RIPD-identidade: §5 novo item 6 (este procedimento, base legal art. 7º V para a execução do contrato e art. 7º II/IX e art. 46 para a segurança; nada do art. 11); §4 o risco de engenharia social com as mitigações da R3 e o risco residual aceito pelo DPO; §5a o controle "recuperação pelo suporte só restaura o fator e exige a senha" com a evidência (testes da R2). Checklist: B12 → "desenho aprovado com ressalvas"; criar **B13** (admin único sem senha e sem fator, resposta 4). Fumaça do staging (com B8/B10): uma recuperação de conta fictícia pelo comando real.

## Conferência dos requisitos

| Requisito | Situação |
|---|---|
| Base legal (art. 7º e 11) | Art. 7º V (contrato com a clínica) para a conferência e a emissão; art. 7º II/IX e art. 46 para os controles. Nada do art. 11. Registrar no RIPD (R10). |
| Minimização | Documento só exibido, nada copiado; chamado sem número de documento; `containerOverrides` só com uuids e chamado; tarefa sem `BETTER_AUTH_SECRET` (R4). |
| Consentimento | Não é a base; o pedido do titular e a confirmação do signatário ficam no chamado. |
| Criptografia | Token só em SHA-256 no banco; SSM `SecureString` com KMS; TLS no uso. |
| Isolamento por tenant | Trilha via `withTenant`; conferências por clínica; token preso à `clinica_id`. |
| Controle de acesso | Grupo IAM nominal com MFA; duas pessoas; uso exige senha atual e admin ativo (R2, R4). |
| Auditoria | Trilha da clínica com ator sistema e chamado; operador no log de segurança e no CloudTrail (R6). |
| Retenção | R7. Prontuário (20 anos) não é tocado. |
| Segredos fora do código | Token só no SSM de vida curta; nada no git. |
| Dados reais fora do git/prompts | Testes e fumaça com conta fictícia. |
| CFM/ANS/ICP-Brasil | Nada específico; a garantia de que só o titular (médico admin) volta a acessar sustenta o sigilo do prontuário (CFM 1.821/2007, 2.299/2021). |

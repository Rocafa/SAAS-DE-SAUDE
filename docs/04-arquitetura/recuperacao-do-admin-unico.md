# Admin único que perde o fator: recuperação pelo suporte (desenho para o Guardião)

> 16/11/2026 · Maestro · **desenho, sem código.** Item **B12** do checklist (`prontidao-producao.md`), da R10 do parecer de 16/11 sobre o provisionamento. Hoje a recuperação de fator é emitida **por um admin ativo da clínica** (#159, `POST /clinica/membros/:id/recuperacao`). Se o único admin perde o celular do TOTP, ninguém consegue emitir, e a clínica fica sem gestão: não convida, não desliga e não recupera ninguém.

## Proposta

1. **Só quando não há outro admin ativo com fator verificado** na clínica. Havendo, o caminho continua sendo o desse admin (#159).
2. **Pedido:** a clínica fala com o suporte pelo canal do contrato. O DPO (ou quem ele designar) **confere a identidade** pelo contrato: pessoa signatária ou responsável indicado, com documento só exibido e nunca copiado (RIPD §5, item 1), e uma ligação de retorno ao telefone do contrato.
3. **Comando operacional** `ops/recuperar-admin-unico.ts`, no padrão do B10:
   - tarefa avulsa do ECS, papel `ops-recuperacao` (grupo nominal, MFA e `SourceIdentity`), só com os segredos de banco;
   - argumentos: `--clinica <uuid>`, `--usuario <uuid>`, `--chamado SUP-<n>` e a trava `CONFIRMA_RECUPERACAO=<usuario>`;
   - o comando confere no banco que o usuário é **admin ativo** da clínica e que **não há outro** admin ativo com fator; se houver, recusa com `ha_outro_admin`.
   - Emite o **mesmo token de recuperação de fator** do #159 (uso único, 72 h, só hash guardado) e grava o token num parâmetro SecureString do SSM. **Outra pessoa** o entrega pelo canal do contrato, como no provisionamento (R3).
4. **Uso:** `POST /recuperacao/usar`, que já existe. A pessoa entra com a senha, o token abre a sessão de cadastro pendente de 15 min e ela cadastra o TOTP novo. As sessões antigas caem.
5. **Trilha e eventos:**
   - na clínica: `factor_recovery_issued` com ator **sistema**, `via: 'suporte'` e o chamado, nunca o operador;
   - no log de segurança: `RECUPERACAO_PELO_SUPORTE`, com o operador e o chamado.
   - Os outros membros da clínica (se houver, sem perfil admin) não são avisados com motivo, só com o fato.
6. **Teto:** uma recuperação pelo suporte por clínica a cada 30 dias. Acima disso, revisão manual pelo DPO e pelos dois sócios.

## Perguntas para o Guardião

1. A conferência de identidade (contrato, documento exibido e ligação de retorno) é suficiente para emitir uma recuperação de fator?
2. O token deve ser o do #159 (mesma tabela e mesmo uso), ou um tipo próprio para separar as provas?
3. O teto de um por 30 dias por clínica está certo?
4. E se o admin único perdeu **a senha e o fator**? Proposta: o mesmo comando emite um token de recuperação completa, que define senha nova e abre o cadastro do fator, com conferência reforçada (duas pessoas do nosso lado e confirmação por escrito da clínica).

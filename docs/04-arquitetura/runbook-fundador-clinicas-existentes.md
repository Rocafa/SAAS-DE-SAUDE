# Runbook: fundador das clínicas existentes sem membros (R15 e R17 do parecer #63)

**Quando usar:** uma vez, antes de abrir o acesso ao piloto, depois de aplicar a migração 0022. Também
serve, depois disso, para qualquer clínica antiga que apareça sem admin no banco.

**Por quê:** até a 0020, numa clínica sem nenhuma linha em `clinic_members`, qualquer usuário da sessão
podia se registrar como o primeiro admin. A 0022 fechou isso: o primeiro admin só vem do fluxo de
criação da clínica (`tenants.founder_user_id` = usuário da sessão, na mesma transação). As clínicas
criadas antes ficaram **sem fundador e sem admin**: ninguém consegue marcar retenção legal, designar
custódia nem conceder perfil nelas até este runbook rodar.

## Quem executa

- Papel de **operação/migração** (`app_migrator`), nunca o runtime (`app_user`): a função recusa o
  papel do runtime e o `EXECUTE` não é concedido a ele.
- Duas pessoas: quem executa e quem confere (o fundador vem do contrato da clínica, nunca de um pedido
  por chat ou e-mail).
- Cada execução tem um **chamado** (ex.: `OPS-123`), que vai para a trilha.

## Passo a passo

1. **Listar as clínicas sem fundador e sem membros** (só ids, sem dado pessoal):

   ```sql
   -- Só leitura, com o papel administrativo do banco (o RLS FORCE esconde as linhas de app_migrator e
   -- de app_user sem contexto). Nenhuma escrita com esse papel.
   SELECT t.id
     FROM tenants t
    WHERE t.founder_user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = t.id);
   ```

   Para cada clínica do inventário, confirme no contrato quem é o responsável (o futuro admin) e o
   `userId` dele no provedor de identidade.

   **Dupla checagem do `userId` (R17), antes do passo 2.** A função aceita qualquer UUID: o banco não
   sabe se o `userId` é de outra clínica, de um ex-funcionário ou de uma conta de teste. Por isso o
   **conferente** (a segunda pessoa, não quem executa) confirma por conta própria, direto no console do
   provedor de identidade, sem copiar o valor de quem executa:
   - o `userId` existe, está **ativo** e não está bloqueado nem marcado para exclusão;
   - a conta pertence ao **responsável do contrato daquela clínica** (confere com o contrato, não com
     um pedido por chat ou e-mail);
   - a conta não é membro ativo nem fundador de **outra** clínica, salvo se o contrato disser que o
     responsável é o mesmo (consulta só de ids, sem dado pessoal):

     ```sql
     -- Só leitura, com o papel administrativo do banco.
     SELECT m.tenant_id, m.role FROM clinic_members m
      WHERE m.user_id = '<userId-do-responsavel>'::uuid AND m.revoked_at IS NULL;
     SELECT t.id FROM tenants t WHERE t.founder_user_id = '<userId-do-responsavel>'::uuid;
     ```

   O conferente registra no chamado: "userId conferido no provedor de identidade em AAAA-MM-DD por
   <conferente>; pertence ao responsável do contrato <nº do contrato>". **Sem esse registro, o passo 2
   não roda.** No chamado vão só ids, número do contrato e os nomes de quem executa e de quem confere.
   Nada de documento, e-mail ou telefone do responsável.

2. **Registrar o fundador** (uma transação por clínica):

   ```sql
   BEGIN;
   SELECT app_runbook_registrar_fundador('<id-da-clinica>'::uuid, '<userId-do-responsavel>'::uuid, 'OPS-123');
   COMMIT;
   ```

   A função, na mesma transação: grava `tenants.founder_user_id`, cria o primeiro admin em
   `clinic_members` e grava `member_found` na trilha (ator `sistema`, `via=runbook`, `chamado`).
   Recusa com 55000 se a clínica já tiver fundador ou qualquer membro (aí é concessão normal por um
   admin), e com 22023 se o chamado não tiver o formato `ABC-123`.

3. **Conferir** (com a sessão do novo admin): `GET /clinica/membros` mostra só ele como admin; a trilha
   da clínica tem o `member_found` com o chamado. O conferente confirma de novo, pelo provedor de
   identidade, que o `userId` que aparece como admin é o mesmo conferido antes do passo 2 e pertence
   ao responsável do contrato daquela clínica (R17), e registra isso no chamado.

   **Se o `userId` estiver errado:** o runbook não desfaz o erro, porque o fundador é gravado uma vez só.
   Abra incidente pelo [plano de resposta](../03-seguranca-lgpd/plano-resposta-incidentes.md), revogue
   o perfil indevido assim que houver um admin legítimo e avise o `guardiao-lgpd`.

4. **Registrar** no chamado: clínica, data, quem executou e quem conferiu. O fundador então concede os
   demais perfis pela API (`POST /clinica/membros`), e cada concessão avisa os outros admins.

## Lista de verificação (marcar no chamado, por clínica)

- [ ] Clínica listada no inventário do passo 1 (sem fundador e sem membros).
- [ ] Responsável tirado do contrato, com o número do contrato no chamado.
- [ ] `userId` conferido pelo **conferente** no provedor de identidade: ativo, do responsável do
      contrato e sem vínculo indevido com outra clínica (R17).
- [ ] Conferência registrada no chamado **antes** do passo 2.
- [ ] Passo 2 executado pela outra pessoa, com `app_migrator`, numa transação só.
- [ ] Passo 3: `GET /clinica/membros` e `member_found` conferidos, e `userId` reconfirmado (R17).
- [ ] Chamado fechado com clínica, data, quem executou e quem conferiu.

## O que o banco garante mesmo se o runbook for mal usado

- O runtime não muda `founder_user_id` (42501) nem chama a função (42501).
- O fundador é gravado uma única vez (de NULL para o usuário da transação).
- Nenhuma linha de `clinic_members` fecha a transação sem o evento correspondente na trilha.

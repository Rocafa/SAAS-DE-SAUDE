# Runbook: fundador das clínicas existentes sem membros (R15 do parecer #63)

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
   da clínica tem o `member_found` com o chamado.

4. **Registrar** no chamado: clínica, data, quem executou e quem conferiu. O fundador então concede os
   demais perfis pela API (`POST /clinica/membros`), e cada concessão avisa os outros admins.

## O que o banco garante mesmo se o runbook for mal usado

- O runtime não muda `founder_user_id` (42501) nem chama a função (42501).
- O fundador é gravado uma única vez (de NULL para o usuário da transação).
- Nenhuma linha de `clinic_members` fecha a transação sem o evento correspondente na trilha.

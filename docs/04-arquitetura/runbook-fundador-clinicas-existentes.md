# Runbook: fundador das clínicas existentes sem membros (R15 e R17 do parecer #63; correção na 0042, 0044 e 0047)

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

   **Se o `userId` estiver errado:** siga a seção "Correção do fundador errado", mais abaixo.
   Não tente rodar o passo 2 de novo: ele recusa com 55000, porque a clínica já tem membro.

4. **Registrar** no chamado: clínica, data, quem executou e quem conferiu. O fundador então concede os
   demais perfis pela API (`POST /clinica/membros`), e cada concessão avisa os outros admins.

## Correção do fundador errado (R17 do #63, migrações 0042 e 0044)

Use quando o passo 3 mostrar que o admin gravado não é o responsável do contrato. Até a correção, o
admin indevido tem acesso de admin à clínica: trate como **incidente**.

1. **Abrir incidente** pelo [plano de resposta](../03-seguranca-lgpd/plano-resposta-incidentes.md),
   com chamado próprio (ex.: `INC-45`), e avisar o `guardiao-lgpd`. Avaliar no incidente o que o
   admin indevido acessou nesse intervalo (trilha da clínica filtrada pelo `actor_id` dele, só ids).
2. **Conferente confirma o `userId` correto** no provedor de identidade, como na dupla checagem do
   passo 1 (ativo, do responsável do contrato, sem vínculo indevido), e registra no chamado.
3. **Quem executa pede a correção** (com o **próprio login nominal**, assumindo `app_migrator`, numa
   transação; ver "Operadores nominais"):

   ```sql
   BEGIN;
   SET LOCAL ROLE app_migrator;
   SELECT app_runbook_pedir_correcao_fundador('<id-da-clinica>'::uuid, '<userId-errado>'::uuid,
                                              '<userId-correto>'::uuid, 'INC-45');
   COMMIT;
   ```

   Devolve o **id do pedido** (vai para o chamado). Recusa com 55000 se o `userId-errado` não for o
   fundador atual, e com 22023 se o chamado for inválido ou o correto for igual ao errado. Grava o
   pedido na tabela interna `founder_fix_requests` (0044: só `app_migrator` lê e grava) e registra
   `founder_fix_requested` na trilha (só ids e chamado). A confirmação lê o pedido **da tabela
   interna**, nunca da trilha: uma linha `founder_fix_requested` na trilha sem pedido na tabela é
   forjada e deve ser tratada no incidente.
4. **O conferente confirma** em até 24 h, em **outra** transação, redigitando o `userId` correto a
   partir do provedor de identidade (não copia de quem executa), com o **login nominal dele** (outro
   login que não o de quem pediu: o banco recusa com 42501):

   ```sql
   BEGIN;
   SET LOCAL ROLE app_migrator;
   SELECT app_runbook_confirmar_correcao_fundador('<id-da-clinica>'::uuid, '<id-do-pedido>'::uuid,
                                                  '<userId-correto>'::uuid, 'INC-45');
   COMMIT;
   ```

   Na mesma transação, a função: troca `tenants.founder_user_id` para o correto, registra o correto
   como admin (`member_found`, `via=runbook_correcao`), **revoga todos os perfis ativos** do errado na
   clínica (`member_revoke`, um evento por perfil) e grava `founder_fixed` com o pedido e o chamado.
   Recusa com 42501 se rodar na mesma transação do pedido; com 22023 se o `userId` ou o chamado não
   baterem com o pedido; com 55000 se o pedido não existir nessa clínica, já tiver sido confirmado,
   tiver expirado (> 24 h) ou se o fundador tiver mudado desde o pedido. O pedido é travado na
   confirmação e marcado como confirmado (`confirmed_at`): duas confirmações simultâneas viram uma
   confirmação e uma recusa. Para conferir o pedido antes de confirmar (papel `app_migrator`):

   ```sql
   SELECT id, tenant_id, user_id_anterior, user_id, chamado, created_at, requested_by, confirmed_at, confirmed_by
     FROM founder_fix_requests WHERE id = '<id-do-pedido>'::uuid;
   ```
5. **Conferir** como no passo 3: `GET /clinica/membros` (sessão do admin correto) mostra só ele como
   admin; a trilha tem `founder_fix_requested`, `member_found`, `member_revoke` e `founder_fixed` com o
   mesmo chamado. Encerrar o incidente com o registro de quem pediu e de quem confirmou.

O banco garante: só membros de `app_migrator` executam as duas funções e ligam a exceção dos guardas
(lista branca, `pg_has_role(current_user, 'app_migrator', 'MEMBER')`, 0044). O runtime (`app_user`) e
qualquer papel novo (BI, leitura) recebem 42501, mesmo ligando por conta própria a configuração da
correção; a exceção nos guardas de `tenants` e `clinic_members` só vale dentro da confirmação. O
runtime (e o portal, que usa o mesmo papel) não tem nenhum privilégio em `founder_fix_requests`: não
forja um pedido por INSERT, e uma linha forjada na trilha (`founder_fix_requested` ou `founder_fixed`)
não cria nem bloqueia pedido. A tabela é interna (`app_internal_tables()`) e fica fora da exportação
da clínica.

**Duas pessoas, verificável pelo banco (O-R17b, 0047).** Pedido e confirmação exigem o **login nominal**
de cada operador (seção abaixo); o login compartilhado `app_migrator` recebe 42501. O pedido grava o
`session_user` de quem pede (`requested_by`), a confirmação grava o de quem confirma (`confirmed_by`) e
**recusa com 42501 se forem o mesmo login**. Os dois nomes vão para o `founder_fixed` da trilha
(`pedido_por`, `confirmado_por`). Pedidos feitos antes da 0047 não têm operador e são recusados (55000):
abra outro. A exceção dos guardas também exige `session_user` nominal: uma função `SECURITY DEFINER`
chamada pelo runtime roda como o dono, mas o `session_user` continua `app_user`, e a exceção não liga
(O-R17e; a guarda de schema reprova qualquer `SECURITY DEFINER` do runtime que grave `tenants` ou
`clinic_members`).

### Operadores nominais (RDS)

Cada pessoa que pode pedir ou confirmar a correção tem um papel LOGIN próprio, membro de `app_migrator`.
Não use o usuário mestre do RDS nem o login `app_migrator` nas funções do runbook. O nome é
pseudônimo e estável (`op_<iniciais>`, ex.: `op_ab`; sem e-mail e com menos de 8 dígitos, senão o
contrato da trilha recusa o evento): ele aparece na trilha da clínica; a relação
nome → pessoa fica no cofre de acessos, não no banco.

Criação, feita uma vez pelo usuário mestre do RDS e registrada em chamado:

```sql
-- Senha gerada e guardada no gerenciador de segredos (nunca no git nem no chamado).
-- Preferível: IAM auth (sem senha): CREATE ROLE op_ab LOGIN; GRANT rds_iam TO op_ab;
CREATE ROLE op_ab LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '<do-cofre>';
GRANT app_migrator TO op_ab;
GRANT CONNECT ON DATABASE plataforma_saude TO op_ab;
```

Uso: o operador entra com o próprio login e, em cada transação do runbook, assume o papel de operação
(o `session_user` continua sendo o dele, e é isso que o banco grava):

```sql
BEGIN;
SET LOCAL ROLE app_migrator;
SELECT app_runbook_pedir_correcao_fundador(...);   -- ou app_runbook_confirmar_correcao_fundador(...)
COMMIT;
```

Saída de um operador: `REVOKE app_migrator FROM op_ab; ALTER ROLE op_ab NOLOGIN;` (não apague o
papel: o nome continua referenciado em `founder_fix_requests` e na trilha). Revisar a lista de membros
de `app_migrator` a cada trimestre (`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON
r.oid = m.member WHERE m.roleid = 'app_migrator'::regrole;`).

No CI e no ambiente local, o teste (`retencao-custodia.rls.test.ts`) cria dois papéis assim com
`DATABASE_ADMIN_URL` (superusuário do container efêmero) e os remove no fim.

## Lista de verificação (marcar no chamado, por clínica)

- [ ] Clínica listada no inventário do passo 1 (sem fundador e sem membros).
- [ ] Responsável tirado do contrato, com o número do contrato no chamado.
- [ ] `userId` conferido pelo **conferente** no provedor de identidade: ativo, do responsável do
      contrato e sem vínculo indevido com outra clínica (R17).
- [ ] Conferência registrada no chamado **antes** do passo 2.
- [ ] Passo 2 executado por **quem executa** (a pessoa que não é o conferente), com `app_migrator`,
      numa transação só.
- [ ] Passo 3: `GET /clinica/membros` e `member_found` conferidos, e `userId` reconfirmado (R17).
- [ ] Se o `userId` estava errado: incidente aberto, pedido por quem executa e confirmação pelo
      conferente (seção "Correção do fundador errado"), com os quatro eventos na trilha.
- [ ] Chamado fechado com clínica, data, quem executou e quem conferiu.

## O que o banco garante mesmo se o runbook for mal usado

- O runtime não muda `founder_user_id` (42501) nem chama a função (42501).
- O fundador é gravado uma única vez (de NULL para o usuário da transação).
- Nenhuma linha de `clinic_members` fecha a transação sem o evento correspondente na trilha.

# Parecer do Guardião LGPD: PR #207, papel `app_provisionamento` (A1/R5) e guarda dos papéis (R4)

**Veredito: APROVADO COM RESSALVAS.** G1 é obrigatória antes do merge. G2 e G3 são obrigatórias antes da primeira clínica real (go-live da tarefa). As demais são recomendações.

- Revisado: `gh pr view 207` e `git diff origin/eng/cliente-ssm...HEAD` (14 arquivos, +491/-25), na worktree `papel-provisionamento`.
- Referências: A1 de `2026-11-17-codigo-ativacao-do-fundador.md` (o PR cita o arquivo de 16/11, mas a A1 do papel dedicado está no de 17/11), R4 e R5 de `2026-11-17-codigo-expurgo-da-ativacao.md`.
- **Não executei a bancada.** Não havia Postgres local. Os números (899/899 RLS, 1217 unidade) são os informados no PR. A leitura é do SQL, do código e dos testes.

## Resumo

O PR faz o que a A1 recomendou. A tarefa deixa de usar `app_auth` (com UPDATE e DELETE na ativação e acesso a conta, sessão e fator) e `app_user` (runtime inteiro). Passa a usar um papel LOGIN, NOINHERIT, NOBYPASSRLS, sem `app_set_user`. A fundação pela sessão de sistema (0078) passa a exigir `pg_has_role(session_user, 'app_provisionamento', 'MEMBER')`. Com isso, um comprometimento da API (`app_user`) deixa de conseguir fundar clínica "pelo provisionamento". O ganho é real e não abre nenhuma porta nova.

A guarda R4 pega grant direto a mais ou a menos, mas **não pega privilégio herdado de PUBLIC em função nem em tabela fora de `identidade`** (G1).

## 1. Os grants são mínimos?

Conferi cada grant contra `provisionamento.ts`, `criarClinica` e os triggers do caminho.

| Grant | Uso | Situação |
|---|---|---|
| `ativacao_do_fundador`: `SELECT (id)`, `INSERT` | repetição do pedido (`:140`) e emissão (`:185`) | Mínimo. Sem UPDATE e DELETE, sem `token_hash` e `email_hmac`. Fecha R5. |
| `usuario`: `SELECT (id, email, ativo, clinica_de_origem)` | conta pelo e-mail (`:164`), A2 (`:175`), C3 (`:120`) | Mínimo em colunas. Ver R1: a coluna `email` permite listar todos os e-mails. |
| `tenants`: `SELECT, INSERT` | leitura do existente (`:149`) e fundação | Necessário. |
| `clinic_members`: `SELECT, INSERT` | fundação; o `NOT EXISTS` do guard roda como invocador | Necessário. |
| `audit_log`: `SELECT, INSERT` | trilha da fundação, `fundadorAtivadoNaTrilha` (`:105`), `app_trilha_do_provisionamento` (invocador) | Necessário. Ver O1. |
| EXECUTE nas 8 funções | contexto, policies, cadeia (`app_audit_chain_tail`, SECURITY DEFINER), prova da 0078 | Necessário. A ausência de `app_set_user` é o ponto central e tem teste (42501). |

O controle por papel na 0080 está correto. `tenants_founder_guard` e `clinic_members_guard` mudam só a condição da sessão de sistema e mantêm o resto da 0078 (incluindo a prova da trilha no COMMIT). Os testes provam que `app_user` e `app_auth` são recusados mesmo com a trilha certa. A 0080 também falha fechado sem o papel ou com o papel privilegiado.

## 2. A guarda pega grant a mais, a menos e via PUBLIC?

- **A mais e a menos (direto): sim.** Tabela, coluna e EXECUTE são comparados com `toEqual` exato, em todos os schemas. Sequência e visão entram por `pg_class`. O autoteste prova que a leitura enxerga um GRANT de coluna.
- **Atributos, posse e pertença: sim.** Superpoder, dono de objeto, membro de outro papel. Para `app_provisionamento`, também NOINHERIT e "ninguém é membro dele".
- **Via PUBLIC: só parcialmente.** Só verifica tabelas e colunas de `identidade`.

### G1 (obrigatória antes do merge). A guarda não vê PUBLIC em funções nem fora de `identidade`

- `funcoesDo` lê só `aclexplode(proacl)` com `grantee = papel`. No Postgres, função nasce com EXECUTE para PUBLIC (`proacl` nulo). O projeto revoga função por função (83 `REVOKE ... FROM PUBLIC` nas migrações), não por `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ... FROM PUBLIC`. Uma função SECURITY DEFINER nova sem o REVOKE fica executável por `app_provisionamento` e `app_auth`, e a guarda continua verde. É exatamente o "grant futuro que passa sem ninguém ver" que a R4 queria pegar.
- O mesmo vale para tabela ou visão em `public` concedida a PUBLIC. Também não há conferência de privilégio de schema (CREATE em `public`/`identidade`, USAGE em outros schemas) nem de banco (TEMPORARY, que hoje só o bootstrap confere).
- **Correção:** acrescentar asserções pelo privilégio **efetivo**, que já inclui PUBLIC e pertença:
  - `has_function_privilege(papel, p.oid, 'EXECUTE')` em todas as funções não-trigger de `public` e `identidade` (`prorettype <> 'trigger'::regtype`), comparado com a lista exata. Alternativa aceitável: uma asserção global de que nenhuma função SECURITY DEFINER não-trigger desses schemas é executável por PUBLIC, mais a lista exata direta que já existe.
  - `has_table_privilege(papel, c.oid, ...)` e `has_any_column_privilege` em todas as relações de `public` e `identidade`, comparado com a lista.
  - `has_schema_privilege(papel, n, 'CREATE')` falso em todos os schemas. `has_schema_privilege(papel, n, 'USAGE')` só em `public` e `identidade`. `has_database_privilege(papel, current_database(), 'TEMPORARY')` falso.
  - Um autoteste com `GRANT EXECUTE ON FUNCTION <x> TO PUBLIC` dentro do ROLLBACK, como o atual.

### R2 (recomendação). Membros de `app_auth`

Só `app_provisionamento` tem a conferência de "ninguém é membro dele". Um `GRANT app_auth TO app_user` daria o schema identidade ao runtime. O bootstrap pega isso pelo `has_schema_privilege`, mas só quando roda. Estender a conferência de membros (excluindo o caso de O2) para `app_auth`.

## 3. Ordem de deploy

A ordem do PR (Terraform, bootstrap, 0080) está certa, mas incompleta.

### G2 (obrigatória antes do go-live). A trava só vale se a tarefa perder os outros segredos

O ganho do papel dedicado depende do #204. Se a definição da tarefa ou o papel de execução continuarem com `GetSecretValue` em `banco-app-auth` ou `banco-app-user`, uma tarefa comprometida volta a ter `app_user` e `app_auth`. Nesse caso, a 0080 só protege contra a API, não contra a tarefa. Condições:

- `banco-app-provisionamento` em `dados.tf`, no padrão do `banco-app-auth` (`sslmode=verify-full`, senha `ephemeral`);
- no #204, `secrets` da tarefa **só** com `DATABASE_PROVISIONAMENTO_URL`; o papel de execução lê só esse segredo de banco; a precondição de variáveis proibidas passa a recusar `DATABASE_URL` e `DATABASE_AUTH_URL` nessa tarefa;
- o papel da API **não** recebe `GetSecretValue` em `banco-app-provisionamento` (incluir na precondição do `app.tf`, linha 183).

Sequência completa:

1. Terraform: cria o segredo (sem mexer ainda na definição da tarefa).
2. Bootstrap com as **quatro** senhas lidas do Secrets Manager. Ele reaplica `ALTER ROLE ... PASSWORD` em todos os papéis. Uma senha errada ou desatualizada derruba a API, então isso vai no runbook.
3. 0080 (pelo caminho normal de migração). Sem o papel, ela falha com mensagem explícita e trava as migrações seguintes. Isso falha fechado, mas segura o release. O bootstrap tem de vir antes do merge que leva a 0080 ao ambiente.
4. Imagem nova e definição da tarefa do #204 juntas. Entre o passo 3 e o 4, a tarefa antiga (`app_user`) não consegue mais fundar clínica. Fica só indisponível, sem janela de fragilidade.
5. Conferência: rodar `guarda-papeis` contra staging (só lê `pg_catalog`) ou a consulta equivalente. Ver O2 antes.

Registrar essa sequência no runbook e na descrição do #204.

## 4. Ponto aberto: clínica sem fundador na sessão de sistema, sem trilha

**Não bloqueia este PR. Bloqueia o go-live (G3).**

Por que não bloqueia:

- Não é regressão. O comportamento é o mesmo antes e depois do PR.
- A linha fica **inerte**. Com `founder_user_id NULL`:
  - `clinic_members_guard` recusa qualquer vínculo. Pelo usuário, exige admin ou fundador igual à sessão. Pelo sistema, exige o fundador registrado.
  - O fundador só sai de NULL pelo `app_migrator` nominal (0047).
  - Ninguém ganha acesso nem dado.
- Não toca dado pessoal (só nome e id da clínica).
- O id da tarefa é `clinicaDoPedido(pedido)`, derivado do pedido. Pré-criar essa clínica exige conhecer o UUID do pedido. Mesmo assim, o resultado é falha da tarefa (unicidade ou guard do vínculo), não tomada da clínica. É DoS, não escalada.
- Quem consegue isso (`app_user`) já grava qualquer coisa em qualquer clínica pelo `app_set_tenant`. O ganho para o atacante é nulo.

Por que tem prazo:

- É criação de tenant sem trilha (art. 37 LGPD; registro das operações). Também é ruído operacional (cobrança, contagem de clínicas, encerramento).
- Agora existe o papel certo para fechar.

### G3 (obrigatória antes da primeira clínica real, em PR próprio)

- Em `tenants_founder_guard`, no INSERT com `founder_user_id IS NULL`, recusar, exceto quando `pg_has_role(session_user, 'app_migrator', 'MEMBER')`.
- Ajustar as fixtures da bancada para criar clínica pelo migrator ou com fundador.
- Teste: `app_user` (com sessão de sistema e com sessão de usuário) e `app_provisionamento` recebem 42501 ao inserir clínica sem fundador.
- Até lá, registrar no RIPD-identidade/plataforma como risco residual baixo, com o prazo.

## Recomendações e observações

- **R1. Enumeração de e-mails.** `SELECT (email)` em `identidade.usuario`, sem RLS, deixa a tarefa listar todos os e-mails de todas as contas. É menos do que o `app_auth` tinha, mas o uso real é pontual: buscar uma conta pelo e-mail e conferir o e-mail de uma conta. **Melhor:** duas funções SECURITY DEFINER em `identidade`, com REVOKE de PUBLIC e EXECUTE só para `app_provisionamento`. Uma, `conta_por_email(text) -> (id, ativo)`. Outra, `email_confere(uuid, text) -> boolean`. Com isso, sai o SELECT da coluna `email`. Não bloqueia (tarefa rara, portão IAM com duas pessoas), mas entra antes do PR 2.
- **O1. Leitura entre clínicas.** O papel pode chamar `app_set_tenant(<qualquer clínica>)` e ler `tenants`, `clinic_members` e `audit_log` dela. É o mesmo alcance do `app_user` nessas três tabelas e não chega a paciente, prontuário nem financeiro. Isso é aceitável com o portão IAM. Registrar no RIPD.
- **O2. Master do RDS como membro (PG16).** No RDS 16, quem cria um papel com CREATEROLE recebe ADMIN OPTION implícito sobre ele (linha em `pg_auth_members`). Por isso, o master é "MEMBER" de `app_provisionamento` para o `pg_has_role` e passa pela 0080 na sessão de sistema. Isso não muda o modelo de ameaça, porque o master já é break-glass e pode se conceder qualquer coisa. Mas duas coisas mudam:
  1. A guarda "ninguém é membro" falharia se rodada contra o RDS. No CI ela passa porque o papel é criado por superusuário.
  2. A verificação do bootstrap não olha os membros do papel.
  Documentar no runbook. Se a guarda for rodada contra staging (passo 5), aceitar só a linha do master com `admin_option` e sem `inherit_option`/`set_option`.
- **O3.** `app_user` continua com EXECUTE em `app_trilha_do_provisionamento` (0078). Isso é inofensivo agora (só lê a trilha da clínica do contexto), mas pode sair em migração futura.
- **O4.** O PR cita a A1 em `2026-11-16-codigo-provisionamento-pr1.md`, mas ali a A1 é do HMAC compartilhado (já resolvida). A origem certa é `2026-11-17-codigo-ativacao-do-fundador.md`. O comentário da 0080 já aponta para ela; se algum texto do PR ou do runbook apontar para o arquivo de 16/11, corrigir.

## Checklist LGPD

| Item | Situação |
|---|---|
| Base legal | Execução de contrato (art. 7º V) para provisionar a clínica contratada. Legítimo interesse em segurança (art. 7º IX). Não há dado de saúde (art. 11). |
| Minimização | Melhorou muito: sem UPDATE e DELETE na ativação, sem hash e HMAC, sem conta, sessão e fator. R1 resta (coluna `email`). |
| Consentimento | Não se aplica. |
| Criptografia | Em trânsito: o segredo novo tem de seguir `sslmode=verify-full` (G2). Em repouso: sem mudança (RDS cifrado, segredo no Secrets Manager com KMS). |
| Isolamento por tenant | RLS forçado nas três tabelas. Papel NOBYPASSRLS. O1 registrado. |
| Controle de acesso | Papel dedicado, NOINHERIT, sem `app_set_user`, fundação pelo sistema só por ele. G1 (guarda) e G2 (segredos da tarefa) pendentes. |
| Log de auditoria | Fundação com trilha obrigatória no COMMIT (0078) mantida. G3: clínica sem fundador continua sem trilha. |
| Retenção | Não toca prontuário (20 anos) nem a retenção da ativação (30 dias). |
| Segredos fora do código | Sim. Senha por variável de ambiente no bootstrap e por Secrets Manager no ECS. No CI, só a senha efêmera `ci-efemero`, já padrão. |
| Dados reais fora do git e de prompts | Sim. Só dados fictícios nos testes. |
| CFM, ANS e ICP-Brasil | Não aplicável a esta mudança. |

## Reconferência (17/11/2026, commit a3f4835)

**Veredito: APROVADO.** G1 fechada (bloqueio do merge removido). G2 continua obrigatória antes do go-live, no #204. G3 está registrada no RIPD com prazo e continua obrigatória antes da primeira clínica real, em PR próprio.

- Revisado: `git diff HEAD~1..HEAD` (6 arquivos, +271/-55). **Executei** `guarda-papeis.rls.test.ts` e `provisionamento.rls.test.ts` contra o Postgres 16 local (porta 54410, 0080 nova aplicada): 34/34 verdes. Também conferi o catálogo direto.
- **G1: fechada.** A guarda agora confere o privilégio efetivo, que inclui PUBLIC, posse e pertença:
  - `has_table_privilege`, `has_any_column_privilege` e `has_sequence_privilege` em todas as relações de `public` e `identidade`;
  - `has_function_privilege` nas funções não-trigger, com a lista de PUBLIC explícita;
  - `has_schema_privilege` (USAGE só em `public` e `identidade`, CREATE em nenhum);
  - `has_database_privilege` (sem TEMPORARY e sem CREATE).

  Há também a asserção global "nenhuma SECURITY DEFINER aberta a PUBLIC", que usa `acldefault` e por isso pega `proacl` nulo. Os autotestes com `GRANT EXECUTE ... TO PUBLIC` e `GRANT SELECT ON patients TO PUBLIC` provam que a leitura direta não vê esses grants e a efetiva vê.
- **R1: fechada.** `identidade.conta_por_email(text)` e `identidade.email_da_conta_confere(uuid, text)` conferidas no catálogo:
  - `prosecdef = true`;
  - `search_path = pg_catalog, identidade`, com a tabela qualificada por schema (pg_temp não sombreia);
  - dono `app_migrator`;
  - ACL só `app_migrator` e `app_provisionamento`, o que confirma o `REVOKE ALL ... FROM PUBLIC`;
  - `app_auth` sem EXECUTE.

  O SELECT de `email` e `ativo` saiu (`has_column_privilege(...email...) = false`, com teste 42501).
- **Enumeração.** Não há listagem nem curinga: a comparação é por `=` sobre `lower(email)`, com índice único, e não por LIKE. `email_da_conta_confere` exige o UUID e devolve só um booleano. O oráculo que resta, "este e-mail tem conta, ativa ou não", é inerente ao R2. Só serve a ataque de dicionário por quem já executa a tarefa (portão IAM com duas pessoas e MFA). Risco aceitável.
- **R2 e O2: fechadas.** Há conferência de "ninguém é membro" para os dois papéis, com autoteste `GRANT app_auth TO app_user`. O runbook traz a pertença do master e a ordem do deploy.
- **O1 e G3:** registradas no RIPD-identidade.
- **N1 (recomendação, não bloqueia).** `SO_ADMIN_DO_CRIADOR` tolera *qualquer* papel com ADMIN OPTION puro, não só o criador. Esse papel não herda nem usa o papel, mas pode concedê-lo a outro, e a guarda pega isso na rodada seguinte. Se a guarda for rodada contra staging, fixar a tolerância ao master (por exemplo, `r.rolname = current_setting('rds.master_user', true)` ou uma lista explícita).
- **N2 (opcional).** Acrescentar `pg_temp` ao fim do `search_path` das duas funções, como endurecimento padrão. Hoje é inócuo, porque tudo está qualificado.

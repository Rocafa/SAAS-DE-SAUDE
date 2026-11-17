# Parecer do Guardião LGPD: PR #208 (clínica sem fundador só pelo app_migrator, 0081)

**Veredito: APROVADO.** A G3 do parecer `2026-11-17-codigo-papel-provisionamento.md` está fechada. Há três recomendações
(R1 a R3), e nenhuma bloqueia o merge.

- **Escopo:** branch `eng/clinica-sem-fundador`, base `eng/papel-provisionamento`. Revisei a migração
  `0081_clinica_sem_fundador_so_pelo_migrator.sql`, `apps/api/test/apoio-clinica.ts`, os 9 arquivos de teste, o
  RIPD-identidade, o parecer do #207 e `api-dominio.md`.
- **Data:** 17/11/2026.
- **Ambiente:** Postgres 16 embutido local (porta 54410), banco efêmero com as migrações até a 0081 e dados fictícios.

## 1. O que foi conferido e como

| Ponto | Resultado | Evidência |
|---|---|---|
| A 0081 muda só o ramo do INSERT com fundador NULL | OK | `diff` do corpo de `tenants_founder_guard` entre a 0080 e a 0081: o resto da função está idêntico. |
| Critério "é o app_migrator" usa `session_user` | OK | O teste é `pg_has_role(session_user, 'app_migrator', 'MEMBER')`. O `session_user` segue o login e não muda com SECURITY DEFINER nem com `SET ROLE`. |
| Contorno por `SET ROLE app_migrator` (a partir do app_user) | Recusado | 42501 `permission denied to set role`. O app_user não é membro. |
| Contorno por `SET SESSION AUTHORIZATION` | Recusado | 42501. Só superusuário pode fazer isso. |
| Contorno por função SECURITY DEFINER de dono app_migrator, com EXECUTE para o app_user | Recusado pelo trigger | 42501 "clínica nova nasce com o fundador…". O `current_user` vira app_migrator, mas o `session_user` continua app_user. |
| O runtime cria a própria função ou desliga o trigger | Recusado | `CREATE FUNCTION` dá 42501 (sem CREATE em `public`). `ALTER TABLE … DISABLE TRIGGER` dá "must be owner": o dono de `tenants` é o app_migrator. |
| Membros de `app_migrator` no banco | Nenhum | Consulta a `pg_auth_members`: nenhum papel herda app_migrator. |
| INSERT sem fundador por app_user (sessão de sistema e de usuário) | 42501 do **trigger** | Mensagem do `tenants_founder_guard`. O trigger BEFORE roda antes do WITH CHECK do RLS. |
| INSERT sem fundador por app_provisionamento (sessão de sistema) | 42501 do **trigger** | Idem. |
| INSERT por app_auth | 42501 por **GRANT** | `permission denied for table tenants`: o app_auth não tem privilégio nenhum em `tenants`. |
| UPDATE do fundador NULL → usuário da sessão, pelo runtime | Recusado | 42501 "fundador da clínica é imutável". O ramo de UPDATE (0047/0080) exige `current_user` e `session_user` membros de app_migrator. |
| UPDATE do fundador X → NULL | Recusado | Pela leitura do ramo da 0042/0047 (`NEW.founder_user_id IS NOT NULL` é exigido). Não muda na 0081. |
| UPDATE de qualquer coluna por app_provisionamento | Recusado | Sem GRANT de UPDATE. A 0080 dá só SELECT e INSERT. |
| DELETE e TRUNCATE de `tenants` | Recusado para app_user, app_auth e app_provisionamento | Só o app_migrator (dono) tem DELETE e TRUNCATE. O app_user teve o DELETE revogado na 0001. |
| O helper chega à produção | Não chega | O helper fica em `apps/api/test/` e não é importado de `src/`. O `tsconfig.build.json` inclui só `src`. A `DATABASE_MIGRATOR_URL` é proibida na tarefa da API (`infra/terraform/staging/app.tf`, validação) e só existe na tarefa de migração. |
| A suíte passa | OK | `test:rls`: provisionamento, crypto, tenant-isolation, retencao-custodia, exit-guarantee e audit-chain, com 71/71. `test:security` (`db-attacks`): 47/47. |
| Dados reais e segredos | OK | Só "Clinica Ficticia …" e UUIDs aleatórios. Nenhuma URL nem senha no código. |

**Conclusão sobre UPDATE e DELETE:** já estão cobertos e não precisam de mudança neste PR. O UPDATE do fundador é
imutável para o runtime. O DELETE e o TRUNCATE não têm GRANT para nenhum papel de runtime.

## 2. Recomendações (não bloqueiam)

- **R1. O teste prova o código 42501, e não a camada que recusou.** No banco, 42501 também vem de RLS ("violates
  row-level security policy") e de GRANT. No caso do `app_auth`, a recusa vem do GRANT, não do trigger. O resultado é
  correto, mas o nome do teste dá a entender que é o trigger. Correção sugerida:
  - Para app_user e app_provisionamento, conferir também a mensagem (`/nasce com o fundador/`), para que uma regressão
    do trigger não fique escondida atrás do RLS.
  - Acrescentar o caso da função SECURITY DEFINER de dono app_migrator chamada pelo app_user. Reproduzi o caso nesta
    revisão, mas ele não está na suíte.
  - Mudar o rótulo do app_auth para "sem GRANT em tenants".
- **R2. Trilha da clínica criada pelo app_migrator.** O caminho permitido não grava `tenant_create` em `audit_log`
  (LGPD art. 37). Hoje isso é aceitável: são migrações, seeds e operadores nominais, por trás do IAM da tarefa de
  migração. Antes da primeira clínica real, o runbook deve exigir o registro do chamado e do operador (CloudTrail) em
  toda criação manual por esse papel.
- **R3. Guarda de pertença ao app_migrator.** A robustez da 0081 depende de nenhum papel de runtime ser membro de
  `app_migrator`. Isso vale hoje (consulta acima). Recomendo estender a conferência "ninguém é membro" da 0080 (R2/O2
  do #207) ao `app_migrator`, tolerando só o master e os operadores nominais. Assim, um `GRANT app_migrator TO
  app_user` acidental não reabre a G3 em silêncio.

## 3. Observação de ambiente (sem efeito no PR)

Na sonda, uma clínica fictícia criada pelo app_migrator não pôde ser apagada, por causa da FK de `job_tenant_index`.
Ela ficou no banco efêmero local, que é descartável. O script da sonda está no scratchpad da sessão e fica fora do git.

## 4. Pendências que seguem

- **G2 (#204):** continua aberta, fora do escopo deste PR.
- **O1:** continua como risco aceito no RIPD-identidade §8.
- **N1 e N2 do parecer do #207:** continuam como recomendações.

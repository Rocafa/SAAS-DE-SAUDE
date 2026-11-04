# Parecer do Guardião: PR #135, consulta da trilha pela clínica (E10)

- **Data:** 04/11/2026
- **Branch:** `eng/consulta-trilha` (diff `main...eng/consulta-trilha`)
- **Escopo:** `apps/api/src/modules/audit/consulta-trilha.ts`, testes (`consulta-trilha.test.ts`, `test/consulta-trilha.rls.test.ts`), listas de cobertura, perfis e docs.
- **Base:** [revisão interna dos profissionais, E10](2026-11-04-revisao-interna-profissionais.md); contrato da metadata (0005); pseudônimo do suporte (0059); LGPD arts. 6º (VI, VII, X), 18, 19, 37, 46 e 48; Código de Ética do Psicólogo art. 9º; Res. CFP 001/2009.
- **Verificado:** o teste de unidade roda (4/4). Não há Postgres local: o teste RLS **não foi executado** nesta revisão.

## Veredito

**VETADO** até a R1 (paginação perde linhas da trilha em silêncio) e a R2 (o teste não prova completude). O desenho está certo e o resto são ressalvas: R3 e R4 antes do piloto, R5 a R8 na fila.

O que está bom: só `admin` (`auditoria:consultar`) com MFA recente; filtros validados com lista fechada (campo desconhecido, uuid, data, período invertido, `acao` fora de `AuditAction`, limite 1–100); tudo parametrizado pelo Drizzle (o `sql\`...->>'patient_id' = ${...}\`` vira parâmetro, sem injeção); `lerNaClinica` + `tenant_id` explícito + RLS; a própria consulta vai para a trilha com só ids e a contagem; rota nas listas de cobertura (leitura auditada, MFA recente) e no teste de leitura entre papéis.

## Ressalvas

### Bloqueiam o merge

**R1. O cursor trunca o horário e pula linhas.** `created_at` é `timestamptz` com microssegundos, gravado pelo trigger da 0005 com `now()` (o horário da transação: todas as linhas de uma transação têm o mesmo valor). O cursor guarda `Date.toISOString()` (milissegundos). Na página seguinte, `created_at < em OR (created_at = em AND id < id_do_cursor)`: toda linha mais antiga que a última da página, mas no mesmo milissegundo (inclusive as irmãs da mesma transação com `id` menor), não satisfaz nem o `<` nem o `=` e **some** da consulta. Para uma ferramenta de investigação e de resposta ao titular (arts. 19 e 37), perder linha em silêncio é defeito material.
**Correção:** paginar por `seq` (único por clínica, índice `audit_log_tenant_seq_idx`, é a ordem da cadeia; ordenar `seq DESC` e cursor `seq < $1`). Ainda não há linha de produção sem `seq` (anteriores à 0005); se houver em algum ambiente, tratar à parte. Alternativa pior: levar o `created_at` no cursor como texto com microssegundos vindo do banco.

**R2. Os testes não provam o que dizem.** (a) A paginação só confere que não há repetição, não que nada falta: comparar a união das páginas (`limite=2`) com a consulta sem cursor (`limite=100`), com pelo menos uma transação que grave 2+ linhas (o caso da R1). (b) O teste de unidade do cursor usa uma data em milissegundos, então não pega a R1. (c) "Nunca mostra outra clínica" só é checado pela ausência do nome do paciente fictício; falta conferir que nenhum `id` devolvido pertence às linhas da outra clínica (e o inverso, com o admin da outra). (d) Rodar o RLS no CI e anexar o resultado ao PR.

### Antes do piloto

**R3. Filtro por paciente sem índice.** Só existe `(tenant_id, created_at)`. O filtro `metadata->>'patient_id'` (e o `actor_id`) percorre a trilha inteira da clínica de trás para frente até achar `limite` linhas; para um paciente com poucos acessos, isso é varrer anos de trilha (que cresce a cada leitura e é guardada pelo prazo do prontuário, 20 anos). **Correção:** migração com `CREATE INDEX CONCURRENTLY ... ON audit_log (tenant_id, (metadata->>'patient_id'), seq DESC) WHERE metadata ? 'patient_id'` e `(tenant_id, actor_id, seq DESC)`; `statement_timeout` curto na transação da consulta; conferir o `EXPLAIN` no staging com volume sintético.

**R4. Metadata devolvida crua: allowlist e minimização na psicologia.** A resposta repassa `l.metadata` inteiro. O contrato da 0005 barra nome, texto e contato, mas deixa passar chaves como `hidden` (o profissional ocultou conteúdo), `template` (pode nomear a especialidade), `export_consent`, `count` e `version`.
Sobre o sigilo: o admin ver **que** um psicólogo acessou o prontuário ou as notas privadas do paciente X, e quando, **é necessário ao controlador** (dever de segurança e de prestar contas, arts. 6º X, 37, 46 e 48; responder ao titular, art. 19) e não viola o sigilo do art. 9º do Código de Ética, que protege o conteúdo e o que o psicólogo soube no atendimento. Ids, ação e data não são conteúdo, e a clínica já sabe pela agenda que X é atendido pelo psicólogo. O que passa do necessário é o detalhe: quantas notas privadas existem, se há consentimento de exportação, se o conteúdo foi ocultado, qual modelo.
**Correção:** mapear a metadata por allowlist de chaves (ids, `op`, `count` fora da psicologia, `reason`, `ticket`, `care_basis`, `filter_*`); nos escopos `private_notes`, `adolescent_confidentiality_requests` e no compartimento de psicologia, devolver só ids do paciente e da nota, `op` e `care_basis`. Teste que prove que `hidden`, `export_consent` e `template` não saem. Registrar no RIPD esse tratamento (admin vê os acessos ao compartimento de psicologia, sem conteúdo) e levar junto da pergunta 1.11 ao advogado (D8).

### Fila

**R5. O filtro por paciente não é "todos os acessos a X".** Só pega linhas com a chave `patient_id`. Listas e lotes (`GET /agendamentos`, caixa, exportação, importador, jobs) gravam contagem e não citam o paciente. Documentar em `api-dominio.md` §18 e na resposta ao titular ("acessos individuais ao seu cadastro e prontuário; listas da agenda não são individualizadas") e checar, na lista de cobertura, que toda leitura **individual** de paciente grava `patient_id`.

**R6. Linhas do suporte e do portal: OK, como desenhado.** O pseudônimo do suporte foi feito para a clínica ler ("o suporte X fez A e B", sem ligar clínicas nem chegar à pessoa); `ticket` e `reason` são o que a 0059 manda mostrar. Linha do portal com a conta do paciente: a clínica é a controladora e já vê os vínculos do portal. Nenhuma mudança; só manter o pseudônimo fora de qualquer junção com outra clínica no front (não cruzar `atorId` de suporte com tabela de usuários).

**R7. Cursor sem assinatura.** Hoje é só posição (data e id; com a R1, `seq`) e os filtros e a clínica são reaplicados a cada página, então adulterar não dá acesso a nada além de pular página. Aceito. Se o cursor passar a carregar filtro, assinar com a `PAGINATION_CURSOR_KEY`, como as outras listas.

**R8. Período sem teto e sem teste.** Sem `de`/`ate`, a consulta vai até o começo da trilha (custo, R3). Considerar teto (ex.: 366 dias por consulta) e incluir teste de `de`/`ate` no RLS (hoje só a unidade cobre a validação; a borda do `ate` inclusivo não é testada).

## Checklist do Guardião

| Item | Situação |
|---|---|
| Base legal | Art. 7º II e art. 11 II "a" (obrigação legal de segurança e guarda) e art. 37; finalidade: investigação e resposta ao titular |
| Minimização | Parcial: R4 (allowlist da metadata) |
| Consentimento | Não se aplica |
| Criptografia trânsito/repouso | Herdada (TLS, RDS cifrado); nada novo |
| Isolamento por tenant | `lerNaClinica` + `tenant_id` + RLS; teste fraco (R2c) |
| Controle de acesso | Admin + MFA recente; nas listas de cobertura |
| Log de auditoria | A consulta é auditada com os filtros (só ids) |
| Retenção | Trilha guardada com o prontuário (20 anos); motiva o índice (R3) |
| Segredos fora do código | OK |
| Dado real fora do git | OK (dados fictícios nos testes) |
| CFM/CFP/ANS/ICP | CFP: sem conteúdo, só o fato do acesso (R4) |

## Nota do Maestro (04/11/2026)

- **R1 (feita):** o cursor agora é o id da última linha. A comparação `(created_at, id) <` usa o horário exato dela no banco, lido por subconsulta, sem arredondar para milissegundos. Linhas da mesma transação não somem mais entre as páginas. Não usei `seq`, que não está no schema do Drizzle e é nulo nas linhas anteriores à 0005.
- **R2 (feita):** o teste RLS confere que a paginação traz o mesmo conjunto de uma página única (nada falta) e que nenhum id da trilha da outra clínica aparece.
- **R3 (feita):** a migração 0061 cria um índice parcial por `(tenant_id, metadata->>'patient_id', created_at, id)` e um índice por `(tenant_id, actor_id, created_at, id)`. A consulta roda com `statement_timeout` de 5 s.
- **R4 (feita):** a metadata devolvida passa pela lista fechada `CHAVES_VISIVEIS` (ids e códigos), e `hidden`, `template`, `export_consent` e as contagens ficam de fora. Testes unitário e RLS conferem isso. O registro no RIPD e na pergunta 1.11 foi para a fila.
- **Fila do parecer (feito):** teto de 366 dias no período, com teste de `de` e `ate`.
- **Fila do parecer (documentado):** o filtro por paciente só pega linhas com `patient_id`. Listas e lotes não entram.

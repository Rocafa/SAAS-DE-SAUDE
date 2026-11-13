# Revisão de código: conselho e número de registro do profissional (PR #194)

**Veredito: VETADO** (1 bloqueante, B1). Corrigido o B1, aprovo com as ressalvas R1 a R6 registradas como pendência.

- Branch: `eng/registro-no-conselho` (commit 584d73c), diff `origin/main...HEAD`, 10 arquivos.
- Revisor: guardião LGPD & segurança, 13/11/2026.
- Base normativa: Res. COFFITO 414/2012 e 415/2012, art. 1º §1º VIII (identificação de quem registra: nome completo e número no CREFITO), conferidas pelo autor do PR e por este revisor; LGPD art. 6º III (necessidade) e V (qualidade dos dados), art. 7º II (obrigação regulatória) e art. 18 III (correção).
- Verificação local: `registro-no-conselho.test.ts` 2/2 verde. No CI, no momento da revisão, "Isolamento entre tenants (RLS)" e "Lint, typecheck e testes" ainda estavam pendentes: o aceite depende deles verdes.

## O que está certo

- **Base legal:** art. 7º II (obrigação regulatória do conselho). O número no conselho é dado pessoal do profissional (identifica pessoa natural), mas não é sensível (art. 5º II) e é público na consulta do próprio conselho. Não precisa de consentimento.
- **Minimização:** só conselho (lista fechada) e número. `exigirObjeto` recusa campo a mais; CHECK no banco espelha a regex; par "os dois ou nenhum" (`0074_registro_no_conselho.sql:15`).
- **Controle de acesso:** `cadastros:gerir` + `@ExigeMfaRecente` (`scheduling.controller.ts:101-103`), na lista de cobertura de auditoria e de MFA (`test/cobertura-auditoria/lista.ts`).
- **Isolamento:** filtro por `tenantId` no SELECT FOR UPDATE e no UPDATE, sobre a policy `tenant_isolation` já existente em `professionals` (0007). Teste de outra clínica devolve 404.
- **Trilha sem o número:** aceitável e coerente com a política de trilha mínima. O dado é público, então guardar o número na trilha não seria grave, mas a trilha é longa e replicada; a alternativa certa é o histórico do B1, não a trilha.
- **Exportação G2:** `tenant-export.ts` 1.25.0 inclui `council` e `councilRegistration` em `professionals[]`; testes de exportação usam `EXPORT_SCHEMA_VERSION`, sem número fixo a quebrar.
- **Retenção:** a linha de `professionals` não é apagada (`REVOKE DELETE` na 0007), então acompanha os 20 anos do prontuário.
- **Numeração 0074:** o runner (`scripts/migrate.mjs:29-32`) aplica o que não está em `schema_migrations` em ordem de nome, com lacuna. Conferi 0065–0073 da pilha do login (`origin/eng/anonimizacao-suporte`): nenhuma altera `professionals` (a 0072 só cita em comentário). Ordem de aplicação indiferente.
- **Testes sem verde falso:** o teste RLS por SQL direto usa o papel da aplicação via `withTenant` e confere o código 23514; o 404 entre clínicas não pode passar por 403 de MFA; a trilha é comparada por igualdade exata e sem "123456". Dados fictícios.

## Bloqueante

**B1. A troca do número apaga o número que valia quando o registro clínico foi feito.** `scheduling.service.ts:401` sobrescreve `council`/`council_registration`, e a trilha (`:408`) não guarda o valor anterior. Quando o profissional muda de região (ex.: CREFITO-3 para CREFITO-2) ou o admin corrige um erro, toda evolução antiga passa a sair, na tela e na exportação (`tenant-export.ts:360-361`, um valor só por profissional), com o número novo. Isso contraria o próprio fim declarado no PR (identificar quem registrou, COFFITO 414/415 art. 1º §1º VIII) e o art. 6º V (qualidade), e não tem volta depois de usado em produção.
**Correção (uma das duas):**
- (a) tabela `professional_council_history (tenant_id, professional_id, council, council_registration, valid_from, set_by)` só de INSERT (sem UPDATE/DELETE para `app_user`), com RLS por tenant, preenchida na mesma transação de `definirRegistroNoConselho`, e exportada no G2; ou
- (b) gravar conselho e número no registro clínico no momento da assinatura (retrato imutável).
Um teste deve provar que, depois de uma troca, o valor anterior continua recuperável e exportado.

## Ressalvas (não bloqueiam após o B1; registrar pendência)

**R1. Duas fontes para o mesmo dado.** `professional_fiscal_profiles.council_registration` (0018:51-52; `financeiro.service.ts:230`; recibo em `recibos.service.ts:485`) já guarda o número em texto livre (com espaço e com a sigla, ex.: "CREFITO-0 00000-TO"), gerido por outra permissão. O recibo e o prontuário podem mostrar números diferentes do mesmo profissional (art. 6º V). Definir `professionals` como fonte única e o recibo lê dali (ou migrar e descontinuar o campo fiscal) em microparte própria.

**R2. O formato não impede nome, só espaço.** `scheduling.validation.ts:123` e o CHECK da 0074:12 aceitam "FulanoDeTal" ou "fulano.tal". Exigir ao menos um dígito (`(?=.*[0-9])` na regex e `council_registration ~ '[0-9]'` no CHECK) e acrescentar o caso ao teste (`registro-no-conselho.test.ts:24`). O título do teste (`:22`) promete "sem ecoar o valor", mas nada confere isso: verificar que a mensagem/campos do erro não contêm o valor enviado.

**R3. Quem altera.** Admin com MFA está correto: a clínica (controladora) responde pela identificação do autor e deve conferir o número na consulta pública do conselho antes de gravar. Não recomendo o próprio profissional editar sem conferência (autodeclaração vira assinatura no prontuário). Recomendo: (i) o profissional VER o próprio registro (art. 18 I/II) e pedir correção ao admin (art. 18 III); (ii) avisar o profissional quando o admin trocar o número dele (mesmo canal de `avisos.ts`).

**R4. Lista de conselhos.** Para o nicho de entrada (fisio/TO, psicologia, fono/TEA, nutrição, odonto, medicina) a lista cobre: CREFITO (fisio e TO), CRP, CRFa, CRN, CRO, CRM. Faltam para os nichos já pesquisados: **COREN** (enfermagem, clínicas multiprofissionais e estética), **CRBM** (biomedicina, estética: `docs/01-mercado/nichos/estetica.md:51`), **CRF** (farmácia, estética) e **CREF** (educação física: pilates e reabilitação em clínica de fisio). Acrescentar ao menos COREN agora (é só o CHECK e `CONSELHOS`); os demais podem esperar a onda do nicho. Profissionais sem conselho (AT, psicopedagogo, esteticista) ficam com o par nulo, o que o desenho já permite.

**R5. Não há como limpar o registro.** A rota só define; não aceita nulo. Se o número foi lançado no profissional errado, o admin não consegue removê-lo (art. 18 III/VI). Aceitar `{conselho: null, registro: null}` com a mesma trilha, depois do histórico do B1.

**R6. Documentação e cobertura de teste.**
- `docs/04-arquitetura/api-dominio.md:508`: a linha entrou no meio da tabela R1–R4 do portal (colunas "Item / O que mudou / Prova"); mover para a tabela de rotas de cadastro.
- Falta caso de segunda definição (`had_registration: true`) no teste RLS.
- A sessão do portal lê `professionals` sem restrição de coluna (0027:270-272), então passa a enxergar `council_registration` por SQL. O dado é público e já sai no recibo; aceito, mas registrar na nota da 0027 que a coluna é deliberadamente visível.

## Checklist

| Item | Situação |
|---|---|
| Base legal (art. 7º/11) | OK (art. 7º II; não sensível) |
| Minimização | OK, com R2 |
| Consentimento | Não se aplica |
| Criptografia em trânsito/repouso | Sem mudança (texto em claro aceitável: dado público, não sensível) |
| Isolamento por tenant | OK |
| Controle de acesso | OK (admin + MFA), R3 |
| Trilha de auditoria | OK, sem o número; histórico via B1 |
| Retenção (20 anos) | Falha parcial: B1 (valor histórico se perde) |
| Segredos / dados reais | Nenhum; dados fictícios |
| COFFITO 414/415 | Atende no valor atual; B1 para o histórico |

## Reconferência (13/11/2026)

**Veredito: VETADO** (novo bloqueante B2). O desenho do B1 está correto; o que impede é a migração 0074 quebrada, que deixou toda a prova sem rodar.

Commit conferido: 7c7954a (`git pull` sem novidades). CI do commit: "Isolamento entre tenants (RLS)", "Testes ofensivos", "Resiliência", "DAST", "Carga" e "conferência das guardas" **falharam** no `db:migrate` com `PostgresError: syntax error at or near "["` na 0074.

### B2 (bloqueante). `0074_registro_no_conselho.sql` não aplica

A edição do R2 colou o trecho no lugar errado (linhas 12-20): o literal da regex ficou sem `$'` de fechamento, o `AND council_registration ~ '[0-9]');` caiu depois do `professionals_council_pair_check`, e o `ADD CONSTRAINT professionals_council_pair_check` aparece duas vezes. O SQL é inválido em banco novo. Se ninguém tivesse visto, teria passado para a main **sem as colunas e sem o CHECK**. Os testes locais só passam em banco onde a 0074 antiga já estava em `schema_migrations` (o runner não reaplica), e isso é **verde falso**: nenhum teste do B1 e do R2 no banco rodou de verdade.
**Correção:** a linha 12-13 deve ficar `CHECK (council_registration ~ '^[A-Za-z0-9][A-Za-z0-9./-]{0,29}$' AND council_registration ~ '[0-9]');`, com **um** só `professionals_council_pair_check`. Depois, recriar o banco de teste do zero (sem `schema_migrations` herdado), rodar `test:rls` inteiro localmente e esperar o CI verde nos jobs que hoje falham.

### B1: desenho resolvido (aceite condicionado ao B2 e ao CI verde)

- **Ordem dos triggers:** os dois são `BEFORE UPDATE ... FOR EACH ROW` em `encounters`. O Postgres dispara por ordem de nome, então `encounters_guard` roda antes de `encounters_snapshot_council` ("g" < "s"). Não há outro BEFORE UPDATE na tabela (0012/0015 conferidas).
- **Transição open→signed:** o guard deixa passar (`OLD.status = 'open'`) e o snapshot **sobrescreve** qualquer valor que a aplicação mande, com o que está em `professionals`. A aplicação não escolhe o valor. O CHECK `encounters_signed_council_only_when_signed` e o ramo `ELSIF` (42501) impedem gravar antes de assinar. Depois de assinado, o guard dá 55000 antes de chegar ao snapshot.
- **Restringir o sigilo de atendimento assinado:** continua funcionando. O guard aceita e retorna cedo; no snapshot, `OLD.status = NEW.status = 'signed'` e o registro não muda, então ele não dispara erro. Assinar e mudar o sigilo no mesmo UPDATE continua recusado (`semSigilo` difere).
- **RLS na leitura de `professionals`:** a função é SECURITY INVOKER (sem `SECURITY DEFINER`), com `search_path` fixo. Ela lê sob a policy `tenant_isolation` (0007, FORCE) da sessão `app_user`, que já está na clínica do atendimento, e filtra por `NEW.tenant_id`. A FK `(professional_id, tenant_id)` (0012:70) garante que o profissional é da mesma clínica. Não há leitura entre clínicas.
- **DTO e exportação:** `conselhoNaAssinatura`/`registroNaAssinatura` vêm do `.returning()` do finalizar e da leitura; `encounters[].signedCouncil*` saem no G2 1.25.0. OK.

### Testes (depois do B2)

- O 1º teste prova o essencial: assina com 3/111111-F, troca o cadastro para 4/222222-F, e a leitura continua 3/111111-F. O UPDATE direto em assinado dá 55000. OK.
- **Ressalva T1:** o 2º teste aceita `23514 || 42501`. O caminho real é 42501 (o trigger BEFORE roda antes do CHECK). Fixar `toContain('42501')` e testar o CHECK à parte (por exemplo, INSERT com `signed_council` em `open`).
- **Ressalva T2:** falta a prova de que restringir o sigilo de um atendimento **assinado** continua funcionando depois da 0075 (no teste de `prontuario.rls.test.ts:516`, o `atNovo` não está finalizado). Acrescentar a finalização antes do `restringirAnteriores` ou fazer um caso próprio.
- **Ressalva T3:** falta conferir no teste da exportação que `encounters[].signedCouncilRegistration` sai com o valor congelado depois da troca. O parecer original pedia que "continua recuperável **e exportado**".
- **Ressalva T4:** os atendimentos assinados antes da 0075 ficam com nulo (não dá para saber o número da época). Aceitável, mas registrar isso na nota da migração e na documentação de exportação.

### R2, R4 e R6

- **R2:** a validação está OK (`scheduling.validation.ts:129`, exige dígito, teste com "FulanoDeTal"). No banco, **falha** por causa do B2. Continua pendente: conferir que o erro não devolve o valor enviado, como promete o título do teste.
- **R4:** COREN entrou em `CONSELHOS` e no CHECK. OK (CRBM, CRF e CREF ficam para a onda de cada nicho, como combinado).
- **R6:** a linha foi movida para a tabela de rotas de cadastro do `api-dominio.md` e saiu da tabela R1–R4. OK. Continuam pendentes o caso `had_registration: true` e a nota sobre a 0027.
- R1, R3 e R5 continuam como pendência registrada (não bloqueiam).

### Checklist (delta)

| Item | Situação |
|---|---|
| Retenção / COFFITO 414/415 (histórico) | Resolvido no desenho (0075); depende do B2 |
| Isolamento por tenant | OK (INVOKER sob RLS + FK composta) |
| Integridade do prontuário assinado | OK (guard + snapshot; sigilo só restringe) |
| Testes sem verde falso | **Falha**: a 0074 não aplica em banco novo; o CI está vermelho |

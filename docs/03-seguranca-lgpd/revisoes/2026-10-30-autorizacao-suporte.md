# Parecer do Guardião LGPD: PR #115 (`eng/autorizacao-suporte`)

- **Data:** 30/10/2026
- **Escopo:** `git diff main...eng/autorizacao-suporte` (commit `1b4867f`, 13 arquivos): migração `0059_autorizacao_de_suporte.sql`, `schema.ts`, `audit.module.ts`, `autorizacao-suporte.ts`, `perfis.ts` (`suporte:autorizar` = `admin`), `tenant-export.ts` (G2 1.23.0), `test/autorizacao-suporte.rls.test.ts`, ajustes em `exit-guarantee`, `exportacao-cobertura`, `guarda-schema` e `sessao-tenant.security`, `api-dominio.md` §16 e `auditoria-encadeada.md` §4c. Lado da clínica do **S9** ([requisitos-tecnicos-seguranca.md](../requisitos-tecnicos-seguranca.md) §2, linha 42).
- **Testes:** não rodei nada (não há Postgres local). Li o diff inteiro e conferi fora dele: CHECK `audit_log_actor_shape_check` (0008), `audit_log_chain` (0005/0008/0033: ordem dos gatilhos e caminho de "carga"), `app_user_has_role` (0020), os `INSERT INTO audit_log` de funções `SECURITY DEFINER` (0022, 0038, 0039, 0040), `recordSupportAudit` (`ator-suporte.ts`), `escreverNaClinica`/`lerNaClinica` e a nota de `pg_restore` em `auditoria-encadeada.md`. CI (`gh pr checks 115`) no fim deste parecer.

## Veredito: **APROVADO COM RESSALVAS**

Sem bloqueio para o merge, condicionado ao CI verde (inclusive **Isolamento entre tenants (RLS)**). A mudança só **restringe**: nenhum dado novo de paciente, nenhuma rota de suporte nova, e a trilha passa a recusar a linha `pedido_da_clinica` sem autorização da clínica. As ressalvas R1 e R2 são **condição para a primeira rota/ferramenta de acesso de suporte** (D4), não para este merge. R3 a R7 podem vir neste PR ou no próximo.

## Conferência

| Item | Situação |
|---|---|
| Base legal | Acesso do operador (suboperador do controlador-clínica) só sob instrução documentada do controlador: art. 39 LGPD; segurança art. 46/47. A autorização é exatamente essa instrução, com prazo. ✅ |
| Minimização | Tabela só com ids, chamado (`SUP-n`) e datas. Trilha da autorização: `grant_id`, `ticket`, `hours`/`op`; leitura só `count`. Nada de paciente, nem motivo em texto livre. ✅ |
| Criptografia | Nada novo a cifrar (sem dado pessoal sensível); trânsito/repouso já cobertos pela plataforma. ✅ |
| Isolamento por tenant | RLS `ENABLE`+`FORCE`, `tenant_isolation` com `WITH CHECK`; o gatilho da trilha filtra `g.tenant_id = NEW.tenant_id` **explicitamente** (vale mesmo se um dia rodar com dono/`SECURITY DEFINER`); `app_user_has_role` amarra o perfil à clínica da sessão. Teste cobre "a autorização de A não vale em B" e 404 na revogação cruzada. ✅ |
| Portal | `portal_fora` RESTRICTIVE; rota exige `SessaoGuard` + perfil `admin` no banco; `guarda-schema` inclui a tabela na lista do portal. ✅ |
| Controle de acesso | Permissão `suporte:autorizar` só `admin`, conferida na API (`exigirPerfilNoBanco`) e no banco (gatilho: usuário da sessão, perfil ativo, autor = sessão). Imutável após criada, salvo a revogação (uma vez, terminal); sem DELETE/TRUNCATE. ✅ |
| Auditoria | Criar, revogar e listar auditados; a autorização entra no pacote G2 (transparência para a clínica). ✅ |
| Retenção | Não se apaga; acompanha a trilha (prova de quem autorizou o quê). ✅ |
| Segredos e dados reais | Nenhum no diff; atendente e clínicas fictícios nos testes. ✅ |
| CFM/ANS/ICP-Brasil | Não toca prontuário nem assinatura. Reforça o sigilo (CEM art. 73; Res. CFM 1.821/2007, acesso restrito e rastreável). ✅ |

## Respostas às perguntas do PR

1. **O gatilho da trilha é contornável?**
   - *Outro caminho de INSERT:* não por SQL. O gatilho é `BEFORE INSERT` na tabela, vale para `recordSupportAudit`, SQL direto e funções `SECURITY DEFINER`. As que inserem em `audit_log` hoje (0022, 0038–0040) não gravam `suporte_plataforma` (o tipo é deduzido como `sistema`/`usuario_clinica`, nunca suporte). O caminho de "carga" (elos prontos) também passa pelo gatilho; o `pg_restore` carrega dados antes de criar gatilhos, então a restauração não quebra (doc §restauração).
   - *Ordem dos gatilhos:* `audit_log_chain` roda antes (ordem alfabética) e não mexe em `metadata`; o `WHEN` é avaliado depois dela. O CHECK da 0008 limita `reason` a `pedido_da_clinica`/`break_glass`, então não há terceiro motivo que escape. ✅
   - *Sessão de sistema:* o banco não tem como saber que um acesso gravado como `sistema` ou `usuario_clinica` foi, na verdade, do suporte. A garantia depende do fluxo do operador gravar como suporte. Ver R2.
   - *`SECURITY DEFINER` / dono:* filtro explícito de tenant no `EXISTS` mantém o resultado correto; donos dessas funções já são proibidos de ser superusuário/BYPASSRLS. Desligar o gatilho exige o dono da tabela (migrador) ou superusuário: risco de infra, fora do escopo.
   - *O contorno real é o motivo:* basta gravar `reason = break_glass` para não precisar de autorização. Ver R1.
   - *`now()` da transação:* uma transação aberta antes do vencimento e mantida depois ainda passa. O `created_at` da linha também é o `now()`, então a trilha fica coerente, mas o acesso real pode ocorrer depois do prazo. Ver R3.
2. **Prazo de 72 h e recálculo pela data do banco:** corretos. O gatilho preserva a duração pedida e reancora em `now()`; o CHECK (avaliado depois do gatilho) barra > 72 h e ≤ 0; `granted_at` explícito no passado não estende nada; `granted_at` nulo cai em NOT NULL. A API limita 1..72 (padrão 24). ✅
3. **Vazamento ao portal ou a outra clínica:** não encontrei. Ver "Isolamento" e "Portal" acima.
4. **Revogação em `escreverNaClinica`:** aceitável **por ora**, porque o risco residual é limitado a ≤ 72 h. Mas revogar só diminui exposição e não deveria depender de pagamento. Ver R4.
5. **Break-glass sem autorização até a D4:** aceitável **só** porque hoje não existe nenhuma rota/ferramenta que chame `recordSupportAudit` (conferido: único caller é teste). O requisito §2 é explícito: o acesso nosso é "somente break-glass com chamado da clínica, aprovação de 2 pessoas, sessão gravada, expiração automática". Ver R1.
6. **Metadata minimizada:** sim (ver tabela). ✅

## Ressalvas

**R1 (condição para a D4; recomendado já) — `break_glass` contorna toda a autorização da clínica.**
`apps/api/db/migrations/0059_autorizacao_de_suporte.sql:11-12` e `:92` (o gatilho só confere `pedido_da_clinica`). Qualquer acesso de suporte gravado como `break_glass` entra sem chamado autorizado, sem aprovação dupla e sem alerta. Isso diverge do MUST de `requisitos-tecnicos-seguranca.md:42` ("proibido por padrão") e de `:41` (break-glass exige alerta ao gestor e revisão posterior).
Correção, em uma de duas formas: (a) **recomendado:** já neste PR, o gatilho recusa `break_glass` (`42501`, "break-glass indisponível até a aprovação dupla (D4)"), e a D4 o libera quando houver aprovação por duas pessoas registrada e alerta ao admin da clínica; ou (b) manter aceito, mas abrir item na fila que **bloqueie** a primeira rota de suporte em produção até haver aprovação dupla + alerta + revisão posterior, e registrar em `requisitos-tecnicos-seguranca.md` que o "chamado" do break-glass é do operador (não da clínica), se essa for a decisão. Hoje não há exposição (nenhum caller), por isso não é veto.

**R2 (condição para a D4) — o gatilho controla a linha da trilha, não a leitura do dado.**
`apps/api/src/modules/audit/ator-suporte.ts:215-219`. A recusa só impede o acesso se o fluxo de suporte gravar a linha de auditoria **na mesma transação e antes** de ler os dados (falha fecha). Se o fluxo ler primeiro, ou gravar a auditoria em outra transação, ou gravar como `sistema`, o acesso acontece e só a trilha falha. Documentar isso no JSDoc de `recordSupportAudit` e exigir, na rota de suporte da D4, teste RLS de "sem autorização → nenhuma linha de dado retornada".

**R3 (baixo) — prazo conferido pelo início da transação.**
`0059_autorizacao_de_suporte.sql:95`. Trocar `now() < g.expires_at` por `clock_timestamp() < g.expires_at` (mantendo `g.granted_at <= now()`), ou garantir `idle_in_transaction_session_timeout`/limite de duração de transação na conexão do fluxo de suporte. Uma transação longa não pode carregar o acesso para depois do vencimento.

**R4 (médio) — revogação bloqueada pela política de assinatura.**
`apps/api/src/modules/audit/autorizacao-suporte.ts:114` (`escreverNaClinica` → `assertCanWrite`). Com a assinatura em status que bloqueia escrita, o admin não consegue revogar o acesso do suporte (resta esperar até 72 h). Revogar deveria seguir a regra de leitura (`canRead`, como os direitos do titular na janela de saída), já que só reduz exposição. Autorizar pode continuar em `escreverNaClinica`. Incluir teste com assinatura bloqueada.

**R5 (baixo) — corrida em `autorizar` pode criar duas autorizações vigentes do mesmo chamado.**
`autorizacao-suporte.ts:79-91`: o "já vigente" é um SELECT sem trava; duas requisições simultâneas criam duas linhas, e revogar uma deixa a outra valendo para o mesmo chamado. Corrigir com `pg_advisory_xact_lock(hashtextextended('support_grant:'||tenant||':'||ticket,0))` antes do SELECT (no service ou no gatilho), ou fazer a revogação encerrar **todas** as vigentes do chamado.

**R6 (baixo, teste) — falta o caso do vencimento.**
`apps/api/test/autorizacao-suporte.rls.test.ts`: há teste de revogada, mas não de **vencida**. Sugestão: inserir como dono uma autorização de poucos segundos por SQL (o CHECK permite `> 0`), aguardar e conferir `42501` na linha `pedido_da_clinica`, `vigente: false` na lista e `409 autorizacao_nao_vigente` ao revogar.

**R7 (baixo, transparência) — alerta e relatório para a clínica.**
`docs/04-arquitetura/api-dominio.md` §16 já lista o alerta de break-glass como pendente da D4. Acrescentar à fila: (a) mostrar ao admin, junto da autorização, os acessos de suporte feitos sob ela (linhas da trilha com o mesmo `ticket`), para a revisão posterior; (b) incluir no futuro relatório trimestral de acessos (`requisitos-tecnicos-seguranca.md:46`).

## CI

`gh pr checks 115` em 30/10/2026: todos verdes, inclusive **Isolamento entre tenants (RLS)**, **Lint, typecheck e testes**, testes ofensivos, CodeQL, gitleaks e backup/restauração. Pendente no momento da conferência: só **Carga (k6) + SIGTERM**. Merge depois que ele também ficar verde.

## Nota do Maestro (30/10/2026)

- **R1:** feita. O banco recusa `break_glass` até a D4, com ou sem autorização. Religar exige migração própria, com parecer. O teste prova os dois casos.
- **R3:** feita. O gatilho confere o prazo com `clock_timestamp()`.
- **R4:** feita. Revogar roda em `lerNaClinica`, que segue a regra de leitura da assinatura.
- **R5:** feita. Uma trava transacional por clínica e chamado (`pg_advisory_xact_lock`) impede duas autorizações vigentes para o mesmo chamado.
- **R6:** feita. O teste faz a autorização vencer, recuando as datas como superusuário do container de teste. Vencida, a trilha recusa, a revogação dá 409, a lista mostra `vigente: false` e o chamado pode ser autorizado de novo.
- **R2 e R7:** na fila, para depois da D4.

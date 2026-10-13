# Garantia de Saída

> Resposta à queixa nº 1 contra concorrentes (clínica inadimplente ou que cancela perde acesso ao
> prontuário e não consegue levar seus dados). A garantia é **código + teste que quebra o CI**.
> Revisão: Guardião LGPD (ajuste de 2026-10-08: G1 vale para inadimplência; cancelamento tem janela).

## Regra

**O status de assinatura não restringe leitura/exportação, exceto após a janela de saída;
RBAC/MFA continuam valendo à parte.**

| Status | Escrita (novos registros) | Leitura | Exportação |
|---|---|---|---|
| `trialing`, `active` | sim | sim | sim |
| `past_due`, `read_only` | **não** | sim, **sem limite de tempo** | sim, sem limite, sem custo |
| `cancelled` | **não** | só em `[cancelled_at, cancelled_at + EXIT_WINDOW_DAYS)` | idem leitura |
| desconhecido / `cancelled` sem data | não | não (falha fechada) | não |

- **G1** — inadimplência (`past_due`, `read_only`) só bloqueia escrita clínica/operacional.
- **G2** — exportação total em formato aberto, sem custo: `export.json` (contrato versionado,
  `schemaVersion` = `1.2.0`, com `manifest`: formato, gerado em, tenant, status, fim da janela,
  contagens por entidade) + `pacientes.csv` (RFC 4180, UTF-8 com BOM, fórmulas neutralizadas).
  Somente dados do próprio tenant (filtro explícito + `withTenant`/RLS FORCE).
  Desde a 1.1.0 (migração 0007): cadastro do paciente com CPF/telefone/nascimento **decifrados**
  (o pacote é da própria clínica, a controladora), profissionais, tipos de atendimento e agendamentos.
  Sem a cifra de campo a exportação falha fechada. `test/exportacao-cobertura.rls.test.ts` lê o
  catálogo e reprova tabela com `tenant_id` (ou coluna de tabela exportada) que não esteja no pacote
  nem em `EXPORT_EXCLUDED_TABLES` com motivo (hoje: chaves e contexto do RLS).
  Desde a 1.2.0 (Decisão 1 do Guardião, parecer PR #57; migração 0008): a trilha de auditoria da
  clínica vai no pacote como `auditoria.jsonl` (um evento por linha, em ordem de `seq`), com os
  campos da cadeia (`seq`, `prevHash`, `hash`), o JSON canônico que o hash cobre e o tipo de ator;
  o manifesto traz a contagem e o último elo (`auditChain.head`) para conferir com a âncora. A
  clínica verifica sem banco com `verifyExportedAuditTrail` (`src/modules/audit/audit-chain.ts`).
  A linha da própria exportação entra na trilha depois de montado o pacote (aparece no próximo).
  Atendentes do suporte da plataforma já estão pseudonimizados na origem (ver auditoria-encadeada.md §4c).
- **G3** — toda exportação grava 1 linha em `audit_log` **na mesma transação** (sem auditoria,
  sem export): ator, data, escopo `tenant.full_export`, contagens e versão. Nunca conteúdo
  clínico/PII. `audit_log` é append-only: `app_user` só tem `SELECT`/`INSERT`, e um trigger
  rejeita `UPDATE`/`DELETE`/`TRUNCATE` por qualquer papel.
- **G4** — janela de saída: `EXIT_WINDOW_DAYS` (ambiente), **padrão e piso 90 dias**. Valor
  menor que 90 faz a API recusar subir; a política também aplica o piso. No instante exato
  `cancelled_at + 90 dias` o acesso já é negado (intervalo semiaberto).

## Após a janela (não implementado)

O descarte/eliminação **não está implementado**. Após a janela, os dados seguem o DPA
(eliminação ou devolução). A **guarda legal do prontuário (mínimo 20 anos, Lei 13.787/2018)
é responsabilidade da clínica** (controladora): por isso a comunicação de cancelamento deve
avisar o prazo e oferecer a exportação. Qualquer job de eliminação futuro precisa: respeitar
`isWithinExitWindow`, ter aprovação do Guardião LGPD e registrar auditoria.

## Onde está

| Item | Arquivo |
|---|---|
| Política pura (`canWrite`, `canRead`, `canExport`, janela) | `apps/api/src/modules/exports/access-policy.ts` |
| Exportação + auditoria | `apps/api/src/modules/exports/tenant-export.ts` |
| Migração (status, `cancelled_at`, `audit_log`) | `apps/api/db/migrations/0002_garantia_de_saida.sql` |
| Testes unitários (tabela-verdade, limites da janela) | `apps/api/src/modules/exports/access-policy.test.ts` |
| Testes contra Postgres real (CI `test:rls`) | `apps/api/test/exit-guarantee.rls.test.ts` |

## Pendências

- Rota HTTP de exportação só junto com autenticação + RBAC/MFA (papel gestor).
- Novas entidades (agenda, prontuário etc.) devem entrar no pacote e no `manifest.counts`;
  campo novo = versão minor, mudança incompatível = major.
- Encadeamento de hash e export para S3 Object Lock da `audit_log` (ver segurança na arquitetura).

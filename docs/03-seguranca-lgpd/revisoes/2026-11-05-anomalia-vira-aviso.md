# Parecer do Guardião LGPD — PR #137 (`eng/anomalia-vira-aviso`): alerta de anomalia vira aviso aos admins

- **Data:** 05/11/2026
- **Escopo:** `git diff main...eng/anomalia-vira-aviso` — migração `0063_anomalia_vira_aviso.sql`, `avisarAdminsDeAnomalia`
  (`records/avisos.ts`), chamadas em `vigilancia-de-leitura.ts`, `sessao.guard.ts` (`alertarVolume`),
  `scheduling.service.ts` (`vinculo_autoagendado` e `vinculo_cruzado`), teste em `vinculo-cruzado.rls.test.ts`, docs.
- **Fecha:** resto do E10 da [revisão interna de 04/11](2026-11-04-revisao-interna-profissionais.md) (sessão da equipe).
- **Limite desta revisão:** sem Postgres local; os testes RLS **não foram rodados** por mim. A conclusão sobre o banco é
  por leitura das migrações 0039, 0040, 0050, 0060 e 0063.

## Veredito: **APROVADO com ressalvas**

Nenhum bloqueio. R1 e R2 devem entrar antes do GA; R3 a R6 podem ir para a fila.

## O que foi conferido

| Ponto | Resultado |
|---|---|
| `shape_check` da 0063 × 0060, linha a linha | Os 7 ramos da 0060 estão **idênticos** (mesma ordem, mesmas condições). O único acréscimo é o ramo `alerta_anomalia`, antes do `ELSE false`. Nada se perdeu. |
| Colunas de outros tipos no ramo novo | `patient_id`/`portal_transition` ficam nulos pela `clinical_notices_portal_check` (0039); `professional_id` pela `area_sensivel_check` (0060) e também no ramo novo; `anomaly_rule` só existe neste tipo (`anomalia_check`, nos dois sentidos). Forma fechada. |
| `kind_check` | A lista da 0060 está toda lá, mais `alerta_anomalia`. |
| `anomaly_rule` | Lista fechada de 6 códigos, sem texto livre. Bate com `RegraDeAnomaliaAvisada` no TS. |
| Trigger `clinical_notices_guard` (versão da 0050) | O tipo novo cai no caminho geral: exige `app_current_user()` não nulo, `created_by = usuário da sessão` e `read_at` nulo. `avisarAdminsDeAnomalia` grava `createdBy: ctx.userId` dentro de `db.run(..., ctx.userId)` ou da transação de escrita da agenda: passa. DELETE continua proibido. |
| RLS | INSERT por tenant (0040), sem `RETURNING` (o SELECT é só do destinatário): o código não usa `returning()`. A leitura continua restrita ao destinatário. |
| Dado revelado | Só o código da regra e o id de quem disparou (colega da mesma clínica). Sem paciente, agendamento, contagem ou limiar (esses ficam na trilha). O teste confere as chaves exatas do DTO. |
| Destinatários | Admins **ativos** (`revoked_at IS NULL`) do tenant, **sem** quem disparou (sem avisar o suspeito), com dedup. Correto. |
| Portal | `portal-vigilancia.ts` não chama a função; a fila registra o resto (portal) e o E9. Correto. |
| Exportação | `clinical_notices` segue fora do pacote, com a justificativa atualizada. Correto. |
| Base legal | Monitorar o uso do sistema pela equipe é medida de segurança (art. 46 LGPD) com base em legítimo interesse/obrigação de segurança do controlador (art. 7º, II e IX; art. 6º, VII e X). O dado do colaborador é mínimo (id). Ver R4 (transparência). |

## Ressalvas

**R1 — Aviso deve ser best-effort em relação ao alerta da trilha (savepoint).** Hoje o aviso está na mesma transação do
`anomaly_alert`. Se o INSERT do aviso falhar:
- em `vigilancia-de-leitura.ts` e `sessao.guard.ts` (transação própria do alerta), o **alerta some da trilha** junto
  (fica só `TRILHA_NAO_GRAVADA` no log). É regressão em relação ao `main`: a trilha é o controle principal; o aviso é
  acessório.
- em `scheduling.service.ts`, a falha derruba a **operação de agenda** do usuário (500), por algo que é só notificação.

Correção: envolver só o aviso num savepoint (`tx.transaction(async (sp) => avisarAdminsDeAnomalia(sp, ctx, regra))`
com `catch` que emite `registrarEventoDeSeguranca('AVISO_NAO_GRAVADO', { regra, motivo: 'alerta_anomalia' })`, sem dado).
Assim a trilha e a mudança da agenda ficam atômicas entre si e o aviso não as derruba. O risco hoje é baixo (o INSERT é
determinístico e passa no trigger e nos CHECKs), por isso não bloqueia; mas deve entrar antes do GA.

**R2 — Volume de avisos (fadiga de alerta).** `vinculo_autoagendado` tem limiar padrão **0** (todo autoagendamento
atendido alerta) e `vinculo_cruzado` alerta por operação. Cada alerta gera um aviso para **cada** admin, e
`clinical_notices` não se apaga. Numa clínica onde profissionais se autoagendam rotineiramente, a caixa vira ruído e o
alerta que importa se perde. Correção: no máximo um aviso por (tenant, quem disparou, regra) por janela (ex.: 24 h),
contado no banco (ex.: `NOT EXISTS` de aviso não lido igual nas últimas 24 h) — a trilha continua com todos.

**R3 — Clínica com um só admin.** Se o único admin dispara a anomalia (vigilância de leitura ou MFA), ninguém é avisado
(correto não avisá-lo, mas a anomalia fica invisível). Registrar como limitação conhecida no RIPD e na tela da trilha
(`GET /clinica/auditoria`); avaliar no pós-GA um destinatário alternativo (encarregado/DPO da clínica).

**R4 — Transparência à equipe (art. 6º, VI; art. 9º).** O aviso expõe aos admins que um colega disparou uma regra de
anomalia. Incluir no RIPD e no modelo de política interna da clínica que o uso do sistema é monitorado e que admins
recebem esses alertas (só regra e id). Não muda código.

**R5 — Cobertura do teste.** O teste prova: o admin recebe o aviso de `vinculo_cruzado` com regra e id corretos, o DTO
não tem chave extra, e o banco recusa o tipo sem regra (23514). **Não prova:** (a) que quem disparou não recebe quando é
admin (vigilância/MFA); (b) que admin revogado não recebe; (c) os outros três caminhos (`vigilancia`, `mfa`,
`autoagendado`); (d) o comportamento na falha do aviso (depois de R1: a trilha fica e a agenda conclui). Adicionar ao
menos (a), (b) e (d). E rodar a suíte RLS no CI antes do merge — não foi rodada nesta revisão.

**R6 — Lista de regras duplicada (TS × SQL).** `RegraDeAnomaliaAvisada` repete à mão o CHECK da 0063. Uma regra nova no
TS sem migração quebra o alerta em produção (e, sem R1, apaga o alerta da trilha). Exportar a lista como `const` (como
`CLINICAL_NOTICE_KINDS`) e ter um teste que compara com o CHECK do banco.

## Itens sem problema (registro)

- Segredos, dados reais ou certificados: nenhum no diff.
- Isolamento por tenant: SELECT de `clinic_members` filtra `tenant_id = ctx.tenantId` e a RLS confere o tenant no INSERT.
- Retenção: o aviso só leva ids; segue a regra geral da caixa de avisos (sem apagar). Não toca prontuário.
- CFM/ANS/ICP-Brasil: não se aplicam a este diff.

## Nota do Maestro (05/11/2026)

- **R1 (feita):** o aviso é best-effort, num SAVEPOINT (`tx.transaction` aninhada). Se falhar, o alerta continua na trilha, a operação do usuário segue, e sai `TRILHA_NAO_GRAVADA` (`motivo: aviso_de_anomalia`) no log de segurança.
- **R2 (feita):** no máximo um aviso por pessoa e regra a cada 24 h, contado pelos `anomaly_alert` da trilha (a RLS dos avisos não deixa o ator ver os avisos dos outros). A trilha continua com todos os alertas. O teste RLS confere que dois disparos do mesmo colega geram um único aviso.
- **R3 a R6 (fila):** clínica com um só admin, registro no RIPD de que a equipe é monitorada, testes dos outros caminhos (admin que dispara, admin revogado, falha do aviso) e a lista de regras repetida entre TS e SQL.

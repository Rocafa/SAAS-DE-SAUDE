# Parecer do Guardião LGPD: PR #134 (alerta de vínculo cruzado, E12 / R6 do #61)

- **Data:** 04/11/2026
- **Branch:** `eng/alerta-vinculo-cruzado` (diff `main...eng/alerta-vinculo-cruzado`, commit c57d397)
- **Base:** R6 do [parecer do #61](2026-10-14-pr61.md); E12 da [revisão interna de 04/11](2026-11-04-revisao-interna-profissionais.md)
- **Revisão:** leitura de código. Sem Postgres local: o teste RLS **não foi executado** por mim.

## Veredito: **VETADO**

O alerta dispara no lugar errado. Ele só toca na **abertura do atendimento** (`ProntuarioService.abrir`), mas o
acesso que a R6 quer vigiar começa **antes**: o Dr. A ganha a base `agenda_do_dia` assim que o agendamento existe
(status `scheduled`/`confirmed`/`checked_in` na janela de horas, `vinculo-de-cuidado.ts`), sem check-in e sem
atendimento. O conluio "o Dr. B cria encaixe, o Dr. A lê o prontuário inteiro e nunca abre atendimento" continua
sem nenhum alerta. Um controle que o próprio infrator decide se aciona não cumpre a R6 (o texto da R6 dizia "vira
atendimento"; a falha de redação foi minha, mas o risco descrito na própria R6 é o `agenda_do_dia` "na hora").

O resto é bom: só ids na trilha, nada de paciente no log de segurança, `creator_role` gravado, alerta na mesma
transação (sem trilha, sem abertura) e sem bloquear o fluxo legítimo.

## Ressalvas

| # | Onde | Problema | Correção | Peso |
|---|---|---|---|---|
| R1 | `prontuario.service.ts` (`abrir` → `alertarVinculoCruzado`) | Gatilho na abertura do atendimento. A leitura por `agenda_do_dia` não passa por ali, e a abertura ainda exige check-in da recepção, que o par de profissionais pode simplesmente não pedir. | Disparar o `anomaly_alert` `vinculo_cruzado` **na criação** (`SchedulingService.criar`), na mesma transação, quando `ctx.roles` tem `profissional` e não tem `recepcao` nem `admin` e o `professionalId` do agendamento não é o do próprio usuário. Manter o da abertura é opcional (vira um 2º sinal, com `stage: 'encounter'`). | **Veto** |
| R2 | `alertarVinculoCruzado` (consulta a `clinic_members` com `revokedAt IS NULL`) | O critério olha os perfis **de agora**, não os de quando o agendamento foi criado. Furos que ficam *fail-open*: (a) criador **desligado** entre a criação e a abertura → 0 linhas → sem alerta; (b) criador **sem linha** no banco → `ativos.size === 0` → sem alerta; (c) criador que **ganhou** recepção/admin depois → sem alerta. O caminho mais arriscado (desligar quem fabricou o vínculo) é exatamente o que some. | Resolvido por R1 (decidir com `ctx.roles`, que já são os perfis vigentes conferidos no banco pelo `sessao.guard`). Se o sinal da abertura for mantido, decidir pelo `creator_role` gravado no audit de `create` (ou coluna no agendamento), nunca pelos perfis atuais, e tratar "sem dado" como alerta, não como silêncio. | Veto (some com R1) |
| R3 | `papelDoCriador` (`scheduling.service.ts`) | A prioridade põe `financeiro` antes de `profissional`. `financeiro` não tem `agenda:escrever`, então quem é `financeiro + profissional` criou como profissional, mas fica registrado `financeiro` e escapa do critério "só profissional". | Ordem `recepcao`, `admin`, `profissional`, `financeiro` (ou gravar a lista de perfis inteira, `creator_roles: [...]`). O critério do alerta deve ser "não tem `recepcao` nem `admin`", não "todos os perfis são clínicos". | Antes do merge |
| R4 | Remarcação | `remarcar` não troca `professionalId` nem `createdBy`, então não abre caminho novo para o vínculo cruzado. Mas o Dr. B pode **remarcar** um agendamento do Dr. A feito pela recepção para dentro da janela de hoje e ressuscitar o `agenda_do_dia`. | Na remarcação, se quem remarca só é profissional e não é o profissional do agendamento, o mesmo alerta `vinculo_cruzado` (`op: 'reschedule'`). Teste junto. | Antes do merge |
| R5 | Atendimento reaberto | Correto: com `existente`, `abrir` devolve antes do alerta e não duplica. Uma abertura só por agendamento (unicidade por `appointment_id`) mantém isso. Nada a corrigir. | — | OK |
| R6 | `vinculo-cruzado.rls.test.ts` | O teste prova o caso feliz, não os furos: (a) `toMatchObject` no 3º caso **não prova "só com ids"** (passaria com `patient_id` ou nome); (b) não cobre criador desligado, sem linha, `financeiro + profissional`, nem remarcação por outro profissional; (c) não cobre a leitura por `agenda_do_dia` sem abrir atendimento (o caso de R1); (d) não confere `creator_role: 'profissional'` no agendamento do Dr. B nem o evento no log de segurança. | Trocar por igualdade exata das chaves da metadata (`Object.keys(...).sort()` igual à lista esperada) e somar os casos (b), (c) e (d). O alerta precisa aparecer **logo depois do `POST /agendamentos`** do Dr. B. | Antes do merge |
| R7 | `prontidao-producao.md` | E12 marcado "em PR". | Manter "em PR" até R1–R4 e R6 entrarem; só então "feito". | Doc |

## O que está certo (não mexer)

- Trilha só com ids (`appointment_id`, `encounter_id`, `professional_id`, `creator_id`); log de segurança só com
  `tenantId` e a regra. Sem dado de paciente fora do banco. Regra incluída na allowlist `REGRAS_DE_SEGURANCA`.
- Alerta na mesma transação: sem trilha, sem efeito (fail-closed).
- Exclusões coerentes: o próprio profissional (coberto por `vinculo_autoagendado`) e lote de importação (admin).
- Não bloqueia: encaminhamento interno é legítimo; o alerta é a resposta proporcional (minimização e finalidade,
  art. 6º, I e III; segurança e prevenção, art. 6º, VII e VIII, e art. 46 da LGPD).

## Para virar APROVADO

R1, R3, R4 e R6 feitos, com o teste RLS **rodado no CI** (Postgres) e o resultado no PR.

## Nota do Maestro (04/11/2026)

- **R1 (feita):** o alerta saiu da abertura do atendimento e foi para a **criação** do agendamento, na mesma transação, decidido pelos perfis de quem cria (`ctx.roles`, já filtrados pelo banco no guard do #130). O teste confere que o alerta existe antes de qualquer atendimento.
- **R2 (feita):** decide pelos perfis de agora, no momento da ação. Não depende de quem foi desligado ou promovido depois.
- **R3 (feita):** em `papelDoCriador`, `profissional` passa a vir antes de `financeiro`. O critério do alerta é "sem recepção nem admin", então quem é financeiro e profissional também alerta, e há teste para isso.
- **R4 (feita):** a remarcação feita por outro profissional também alerta (`op: reschedule`). A da recepção não.
- **R6 (feita):** o teste compara a metadata **exata** (`toEqual`), só com ids, e cobre R1, R3 e R4.
- **Não alerta:** importador, autoagendamento e profissional sem usuário (sem usuário, ninguém ganha acesso).

## Veredito final (04/11/2026, commit 30dee3f): **APROVADO COM RESSALVAS**. R1–R4 e R6 conferidas no diff (alerta na criação e na remarcação, na mesma transação, por `ctx.roles`; prontuário sem o alerta antigo; metadata exata, só ids). Condições: (R8) o teste RLS precisa **passar no CI** com Postgres antes do merge, porque não foi executado nesta revisão; (R9) o evento `ALERTA_ANOMALIA`/`vinculo_cruzado` no log de segurança ainda não é conferido em teste: acrescentar no próximo PR da agenda; (R7) E12 vira "feito" em `prontidao-producao.md` só depois do merge. Risco aceito: `admin + profissional` não alerta (quem é admin já cuida da agenda, como definido na R6).

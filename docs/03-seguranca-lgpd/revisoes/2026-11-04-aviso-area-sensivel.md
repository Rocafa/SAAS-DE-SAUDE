# Parecer do Guardião — PR #133 (E8, resto: aviso ao desmarcar a área sensível)

- **Data:** 04/11/2026
- **Branch:** `eng/aviso-area-sensivel` (commit 3c58eeb), diff `main...eng/aviso-area-sensivel`
- **Origem:** R1 do parecer do #131 / E8 de [2026-11-04-revisao-interna-profissionais.md](2026-11-04-revisao-interna-profissionais.md)
- **Veredito:** **VETADO** (R1 bloqueia: o aviso nunca é gravado e a desmarcação passa a falhar). Corrigida a R1, o
  restante é aprovável com as ressalvas R2 a R5.

Revisão estática. Não há Postgres local; a suíte RLS não foi rodada.

## O que foi conferido

| Ponto | Resultado |
|---|---|
| `clinical_notices_guard` (última versão: 0050) | OK. O tipo novo não é `pedido_titular_aberto` nem está na lista "só o banco gera", então cai no caminho geral: exige `app_current_user()` não nulo, `created_by = usuário da sessão` e `read_at IS NULL`. O serviço grava `createdBy: ctx.userId` sem `readAt`. Nada foi aberto. |
| `clinical_notices_kind_check` | OK: recriado com os 6 tipos anteriores + `area_sensivel_desmarcada`, igual ao `CLINICAL_NOTICE_KINDS`. |
| `clinical_notices_portal_check` (0039) | OK: exige `patient_id`/`portal_transition` nulos fora do tipo do portal. |
| `clinical_notices_area_sensivel_check` (novo) | OK: `professional_id` presente se e só se for o tipo novo; demais colunas nulas/zero no tipo novo. |
| **`clinical_notices_shape_check` (última versão: 0039)** | **FALHA (R1).** O CASE da 0039 **tem ELSE** (não devolve NULL): o ELSE foi escrito para os tipos de retenção e exige `legal_hold_id IS NOT NULL`. O tipo novo cai nele e o novo CHECK exige `legal_hold_id IS NULL`: contradição, nenhuma linha do tipo é inserível. |
| FK `(professional_id, tenant_id)` → `professionals (id, tenant_id)` | OK: `professionals_id_tenant_key` existe (0007). Impede apontar profissional de outra clínica. |
| RLS do destinatário (0040, O1) | OK: SELECT/UPDATE só `recipient_user_id = app_current_user()` e mesmo tenant; INSERT só no tenant da sessão. O teste confere que o autor não vê o aviso. |
| Destinatários | OK: admins ativos (`revoked_at IS NULL`) + usuário do profissional, deduplicados, sem o autor. Ver R3. |
| Minimização | OK: só o id do profissional; nenhum dado de paciente. O fato completo fica em `audit_log` (`notified` só como contagem). |
| Exportação total | OK: `clinical_notices` já está nas exclusões com motivo; o fato sai em `audit_log` e `professionals`. Ver R4 (texto do motivo). |
| Concorrência | OK: `SELECT ... FOR UPDATE` na linha do profissional antes do UPDATE serializa duas desmarcações simultâneas; só a que vê `true → false` avisa. |
| Segredos / dados reais | OK: teste com dados fictícios; nada sensível no diff. |

## Ressalvas

1. **(BLOQUEIA) Recriar `clinical_notices_shape_check` na 0060** com um `WHEN 'area_sensivel_desmarcada' THEN` próprio
   (todas as colunas dos outros tipos nulas/zero, inclusive `legal_hold_id IS NULL`), mantendo o ELSE da retenção. Hoje
   toda desmarcação com ao menos um destinatário levanta `23514` e a transação inteira (inclusive a desmarcação e a
   trilha) é desfeita: a rota passa a responder 500. O teste `desmarcar avisa...` vai falhar na CI de RLS; o caso
   `tentar({})` passa por acaso (falha pelo CHECK errado).
2. **Teste positivo no banco:** no bloco "o banco recusa", incluir um insert válido do tipo novo (`professionalId` só)
   esperando `ok`, para que um CHECK contraditório como o da R1 seja pego de forma direta, não só pela rota.
3. **Usuário do profissional sem vínculo ativo:** `p.userId` entra sem conferir `clinic_members.revoked_at`. Sem
   vazamento (o revogado não lê a caixa do tenant), mas é aviso inútil; filtrar pelo vínculo ativo ou registrar no
   comentário que é intencional.
4. **Motivo da exclusão em `tenant-export.ts`:** o texto de `clinical_notices` lista os tipos; acrescentar "área
   sensível desmarcada" e apontar `professionals`/`audit_log` como onde o fato sai.
5. **Sem destinatário (clínica com um admin só e profissional sem usuário):** a desmarcação passa calada, só com
   `notified: 0` na trilha. Aceitável hoje; registrar na fila se o alerta de anomalia (B2) deve cobrir esse caso.

## Bases e requisitos

Controle de acesso e trilha de mudanças de privilégio sobre dado sensível de saúde (LGPD art. 11, art. 46 e art. 6º,
VII e X; Res. CFP 01/2009 e CFM 1.821/2007 quanto ao sigilo do prontuário). Sem impacto em retenção, criptografia ou
ICP-Brasil.

## Nota do Maestro (04/11/2026)

- **R1/B1 (feita):** a 0060 recria a `clinical_notices_shape_check` com o ramo `area_sensivel_desmarcada`. Os dois tipos de retenção ganharam ramos explícitos, e o `ELSE` virou `false`: tipo novo sem ramo próprio não passa mais em silêncio.
- **R2 (feita):** o teste RLS insere direto no banco a forma válida, que tem de passar, além das inválidas.
- **R3 (feita):** o profissional só é avisado se ainda tiver perfil ativo na clínica.
- **R4 (feita):** o texto da exclusão em `tenant-export.ts` cita o tipo novo e a tabela `professionals`.
- **R5 (aceita como está):** a desmarcação sem nenhum destinatário fica registrada na trilha (`notified: 0`), e a rota já exige MFA recente. Um evento no log de segurança para esse caso entra se a vigilância pedir.

**Veredito final do Guardião (04/11/2026, commit 8bfb944): APROVADO.** R1 a R4 conferidas no diff. A shape_check da 0060 repete os ramos da 0039 sem mudança, os de retenção agora explícitos, e cobre as linhas que já existem (o kind_check limita aos 7 tipos). `patient_id`/`portal_transition` do tipo novo ficam travados pelo portal_check e pelo area_sensivel_check. R5 aceita. Ressalva: o teste RLS precisa passar na CI antes do merge (revisão estática, sem Postgres local).

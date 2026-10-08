# Garantias ao cliente: transformar as reclamações do mercado em compromissos verificáveis

> **Por que existe:** as 5 dores mais repetidas no Reclame Aqui dos concorrentes ([mercado §1.5 e §5.3](../01-mercado/mercado-geral-e-concorrentes.md)) são:
> 1. prontuário bloqueado por inadimplência;
> 2. cancelamento difícil e fidelidade;
> 3. diferença entre o que foi vendido e o que foi entregue;
> 4. suporte pós-venda lento;
> 5. cobrança de adicionais e após downgrade.
>
> O iClinic tem nota **6,4**; na Doctoralia, **18%** das queixas são "não consigo cancelar".
>
> **A regra deste documento:** cada garantia tem um **mecanismo que a faz valer** (código + teste no CI, métrica com alarme ou cláusula contratual) e um **dono**. Garantia sem mecanismo não pode ir para o marketing.
>
> Versão 1.0, 09/10/2026. Dono: sócios. Revisão jurídica obrigatória antes de publicar (⚖️ D8; ver o alerta do Guardião sobre publicidade com garantia absoluta, CDC art. 37).

## 1. Matriz reclamação → garantia → mecanismo

| # | Reclamação do mercado | Nossa garantia (texto para contrato e site) | Como a fazemos valer | WBS / Fase | Dono |
|---|---|---|---|---|---|
| **G1** | "Bloquearam meu acesso ao prontuário porque atrasei" | **Atraso de pagamento nunca bloqueia a consulta nem a exportação dos seus dados.** A inadimplência só pausa o cadastro de novos registros. Depois de um cancelamento, vale o prazo de saída da G3 | **Código + teste no CI:** a política de acesso por status de assinatura não restringe leitura nem exportação em `past_due`/`read_only` (sem limite de tempo) e, em `cancelled`, só dentro da janela de saída. Testes cobrem todos os status e o limite exato da janela; se alguém mudar a regra, o CI falha. As permissões por perfil (RBAC), o MFA e os controles da EXP-01.5 continuam valendo à parte | BIL-01.7, EXP-01.1 · MVP | Engenharia |
| **G2** | "Não consigo levar meus dados para outro sistema" | **Exportação total, sem custo, em formato aberto** (JSON documentado + CSV; FHIR na Fase 2), feita pelo administrador com ciência do responsável técnico da clínica | **Código + teste:** a exportação devolve todas as entidades do tenant com manifesto de contagens; o teste de isolamento garante que só vem o que é da clínica; cada exportação fica em auditoria append-only. **Controles contra vazamento (EXP-01.5 + M1 do parecer):** MFA recente no momento do pedido; link vinculado ao usuário que pediu, válido por 24 h; arquivo cifrado; alerta por e-mail a todos os admins com botão **"não fui eu"**, que revoga o link; janela de segurança antes da liberação; pausa automática se houver suspeita de conta comprometida. Esses controles entram como testes na Definição de Pronto | EXP-01.1, EXP-01.3, EXP-01.5 · MVP | Engenharia + Guardião |
| **G3** | "Cancelei e sumiram com tudo" / "não me deixam sair" | **Depois do cancelamento, seus dados ficam disponíveis em modo leitura por no mínimo 90 dias**, com a exportação liberada e avisos 30, 7 e 1 dia antes do fim do prazo. Depois disso, eliminamos os dados com certificado, conforme o contrato de operador (DPA, cláusula 12). **A guarda legal do prontuário é da clínica** (Lei 13.787/2018 e normas do conselho: CFM e CFO 20 anos; CFP 5 anos), por isso a exportação antes do fim do prazo é responsabilidade dela; custódia paga do arquivo pode ser contratada como opção. Ressalva: guardamos apenas o que a lei nos obriga (registros de acesso pelo Marco Civil, art. 15, e documentos fiscais), e os backups seguem o ciclo de expurgo documentado | **Código:** janela de saída como constante configurável e testada. **Processo:** avisos D-30/D-7/D-1 e eliminação só com certificado (EXP-01.6) | EXP-01.6 · MVP | Engenharia + Guardião |
| **G4** | "Para cancelar tive que ligar 5 vezes" | **Cancelamento pelo próprio sistema, em até 3 cliques, sem ligação e sem multa de fidelidade** | **Teste E2E:** cancelamento em ≤ 3 cliques (Playwright). **Contrato:** sem cláusula de fidelidade | BIL-01.9 · MVP | Produto + QA |
| **G5** | "Me cobraram depois do downgrade" / "taxa escondida" | **Preço único com WhatsApp, IA (cota definida na página de preço) e assinatura digital na plataforma incluídos** (o certificado digital ICP-Brasil do profissional não está incluído). Downgrade vale na hora e é proporcional; nunca cobramos por recurso que você não tem mais** | **Teste de cobrança:** cálculo pro rata conferido em testes (BIL-01.5). **Página de preço** com calculadora e lista do que é variável (mensagens e IA além da cota) | BIL-01.4, BIL-01.5 · MVP | Produto + Financeiro |
| **G6** | "Venderam um recurso que não existe" | **Só vendemos o que está em produção.** O que está em construção aparece no **roadmap público**, com status honesto | **Regra comercial:** proposta só lista itens com status "em produção". **Roadmap público** antecipado para o MVP (ver §3) | SUP-01.7 · F2 → **MVP (proposto)** | Sócios |
| **G7** | "Suporte demora dias" | **90% dos chamados com 1ª resposta em até 15 min em horário comercial** no chat, com o número medido e publicado | **Métrica com alarme:** tempo de 1ª resposta e CSAT no painel; alerta quando o p90 passar de 15 min | SUP-01.2 · MVP | Suporte |
| **G8** | "Mudaram o sistema e perdi dados" | **Migração assistida com simulação (dry-run) e desfazer (rollback)**; nada é sobrescrito sem você aprovar a simulação | **Código + teste:** dry-run e rollback testados por importador | MIG-02.1, MIG-02.2 · MVP (M4) | Engenharia |
| **G9** | "Ficou fora do ar e ninguém avisou" | **Status do sistema público e comunicação proativa de incidentes** | **Status page** atualizada pelo monitoramento | SUP-01.6 · F2 → **MVP (proposto)** | DevOps |

## 2. Texto da "Carta de Compromissos" (rascunho para o site, depois de passar pelo advogado)

> **Seus dados são da sua clínica. Nosso trabalho é guardá-los bem, e não usá-los para prender você.**
> - Atrasou o pagamento? Você continua consultando e exportando tudo. Só pausamos novos cadastros até regularizar.
> - Quer sair? Cancele pelo próprio sistema, sem ligação e sem multa. Seus dados ficam disponíveis por 90 dias, com aviso antes do fim do prazo, e a exportação completa é gratuita. Lembre-se: a guarda legal do prontuário é da sua clínica, então exporte antes do fim do prazo (ou contrate nossa custódia).
> - O preço que você vê é o que você paga: WhatsApp, IA (dentro da cota) e assinatura digital na plataforma já estão incluídos. Só cobramos à parte o que passar da cota, com aviso antes. O certificado ICP-Brasil do profissional é contratado à parte.
> - Só vendemos o que já funciona. O que estamos construindo fica no nosso roadmap público.
> - 90% dos atendimentos no chat recebem resposta em até 15 minutos em horário comercial, e publicamos esse número.

*Cada frase acima tem um mecanismo na §1, foi ajustada conforme o [parecer do Guardião LGPD de 09/10/2026](../03-seguranca-lgpd/revisoes/2026-10-09-garantias.md) e ainda precisa de validação jurídica antes de publicar (D8).*

## 3. Mudanças propostas no backlog (decisão dos sócios)
1. **Antecipar SUP-01.7 (roadmap público) da F2 para o MVP.** É barato e ataca a reclamação "vendido ≠ entregue" (G6).
2. **Antecipar SUP-01.6 (status page) para o MVP**, com uma ferramenta pronta e barata (G9).
3. **Cada garantia G1–G9 vira critério de aceite** das histórias correspondentes no `backlog-mvp.md` e item da Definição de Pronto.
4. **Métrica de confiança no painel:** % de cancelamentos concluídos sem contato com o suporte (meta ≥ 95%) e tempo médio entre o pedido de exportação e o arquivo pronto.

## 4. Estado da implementação

| Garantia | Estado |
|---|---|
| G1, G2, G3 | 🛠️ Em implementação na branch `eng/garantia-de-saida`: política de acesso por status de assinatura, exportação com manifesto e auditoria append-only, prazo de 90 dias, testes de unidade e de isolamento |
| G4–G9 | 📋 No backlog (WBS acima); viram critérios de aceite das histórias |

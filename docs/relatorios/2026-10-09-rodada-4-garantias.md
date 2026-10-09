# Relatório da Rodada 4: garantias ao cliente

**Data:** 09/10/2026 · **Responsável:** Maestro · **Agentes:** 2 de no máximo 3 (engenharia, guardiao-lgpd)
**Pedido dos sócios:** "fazer o que está faltando para melhorar o produto, conforme o que os clientes reclamam, do jeito mais profissional possível".

## 1. Diagnóstico
As 5 dores mais repetidas no Reclame Aqui dos concorrentes ([mercado §1.5 e §5.3](../01-mercado/mercado-geral-e-concorrentes.md)) são:
1. prontuário bloqueado por inadimplência;
2. cancelamento difícil e fidelidade;
3. recurso vendido e não entregue;
4. suporte lento;
5. cobrança escondida e após downgrade.

A WBS já tinha itens sobre isso (EXP-01.x, BIL-01.7/01.9), mas **não havia compromisso verificável**: nada impedia que uma mudança futura reintroduzisse o bloqueio.

## 2. Entregas

| Entrega | PR | CI |
|---|---|---|
| **Garantias G1–G9**: matriz reclamação → garantia → mecanismo → WBS → dono; Carta de Compromissos (rascunho); garantias na Definição de Pronto; decisão D9 | #8 | ✅ 5/5 |
| **Parecer do Guardião** sobre as garantias: VETADO por 2 bloqueantes, ambos corrigidos | #8 | ✅ |
| **Garantia de saída em código** (G1–G3): migração 0002 (status de assinatura + `audit_log` append-only em 2 camadas), política de acesso pura com janela de 90 dias (piso, falha fechada), exportação total isolada por tenant com auditoria na mesma transação | #9 | ✅ 5/5, incluindo os 18 testes RLS |

## 3. Como o padrão profissional foi aplicado
- **Revisão de segurança antes do PR:** o Guardião vetou a 1ª versão. "Cancelamento nunca bloqueia" era uma promessa impossível de cumprir (CDC art. 37), e o texto atribuía a nós a guarda de 20 anos do prontuário, que é da clínica. A correção foi levada **ao código antes de o agente terminar**: `cancelled` só lê e exporta dentro da janela.
- **Teste que prova que o teste funciona:** o agente introduziu de propósito um erro na política; 3 testes de banco e 7 unitários falharam.
- **Verificação dupla:** agente e Maestro rodaram install, lint, typecheck, testes e audit; o CI repetiu tudo contra Postgres 16 real.
- **Nada de marketing sem mecanismo:** cada frase da Carta aponta para um teste, uma métrica ou uma cláusula, e a publicação depende da validação jurídica (D8).

## 4. Pendências
| Item | Dono |
|---|---|
| Merge dos PRs #8 e #9 | Sócios |
| Decisão D9 (aprovar a Carta; antecipar roadmap público e status page para o MVP) | Sócios |
| Validação jurídica da Carta antes de publicar (D8) | Sócios + advogado |
| Rota HTTP de exportação com RBAC e controles anti-exfiltração da G2 (MFA recente, link de 24 h, "não fui eu") | Engenharia, na história de exportação |
| Eliminação certificada após a janela de saída (EXP-01.6) | Engenharia + Guardião |
| Mecanismos de G4–G9 (teste E2E de cancelamento, pro rata, roadmap público, status page, SLA de suporte) | Produto/Engenharia, conforme o backlog |

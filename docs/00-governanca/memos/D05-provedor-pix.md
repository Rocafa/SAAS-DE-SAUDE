# D5 — Provedor Pix e pagamentos
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Engenharia · **Este memo não decide nada.**

**Pergunta:** qual gateway cobra (a) a assinatura do nosso SaaS e (b) as consultas e pacotes que a clínica cobra do paciente?
**Prazo sugerido:** antes do módulo financeiro (M2) e da primeira cobrança do piloto · **Urgência:** Baixa agora, Média no M2

## Contexto
A rodada 7 sugeriu dividir a decisão em duas partes, porque os requisitos são diferentes. Fato novo: o **Pix Automático** já funciona para recorrência. No Asaas, um único QR paga a 1ª cobrança e autoriza as próximas ("Jornada 3"), e desde 19/05/2026 as cobranças seguintes são geradas sozinhas [FATO, docs do Asaas]. O pagador pode cancelar até 23h59 do dia da cobrança.

## Opções
| Opção | Custo (taxas) | Prós | Contras/riscos |
|---|---|---|---|
| Asaas | Custo não levantado (tabela pública não consultada) | Pix Automático documentado; Pix, boleto, cartão e split | Concentração num fornecedor |
| Efí (ex-Gerencianet) | Custo não levantado | Pix com API do Bacen e mTLS | Documentação de Pix Automático não encontrada na rodada 7 |
| Pagar.me (Stone) | Custo não levantado | Cartão e split fortes | Pix recorrente a confirmar |
| Stripe | Custo não levantado | Ótima experiência para cobrar o SaaS | Disponibilidade do Pix e prazo de recebimento na conta brasileira a confirmar antes de escolher |

## Recomendação dos agentes
Recomendação, não decisão:
- **(a) nossa assinatura:** Asaas com Pix Automático + cartão, porque é o único com recorrência por Pix documentada;
- **(b) clínica ao paciente:** um gateway padrão (Asaas ou Efí) atrás da interface `PaymentGateway`, permitindo que a clínica conecte a própria conta.

Em qualquer caso, webhooks idempotentes e verificados são requisito do Portão B.

## O que trava se adiar
- Módulo financeiro (cobrança de consultas, pacotes, repasse).
- Primeira cobrança do piloto e a garantia G4 (cancelamento sem multa, cobrança correta).

## Para decidir, falta
Tabela de taxas de Asaas e Efí (Pix, Pix Automático, boleto, cartão, split); confirmar o Pix Automático na Efí.

## Fontes
- `docs/04-arquitetura/integracoes.md` §2
- `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.4 (branch `pesquisa/necessidades-producao`)
- [Asaas: Pix Automático](https://docs.asaas.com/docs/pix-automatico), [Asaas: Pix Automático x assinaturas](https://docs.asaas.com/docs/diferença-entre-pix-automático-e-assinaturas)

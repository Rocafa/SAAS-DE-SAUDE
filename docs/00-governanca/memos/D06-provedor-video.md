# D6 — Provedor de vídeo (teleconsulta)
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Engenharia · **Este memo não decide nada.**

**Pergunta:** qual tecnologia de vídeo usar na teleconsulta?
**Prazo sugerido:** antes da Fase 2 (teleconsulta não está no MVP) · **Urgência:** Baixa

## Contexto
A teleconsulta segue a Lei 14.510/2022 e as normas dos conselhos (CFM 2.314/2022, Res. CFP 9/2024 para psicologia). Vídeo de consulta é dado de saúde, então a residência no Brasil pesa. O roadmap deixou teleconsulta para a Fase 2.

## Opções
| Opção | Custo | Residência | Prós | Contras/riscos |
|---|---|---|---|---|
| A. LiveKit self-hosted em sa-east-1 | Custo não levantado (servidores de mídia na AWS) | Brasil | Open source, controle total | Operação de servidor WebRTC |
| B. LiveKit Cloud | Custo não levantado | A confirmar | Sem operação | Possível transferência internacional |
| C. Daily | Custo não levantado | Exterior | API simples, UI pronta | Transferência internacional (cláusulas-padrão) |
| D. Jitsi self-hosted | Custo não levantado | Brasil | Open source | Mais operação, menos API |

## Recomendação dos agentes
Recomendação, não decisão: **LiveKit**, começando por A se a psicologia confirmar a teleconsulta como prioridade (sessões online são comuns no nicho), ou por B se a residência for confirmada no contrato. A decisão pode esperar o fim do MVP.

## O que trava se adiar
Nada no MVP. Na Fase 2, trava a teleconsulta e o escriba em consulta online (o áudio viria do vídeo).

## Para decidir, falta
Peso real da teleconsulta nas entrevistas da D1 (principalmente psicologia); custo de servidores LiveKit em sa-east-1; região de processamento do LiveKit Cloud.

## Fontes
- `docs/04-arquitetura/integracoes.md` §6
- `docs/02-produto/roadmap.md` (teleconsulta na Fase 2)
- Res. CFP 9/2024 citada na pesquisa de 10/10/2026 ([CFP](https://site.cfp.org.br/))

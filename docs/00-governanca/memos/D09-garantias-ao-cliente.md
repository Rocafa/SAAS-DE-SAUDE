# D9 — Garantias ao cliente (Carta de Compromissos)
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Produto · **Este memo não decide nada.**

**Pergunta:** aprovar a Carta de Compromissos (G1–G9) e antecipar o roadmap público e a status page para o MVP?
**Prazo sugerido:** antes do piloto (a Carta é o argumento de venda) · **Urgência:** Média

## Contexto
As 5 queixas mais repetidas contra os concorrentes viraram garantias, e cada uma tem um mecanismo que a faz valer (código com teste, métrica com alarme ou cláusula). Exemplos: prontuário bloqueado por inadimplência e "não me deixam sair". O iClinic tem nota 6,4 no Reclame Aqui, e 18% das queixas da Doctoralia são "não consigo cancelar" [FATO-snippet, a revalidar]. A garantia de saída (G1–G3) já está em código, com testes no CI.

## Opções
| Opção | Custo | Prós | Contras/riscos |
|---|---|---|---|
| A. Aprovar G1–G9 e antecipar roadmap público (SUP-01.7) e status page (SUP-01.6) para o MVP | Status page e roadmap: custo não levantado (ferramenta + tempo) | Diferencial claro desde o piloto | Promessa pública cria obrigação; G5 depende do preço (D2) |
| B. Aprovar só G1–G3 (garantia de saída), já em código com teste | Baixo | Só promete o que já existe | Discurso de venda mais fraco |
| C. Adiar a Carta para depois do lançamento | Zero agora | Sem risco de publicidade | Perde o principal argumento contra a concorrência |

## Recomendação dos agentes
Recomendação, não decisão: **opção A**, publicada **somente depois** da revisão do advogado (D8) e das ressalvas M1–M6 do Guardião. Regra que continua valendo: garantia sem mecanismo não vai para o marketing (CDC art. 37).

## O que trava se adiar
- Página de vendas e material do piloto.
- Itens SUP-01.6 e SUP-01.7 no backlog do MVP.
- Teste E2E do cancelamento em até 3 cliques (G4).

## Para decidir, falta
D2 (para fechar a G5); parecer do advogado; revalidar os números do Reclame Aqui antes de usá-los em público.

## Fontes
- `docs/02-produto/garantias-ao-cliente.md` (matriz G1–G9)
- `docs/03-seguranca-lgpd/revisoes/2026-10-09-garantias.md` (ressalvas M1–M6)
- `docs/04-arquitetura/garantia-de-saida.md` e `apps/api/src/modules/exports/access-policy.ts`

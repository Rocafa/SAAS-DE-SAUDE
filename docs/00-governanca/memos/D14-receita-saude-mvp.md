# D14 — Escopo do Receita Saúde no MVP
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Produto · **Este memo não decide nada.**
> Origem: branch `pesquisa/necessidades-producao` (consolidação da rodada 7, depois do pedido que listava D1–D13). Incluído para o conjunto de memos ficar completo.

**Pergunta:** o MVP promete emitir o recibo do Receita Saúde sozinho, ou gera o arquivo de lote para o profissional enviar?
**Prazo sugerido:** junto com a D2 (afeta a promessa de venda) · **Urgência:** Média

## Contexto
Desde 01/01/2025, profissionais de saúde que atendem como **pessoa física** emitem recibo pelo Receita Saúde [FATO]. Isso inclui psicólogos, fisioterapeutas e terapeutas ocupacionais. Desde 04/11/2025 a Receita aceita **arquivos de integração** gerados por software de consultório para emitir vários recibos de uma vez (Manual v2.1, perguntas 24 e 25) [FATO]. **Não há API pública documentada.** O psicólogo autônomo, metade do nicho de entrada, é pessoa física.

## Opções
| Opção | Custo | Prós | Contras/riscos |
|---|---|---|---|
| A. Gerar o arquivo de lote no formato do manual v2.1 e conciliar o que foi emitido | Custo não levantado (engenharia) | Honesto; resolve a dor de digitar recibo por recibo | Profissional ainda envia o arquivo no e-CAC |
| B. Prometer emissão automática | Custo não levantado | Discurso mais forte | Sem API, a promessa não tem mecanismo: fere a regra das garantias e o CDC art. 37 |
| C. Fora do MVP | Zero | Foco | Psicólogo PF continua digitando recibo à mão: argumento a menos contra a concorrência |

## Recomendação dos agentes
Recomendação, não decisão: **opção A**, vendida como "gera o lote para o Receita Saúde", nunca como "emite sozinho". Reavaliar se a Receita publicar uma API.

## O que trava se adiar
- Texto da página de preço e da G5 (D2, D9).
- Histórias do financeiro para profissional PF no M2.

## Para decidir, falta
Validar o formato do arquivo com um contador; confirmar o prazo de emissão dos atendimentos de 2026 (estimado até 28/02/2027).

## Fontes
- Branch `pesquisa/necessidades-producao`: `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.2 e `docs/00-governanca/decisoes.md` (D14)
- [Fenacon: emissão em lote](https://fenacon.org.br/noticias/disponibilizada-nova-funcionalidade-para-emissao-em-lote-de-recibos-do-receita-saude/), [CRC-SP](https://online.crcsp.org.br/portal/noticias/noticia.asp?c=10027)

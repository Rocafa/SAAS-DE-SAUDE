# D12 — Certificação SBIS S-RES (NGS1/NGS2)
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Pesquisa · **Este memo não decide nada.**
> Origem: branch `pesquisa/necessidades-producao` (rodada 7), ainda não incorporado à `main`.

**Pergunta:** vamos buscar o selo SBIS de prontuário eletrônico, e em que momento?
**Prazo sugerido:** decidir antes do M0, porque afeta o desenho da auditoria e da assinatura · **Urgência:** Média

## Contexto
A certificação SBIS não é obrigatória por lei, mas é argumento de venda contra os concorrentes. Só o nível NGS2 permite prontuário 100% digital, sem papel (Res. CFM 1.821/2007) [FATO]. Os certificados emitidos até ago/2026 ainda citam o **Manual 2021 v5.2**, com validade inicial aparente de cerca de 2 anos [FATO]. Custo e prazo não são públicos.

## Opções
| Opção | Custo | Prós | Contras/riscos |
|---|---|---|---|
| A. Seguir o manual 5.2 desde o M0; NGS1 no 1º ano após o lançamento e NGS2 depois | Custo não levantado (pedir cotação à SBIS) | Evita refazer auditoria, assinatura e tempo confiável; selo vira argumento de venda | Mais requisitos no M0 |
| B. Certificar só quando um cliente exigir | Zero agora | Foco no MVP | Retrabalho grande na auditoria e na assinatura depois |
| C. Não certificar | Zero | Simples | Clínicas que querem eliminar papel precisam de NGS2; perde argumento contra iClinic e Feegow |

## Recomendação dos agentes
Recomendação, não decisão: **opção A**. Seguir o manual custa pouco agora: a auditoria append-only já existe e o encadeamento por hash já está planejado. Certificar só depois do lançamento.

## O que trava se adiar
- Desenho final da auditoria (hash encadeado) e do fluxo de assinatura ICP-Brasil no M0.
- Portão C (lançamento comercial) prevê SBIS "em andamento".

## Para decidir, falta
Cotação e prazo da SBIS (sbis@sbis.org.br); confirmar se o manual v5.3 já está vigente.

## Fontes
- Branch `pesquisa/necessidades-producao`: `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.9 e §5 e `docs/00-governanca/decisoes.md` (D12)
- [Certificado SBIS nº 203 (ago/2026)](https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_203_PRONTU.pdf), [Res. CFM 1.821/2007](https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2007/1821_2007.pdf)
- `docs/02-produto/PRD.md` (risco R5 e pergunta "Certificação SBIS NGS2: em que fase?")

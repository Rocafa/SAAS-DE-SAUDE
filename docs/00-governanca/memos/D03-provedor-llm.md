# D3 — Provedor de LLM para dado sensível
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente IA-LLM · **Este memo não decide nada.**

**Pergunta:** qual modelo processa dado de saúde no escriba e no resumo do paciente?
**Prazo sugerido:** antes do início do M3 (escriba) · **Urgência:** Média

## Contexto
O código já está pronto para receber o provedor: `apps/api/src/modules/ai/` tem a interface, a política de residência (dado sensível e psicologia só no Brasil, sem fallback para o exterior) e um adaptador fake. O adaptador real só entra depois desta decisão e de passar no gate do M3 ([protocolo](../../05-ia-llm/protocolo-avaliacao-escriba.md)). Fato novo da rodada 7: **Claude no Bedrock São Paulo usa endpoint Global**, ou seja, não garante processamento no Brasil.

## Opções
| Opção | Custo LLM por consulta [FATO de preço, cálculo ESTIMATIVA] | Residência | Prós | Contras/riscos |
|---|---|---|---|---|
| A. Gemini 2.5 Flash via Vertex AI, endpoint regional `southamerica-east1` | ≈ R$ 0,05 | Brasil, se chamado o endpoint regional | Barato, multimodal, contrato Google Cloud | Garantia só para funções da tabela de residência; risco de alguém usar o endpoint global |
| B. Maritaca Sabiá-4 + Sabiazinho-4 | ≈ R$ 0,075 | Brasil | Empresa nacional, cobra em reais, forte em PT-BR | Fornecedor menor; menos recursos (multimodal, SLA) |
| C. Claude ou GPT com dado pseudonimizado | ≈ R$ 0,04–0,22 | Exterior (cláusulas-padrão ANPD, Res. 19/2024) | Qualidade alta | Transferência internacional; psicologia proibida por regra nossa; depende da pseudonimização |
| D. A + B (duas rotas BR, uma como reserva da outra) | Soma das integrações | Brasil | Fallback sem sair do país | Dois contratos e dois evals |

## Recomendação dos agentes
Recomendação, não decisão: **opção D**, com o vencedor do eval como rota principal. A e B passam pelo mesmo protocolo (golden sets de fisio/TO e psicologia) e o resultado define a ordem. C fica só para dado pseudonimizado de clínicas que aceitarem transferência em contrato, e nunca para psicologia.

## O que trava se adiar
- Adaptadores reais do módulo `ai` e o eval com modelo real (`ia/eval-escriba`).
- Gate do M3 e o modo sombra no piloto.
- Frase "IA no Brasil" no marketing e o mapa de suboperadores do DPA (D8).

## Para decidir, falta
Rodar o protocolo com A e B (custa poucos reais em tokens); confirmar o preço do Vertex no endpoint regional; DPA e cláusula de não-treino de cada fornecedor.

## Fontes
- `docs/05-ia-llm/README.md` e `docs/05-ia-llm/arquitetura-ia.md` §2 e §4
- `docs/05-ia-llm/protocolo-avaliacao-escriba.md` §5
- `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.5 (branch `pesquisa/necessidades-producao`)
- [Vertex AI: residência de dados](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency), [Claude in Amazon Bedrock](https://platform.claude.com/docs/build-with-claude/claude-in-amazon-bedrock), [Maritaca: preços](https://www.maritaca.ai/en/api)

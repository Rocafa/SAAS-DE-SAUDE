# D2 — Preço
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com as frentes Produto e Pesquisa de mercado · **Este memo não decide nada.**

**Pergunta:** quanto cobrar, por qual unidade (profissional, clínica ou paciente) e o que vem incluído?
**Prazo sugerido:** junto com a D1, antes da página de preço e do piloto · **Urgência:** Média

## Contexto
Concorrentes cobram cerca de R$ 89–170 por profissional/mês e cobram WhatsApp e IA à parte [FATO, mercado]. A garantia G5 promete preço único com WhatsApp e IA incluídos (com cota). Dois custos variáveis novos pesam nessa promessa: IA de R$ 0,30–0,58 por consulta [ESTIMATIVA, arquitetura-ia.md §4.3] e WhatsApp de R$ 32–64 por clínica/mês com 400 consultas [ESTIMATIVA, rodada 7 §3.3].

## Opções
| Opção | Custo para nós | Prós | Contras/riscos |
|---|---|---|---|
| A. R$ 99–129 por profissional/mês, tudo incluído com cota de IA e WhatsApp, sem fidelidade; plano clínica a partir de R$ 249 para 3 profissionais | IA + WhatsApp ≈ R$ 230–445 por clínica de 600 consultas/mês [ESTIMATIVA: 600 × R$ 0,30–0,58 de IA + R$ 48–96 de WhatsApp] | Ataca a dor nº 1 (cobrança escondida); simples | Margem apertada em clínica de alto volume se a cota for generosa |
| B. Preço base menor + IA e WhatsApp como adicionais | Custo variável repassado | Margem protegida | Repete o modelo que o mercado critica; enfraquece a G5 |
| C. TEA por paciente ativo (≥ R$ 60/paciente/mês, hipótese H3) | Custo não levantado | Alinha preço ao valor no TEA | Só faz sentido se a D1 trouxer TEA para a onda 1 |

## Recomendação dos agentes
Recomendação, não decisão: **testar a opção A** nas entrevistas da D1 (teste Van Westendorp simplificado; aceitação ≥ 50%, hipótese H1). Definir uma **cota de IA e de mensagens por profissional** antes de publicar a G5, e templates de lembrete sempre na categoria "utilidade" do WhatsApp (marketing custa de 5 a 8 vezes mais).

## O que trava se adiar
- Página de preço e texto da Carta de Compromissos (G5, D9).
- Modelo financeiro do piloto e cálculo do ponto de equilíbrio de infraestrutura (D13).
- Configuração de cotas no gateway de IA (orçamento por tenant).

## Para decidir, falta
Resultado das entrevistas; tabela oficial de preços da Meta para o Brasil; preço do provedor de LLM (depende da D3).

## Fontes
- `docs/01-mercado/relatorio-executivo-mercado.md` (preço [ESTIMATIVA], H1, H3)
- `docs/02-produto/garantias-ao-cliente.md` (G5) e `docs/02-produto/PRD.md`
- `docs/05-ia-llm/arquitetura-ia.md` §4.3
- `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.3 (branch `pesquisa/necessidades-producao`) e [Meta: preços](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

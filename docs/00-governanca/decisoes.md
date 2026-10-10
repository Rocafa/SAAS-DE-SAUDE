# Registro de decisões

Cada decisão: data, quem decidiu (N0 = sócios), o que, por quê, e onde está a análise.

## Pendentes para os sócios (N0) — saída da Rodada 1 (08/10/2026)

| # | Decisão | Opções levantadas | Análise |
|---|---|---|---|
| D1 | **Nicho de entrada** — recomendação atual: fisio/TO + psico autônomo; TEA na onda 2 (ver relatorio-executivo-mercado.md) | (a) Psico + nutri + fisio + multiprofissionais — pesquisa geral; (b) TEA/ABA + fisio/TO — pesquisa de nichos. Ponto em comum: núcleo de sessões recorrentes, guias de convênio e repasse | `docs/01-mercado/mercado-geral-e-concorrentes.md` §5, `docs/01-mercado/nichos/` |
| D2 | **Preço** | Preço único R$ 89–129 com WhatsApp, IA e Receita Saúde inclusos, sem fidelidade; TEA cobra por paciente | `docs/01-mercado/`, `docs/02-produto/PRD.md` |
| D3 | **Provedor de LLM para dado sensível** | Gemini (Vertex, São Paulo) ou Maritaca/Sabiá no Brasil; Claude/GPT só pseudonimizado + cláusulas-padrão ANPD; psicologia nunca sai do país | `docs/05-ia-llm/README.md`, `arquitetura-ia.md` |
| D4 | **Autenticação** | Login próprio vs Keycloak hospedado no Brasil | `docs/04-arquitetura/README.md` |
| D5 | **Provedor Pix** | Asaas, Efí, Pagar.me, Stripe | `docs/04-arquitetura/integracoes.md` |
| D6 | **Provedor de vídeo** | LiveKit (recomendado), Daily, Jitsi | `docs/04-arquitetura/integracoes.md` |
| D7 | **Retenção da trilha de auditoria** | Mínimo 5 anos (sugestão) | `docs/03-seguranca-lgpd/` |
| D9 | **Garantias ao cliente** | Aprovar a Carta de Compromissos (G1–G9) e antecipar roadmap público (SUP-01.7) e status page (SUP-01.6) para o MVP | `docs/02-produto/garantias-ao-cliente.md` |
| D8 | **Validação jurídica** | Advogado especialista em saúde + LGPD revisa os itens ⚖️ (CFM 2.454/2026, TRF-1 estética, ANS cartões de desconto, DPA) | `docs/03-seguranca-lgpd/README.md` |
| D10 | **Receita controlada (SNCR)** — Anvisa RDC 1.000/2025: receita de controle especial só vale se emitida por sistema integrado ao SNCR | Integrar direto à API do SNCR vs usar parceiro já integrado (confirmar com a Memed) | `docs/relatorios/2026-10-10-rodada-7-necessidades-de-producao.md` §3 (R7) |
| D11 | **Inscrição no CRM como plataforma de prescrição** (Res. CFM 2.299/2021, art. 5º) | Inscrever a empresa (com responsável técnico) vs delegar a prescrição a parceiro inscrito | idem §3 (R6) ⚖️ |
| D12 | **Certificação SBIS S-RES NGS2** | Seguir o manual 5.2 desde o M0 e certificar depois do GA vs não certificar | idem §3 (R4) |
| D13 | **Orçamento de infraestrutura e pentest** | ~US$ 750–1.050/mês de AWS (staging + prod) [ESTIMATIVA]; pentest US$ 5–30 mil | idem §6 |

## Tomadas

| Data | Decisão | Por quem | Justificativa |
|---|---|---|---|
| 06/10/2026 | Hierarquia de agentes: Maestro + Guardião LGPD com veto + 4 frentes | Sócios | `hierarquia.md` |
| 08/10/2026 | Não treinar LLM do zero; API + RAG na Fase 1, fine-tune só com dados anonimizados e opt-in | Recomendação IA + Guardião (aguarda ratificação N0) | `docs/05-ia-llm/README.md` |

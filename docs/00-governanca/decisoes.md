# Registro de decisões

Cada decisão: data, quem decidiu (N0 = sócios), o que, por quê, e onde está a análise.

## Pendentes para os sócios (N0) — saída da Rodada 1 (08/10/2026)

| # | Decisão | Opções levantadas | Análise |
|---|---|---|---|
| D1 | **Nicho de entrada** — recomendação atual: fisio/TO + psico autônomo; TEA na onda 2 (ver relatorio-executivo-mercado.md) | (a) Psico + nutri + fisio + multiprofissionais — pesquisa geral; (b) TEA/ABA + fisio/TO — pesquisa de nichos. Ponto em comum: núcleo de sessões recorrentes, guias de convênio e repasse | `docs/01-mercado/mercado-geral-e-concorrentes.md` §5, `docs/01-mercado/nichos/` — **para decidir: `docs/01-mercado/kit-entrevistas/`** |
| D2 | **Preço** | Preço único R$ 89–129 com WhatsApp, IA e Receita Saúde inclusos, sem fidelidade; TEA cobra por paciente | `docs/01-mercado/`, `docs/02-produto/PRD.md` |
| D3 | **Provedor de LLM para dado sensível** | Gemini (Vertex, São Paulo) ou Maritaca/Sabiá no Brasil; Claude/GPT só pseudonimizado + cláusulas-padrão ANPD; psicologia nunca sai do país | `docs/05-ia-llm/README.md`, `arquitetura-ia.md` |
| D5 | **Provedor Pix** | Asaas, Efí, Pagar.me, Stripe | `docs/04-arquitetura/integracoes.md` |
| D6 | **Provedor de vídeo** | LiveKit (recomendado), Daily, Jitsi | `docs/04-arquitetura/integracoes.md` |
| D7 | **Retenção da trilha de auditoria** | Proposta: 20 anos (auditoria de prontuário), 5 anos (administrativa), 12 meses (logs de acesso) | `docs/03-seguranca-lgpd/retencao-e-descarte.md`, `matriz-retencao.md` |
| D8 | **Validação jurídica** | Advogado especialista em saúde + LGPD revisa os itens ⚖️ (CFM 2.454/2026, TRF-1 estética, ANS cartões de desconto, DPA) | `docs/03-seguranca-lgpd/README.md` — **para contratar: `docs/03-seguranca-lgpd/pacote-advogado.md`** |
| D9 | **Garantias ao cliente** | Aprovar a Carta de Compromissos (G1–G9) e antecipar roadmap público (SUP-01.7) e status page (SUP-01.6) para o MVP | `docs/02-produto/garantias-ao-cliente.md` |
| D10 | **Receita controlada (SNCR)** — Anvisa RDC 1.000/2025: receita de controle especial só vale se emitida por sistema integrado ao SNCR | Integrar direto à API do SNCR vs usar parceiro já integrado (confirmar com a Memed) | `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.8 |
| D11 | **Inscrição no CRM como plataforma de prescrição** (Res. CFM 2.299/2021, art. 5º) | Inscrever a empresa (com responsável técnico) vs delegar a prescrição a parceiro inscrito | idem §3.8 ⚖️ |
| D12 | **Certificação SBIS S-RES NGS2** | Seguir o manual 5.2 desde o M0 e certificar depois do GA vs não certificar | idem §3.9 |
| D13 | **Orçamento de infraestrutura e pentest** | ~US$ 750–1.050/mês de AWS (staging + prod) [ESTIMATIVA]; pentest US$ 5–30 mil | idem §4 |
| D14 | **Escopo do Receita Saúde no MVP** | Gerar o arquivo de lote (manual v2.1) e conciliar vs prometer emissão automática (não há API pública) | `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.2 |
| D15 | **Login real: saída para a base de senhas vazadas (B2) e queda do Redis** | Filtro de saída por domínio, proxy, cópia local ou abrir sem a conferência; login aberto ou fechado quando o Redis cai | `docs/00-governanca/memos/D15-login-real-egresso-e-falha-do-redis.md` |
| J4 | **Nomear o encarregado (DPO)** com canal público | Sócio, funcionário ou DPO terceirizado; trava o plano de incidente e os RIPDs | `docs/03-seguranca-lgpd/plano-resposta-incidentes.md` |

## Tomadas

| Data | Decisão | Por quem | Justificativa |
|---|---|---|---|
| 05/11/2026 | **D4 — Autenticação: Better Auth**, com as 6 regras da recomendação como requisito (clínica sempre da sessão no servidor; MFA por perfil e MFA recente de 15 min para prontuário sensível e exportação; sessão curta e revogável, que **substitui** o refresh rotativo do `seguranca-na-arquitetura.md` §2 e precisa do aval do Guardião; identidade em schema separado, migração pelo nosso pipeline, bloqueio de 5 tentativas em 15 min no Redis; portal do paciente com login separado; versão fixada e revisão mensal dos avisos). Sem SSO/SAML no primeiro ano (nicho de entrada). Login do paciente no portal por **SMS**, com e-mail como alternativa. Condição: R6 do parecer do #117 — login montado fora de controller Nest tem de ser auditado pelos hooks da biblioteca e entrar na lista conhecida do teste de cobertura | Sócios @Rocafa (03/11) e @Lopesloro (05/11) | `memos/D04-recomendacao.md`; PoC medida no PR #36 |
| 03/11/2026 | **#105 (S6):** aval ao desenho de @Lopesloro — teste que exige declaração (toda rota de escrita está na lista "auditada" ou na lista "sem auditoria, com motivo"; rota nova fora das duas falha o CI). Interceptor global descartado: a trilha tem de ficar na transação de quem age | Sócio @Rocafa | comentário de @Lopesloro no #105 |
| 06/10/2026 | Hierarquia de agentes: Maestro + Guardião LGPD com veto + 4 frentes | Sócios | `hierarquia.md` |
| 08/10/2026 | Não treinar LLM do zero; API + RAG na Fase 1, fine-tune só com dados anonimizados e opt-in | Recomendação IA + Guardião (aguarda ratificação N0) | `docs/05-ia-llm/README.md` |

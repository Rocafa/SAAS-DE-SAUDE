# Plataforma Saúde (nome provisório)

SaaS brasileiro de gestão para clínicas e consultórios de **todos os nichos da saúde**
(medicina, odontologia, psicologia, nutrição, fisioterapia/TO, estética, fonoaudiologia/TEA,
clínicas multiprofissionais) — com IA (LLM própria), WhatsApp, Pix e **LGPD by design**.

## Como o projeto é organizado

O trabalho é feito por uma **orquestra de agentes** com hierarquia definida:

| Nível | Papel |
|---|---|
| N0 | 👥 Sócios — decisão final |
| N1 | 🎼 Maestro — orquestra e integra · 🛡️ Guardião LGPD — poder de veto |
| N2 | 📊 Mercado · 🧩 Produto · 🛠️ Engenharia · 🤖 IA/LLM |
| N3 | Executores de micropartes |

- Hierarquia e regras: [docs/00-governanca/hierarquia.md](docs/00-governanca/hierarquia.md)
- Fluxogramas: [docs/00-governanca/fluxograma.md](docs/00-governanca/fluxograma.md)
- Definições dos agentes (Claude Code): [.claude/agents/](.claude/agents/)

## Mapa da documentação

| Pasta | Conteúdo | Frente dona |
|---|---|---|
| `docs/00-governanca` | Hierarquia, fluxogramas, decisões | Maestro |
| `docs/01-mercado` | Mercado, concorrentes, pesquisa por nicho | Pesquisa de Mercado |
| `docs/02-produto` | PRD, micropartes (WBS), roadmap, jornadas | Produto |
| `docs/03-seguranca-lgpd` | Mapa regulatório, bases legais, checklist | Guardião LGPD |
| `docs/04-arquitetura` | Stack, modelo de dados, integrações, DevOps | Engenharia |
| `docs/05-ia-llm` | Estratégia de LLM, dados, treino, avaliação | IA/LLM |
| `apps/`, `packages/` | Código (monorepo) | Engenharia |

## Regra nº 1
**Nunca** commite dado real de paciente, segredo, certificado ou dataset. Veja `docs/03-seguranca-lgpd/`.

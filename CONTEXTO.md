# Contexto do projeto — leia primeiro

> Resumo para o sócio (e para qualquer agente de IA) entender o projeto em 5 minutos.
> Atualizado em 08/10/2026 (rodada 2: ver [relatório](docs/relatorios/2026-10-08-rodada-2.md)). Detalhes e fontes estão nos links de cada seção.

## 1. O que estamos construindo
SaaS brasileiro de gestão para clínicas e consultórios de **todos os nichos da saúde**, concorrente do iClinic,
Feegow e Ninsaúde. Inclui agenda, agendamento online, prontuário por especialidade, receita digital (ICP-Brasil),
financeiro, Pix, NFS-e, WhatsApp, portal do paciente, TISS (convênios) e **IA** (escriba que escreve a evolução,
resumo do paciente, chatbot). Tudo com **LGPD desde o desenho** (*by design*).

## 2. Como trabalhamos
- Somos dois sócios (N0) e uma **orquestra de agentes de IA** no Claude Code: o Maestro coordena, o Guardião LGPD
  pode vetar, o Revisor de código bloqueia bugs, e há líderes e executores por frente.
  → [hierarquia](docs/00-governanca/hierarquia.md) · [fluxogramas](docs/00-governanca/fluxograma.md)
- Skills disponíveis, qual agente usar e como automatizar CI e features:
  → [skills-agentes-e-automacao.md](docs/00-governanca/skills-agentes-e-automacao.md)
- Os agentes ficam em `.claude/agents/`. Abra o Claude Code nesta pasta e eles são carregados sozinhos.

## 3. O que a pesquisa mostrou (Rodada 1)
- **Mercado de troca, não de primeira adoção:** 92% dos estabelecimentos já usam sistema eletrônico.
  Migração fácil e exportação total dos dados são as armas de venda.
- **Preços dos concorrentes:** cerca de R$ 89–170 por profissional por mês; WhatsApp e IA costumam ser cobrados à parte.
- **Queixas recorrentes:** prontuário bloqueado ao cancelar, cobrança indevida e suporte lento.
- **Potencial estimado:** cerca de 2,19 milhões de profissionais com consultório; R$ 0,6–2,0 bilhões por ano.
- **Nichos:** 11 pesquisados. A pesquisa de nichos aponta TEA/ABA (autismo) + fisio/TO como entrada mais atrativa.
  A pesquisa geral aponta psicologia, nutrição e fisio.
  → [mercado](docs/01-mercado/) · [nichos](docs/01-mercado/nichos/)

## 4. Produto
- **24 módulos, 332 micropartes** (194 no MVP, 106 na Fase 2, 32 na Fase 3); 169 tocam dado sensível.
- **MVP estimado de nov/2026 a jun/2027.** TISS e teleconsulta ficam para a Fase 2.
- **Garantias ao cliente** contra as queixas nº 1 do mercado (prontuário bloqueado, cancelamento difícil): [garantias-ao-cliente.md](docs/02-produto/garantias-ao-cliente.md).
- **Backlog do MVP:** 24 épicos, 176 histórias, 898 pontos (M0+M1: 79 histórias, 377 pontos), incluindo controle de guia simples e pacotes no M1. Também prontos: definição de pronto, métricas e plano de piloto (30 clínicas).
- **Nicho de entrada recomendado:** fisio/TO + psicólogos autônomos; TEA/ABA na onda 2 ([relatório executivo](docs/01-mercado/relatorio-executivo-mercado.md)).
  → [PRD](docs/02-produto/PRD.md) · [WBS](docs/02-produto/WBS-micropartes.md) · [roadmap](docs/02-produto/roadmap.md) · [jornadas](docs/02-produto/jornadas.md)

## 5. LGPD e regulação (inegociável)
- **Papéis:** a clínica é a controladora dos dados e nós somos operadores. Se treinarmos IA com dados, passamos a ser controladores.
- **Já em vigor:**
  - Resolução CFM 2.454/2026: a IA exige revisão humana e o paciente pode recusar.
  - A ANPD virou agência reguladora.
  - Incidente de vazamento deve ser comunicado em 3 dias úteis.
- **Nunca** usar dado real de paciente no git, em prompts ou em datasets.
  → [mapa regulatório e checklist](docs/03-seguranca-lgpd/)

## 6. Tecnologia
- **Stack:** monorepo pnpm + Turborepo; Next.js + shadcn no front; NestJS na API.
- **Dados:** PostgreSQL com isolamento por clínica (RLS); Redis/BullMQ para filas.
- **Hospedagem:** AWS São Paulo.
- **Código:** o esqueleto está pronto, mas **ainda não foi executado**.
  → [arquitetura](docs/04-arquitetura/)

## 7. IA
- Não vamos treinar um modelo do zero.
- **Fase 1:** API + RAG, com o profissional revisando tudo.
- **Fase 2:** ajuste fino só com dados anonimizados e com opt-in das clínicas.
- **Fase 3:** modelo próprio no Brasil, quando houver escala.
- **Dado sensível** vai para modelos hospedados no Brasil (Gemini em São Paulo ou Maritaca/Sabiá).
- **Custo do escriba:** cerca de R$ 0,30–0,58 por consulta.
  → [estratégia de IA](docs/05-ia-llm/)

## 8. Decisões pendentes dos sócios
Nicho de entrada · preço · provedor de LLM · autenticação · Pix · vídeo · retenção de auditoria · advogado.
→ [decisoes.md](docs/00-governanca/decisoes.md)

## 9. Como começar (sócio novo)
```bash
git clone https://github.com/Rocafa/SAAS-DE-SAUDE.git
cd SAAS-DE-SAUDE
claude
```
Depois peça ao Claude: *"Leia o CONTEXTO.md e me dê um resumo do estado do projeto e das decisões pendentes."*

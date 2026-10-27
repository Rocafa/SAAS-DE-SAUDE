# Contexto do projeto — leia primeiro

> 📘 **Quer entender tudo de uma vez?** Leia o [Relatório Geral](docs/relatorios/RELATORIO-GERAL.md) (atualizado até a rodada 27, 27/10/2026): estado de cada área, migrações, o que cada check do CI protege, decisões pendentes, riscos, ordem de merge quando o CI voltar, o que falta para o piloto e glossário.
>
> 🚀 **O que falta para produção (rodada 7, 10/10/2026):** [checklist P0/P1/P2 + pesquisa regulatória atualizada](docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md).
>
> 🧭 **O que ainda falta (12/10/2026, depois da rodada 8):** [visão consolidada](docs/relatorios/2026-10-12-o-que-falta.md) · **Quem está fazendo o quê agora:** [fila.md](docs/00-governanca/fila.md).
>
> Resumo para o sócio (e para qualquer agente de IA) entender o projeto em 5 minutos.
> Atualizado em 27/10/2026 (rodadas 16–27: importador, responsáveis, portal, WhatsApp, agendador de tarefas, integração #73, vetos do front levantados e portal ligado ao backend no #75, ensaio do merge completo, pacientes/agenda no backend novo (#76), chave por clínica trancada à própria clínica e Terraform do staging aprovado). Último relatório: [rodada 27](docs/relatorios/2026-10-27-rodada-27.md). Detalhes e fontes estão nos links de cada seção.

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
- **Telas (rodadas 8 a 25):** na `main` ainda com **dados fictícios** e **sem falar com a API**. Na `main` (PR #42): design system em cinza (alto contraste, letra grande), o **Ajudante** (busca e ações digitadas em português, processadas só no navegador), Hoje, Agenda e Pacientes. Em PR: agenda e pacientes completos (#43, pronto, parado sem CI); atendimento/prontuário/documentos (#44), financeiro/guias/mensagens (#45), configurações (#46) e portal do paciente (#47), com os **vetos do Guardião levantados em 24/10** ([re-revisão](docs/03-seguranca-lgpd/revisoes/2026-10-24-front-vetos.md)); e o portal ligado ao backend real (#75); pacientes e agenda alinhados ao backend novo (#76, aprovado em 27/10). Capturas em `docs/02-produto/telas/`; parecer em [front-r8](docs/03-seguranca-lgpd/revisoes/2026-10-12-front-r8.md).
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
- **Código na `main` (12/10/2026):**
  - isolamento por clínica (RLS) com **guarda de schema** (o CI reprova tabela nova sem a trava);
  - **criptografia por clínica** (cada clínica tem a própria chave; apagar a chave torna os dados dela ilegíveis, até nos backups);
  - **auditoria encadeada** (cada registro carrega a impressão digital do anterior, então alterar ou apagar deixa rastro);
  - garantia de saída, **rate limit em Redis**, NestJS 12, interface de IA só com adaptador falso;
  - 9 checks de CI, verdes na última execução.
- **Prontos em PR, esperando o CI voltar** (testados localmente contra Postgres real):
  - rotas de **pacientes e agenda** (#57);
  - **vínculo de cuidado**, alerta de anomalia e pseudônimo via KMS (#61);
  - **guias de convênio e pacotes** (#62);
  - **prontuário** por nicho: cifrado, versionado, só com vínculo de cuidado, notas privadas da psicologia (#63);
  - **financeiro**: cobranças, caixa, recibos sem buraco, insumo do Receita Saúde (#65);
  - **integração #73** (substitui #66–#69): **importador** dos concorrentes (desligado em produção até a R3), **responsáveis** do paciente (pagador congelado no recibo; informação clínica só por decisão do profissional), **backend do portal do paciente** (sessão própria; responsável só para menor/curatela, sem nada clínico; sigilo do adolescente até no banco), **lembretes por WhatsApp** (opt-in amarrado ao número, modelos em lista fechada, canal desligado por padrão). inclui também o **agendador real das tarefas automáticas** (merge só com os testes de Redis real verdes no CI). Guardião: aprovado; migrações até a 0053; `test:rls` 600/600 local;
  - **telas ligadas à API real** (#60) e **portal do paciente ligado ao backend real** (#75, aguarda @Lopesloro).
- **Ainda não há:** login real (depende da **D4**, o gargalo), conta da Meta/BSP para o WhatsApp real, nem ambiente aplicado na AWS.
- **Infra em PR:** Terraform do staging (#58, aprovado com ressalvas, nada aplicado na AWS) e imagem Docker distroless com scan (#59).
- ⚠️ **O GitHub Actions parou por falta de pagamento da conta:** hoje nenhum CI roda, e sem CI verde não se faz merge de código ([fila.md](docs/00-governanca/fila.md)).
- **O que falta para produção** (infra, regulação, custos e checklist de go-live): [rodada 7](docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md).
  → [arquitetura](docs/04-arquitetura/)

## 7. IA
- Não vamos treinar um modelo do zero.
- **Fase 1:** API + RAG, com o profissional revisando tudo.
- **Fase 2:** ajuste fino só com dados anonimizados e com opt-in das clínicas.
- **Fase 3:** modelo próprio no Brasil, quando houver escala.
- **Dado sensível** vai para modelos hospedados no Brasil (Gemini em São Paulo ou Maritaca/Sabiá).
- **Custo do escriba:** cerca de R$ 0,30–0,58 por consulta.
  → [estratégia de IA](docs/05-ia-llm/)

## 8. Decisões pendentes dos sócios (D1–D14 + DPO)
Todas pendentes; cada uma tem um memo de 1 página em [memos/](docs/00-governanca/memos/README.md) (o memo recomenda, não decide).
- **Mais urgentes:** **D4** autenticação (gargalo; a PoC #36 mediu Zitadel × Better Auth) · **D8** advogado de saúde + LGPD · nomear o **DPO** (encarregado de dados) · **D13** orçamento de infra e pentest.
- **Dependem de entrevistas com clínicas:** **D1** nicho de entrada · **D2** preço · **D14** Receita Saúde no MVP.
- **Demais:** **D3** provedor de LLM no Brasil · **D5** Pix · **D6** vídeo · **D7** retenção da auditoria (proposta: 20 anos prontuário, 5 anos administrativa, 12 meses logs de acesso) · **D9** Carta de Compromissos · **D10** receita controlada (SNCR) · **D11** inscrição no CRM · **D12** certificação SBIS.
→ [decisoes.md](docs/00-governanca/decisoes.md)

## 9. Como começar (sócio novo)
```bash
git clone https://github.com/Rocafa/SAAS-DE-SAUDE.git
cd SAAS-DE-SAUDE
claude
```
Depois peça ao Claude: *"Leia o CONTEXTO.md e me dê um resumo do estado do projeto e das decisões pendentes."*

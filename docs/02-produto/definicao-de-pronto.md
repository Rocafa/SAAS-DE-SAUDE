# Definição de Pronto — Definition of Ready (DoR) e Definition of Done (DoD)

> Frente: 🧩 Produto (N2) · Versão 0.1 · Data: 2026-10-08
> Base: [WBS-micropartes.md](./WBS-micropartes.md) (DoD global e critério de pronto por microparte) · [backlog-mvp.md](./backlog-mvp.md) · [checklist-pr.md](../03-seguranca-lgpd/checklist-pr.md) · agentes em `.claude/agents/`
> Vale para toda história de usuário (HU) e toda microparte da WBS. Mudanças nesta página: proposta por qualquer frente → Produto (N2) → Maestro (N1); se afrouxar item de LGPD, também Guardião LGPD.

## 1. Níveis de "pronto"

| Nível | Quem declara | Quando |
|---|---|---|
| **Pronta para entrar** (DoR) | Produto (N2) + líder da frente dona | Antes de a HU entrar numa iteração |
| **Pronta** (DoD da HU/microparte) | Executor → Revisor de código → Guardião (se `S`) → líder da frente | Antes do merge na `main` |
| **Pronto do marco** | Maestro (N1) + Guardião + sócios (N0) | No fim de cada marco M0–M4 ([roadmap.md](./roadmap.md) §2) |
| **Pronto para GA** | Sócios (N0) | Critérios de [plano-piloto.md](./plano-piloto.md) §6 |

## 2. Definition of Ready (DoR) — a história pode entrar na iteração quando

### 2.1 Conteúdo
- [ ] Tem ID `HU-<MOD>-NNN`, épico, marco e fase (MVP/F2/F3).
- [ ] Está no formato **"Como <persona>, quero <ação>, para <benefício>"**, com persona do [PRD](./PRD.md) §3.
- [ ] Lista os **IDs da WBS** cobertos; cada microparte tem frente dona, dependências, critério de pronto, flag `S/N` e fase preenchidos na WBS.
- [ ] Tem **critérios de aceite em Gherkin** (Dado/Quando/Então), 2–4 cenários; se a flag LGPD for `S`, pelo menos **1 cenário de erro/segurança** (acesso negado, tenant cruzado, consentimento ausente, auditoria gerada).
- [ ] Estimada em story points (Fibonacci 1, 2, 3, 5, 8, 13). **13 é o teto:** acima disso, quebrar a história antes de entrar.
- [ ] Prioridade MoSCoW definida; tag `[nicho:X]` quando específica de nicho (ver decisão D1 em [decisoes.md](../00-governanca/decisoes.md)).

### 2.2 Dependências e insumos
- [ ] Dependências da WBS **prontas** ou com plano explícito (stub/contrato de interface) aprovado pelo líder da frente.
- [ ] Dependências externas (Meta/BSP, PSP, PSC ICP-Brasil, agregador NFS-e, provedor de IA) contratadas ou com sandbox disponível.
- [ ] Conteúdo clínico (modelos, escalas, golden sets) **revisado por profissional do nicho** quando a HU depender dele.
- [ ] Protótipo/fluxo de tela aprovado pelo `design-ui` quando houver interface nova (inclui estados de vazio, erro e carregamento).
- [ ] Eventos de analytics a instrumentar identificados em [metricas-produto.md](./metricas-produto.md) §5.

### 2.3 LGPD (obrigatório se flag `S`)
- [ ] Finalidade e base legal identificadas na matriz (LGP-01.1 · [bases-legais-e-consentimento.md](../03-seguranca-lgpd/bases-legais-e-consentimento.md)).
- [ ] Classificação de dados (C3/C4) dos campos novos definida; minimização discutida (nenhum campo "por via das dúvidas").
- [ ] Se for novo fluxo de dado sensível, novo suboperador ou uso de IA: necessidade de atualizar ROPA/RIPD registrada como tarefa da HU.
- [ ] Guardião LGPD **ciente** (comentário na HU) — o veto é no merge, mas a ciência é no início.
- [ ] Dados de teste definidos como **sintéticos** (nunca dado real de paciente).

## 3. Definition of Done (DoD) — a história/microparte está pronta quando

### 3.1 Funcional
- [ ] Todos os cenários Gherkin da HU passam, **automatizados** (unitário, integração ou E2E Playwright conforme o caso).
- [ ] Critério de pronto específico de cada microparte coberta (coluna da WBS) foi cumprido e evidenciado (print, relatório de teste ou métrica).
- [ ] Demonstrado ao líder da frente dona no ambiente de *staging* com dados sintéticos.

### 3.2 Testes (agente `qa-testes`)
- [ ] Testes escritos antes ou junto do código (TDD); cobertura de linhas ≥ 80% no código novo de domínio.
- [ ] Unitários + integração verdes no CI; E2E dos fluxos críticos (agenda → atendimento → assinatura) verdes.
- [ ] Testes de **contrato** para integrações externas (WhatsApp, PSP, NFS-e, PSC, IA) com *mock* do provedor.
- [ ] Testes de desempenho quando a WBS fixa tempo (ex.: busca < 300 ms, histórico < 2 s).
- [ ] Executor apresentou **evidência real** de execução dos testes (skill `verification-before-completion`).

### 3.3 Isolamento de tenant (inegociável)
- [ ] Toda tabela nova com dado de tenant tem `tenant_id` + **RLS com `FORCE`**.
- [ ] Toda query/endpoint novo tem teste automatizado provando que **o tenant A não lê nem escreve dado do tenant B** (incluindo jobs, filas, arquivos, buscas e respostas de IA/RAG).
- [ ] Requisição sem contexto de tenant é rejeitada.

### 3.4 Acesso, sigilo e auditoria
- [ ] Autenticação e autorização (RBAC + vínculo de cuidado/ABAC) verificadas **no servidor**.
- [ ] Recepção e financeiro continuam sem acesso a conteúdo clínico (teste).
- [ ] Leituras, escritas e exportações de dado C3/C4 geram **evento de auditoria** (NUC-04.1) com quem, o quê, quando, IP e dispositivo — teste verifica o evento.
- [ ] Campos clínicos novos com criptografia em nível de campo.

### 3.5 LGPD e segurança (agente `guardiao-lgpd`)
- [ ] [checklist-pr.md](../03-seguranca-lgpd/checklist-pr.md) preenchido na descrição do PR; **nenhum "Não" em item 🔴**; todo "N/A" justificado.
- [ ] Se flag `S`: **aprovação do Guardião LGPD** registrada no PR (veto absoluto).
- [ ] Funcionalidade dependente de consentimento consulta o consentimento ativo no servidor (LGP-01.2).
- [ ] Logs, APM, Sentry e eventos de analytics **sem dado pessoal/sensível** (varredura de PII sem achados).
- [ ] Secret scan, SAST, SCA e scan de imagem sem vulnerabilidade crítica/alta aberta.
- [ ] ROPA/RIPD atualizados quando aplicável; nova retenção registrada na tabela de temporalidade (LGP-03.3).
- [ ] Mensagens de WhatsApp/SMS/e-mail sem informação clínica.
- [ ] Saída de IA entra como **rascunho** com revisão humana obrigatória e registro de uso de IA (Resolução CFM 2.454/2026).

### 3.6 Revisão de código (agente `revisor-codigo`)
- [ ] Revisão do `revisor-codigo` com resultado **APROVADO** (skills `code-review` nível high + `simplify`); nenhum bug crítico aberto.
- [ ] Mudança em autenticação, sessão, criptografia, prontuário, prescrição ou IA revisada também por um segundo engenheiro com foco em segurança.
- [ ] Padrões do projeto: tipos de `packages/shared`, Conventional Commits em português, branch `<frente>/<microparte>`.

### 3.7 Qualidade de produto
- [ ] Telas com acessibilidade mínima (WCAG 2.1 AA: contraste, foco por teclado, rótulos) e responsivas (tablet na recepção, celular no portal).
- [ ] Textos em pt-BR revisados; mensagens de erro acionáveis e sem dado sensível.
- [ ] Eventos de analytics definidos em [metricas-produto.md](./metricas-produto.md) instrumentados e validados em *staging*.
- [ ] Feature flag (NUC-05.7) quando a liberação for gradual.

### 3.8 Documentação
- [ ] Documentação de API (OpenAPI) atualizada.
- [ ] `docs/` atualizados quando a HU muda comportamento descrito (PRD, WBS, jornadas, arquitetura, LGPD).
- [ ] Artigo da central de ajuda (SUP-01.1) criado/atualizado para funcionalidade visível ao cliente.
- [ ] Nota de mudança (changelog) para o cliente quando aplicável.

### 3.9 Operação
- [ ] Métricas, alertas e dashboards de SLO cobrem o fluxo novo (NUC-05.5).
- [ ] Migrations reversíveis; *deploy* em staging verde; plano de *rollback* conhecido.

## 4. Pronto do marco (gate)

| Marco | Critério adicional ao DoD de todas as HUs do marco |
|---|---|
| M0 | Suíte de isolamento de tenant 100% verde; auditoria e criptografia ativas; ROPA inicial aprovada |
| M1 | **Gate LGPD:** RIPD do produto aprovado, pentest externo do núcleo sem achado crítico/alto aberto, plano de incidentes testado em *tabletop* → só então entra dado real de piloto |
| M2 | ≥ 70% dos agendamentos do bot concluídos sem humano no piloto; no-show medido |
| M3 | RIPD do escriba aprovado; gate de avaliação de IA (IA-05.3) aprovado por nicho liberado |
| M4 / GA | Critérios de [plano-piloto.md](./plano-piloto.md) §6 + SLO 99,9% por 4 semanas + Guardião ✅ + Sócios ✅ |

## 5. O que NÃO é pronto
- "Funciona na minha máquina" sem evidência de CI.
- Teste com dado real de paciente, ou print com dado real anexado ao PR.
- HU com flag `S` mergeada sem aprovação do Guardião, mesmo em hotfix (hotfix segue o fluxo acelerado, não o pula).
- Funcionalidade de IA que grava direto no prontuário sem revisão humana.

## Garantias ao cliente (obrigatório nas histórias afetadas)

Toda história que mexe em **assinatura e cobrança (BIL), exportação (EXP), migração (MIG), suporte (SUP) ou acesso por status de assinatura** só fica pronta se:

- [ ] Não viola nenhuma garantia G1–G9 de [garantias-ao-cliente.md](garantias-ao-cliente.md).
- [ ] Mantém verdes os testes que fazem valer G1–G3 (política de acesso por status e janela de saída, exportação isolada por tenant, auditoria append-only).
- [ ] Histórias de exportação (EXP) testam os controles contra vazamento da G2 (EXP-01.5): MFA nos últimos 5 min, aprovação do responsável técnico, link vinculado ao usuário com expiração de 24 h e limite de downloads, alerta a todos os admins e ao RT com "não fui eu" revogando o link e encerrando as sessões, janela de segurança, pausa quando houver suspeita de conta comprometida e auditoria da exportação.
- [ ] Histórias de eliminação (EXP-01.6) registram que a exportação foi oferecida antes de eliminar e emitem certificado com a data de expiração da última cópia de backup ([retencao-e-descarte.md](../03-seguranca-lgpd/retencao-e-descarte.md)).
- [ ] Quando cria um mecanismo novo para uma garantia, atualiza a coluna "Como a fazemos valer" e a §4 (estado da implementação) daquele documento.

# Processo de trabalho (playbook operacional)

> Como os dois sócios e a orquestra de agentes transformam uma ideia em entrega revisada no GitHub.
> Complementa [hierarquia.md](hierarquia.md), [fluxograma.md](fluxograma.md) e [skills-agentes-e-automacao.md](skills-agentes-e-automacao.md).

## 1. Matriz RACI

R = executa · A = responde pelo resultado (só um por linha) · C = consultado · I = informado

| Atividade | Sócios | Maestro | Guardião LGPD | Revisor | Líder de frente | Executor |
|---|---|---|---|---|---|---|
| Definir prioridades e escopo | **A** | R | C | I | C | I |
| Quebrar em micropartes | C | **A** | C | I | R | I |
| Pesquisa de mercado | I | C | I | — | **A** (Mercado) | R |
| Especificação (PRD/histórias) | C | C | C | I | **A** (Produto) | R |
| Código e testes | I | C | C | C | **A** (Engenharia) | R |
| Funcionalidades de IA | C | C | C | C | **A** (IA/LLM) | R |
| Revisão de código | I | I | I | **A**/R | C | C |
| Revisão LGPD/segurança (veto) | I | I | **A**/R | C | C | C |
| Integração entre frentes | I | **A**/R | C | C | C | I |
| Merge na `main` / release | **A** | R | C (veto) | C | I | I |
| Decisões de negócio (preço, nicho) | **A**/R | C | C | — | C | — |

## 2. Rituais

| Ritual | Quando | Quem | Saída |
|---|---|---|---|
| **Sync dos sócios** | Semanal, 30 min | Sócios | Prioridades da semana; decisões registradas em [decisoes.md](decisoes.md) |
| **Rodada de agentes** | Por demanda (1 a 3 por semana) | Maestro + até 3 agentes | Entregas commitadas e relatório em `docs/relatorios/` |
| **Revisão de entregas** | Ao fim de cada rodada | Sócios | Aprovar, pedir ajuste ou descartar |
| **Revisão regulatória** | Mensal | Guardião LGPD | Atualização do mapa regulatório (ANPD, CFM, ANS, Anvisa) |
| **Retrospectiva** | Mensal | Sócios | O que melhorar no processo e no uso dos agentes |

## 3. Como abrir uma demanda
1. No GitHub, abra uma **Issue** usando um modelo: Feature, Pesquisa, Decisão ou Incidente LGPD (`.github/ISSUE_TEMPLATE/`).
2. Informe os IDs da WBS quando houver (ex.: `AGD-03.2`).
3. No Claude Code: *"Use o agente maestro na issue #N"*.
4. O Maestro aplica o pipeline da [Parte 4 do guia de skills](skills-agentes-e-automacao.md).

## 4. Regras de economia e continuidade
- **No máximo 3 subagentes** por rodada. Prefira executar direto; delegue só o que é grande e independente.
- Prompts de agentes enxutos: arquivos exatos para ler, formato de saída e tamanho máximo da resposta.
- **Commit após cada entrega.** Perto do limite de uso, commite tudo e registre o relatório da rodada.
- Toda rodada termina com um relatório em `docs/relatorios/AAAA-MM-DD-<tema>.md`.

## 5. Classificação de mudanças

| Tipo | Exemplo | Exige |
|---|---|---|
| 🟢 Documento sem dado sensível | Pesquisa, roadmap | Commit direto na `main` (fase atual) |
| 🟡 Código sem dado de paciente | UI, utilitários | PR + revisor + CI verde |
| 🔴 Toca dado pessoal ou de saúde | Prontuário, IA, integrações | PR + revisor + **Guardião APROVADO** + RIPD quando aplicável + 2 sócios |

> Quando o código do MVP começar, a `main` passa a ser protegida: nada entra sem PR (ver a Parte 5 do guia de skills).

## 6. Níveis de severidade de incidente

| Nível | Exemplo | Resposta |
|---|---|---|
| S1 | Vazamento ou acesso indevido a dado de saúde | Imediata: Guardião + sócios; comunicação à ANPD e aos titulares em até 3 dias úteis |
| S2 | Segredo exposto no git | Revogar a credencial na hora e limpar o histórico |
| S3 | Bug sem exposição de dados | Correção no próximo ciclo |

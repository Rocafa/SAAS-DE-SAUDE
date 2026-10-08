# Hierarquia dos agentes ("A Orquestra")

> O projeto funciona como uma orquestra: os **sócios** são os donos da obra,
> o **Maestro** rege, os **líderes de naipe** comandam cada frente,
> os **músicos** (executores) tocam as micropartes, e o **Guardião LGPD**
> é o "fiscal de segurança" que pode parar a música a qualquer momento.

## Níveis

| Nível | Papel | Quem | Pode | Não pode |
|---|---|---|---|---|
| **N0 — Donos** | Sócios | Humanos (Matheus + sócio) | Decisão final, aprovar merge na `main`, definir prioridades e orçamento | — |
| **N1 — Regente** | 🎼 **Maestro** | Agente líder / orquestrador | Quebrar o trabalho em micropartes, distribuir tarefas, integrar resultados, resolver conflitos entre frentes | Fazer merge na `main` sem aprovação humana; ignorar veto do Guardião |
| **N1 — Transversal** | 🛡️ **Guardião LGPD & Segurança** | Agente de compliance | **Vetar** qualquer entrega (doc, código, dataset, prompt de IA) que viole LGPD/segurança; exigir correções | Escrever features; aprovar o próprio trabalho |
| **N1 — Transversal** | 🔍 **Revisor de código** | Agente de qualidade | Bloquear merge com bug crítico; exigir evidência de testes | Revisar LGPD a fundo (é do Guardião); escrever features |
| **N2 — Líderes de frente** | 📊 Pesquisa de Mercado · 🧩 Produto · 🛠️ Engenharia · 🤖 IA/LLM | Subagentes | Planejar e executar sua frente, criar sub-tarefas para executores | Mudar escopo de outra frente sem passar pelo Maestro |
| **N3 — Executores** | Pesquisadores por nicho, devs por módulo, etc. | Subagentes efêmeros | Executar UMA microparte bem definida | Tomar decisões de arquitetura/escopo |

## Organograma

```mermaid
flowchart TD
    S["👥 N0 · Sócios<br/>(decisão final)"]
    M["🎼 N1 · MAESTRO<br/>orquestra, integra, prioriza"]
    G["🛡️ N1 · GUARDIÃO LGPD & SEGURANÇA<br/>poder de veto"]

    S --> M
    S -.-> G
    M <--> G

    M --> P1["📊 N2 · Pesquisa de Mercado"]
    M --> P2["🧩 N2 · Produto (PRD + micropartes)"]
    M --> P3["🛠️ N2 · Engenharia"]
    M --> P4["🤖 N2 · IA / LLM"]

    P1 --> E1["N3 · Mercado geral & concorrentes"]
    P1 --> E2["N3 · Nichos A: Medicina · Odonto · Psico"]
    P1 --> E3["N3 · Nichos B: Nutri · Fisio · Estética · Fono/TO · Multi"]
    P2 --> E4["N3 · PRD + WBS de micropartes"]
    P3 --> E5["N3 · Arquitetura + esqueleto do MVP"]
    P4 --> E6["N3 · Estratégia de LLM, dados e treino"]
    P2 --> E7["N3 · 🎨 design-ui"]
    P3 --> E8["N3 · 🧪 qa-testes"]
    P3 --> E9["N3 · ⚙️ devops-ci"]

    R["🔍 N1 · REVISOR DE CÓDIGO<br/>bloqueia bug crítico"]
    M <--> R
    R -. revisa PRs .-> P3
    R -. revisa PRs .-> P4

    G -. audita .-> P1
    G -. audita .-> P2
    G -. audita .-> P3
    G -. audita .-> P4

    classDef dono fill:#1f2937,color:#fff,stroke:#111
    classDef maestro fill:#7c3aed,color:#fff,stroke:#5b21b6
    classDef guard fill:#b91c1c,color:#fff,stroke:#7f1d1d
    classDef lider fill:#2563eb,color:#fff,stroke:#1e40af
    classDef exec fill:#e5e7eb,color:#111,stroke:#9ca3af
    class S dono
    class M maestro
    class G guard
    class P1,P2,P3,P4 lider
    class R guard
    class E1,E2,E3,E4,E5,E6,E7,E8,E9 exec
```

## Regras de ouro

1. **Cadeia de comando:** executor → líder de frente → Maestro → sócios. Ninguém pula nível.
2. **Veto do Guardião é absoluto:** só os sócios (N0) podem derrubar um veto, e por escrito no PR.
3. **Uma microparte = um dono.** Cada tarefa tem exatamente um agente executor responsável.
4. **Trabalho paralelo, integração serial:** frentes rodam ao mesmo tempo; só o Maestro integra.
5. **Nada de dado real de paciente** em repositório, prompt, log ou dataset de treino sem anonimização aprovada pelo Guardião.
6. **Tudo vira arquivo no git.** Conversa não é entrega; entrega é commit revisado.

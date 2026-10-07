# Fluxograma de trabalho (como a orquestra toca)

## 1. Ciclo de uma demanda (do pedido ao merge)

```mermaid
flowchart TD
    A([Sócios abrem uma demanda<br/>issue no GitHub]) --> B[🎼 Maestro analisa e<br/>quebra em micropartes]
    B --> C{Toca dado pessoal<br/>ou de saúde?}
    C -- Sim --> D[🛡️ Guardião faz<br/>RIPD / análise de risco ANTES]
    C -- Não --> E
    D --> E[Maestro distribui<br/>micropartes para os líderes N2]

    E --> F1[📊 Mercado]
    E --> F2[🧩 Produto]
    E --> F3[🛠️ Engenharia]
    E --> F4[🤖 IA/LLM]

    F1 --> G[Executores N3 trabalham<br/>em paralelo, cada um na sua branch]
    F2 --> G
    F3 --> G
    F4 --> G

    G --> H[Líder N2 revisa<br/>e abre Pull Request]
    H --> I{🛡️ Gate LGPD &<br/>Segurança}
    I -- Reprovado --> J[Volta para o executor<br/>com lista de correções] --> G
    I -- Aprovado --> K[🎼 Maestro integra,<br/>resolve conflitos entre frentes]
    K --> L{👥 Sócios aprovam?}
    L -- Não --> B
    L -- Sim --> M([Merge na main ✅])
```

## 2. Fluxo paralelo (linha do tempo de uma rodada)

```mermaid
gantt
    title Rodada 1 — Fundação do projeto
    dateFormat  YYYY-MM-DD
    axisFormat  %d/%m
    section Maestro
    Planejamento e divisão          :m1, 2026-10-06, 1d
    Integração e consolidação       :m2, after r3, 2d
    section Pesquisa de Mercado
    Mercado geral e concorrentes    :r1, 2026-10-07, 5d
    Nichos A (Med/Odonto/Psico)     :r2, 2026-10-07, 5d
    Nichos B (Nutri/Fisio/Estética…) :r3, 2026-10-07, 5d
    section Produto
    PRD + WBS micropartes           :p1, 2026-10-07, 5d
    section Engenharia
    Arquitetura + esqueleto MVP     :e1, 2026-10-07, 5d
    section IA / LLM
    Estratégia LLM e dados          :i1, 2026-10-07, 5d
    section Guardião LGPD
    Políticas e checklist           :g1, 2026-10-07, 4d
    Auditoria de todas as entregas  :g2, after g1, 3d
```

## 3. Fluxo de dados de paciente (visão LGPD)

```mermaid
flowchart LR
    P[Paciente] -->|consentimento<br/>explícito| APP[App / WhatsApp]
    APP -->|TLS 1.3| API[API]
    API --> AUTH{Autorização<br/>RBAC + tenant}
    AUTH --> DB[(PostgreSQL<br/>criptografado<br/>região Brasil)]
    API --> LOG[(Log de auditoria<br/>imutável)]
    API -->|dados minimizados| IA[LLM]
    IA -.->|NUNCA treina com<br/>dado identificável| X[[Bloqueado]]
    DB -->|pipeline de<br/>anonimização| ANON[(Dataset anonimizado<br/>aprovado pelo Guardião)]
    ANON --> TREINO[Treino / fine-tune]
```

## 4. Git: branches e quem aprova

```mermaid
gitGraph
    commit id: "init"
    branch pesquisa/mercado
    commit id: "nichos"
    checkout main
    branch produto/prd
    commit id: "PRD + WBS"
    checkout main
    branch eng/esqueleto
    commit id: "monorepo"
    checkout main
    merge pesquisa/mercado tag: "Guardião ✅ Sócios ✅"
    merge produto/prd
    merge eng/esqueleto
```

**Convenção de branches:** `<frente>/<microparte>` — ex.: `eng/agenda-api`, `ia/escriba-prompt`, `lgpd/ripd-teleconsulta`.

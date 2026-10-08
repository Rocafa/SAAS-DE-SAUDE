# Jornadas de usuário

> Frente: 🧩 Produto (N2) · Executor: N3 PRD + WBS · Versão 0.1 · Data: 2026-10-08
> Base: [PRD.md](./PRD.md) · [WBS-micropartes.md](./WBS-micropartes.md) · [roadmap.md](./roadmap.md)
> Cada passo traz entre colchetes as micropartes da WBS que o tornam possível. Pontos com 🔒 tocam dado sensível e têm controle LGPD explícito.

## Índice
1. [Jornada principal — do WhatsApp ao NPS (MVP)](#1-jornada-principal--do-whatsapp-ao-nps-mvp)
2. [Exceções da jornada principal](#2-exceções-da-jornada-principal)
3. [Recepção — um dia na inbox compartilhada (MVP)](#3-recepção--um-dia-na-inbox-compartilhada-mvp)
4. [Dono de clínica — da assinatura à migração (MVP)](#4-dono-de-clínica--da-assinatura-à-migração-mvp)
5. [Paciente — direitos LGPD pelo portal (MVP)](#5-paciente--direitos-lgpd-pelo-portal-mvp)
6. [Faturista — guia TISS sem glosa (Fase 2)](#6-faturista--guia-tiss-sem-glosa-fase-2)
7. [Teleconsulta com escriba (Fase 2)](#7-teleconsulta-com-escriba-fase-2)
8. [Jornadas de nicho (resumo)](#8-jornadas-de-nicho-resumo)

---

## 1. Jornada principal — do WhatsApp ao NPS (MVP)

**Persona:** Ana (paciente) e Dr. Rafael (médico autônomo), com Juliana (recepção) de apoio.
**Resultado esperado:** Ana marca sem ligar, comparece, recebe receita assinada no celular, paga por Pix e avalia — e Rafael não digita o prontuário.

### 1.1 Visão macro

```mermaid
flowchart LR
    A["1. Paciente chama<br/>no WhatsApp"] --> B["2. Bot agenda<br/>(OTP + pré-cadastro)"]
    B --> C["3. Lembrete e<br/>confirmação D-1"]
    C --> D["4. Check-in<br/>na recepção"]
    D --> E["5. Consulta com<br/>escriba de IA 🔒"]
    E --> F["6. Revisão e<br/>assinatura do prontuário 🔒"]
    F --> G["7. Receita assinada<br/>ICP-Brasil 🔒"]
    G --> H["8. Envio seguro<br/>por WhatsApp/portal 🔒"]
    H --> I["9. Cobrança Pix<br/>+ baixa automática"]
    I --> J["10. NFS-e e recibo"]
    J --> K["11. NPS pelo<br/>WhatsApp"]

    classDef sens fill:#fee2e2,stroke:#b91c1c,color:#111
    class E,F,G,H sens
```

### 1.2 Sequência detalhada

```mermaid
sequenceDiagram
    autonumber
    actor P as Paciente (Ana)
    participant WA as WhatsApp (API oficial)
    participant BOT as Bot de agendamento
    participant AG as Agenda
    participant REC as Recepção (inbox)
    actor MED as Profissional (Dr. Rafael)
    participant ESC as Escriba de IA
    participant PRO as Prontuário
    participant DOC as Documentos e assinatura ICP
    participant PAG as Pagamentos (PSP Pix)
    participant FIS as NFS-e
    participant POR as Portal do paciente

    P->>WA: Oi, quero marcar consulta
    WA->>BOT: Mensagem recebida (webhook)
    BOT->>P: Qual serviço? (lista interativa)
    P->>BOT: Consulta clínica
    BOT->>AG: Busca horários livres (regras de autoagendamento)
    AG-->>BOT: Ter 14h, Qua 9h, Qui 16h
    BOT->>P: Opções de horário (botões)
    P->>BOT: Qua 9h
    BOT->>P: Código OTP para confirmar identidade
    P->>BOT: Informa o código
    BOT->>P: Link de pré-cadastro + aceite da política de privacidade
    P->>POR: Preenche dados mínimos e aceita a política
    BOT->>AG: Cria agendamento (status agendado, origem WhatsApp)
    BOT->>P: Agendado. Endereço e preparo enviados

    Note over AG,WA: D-1 às 10h (regra de confirmação)
    AG->>WA: Lembrete com botões Confirmar / Remarcar / Cancelar
    WA->>P: Lembrete (sem dado clínico no texto)
    P->>WA: Confirmar
    WA->>AG: Status confirmado

    Note over P,REC: Dia da consulta
    P->>REC: Chega à clínica
    REC->>AG: Check-in (status chegou)
    MED->>AG: Chama paciente (status em atendimento)
    MED->>PRO: Abre atendimento no modelo do nicho
    PRO-->>MED: Resumo do histórico gerado por IA com fontes
    MED->>P: Pede consentimento para o escriba
    P-->>MED: Autoriza
    MED->>PRO: Registra consentimento (versão do termo)
    MED->>ESC: Inicia gravação (indicador visível)
    ESC->>ESC: Transcrição pt-BR + rascunho estruturado (SOAP)
    ESC-->>PRO: Rascunho + sugestões de CID (não preenchidas)
    MED->>PRO: Revisa, edita e aceita campo a campo
    PRO->>PRO: Finaliza e bloqueia o registro (auditoria)
    ESC->>ESC: Descarta o áudio (política de retenção)
    MED->>DOC: Gera receita (base de medicamentos)
    DOC->>MED: Solicita assinatura ICP-Brasil em nuvem
    MED-->>DOC: Autoriza no app do certificado
    DOC->>POR: Publica receita assinada + QR de verificação
    DOC->>WA: Link seguro e expirável para a receita
    WA->>P: Sua receita está disponível (OTP para abrir)

    MED->>AG: Conclui atendimento (status atendido)
    AG->>PAG: Gera cobrança pelo preço do tipo de atendimento
    PAG->>WA: Link de pagamento Pix (descrição genérica)
    WA->>P: Link de pagamento
    P->>PAG: Paga via Pix
    PAG-->>AG: Webhook de pagamento confirmado (baixa automática)
    PAG->>FIS: Emite NFS-e (descrição sem dado clínico)
    FIS-->>POR: NFS-e e recibo disponíveis
    WA->>P: Pagamento confirmado + recibo e NFS-e

    Note over WA,P: 2 h depois
    WA->>P: De 0 a 10, quanto recomendaria a clínica?
    P->>WA: 10 + comentário
    WA->>AG: Registra NPS (painel do gestor)
```

### 1.3 Passos, micropartes e controles

| # | Passo | Micropartes (WBS) | Métrica do passo | Controle LGPD 🔒 |
|---|---|---|---|---|
| 1 | Paciente inicia conversa | COM-01.1, COM-01.4 | Tempo até 1ª resposta < 5 s | Número oficial da clínica (não pessoal) |
| 2 | Bot oferece serviços e horários | AON-02.1, AON-02.2, IA-04.1, AGD-02.2 | % agendamentos sem humano ≥ 70% | Bot não dá orientação clínica (IA-04.3) |
| 3 | Identificação e pré-cadastro | AON-01.3, PAC-01.4, COM-04.2, LGP-01.3 | Tempo de pré-cadastro < 2 min | Minimização (só nome + telefone obrigatórios); aceite de política registrado |
| 4 | Lembrete e confirmação | COM-03.1, COM-03.2, AGD-03.1 | Taxa de confirmação; no-show | Texto sem dado clínico; opt-in de canal (COM-01.3) |
| 5 | Check-in e chamada | AGD-02.7 | Tempo de espera | — |
| 6 | Resumo do histórico | IA-02.1, PRO-02.7 | Avaliação do resumo ≥ 4/5 | 🔒 RAG isolado por tenant e permissão (IA-05.2) |
| 7 | Consentimento e gravação | LGP-01.2, IA-01.1 | % consultas com escriba | 🔒 Sem consentimento não há gravação |
| 8 | Transcrição e rascunho | IA-01.2, IA-01.3, IA-02.2 | Rascunho < 60 s; alucinação ≤ 2% | 🔒 Provedor sem retenção; logs sem PII (IA-05.1) |
| 9 | Revisão e assinatura do registro | IA-01.4, PRO-02.3, NUC-04.1 | Taxa de aceitação do rascunho ≥ 60% | 🔒 Humano no loop obrigatório; bloqueio pós-assinatura; descarte do áudio (IA-01.5) |
| 10 | Receita assinada | DOC-01.1, DOC-02.1, DOC-02.3 | Tempo de emissão < 60 s | 🔒 Assinatura qualificada; verificação pública sem expor conteúdo |
| 11 | Entrega ao paciente | DOC-03.1, POR-02.2 | % documentos abertos | 🔒 Link expirável + OTP; abertura auditada |
| 12 | Cobrança e Pix | FIN-01.1, PAG-01.2, PAG-02.1, PAG-01.4 | Dias para receber; % conciliado automático | Descrição genérica do serviço |
| 13 | NFS-e e recibo | FIS-01.3, FIS-01.6, FIN-01.4 | NFS-e < 5 min após pagamento | Sem CID na nota (FIS-01.6) |
| 14 | NPS | COM-03.4, CRM-01.1, CRM-01.2 | Taxa de resposta; NPS ≥ 70 | Anti-fadiga; resposta não vinculada a dado clínico |

### 1.4 Mapa de estados do agendamento

```mermaid
stateDiagram-v2
    [*] --> Agendado: bot, página online ou recepção
    Agendado --> Confirmado: paciente confirma
    Agendado --> Cancelado: paciente ou clínica cancela
    Agendado --> Remarcado: paciente remarca
    Remarcado --> Agendado: novo horário
    Confirmado --> Chegou: check-in
    Confirmado --> Faltou: sem check-in até tolerância
    Agendado --> Faltou: sem check-in até tolerância
    Chegou --> EmAtendimento: profissional chama
    EmAtendimento --> Atendido: registro finalizado
    Atendido --> [*]
    Faltou --> [*]
    Cancelado --> [*]
```

## 2. Exceções da jornada principal

```mermaid
flowchart TD
    S["Paciente no WhatsApp"] --> Q{"Bot entendeu<br/>a intenção?"}
    Q -- sim --> H{"Há horário<br/>disponível?"}
    Q -- "não, após 2 tentativas" --> HUM["Handoff para inbox<br/>da recepção (AON-02.3)"]
    H -- sim --> OK["Agendamento criado"]
    H -- não --> LE["Oferece lista de espera<br/>(AGD-02.5)"]
    S --> U{"Mensagem indica<br/>urgência?"}
    U -- sim --> URG["Orienta SAMU 192 / PS<br/>e alerta a clínica (IA-04.3)"]
    OK --> L{"Confirmou no D-1?"}
    L -- não --> FILA["Fila de não confirmados<br/>na recepção (AGD-03.1)"]
    L -- remarcar --> RM["Autorremarcação<br/>(AGD-03.2) e vaga liberada"]
    OK --> C{"Consentiu<br/>com o escriba?"}
    C -- não --> MAN["Registro manual / modelo do nicho<br/>(sem gravação)"]
    OK --> P{"Pix pago?"}
    P -- "não em 24 h" --> LEMB["Lembrete de pagamento<br/>(F2 régua FIN-01.7)"]
    P -- "falha do WhatsApp" --> FB["Fallback SMS/e-mail<br/>(COM-01.4)"]
```

## 3. Recepção — um dia na inbox compartilhada (MVP)

**Persona:** Juliana (recepção). Micropartes: COM-02.1–02.4, AON-02.3, AGD-02.*, PAG-02.1, PAC-01.3.

```mermaid
sequenceDiagram
    autonumber
    actor J as Recepção (Juliana)
    participant IN as Inbox compartilhada
    participant CTX as Painel de contexto
    participant AG as Agenda
    participant PAG as Pagamentos
    actor P as Paciente

    P->>IN: Pergunta sobre convênio e preço
    IN->>IN: Bot não resolve e transfere (handoff)
    IN-->>J: Conversa atribuída na fila "Atendimento"
    J->>CTX: Vê próximos agendamentos e pendências (sem dado clínico)
    J->>IN: Resposta rápida "Valores e convênios"
    P->>IN: Quero encaixe hoje
    J->>AG: Cria encaixe sinalizado
    AG-->>P: Confirmação automática com endereço
    J->>IN: Nota interna para o profissional (nunca vai ao paciente)
    J->>PAG: Envia link de pagamento do pacote
    P->>PAG: Paga
    PAG-->>CTX: Pendência some do painel
    J->>IN: Marca conversa como resolvida
```

## 4. Dono de clínica — da assinatura à migração (MVP)

**Persona:** Carla (dona de clínica multiprofissional). Micropartes: BIL-01.1–01.3, NUC-01.2, LGP-01.4, MIG-01.*, MIG-02.*, COM-01.1, PAG-01.1, FIS-01.2, SUP-01.4, EXP-01.*.

```mermaid
flowchart TD
    A["Vê preço público no site<br/>(BIL-01.1)"] --> B["Inicia trial 14 dias<br/>sem cartão (BIL-01.2)"]
    B --> C["Wizard de onboarding:<br/>nichos, profissionais, horários (NUC-01.2)"]
    C --> D["Aceita termos e DPA:<br/>clínica = controladora (LGP-01.3, LGP-01.4)"]
    D --> E{"Vem de outro<br/>sistema?"}
    E -- sim --> F["Envia exportação por canal seguro<br/>(MIG-02.4)"]
    F --> G["Dry-run + relatório de divergências<br/>(MIG-02.1)"]
    G --> H{"Aprova?"}
    H -- não --> G2["Ajuste de mapeamento<br/>pelo time de migração (MIG-02.3)"] --> G
    H -- sim --> I["Importação efetiva<br/>(rollback disponível MIG-02.2)"]
    E -- não --> J["Importa planilha de pacientes<br/>(MIG-01.1)"]
    I --> K["Conecta WhatsApp oficial<br/>(COM-01.1)"]
    J --> K
    K --> L["Ativa recebimentos Pix (KYC)<br/>(PAG-01.1)"]
    L --> M["Configura NFS-e e certificado A1<br/>(FIS-01.2)"]
    M --> N["Checklist de ativação concluído<br/>(SUP-01.4)"]
    N --> O["Assina plano (BIL-01.3)"]
    O --> P["Usa dashboard e repasses<br/>(REL-03.1, FIN-03.2)"]
    P -. "a qualquer momento" .-> Q["Exporta 100% dos dados<br/>sem custo (EXP-01.1, EXP-01.5)"]
```

## 5. Paciente — direitos LGPD pelo portal (MVP)

**Persona:** Seu Antônio (paciente). Micropartes: POR-01.1, POR-02.5, POR-02.6, LGP-02.1–02.3, EXP-01.3, NUC-04.1.

```mermaid
sequenceDiagram
    autonumber
    actor T as Titular (paciente)
    participant POR as Portal do paciente
    participant LG as Fluxo de direitos do titular
    actor CL as Clínica (controladora)
    participant EXP as Exportação
    participant AUD as Auditoria

    T->>POR: Login por OTP no WhatsApp
    T->>POR: Central de privacidade - pedir cópia dos meus dados
    POR->>LG: Abre solicitação com protocolo e prazo
    LG-->>CL: Notifica a clínica (fila com alerta de prazo)
    CL->>EXP: Gera pacote do prontuário individual com hash
    EXP->>AUD: Registra geração e responsável
    CL->>LG: Responde e anexa pacote
    LG->>POR: Disponibiliza resposta por link expirável
    POR-->>T: Notificação - sua solicitação foi respondida
    T->>POR: Revoga consentimento de marketing
    POR->>AUD: Registra revogação (efeito imediato)
    Note over T,CL: Pedido de eliminação do prontuário é recusado com justificativa legal (guarda de 20 anos) e os dados ficam bloqueados para outras finalidades
```

## 6. Faturista — guia TISS sem glosa (Fase 2)

**Persona:** Fernanda (faturista). Micropartes: CNV-01.*, CNV-02.1–02.5, CNV-03.1–03.3, IA-02.3, PAC-01.5.

```mermaid
flowchart LR
    A["Atendimento concluído<br/>com convênio"] --> B["Guia pré-preenchida<br/>do prontuário (CNV-02.1/02.2)"]
    B --> C["IA sugere TUSS<br/>(IA-02.3)"]
    C --> D["Validação pré-envio<br/>schema + regras da operadora (CNV-02.5)"]
    D -- erro --> E["Pendência para<br/>profissional/recepção"] --> B
    D -- ok --> F["Lote XML TISS<br/>(CNV-03.1)"]
    F --> G["Envio portal/webservice"]
    G --> H["Demonstrativo de retorno<br/>(CNV-03.2)"]
    H --> I{"Glosa?"}
    I -- não --> J["Conciliado no financeiro"]
    I -- sim --> K["Recurso de glosa<br/>(CNV-03.3)"] --> H
```

## 7. Teleconsulta com escriba (Fase 2)

Micropartes: TEL-01.1–01.3, TEL-02.1, TEL-02.2, IA-01.*, POR-02.9, PAG-02.1.

```mermaid
sequenceDiagram
    autonumber
    actor P as Paciente
    participant POR as Portal / link WhatsApp
    participant TEL as Sala de vídeo
    actor PR as Profissional
    participant ESC as Escriba

    P->>POR: Abre link único (OTP)
    POR->>P: Termo de teleconsulta
    P-->>POR: Aceita (registro versionado)
    POR->>TEL: Entra na sala de espera
    PR->>TEL: Admite o paciente
    PR->>P: Pergunta sobre o escriba
    P-->>PR: Autoriza a captura de áudio
    TEL->>ESC: Fluxo de áudio da sessão
    ESC-->>PR: Rascunho para revisão ao fim da chamada
    PR->>PR: Revisa, assina, emite documentos
    TEL->>TEL: Encerra e invalida o link (sem gravação de vídeo)
```

## 8. Jornadas de nicho (resumo)

| Nicho | Momento-chave da jornada | Micropartes | Fase |
|---|---|---|---|
| Odontologia | Odontograma na 1ª consulta → plano de tratamento com orçamento → aprovação assinada → parcelas Pix → execução marca dente/face | PRO-03.1, PRO-03.2, FIN-01.6, DOC-02.4, PAG-01.2 | MVP (odontograma) / F2 (plano + orçamento) |
| Psicologia | Série semanal recorrente → sessão com evolução + anotações privadas → recibo para reembolso → pacote mensal | AGD-02.4, PRO-02.6, FIN-01.4, FIN-01.5 | MVP |
| Nutrição | Antropometria + gráficos → plano alimentar → paciente acompanha evolução no portal | PRO-03.4, PRO-03.6, POR-02.8 | MVP (antropometria) / F2 (plano + portal) |
| Fisioterapia / TO | Avaliação com escalas → plano de sessões com metas → saldo de sessões → guia SP/SADT com autorização | PRO-03.8, PRO-03.7, CNV-02.2, CNV-02.4 | MVP (plano) / F2 (TISS) |
| Estética | Termo de consentimento + consentimento de imagem → fotos padronizadas antes → mapa de aplicação com lote → baixa de estoque → fotos depois lado a lado | PRO-03.13, PRO-03.9, PRO-03.10, EST-01.3, EST-01.4 | MVP (termo + fotos) / F2 (mapa + estoque) |
| Fono / TEA | Plano terapêutico multiprofissional com metas → registros por sessão de cada área → relatório consolidado para família, escola e operadora | PRO-03.11, PRO-02.8, CNV-02.4 | F2 |
| Medicina | Jornada principal (seção 1) + pedidos de exame, atestado com CID só se autorizado, resultado de laboratório integrado | DOC-01.3, DOC-01.4, INT-01.2 | MVP / F2 (laboratórios) |

# Modelo de dados

> Modelo lógico do MVP. Nomes de tabelas/colunas em inglês (`snake_case` no banco, `camelCase` no TypeScript). Detalhes de colunas evoluem via migrations revisadas; este documento é a referência conceitual.

## 1. Convenções obrigatórias

- **PK:** `id uuid` (UUIDv7 — ordenável, não enumerável). Nunca expor IDs sequenciais.
- **Tenant:** toda tabela de domínio tem `tenant_id uuid not null` + índice composto iniciado por `tenant_id` + **política RLS** (ver [seguranca-na-arquitetura.md](seguranca-na-arquitetura.md)). Exceções globais: `tenant`, catálogos públicos (`insurance_plan_catalog`, códigos TUSS/CID).
- **Timestamps:** `created_at`, `updated_at` (`timestamptz`, UTC), `created_by`, `updated_by`.
- **Exclusão:** dados clínicos **nunca** são apagados fisicamente durante o prazo legal de guarda (prontuário: mínimo 20 anos — Lei 13.787/2018). Usa-se `archived_at`/`retention_until`. Dados não clínicos seguem a política de retenção do Guardião LGPD (anonimização ao fim da finalidade).
- **Versionamento clínico:** registros assinados de prontuário e prescrição são **imutáveis**; correções geram nova versão (`supersedes_id`) com trilha.
- **Criptografia em nível de campo:** colunas marcadas 🔒 são armazenadas como `bytea` cifrado (AES-256-GCM, envelope com DEK por tenant protegida por KMS). Para busca, usa-se **blind index** (`*_bidx` = HMAC-SHA256 com chave separada) — nunca o valor em claro.

## 2. Diagrama ER (núcleo)

```mermaid
erDiagram
    TENANT ||--o{ CLINIC : possui
    TENANT ||--o{ USER : possui
    TENANT ||--o{ ROLE : define
    USER }o--o{ ROLE : "user_role"
    USER ||--o| PROFESSIONAL : "pode ser"
    CLINIC ||--o{ PROFESSIONAL : "atua em (professional_clinic)"
    TENANT ||--o{ PATIENT : possui
    PATIENT ||--o{ CONSENT : concede
    PATIENT ||--o{ PATIENT_INSURANCE : tem
    INSURANCE_PLAN ||--o{ PATIENT_INSURANCE : cobre
    PROFESSIONAL ||--o{ SCHEDULE : "tem agenda"
    SCHEDULE ||--o{ APPOINTMENT : contem
    PATIENT ||--o{ APPOINTMENT : agenda
    APPOINTMENT ||--o| TELECONSULTATION : "pode ter"
    PATIENT ||--|| MEDICAL_RECORD : "possui (por tenant)"
    MEDICAL_RECORD ||--o{ RECORD_ENTRY : contem
    RECORD_TEMPLATE ||--o{ RECORD_ENTRY : estrutura
    APPOINTMENT ||--o{ RECORD_ENTRY : origina
    PROFESSIONAL ||--o{ RECORD_ENTRY : assina
    RECORD_ENTRY ||--o{ PRESCRIPTION : gera
    PRESCRIPTION ||--o{ PRESCRIPTION_ITEM : contem
    PATIENT ||--o{ DOCUMENT : "anexos / atestados"
    DOCUMENT ||--o| SIGNATURE : "assinado por"
    PRESCRIPTION ||--o| SIGNATURE : "assinada por"
    APPOINTMENT ||--o{ CHARGE : gera
    CHARGE ||--o{ PAYMENT : "liquidada por"
    CHARGE ||--o| INVOICE : "NFS-e"
    APPOINTMENT ||--o{ TISS_GUIDE : fatura
    TISS_GUIDE }o--|| TISS_BATCH : agrupada
    INSURANCE_PLAN ||--o{ TISS_GUIDE : "cobrada de"
    TENANT ||--o{ AUDIT_LOG : registra
    PATIENT ||--o{ MESSAGE_LOG : "comunicações"

    TENANT {
        uuid id PK
        string legal_name
        string cnpj
        string slug
        string plan
        string status
        string kms_key_ref
        string data_region
    }
    CLINIC {
        uuid id PK
        uuid tenant_id FK
        string name
        string cnes
        jsonb address
        string timezone
    }
    USER {
        uuid id PK
        uuid tenant_id FK
        string email
        string password_hash
        bool mfa_enabled
        timestamptz last_login_at
    }
    ROLE {
        uuid id PK
        uuid tenant_id FK
        string name
        string[] permissions
    }
    PROFESSIONAL {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK
        string council
        string council_number
        string council_uf
        string specialty
        string cbo
    }
    PATIENT {
        uuid id PK
        uuid tenant_id FK
        bytea full_name_enc
        bytea cpf_enc
        string cpf_bidx
        bytea birth_date_enc
        bytea phone_enc
        string phone_bidx
        bytea email_enc
        bytea social_name_enc
        timestamptz archived_at
    }
    CONSENT {
        uuid id PK
        uuid tenant_id FK
        uuid patient_id FK
        string purpose
        string legal_basis
        string version
        timestamptz granted_at
        timestamptz revoked_at
        string channel
        string evidence_hash
    }
    SCHEDULE {
        uuid id PK
        uuid tenant_id FK
        uuid professional_id FK
        uuid clinic_id FK
        jsonb rules
        int slot_minutes
    }
    APPOINTMENT {
        uuid id PK
        uuid tenant_id FK
        uuid schedule_id FK
        uuid patient_id FK
        timestamptz starts_at
        timestamptz ends_at
        string status
        string modality
        string source
    }
    MEDICAL_RECORD {
        uuid id PK
        uuid tenant_id FK
        uuid patient_id FK
        timestamptz retention_until
    }
    RECORD_TEMPLATE {
        uuid id PK
        uuid tenant_id FK
        string name
        string specialty
        int version
        jsonb schema
    }
    RECORD_ENTRY {
        uuid id PK
        uuid tenant_id FK
        uuid medical_record_id FK
        uuid template_id FK
        int template_version
        uuid professional_id FK
        uuid appointment_id FK
        bytea content_enc
        string status
        timestamptz signed_at
        uuid supersedes_id
    }
    PRESCRIPTION {
        uuid id PK
        uuid tenant_id FK
        uuid record_entry_id FK
        string type
        bytea content_enc
        string external_ref
        string status
    }
    DOCUMENT {
        uuid id PK
        uuid tenant_id FK
        uuid patient_id FK
        string kind
        string storage_key
        string sha256
        string mime_type
    }
    SIGNATURE {
        uuid id PK
        uuid tenant_id FK
        string provider
        string certificate_subject
        string format
        timestamptz signed_at
        string signed_hash
    }
    CHARGE {
        uuid id PK
        uuid tenant_id FK
        uuid patient_id FK
        int amount_cents
        string method
        string status
        string gateway_ref
        date due_date
    }
    PAYMENT {
        uuid id PK
        uuid tenant_id FK
        uuid charge_id FK
        int amount_cents
        timestamptz paid_at
        string gateway_event_id
    }
    INVOICE {
        uuid id PK
        uuid tenant_id FK
        uuid charge_id FK
        string number
        string status
        string provider_ref
        string service_code
    }
    INSURANCE_PLAN {
        uuid id PK
        uuid tenant_id FK
        string ans_registry
        string name
        jsonb price_table
    }
    TISS_GUIDE {
        uuid id PK
        uuid tenant_id FK
        uuid appointment_id FK
        uuid insurance_plan_id FK
        string guide_type
        string tiss_version
        string status
        bytea xml_enc
    }
    TISS_BATCH {
        uuid id PK
        uuid tenant_id FK
        string protocol
        string status
    }
    AUDIT_LOG {
        bigint seq PK
        uuid tenant_id
        uuid actor_id
        string action
        string resource_type
        uuid resource_id
        string purpose
        inet ip
        timestamptz at
        string prev_hash
        string hash
    }
```

Entidades auxiliares (fora do diagrama para legibilidade): `user_role`, `professional_clinic`, `patient_insurance` (número da carteirinha 🔒), `prescription_item`, `teleconsultation` (sala, tokens efêmeros, consentimento específico), `message_log` (WhatsApp/e-mail — sem conteúdo clínico), `webhook_event` (idempotência), `data_subject_request` (pedidos do titular — art. 18), `ai_interaction` (metadados de uso de IA, sem conteúdo identificável).

## 3. Descrição das entidades

| Entidade | Finalidade | Observações |
|---|---|---|
| `tenant` | Conta contratante (clínica, rede ou profissional autônomo) | Raiz do isolamento. Guarda referência à chave KMS/DEK do tenant |
| `clinic` | Unidade física/virtual do tenant | CNES opcional; fuso horário próprio |
| `user` | Login de pessoa da equipe | MFA obrigatório para papéis com acesso clínico. Paciente do portal é `patient_account` separado |
| `role` / `user_role` | RBAC por tenant | Permissões granulares (`records:read`, `billing:write`...) + ABAC: profissional vê prontuário de quem atendeu, salvo compartilhamento |
| `professional` | Profissional de saúde | Conselho (CRM, CRO, CRP, CREFITO, CRN, COREN...), UF, CBO — necessário para TISS e prescrição |
| `patient` | Titular dos dados | Maior concentração de PII 🔒; nome social suportado |
| `consent` | Registro de consentimentos e bases legais | Uma linha por finalidade/versão; revogação nunca apaga histórico |
| `schedule` / `appointment` | Agenda e consultas | `modality`: presencial/teleconsulta; `source`: recepção/online/WhatsApp |
| `medical_record` | Prontuário do paciente no tenant | Um por paciente por tenant; `retention_until` ≥ 20 anos após último registro |
| `record_template` | Construtor de modelos (anamnese, evolução, odontograma, escalas...) | `schema` JSON versionado; entradas guardam a versão usada |
| `record_entry` | Evolução/registro clínico | Conteúdo 🔒; imutável após `signed_at`; correção por nova versão |
| `prescription` | Receita, atestado, solicitação de exames | Pode ser gerada via Memed (`external_ref`) ou nativa; assinatura ICP-Brasil |
| `document` / `signature` | Arquivos no S3 e evidência de assinatura | Hash SHA-256 do arquivo; objeto no S3 cifrado com SSE-KMS |
| `charge` / `payment` | Cobranças (Pix, boleto, cartão) e baixas | Valores em centavos (`int`); idempotência por `gateway_event_id` |
| `invoice` | NFS-e | Discriminação do serviço **sem** diagnóstico/CID |
| `insurance_plan` / `tiss_guide` / `tiss_batch` | Convênios e faturamento TISS | Registro ANS; versão TISS por guia |
| `audit_log` | Trilha imutável | Append-only com encadeamento de hash; ver segurança |

## 4. Criptografia em nível de campo (🔒)

| Tabela | Campos cifrados | Busca |
|---|---|---|
| `patient` | `full_name`, `social_name`, `cpf`, `rg`, `birth_date`, `phone`, `email`, `address`, `mother_name` | `cpf_bidx`, `phone_bidx`, `email_bidx` (HMAC). Busca por nome: índice de prefixo tokenizado HMAC (n-gramas normalizados) — avaliar custo × risco |
| `patient_insurance` | `card_number` | `card_number_bidx` |
| `record_entry` | `content` (JSON inteiro do registro clínico) | Sem busca textual no banco; busca clínica futura só via índice cifrado/isolado aprovado pelo Guardião |
| `prescription` | `content` | — |
| `tiss_guide` | `xml` (contém dados clínicos e de beneficiário) | — |
| `teleconsultation` | `notes` (se houver) | Vídeo **não é gravado** por padrão |
| `user` | `phone`, segredo TOTP | — |
| `document` | Arquivo cifrado no S3 (SSE-KMS); metadados não sensíveis no banco | — |

**Não cifrados em campo** (protegidos por criptografia em repouso do volume + RLS): IDs, datas e status de agendamento, valores financeiros, nomes de modelos de prontuário. Regra geral: *na dúvida, se identifica o titular ou revela informação de saúde, cifra.*

**Esquema de chaves:**

```mermaid
flowchart LR
    CMK["KMS CMK (por ambiente)"] -->|cifra| DEK["DEK por tenant<br/>(armazenada cifrada em tenant.kms_key_ref)"]
    DEK -->|AES-256-GCM| F["Campos 🔒"]
    HK["Chave HMAC separada<br/>(Secrets Manager)"] --> B["Blind indexes *_bidx"]
```

- DEK decifrada em memória, com cache de curta duração (minutos), nunca logada.
- Rotação: nova DEK por tenant → re-cifra em background (job BullMQ) com coluna `key_version`.
- **Crypto-shredding:** ao encerrar contrato e após prazos legais, destruir a DEK do tenant torna ilegíveis backups antigos.

## 5. Multi-tenancy no schema

- Modelo: **banco compartilhado, schema compartilhado, coluna `tenant_id` + RLS**. Simples de operar e migrar; isolamento garantido pelo Postgres.
- FKs compostas `(tenant_id, id)` nas relações críticas (ex.: `record_entry → medical_record`) para impedir referência cruzada entre tenants mesmo com bug.
- Opção enterprise futura: banco dedicado por tenant, mesma base de código (a conexão é escolhida pelo `TenantResolver`).

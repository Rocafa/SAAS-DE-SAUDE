# Segurança na arquitetura

> Controles técnicos que implementam as políticas de `docs/03-seguranca-lgpd/`. Em caso de conflito, prevalece o que o **Guardião LGPD** definir lá.

## 1. Isolamento de tenant — Row-Level Security (RLS)

Defesa em três camadas:

1. **Aplicação:** `TenantGuard` resolve o `tenant_id` da sessão; repositórios sempre filtram por `tenant_id`.
2. **Banco (RLS):** mesmo que um filtro seja esquecido, o Postgres bloqueia.
3. **Testes:** suíte de testes de isolamento roda contra Postgres real (testcontainers) em todo PR.

```sql
-- Papel da aplicação: NÃO é dono das tabelas e NÃO tem BYPASSRLS
CREATE ROLE app_user LOGIN NOBYPASSRLS;

ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON patient
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

- O contexto é definido por transação: `SET LOCAL app.tenant_id = $1` — nunca `SET` de sessão (evita vazamento em pool de conexões).
- Sem `app.tenant_id` definido → `current_setting(..., true)` retorna `NULL` → nenhuma linha visível (falha fechada).
- Migrations rodam com papel `app_migrator` (dono das tabelas), separado do papel de runtime.
- Jobs administrativos multi-tenant (ex.: relatórios do backoffice) usam papel `app_admin` dedicado, com auditoria reforçada e acesso via fluxo de *break-glass*.
- CI verifica que **toda** tabela com coluna `tenant_id` tem RLS habilitado e forçado (query em `pg_class.relrowsecurity`/`relforcerowsecurity`).

## 2. Controle de acesso

- **RBAC** por tenant + **ABAC** para prontuário (profissional responsável, equipe do atendimento, compartilhamento explícito).
- **MFA obrigatório** para usuários com acesso clínico ou financeiro; WebAuthn/passkeys suportados.
- Sessões: cookie `HttpOnly`, `Secure`, `SameSite=Lax`; access token curto (≤ 15 min) + refresh rotativo com detecção de reuso.
- Senhas com Argon2id; bloqueio progressivo e detecção de credenciais vazadas.
- Acesso de suporte da empresa a dados de cliente: somente com autorização do tenant, tempo limitado, registrado em auditoria e visível para a clínica.

## 3. Criptografia

| Camada | Controle |
|---|---|
| **Em trânsito** | TLS 1.2+ (preferir 1.3) em todo endpoint externo; HSTS com preload; TLS também entre API ↔ RDS/ElastiCache (`sslmode=verify-full`) |
| **Em repouso** | RDS, snapshots, ElastiCache, EBS e S3 cifrados com KMS (AES-256) |
| **Em campo** | AES-256-GCM com envelope encryption (DEK por tenant, CMK no KMS) para PII e conteúdo clínico — ver [modelo-de-dados.md §4](modelo-de-dados.md) |
| **Arquivos** | S3 privado, *Block Public Access*, SSE-KMS, URLs pré-assinadas de curta duração (≤ 5 min), download auditado |
| **Backups** | Cifrados com chave KMS distinta; cópia cross-account |

Uso de KMS é registrado no CloudTrail. Chaves com rotação anual automática; políticas de chave com menor privilégio por serviço.

## 4. Gestão de segredos

- **Nenhum segredo no repositório**, em imagens Docker, em variáveis de build do front ou em logs.
- Produção/staging: **AWS Secrets Manager** (ou SSM Parameter Store SecureString), injetados em runtime via IAM role da tarefa.
- Local: `.env` (ignorado no git) a partir de `.env.example` só com placeholders.
- Credenciais de integradores (gateway Pix, WhatsApp, NFS-e) **por tenant** quando a clínica usa conta própria: armazenadas cifradas (envelope) e nunca retornadas pela API.
- Certificados ICP-Brasil: **preferir certificado em nuvem (A3 remoto)** — a plataforma não guarda a chave privada do profissional. Arquivos `.pfx`/`.pem` são bloqueados no `.gitignore` e no gitleaks.
- Rotação: segredos de integração a cada 90 dias ou em incidente; plano documentado.

## 5. Auditoria imutável

O que é auditado (mínimo):
- Toda **leitura e escrita** de prontuário, prescrição, documento, dados do paciente.
- Login, falha de login, MFA, mudança de permissão, exportações, acesso de suporte, alteração de consentimento.

Como:
- `AuditInterceptor` no NestJS emite evento `{tenant_id, actor_id, action, resource_type, resource_id, purpose, ip, user_agent, at}` — **sem conteúdo clínico** no log.
- Tabela `audit_log` **append-only**: papel da aplicação só tem `INSERT`; `UPDATE`/`DELETE` revogados; trigger rejeita alterações.
- **Encadeamento de hash** (`hash = SHA-256(prev_hash || payload)`) por tenant, permitindo detectar adulteração.
- Export contínuo para **S3 com Object Lock (modo compliance)** e retenção definida pelo Guardião (sugestão: ≥ 5 anos; prontuário segue 20 anos).
- A clínica (controladora) consegue consultar quem acessou cada prontuário — atende art. 37 (registro das operações) e pedidos do titular.

## 6. Logs e observabilidade sem vazamento

- Logs estruturados (JSON) com **lista de permissão** de campos; *redaction* automática de CPF, e-mail, telefone, nomes, tokens.
- Sentry/APM com `beforeSend` que remove corpo de requisição e cabeçalhos sensíveis.
- Proibido logar payloads de prontuário, prescrição, webhooks de pagamento brutos ou prompts de IA com dado identificável.

## 7. Backups e continuidade

- RDS: backup automático com PITR (retenção 35 dias) + snapshots diários copiados para conta/região secundária (dentro do Brasil quando possível; se fora, registrar como transferência internacional).
- S3: versionamento + replicação; Object Lock para auditoria.
- **Teste de restauração mensal** documentado. Metas iniciais: **RPO ≤ 15 min**, **RTO ≤ 4 h**.
- Plano de resposta a incidentes alinhado ao fluxo de comunicação à ANPD e titulares (Res. CD/ANPD nº 15/2024 — prazo de 3 dias úteis).

## 8. Isolamento de ambientes

- Contas AWS **separadas** para `dev`, `staging` e `prod` (AWS Organizations + SCPs). Rede (VPC) própria por ambiente; banco e Redis em subnets privadas.
- **Dados reais de pacientes só existem em produção.** Staging/dev usam dados sintéticos (geradores tipo faker pt-BR). Cópia de produção para staging é proibida, salvo anonimização aprovada pelo Guardião.
- Acesso humano a produção: SSO + MFA, privilégio mínimo, *just-in-time*, sessões registradas (SSM Session Manager, sem SSH aberto).

## 9. Segurança de aplicação

- Validação de entrada em toda borda (class-validator/Zod); saída com DTOs explícitos (nunca serializar entidade inteira).
- Proteções OWASP: CSRF, CSP estrita, rate limit (Redis) por IP/usuário/tenant, proteção contra IDOR (IDs UUID + checagem de posse + RLS).
- Webhooks de terceiros: verificação de assinatura/HMAC, allowlist de IP quando disponível, idempotência por `event_id`.
- Upload: validação de MIME/magic bytes, limite de tamanho, antivírus (ClamAV/GuardDuty Malware Protection for S3).
- WAF (AWS WAF) na borda com regras gerenciadas.

## 10. CI de segurança

Em todo PR (ver `.github/workflows/ci.yml`):

| Verificação | Ferramenta | Bloqueia merge? |
|---|---|---|
| Secret scanning | **gitleaks** (+ GitHub secret scanning/push protection) | Sim |
| Dependências vulneráveis | `pnpm audit` / **Dependabot** / OSV-Scanner | Sim para *high/critical* |
| SAST | **CodeQL** (JavaScript/TypeScript) ou Semgrep | Sim para *high* |
| Lint + typecheck + testes | ESLint, `tsc`, Vitest | Sim |
| Testes de isolamento RLS | Vitest + testcontainers | Sim (quando o módulo `db` existir) |
| IaC | tfsec/Checkov | Sim (quando `infra/` existir) |
| Imagens | Trivy | Sim para *critical* |

Periodicamente: pentest externo antes do go-live e anual; revisão de acessos trimestral.

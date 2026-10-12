# Requisitos técnicos de segurança (obrigatórios)

> Base: LGPD arts. 6º (VII, VIII), 46–49; Res. CD/ANPD 15/2024; Lei 13.787/2018; Res. CFM 1.821/2007 + Manual SBIS S-RES v5.2 (NGS1/NGS2); Res. CFM 2.314/2022; Marco Civil art. 15 e Decreto 8.771/2016 art. 13; OWASP ASVS 5.0. Alinhado com `docs/04-arquitetura/`.
>
> **MUST** = bloqueia release. **SHOULD** = exigido até a fase indicada.

## 1. Classificação de dados

| Classe | Exemplos | Tratamento |
|---|---|---|
| **C4 — Clínico sensível** | Prontuário, notas psicológicas, anexos/exames, gravações, transcrições, prompts/respostas de IA com dados clínicos, motivo de consulta | Criptografia em nível de campo/objeto com chave por tenant; acesso por perfil clínico + vínculo de atendimento; auditoria de **leitura** |
| **C3 — Pessoal sensível indireto** | Agenda (profissional/especialidade), dados de menores, CPF, dados de convênio | Criptografia em repouso; RLS; auditoria de escrita e de exportação |
| **C2 — Pessoal comum** | Nome, contato de profissionais, dados de cobrança | Criptografia em repouso; RLS |
| **C1 — Interno** | Configurações, métricas agregadas | Controle de acesso padrão |
| **Segredos** | Chaves, tokens, certificados ICP-Brasil | Somente em KMS/Secrets Manager/HSM |

## 2. Criptografia (MUST)

- **Em trânsito:** TLS 1.2+ (preferir 1.3), HSTS com preload, sem protocolos/cifras fracos; mTLS ou rede privada entre serviços internos; teleconsulta com DTLS-SRTP (WebRTC).
- **Em repouso:** volumes, bancos, backups e buckets cifrados com KMS (AES-256).
- **Em nível de campo (envelope encryption):** campos C4 cifrados na aplicação com **DEK por tenant**, protegida por KEK no KMS. Rotação anual da KEK; re-wrap de DEKs; capacidade de **crypto-shredding** por tenant.
- **Busca em campos cifrados:** usar índices cegos (HMAC com chave dedicada) apenas para campos que precisam de busca exata (CPF); nunca índice de texto livre clínico fora do tenant.
- **Senhas:** Argon2id (ou bcrypt cost ≥ 12) com pepper em KMS.
- **Assinatura digital:** ICP-Brasil (A3 em nuvem / HSM do prestador) para receitas de controle especial, atestados e documentos clínicos (exigência para NGS2 e para eliminar papel — CFM 1.821/2007). Carimbo de tempo.

## 3. Multi-tenant (MUST)

- `tenant_id` obrigatório em todas as tabelas com dado de cliente.
- **PostgreSQL RLS habilitado e `FORCE ROW LEVEL SECURITY`**; aplicação conecta com role sem `BYPASSRLS`; `SET LOCAL app.tenant_id` por transação.
- Filtro também na camada de aplicação (defesa em profundidade).
- Objetos no S3 com prefixo por tenant + política IAM/URLs pré-assinadas curtas (≤ 5 min) geradas após checagem de autorização.
- Caches (Redis) com chave prefixada por tenant; filas com `tenant_id` no payload e verificação no consumidor.
- **Testes automatizados de isolamento** (testcontainers, Postgres real) em todo PR que mexe em queries/migrations: usuário do tenant A nunca lê/escreve dado do tenant B.
- Jobs de IA, busca e analytics respeitam o tenant (índices vetoriais **por tenant** ou com filtro obrigatório validado).

## 4. Identidade e acesso

- **MFA obrigatório** (TOTP ou WebAuthn/passkey) para todos os perfis com acesso a C3/C4 e para administradores; WebAuthn preferido. MUST.
- **RBAC** com perfis por profissão (médico, dentista, psicólogo, fisio, nutri, fono, terapeuta TEA, esteticista), recepção, financeiro, gestor, admin da clínica. MUST.
- **ABAC** sobre o RBAC: acesso ao prontuário somente se houver **vínculo de cuidado** (profissional responsável, equipe do caso, agendamento ativo) e respeitando compartimentos (ex.: notas psicológicas só do autor). Recepção e financeiro **não** veem conteúdo clínico. MUST.
- **Break-glass:** acesso emergencial com justificativa obrigatória, tempo limitado, alerta ao gestor/encarregado e revisão posterior. MUST.
- Acesso de colaboradores **nossos** a dados de clientes: proibido por padrão; somente break-glass com chamado da clínica, aprovação de 2 pessoas, sessão gravada, expiração automática. MUST.
- Sessões: expiração por inatividade (15 min para perfis clínicos em estação compartilhada, configurável), refresh token rotativo com detecção de reuso, logout global. MUST.
- Proteção contra força bruta e credential stuffing (rate limit, bloqueio progressivo, verificação de senhas vazadas). MUST.
- SSO corporativo (SAML/OIDC) para redes de clínicas. SHOULD (fase 2).
- Revisão de acessos trimestral pelo admin da clínica (relatório no produto). SHOULD.

## 5. Logs de auditoria imutáveis (MUST)

- Registrar: **quem** (usuário, perfil, tenant), **o quê** (ação: criar/ler/alterar/assinar/imprimir/exportar/compartilhar/excluir), **qual recurso** (IDs, nunca o conteúdo clínico), **quando** (UTC, NTP sincronizado), **de onde** (IP, dispositivo), **resultado**, **justificativa** (break-glass).
- **Leitura de prontuário é auditada** (exigência SBIS NGS1).
- Imutabilidade: append-only no banco (sem UPDATE/DELETE pela role da aplicação) + encadeamento por hash (cada registro contém o hash do anterior) + cópia para armazenamento WORM (S3 Object Lock, modo compliance).
- Retenção: trilhas de acesso a prontuário pelo **mesmo prazo do prontuário (≥ 20 anos)**; registros de acesso à aplicação ≥ **6 meses** (Marco Civil art. 15) — adotamos 5 anos para logs de segurança. ⚖️
- Clínica consulta a trilha de auditoria de cada paciente no produto; paciente pode solicitar.
- **Logs técnicos (aplicação/APM/Sentry) sem dados pessoais sensíveis**: scrubbing automático, proibido logar payloads de prontuário, prompts de IA, tokens, CPF completo.
- Alertas: volume anômalo de leituras, exportações em massa, acesso fora do horário, falhas de login, uso de break-glass.

## 6. Backup e continuidade (MUST)

- Backups automáticos cifrados, PITR do PostgreSQL (≥ 35 dias), snapshots diários retidos 35 dias, mensais retidos 12 meses, anuais conforme política de guarda.
- Cópia em **segunda região no Brasil** ou conta isolada (imutável, Object Lock) contra ransomware.
- **RPO ≤ 15 min, RTO ≤ 4 h** para prontuário e agenda (meta inicial).
- **Teste de restauração trimestral** documentado.
- Backups seguem o mesmo isolamento e criptografia; exclusão de dados em produção é refletida nos backups pelo ciclo de expiração (documentar ao titular).

## 7. Retenção e descarte

| Dado | Prazo mínimo | Fundamento |
|---|---|---|
| Prontuário (todas as profissões; padrão conservador) | **20 anos a partir do último registro** | Lei 13.787/2018, art. 6º; CFP 01/2009 exige 5 anos (adotamos 20) ⚖️ |
| Documentos assinados (receitas, atestados, laudos) | Junto ao prontuário | Idem |
| Trilha de auditoria do prontuário | Igual ao prontuário | SBIS / defesa em processos |
| Gravação de teleconsulta (se houver) | Igual ao prontuário | Integra o prontuário |
| Dados fiscais (NFS-e, financeiro) | 5 anos (prazo tributário) — confirmar com contador | CTN art. 173/174 ⚖️ |
| Logs de acesso à aplicação | ≥ 6 meses (proposta D7: 12 meses, ver [retencao-e-descarte.md](retencao-e-descarte.md)) | Marco Civil art. 15 |
| Mensagens de WhatsApp fora do prontuário | 12 meses (proposta) | Minimização |
| Prompts/respostas de IA não incorporados ao prontuário | ≤ 30 dias | Minimização |
| Consentimentos e revogações | Duração do tratamento + 5 anos | Prova (art. 8º, §2º) ⚖️ |
| Registro de incidentes | ≥ 5 anos | Res. CD/ANPD 15/2024 |

- **Bloqueio técnico de exclusão** de prontuário antes do prazo; "exclusão" pela clínica = inativação.
- **Descarte ao fim do prazo**: rotina anual gera lista de prontuários elegíveis → aprovação da clínica (pode haver interesse histórico/pesquisa/judicial) → crypto-shredding da DEK por registro/paciente ou exclusão segura + registro do descarte. Mídias físicas: NIST SP 800-88.
- **Encerramento de contrato**: exportação completa por 90 dias; depois eliminação certificada ou custódia contratada.
- **Política detalhada e expurgo de backups:** [retencao-e-descarte.md](retencao-e-descarte.md) (proposta para a D7).

## 8. Gestão de segredos (MUST)

- Segredos só em **AWS Secrets Manager/KMS** (ou Vault); nunca em git, `.env` de produção, imagens de container, logs ou prompts.
- **Secret scanning** (gitleaks/trufflehog) no pre-commit e no CI; push protection.
- Rotação automática (banco: 90 dias; chaves de API de terceiros: 180 dias ou em incidente).
- Least privilege em IAM; sem credenciais de longa duração para humanos (SSO + roles temporárias).
- Certificados ICP-Brasil dos profissionais: **nunca** custodiados por nós em arquivo; usar provedor de certificado em nuvem (PSC credenciado) com autorização do titular.

## 9. Hospedagem e localização

- Produção, backups e réplicas em **região brasileira** (AWS sa-east-1 ou equivalente). MUST.
- Qualquer suboperador fora do Brasil exige: mecanismo do art. 33 (CPC da Res. 19/2024), registro na lista pública de suboperadores, RIPD atualizado. MUST.
- Ambientes de dev/teste **sem dados reais** — usar dados sintéticos. MUST.

## 10. Desenvolvimento seguro e testes

- **OWASP ASVS 5.0 nível 2** como baseline; **nível 3** para autenticação, sessão, controle de acesso, criptografia e módulos de prontuário/prescrição.
- SAST (Semgrep/CodeQL), SCA/dependências (Dependabot/Renovate + `pnpm audit`), varredura de imagens (Trivy), IaC scan (Checkov/tfsec), DAST (ZAP) em staging. Vulnerabilidade crítica/alta bloqueia merge.
- SBOM gerado por release.
- **Pentest externo** antes do go-live e **anual**, além de a cada mudança relevante (IA, teleconsulta, novo módulo de pagamento); escopo inclui isolamento multi-tenant e prompt injection.
- Programa de divulgação responsável de vulnerabilidades (`security.txt`).
- Threat modeling (STRIDE + LINDDUN para privacidade) para toda feature nova que toque C3/C4.
- Headers de segurança (CSP restritiva, X-Content-Type-Options, frame-ancestors), proteção CSRF, validação de entrada no servidor, upload de arquivos com verificação de tipo e antivírus.

## 11. Teleconsulta

- Sala com token único, expiração, sala de espera e admissão pelo profissional.
- Provedor de vídeo com mídia trafegando cifrada; preferência por servidores no Brasil; CPC se internacional.
- Gravação **desligada por padrão**; quando ligada, consentimento específico registrado e arquivo cifrado anexado ao prontuário.
- TCLE de teleconsulta registrado antes da primeira sessão (CFM 2.314/2022; Lei 14.510/2022).

## 12. Comunicação (WhatsApp/SMS/e-mail)

- Templates aprovados pelo Guardião: **sem dado clínico**; nome fantasia configurável neutro.
- Links levam ao portal autenticado; nunca anexar exames/receitas em mensagem.
- Opt-in/opt-out registrados; números validados para evitar envio a terceiros.

## 13. Plano de resposta a incidentes

> Plano detalhado, com modelos de aviso à clínica, à ANPD e ao paciente: [plano-resposta-incidentes.md](plano-resposta-incidentes.md).

### Papéis
- **Líder do incidente** (on-call de engenharia), **Guardião LGPD/Encarregado**, **Jurídico**, **Comunicação**, **N0** para decisões de notificação.

### Prazos (relógio começa quando se toma conhecimento de que o incidente **afetou dados pessoais**)

| Marco | Prazo | Responsável |
|---|---|---|
| Detecção → triagem inicial e contenção | Imediato (alvo ≤ 1 h para C3/C4) | On-call |
| **Nós (operador) → clínicas afetadas** | **≤ 24 h** (contratual) com informações disponíveis; atualizações a cada 24 h | Encarregado |
| **Controlador → ANPD** (comunicação preliminar) | **3 dias úteis** (Res. CD/ANPD 15/2024); ATPP: 6 dias úteis | Clínica (nós apoiamos com minuta pronta). Quando somos controladores, nós. |
| **Controlador → titulares** | **3 dias úteis**, linguagem clara, com riscos e medidas | Clínica (nós fornecemos ferramenta de envio em massa) |
| Complementação à ANPD | **20 dias úteis** após a comunicação preliminar | Controlador |
| Registro do incidente (mesmo se não notificável) | Manter por **≥ 5 anos** | Encarregado |
| Post-mortem sem culpados | ≤ 10 dias úteis | Líder do incidente |

### Conteúdo mínimo da comunicação (art. 48, §1º e Res. 15/2024)
Natureza e categoria de dados e titulares afetados; quantidade; medidas técnicas de segurança usadas (ex.: dados cifrados); riscos; motivos de eventual demora; medidas adotadas para reverter/mitigar; contato do encarregado.

### Critério de notificação
Notificar quando o incidente puder acarretar **risco ou dano relevante** — dado de saúde e dado de menor são, na prática, indicativos fortes de relevância. Na dúvida, notificar. ⚖️

### Runbooks obrigatórios
Vazamento entre tenants; credencial de profissional comprometida; ransomware; vazamento por suboperador (inclusive provedor de LLM); envio de mensagem a destinatário errado; exposição de bucket; perda de chave KMS; prompt injection com exfiltração. Simulação (tabletop) **semestral**.

## 14. Governança

- Encarregado (DPO) nomeado e publicado (Res. CD/ANPD 18/2024).
- ROPA (registro de operações, art. 37) atualizado a cada nova feature.
- Treinamento anual de segurança e LGPD para toda a equipe; termo de confidencialidade.
- Avaliação de fornecedores (questionário + contrato + CPC) antes de qualquer integração.
- Roadmap de certificações: **SBIS S-RES NGS2** (prioridade para clientes médicos), ISO/IEC 27001, ISO/IEC 27701.

# WBS — Divisão do sistema em Módulos → Partes → Micropartes

> Frente: 🧩 Produto (N2) · Executor: N3 PRD + WBS · Versão 0.1 · Data: 2026-10-06
> Referências: [PRD.md](./PRD.md) · [roadmap.md](./roadmap.md) · [jornadas.md](./jornadas.md)

## Convenções

- **ID:** `MOD-PP.M` → `MOD` = código do módulo, `PP` = parte, `M` = microparte. Ex.: `AGD-02.3` = Agenda › Parte 02 (Operação) › microparte 3.
- **Dependência** pode apontar para uma microparte (`COM-01.1`) ou para uma parte inteira (`COM-01` = todas as micropartes MVP daquela parte).
- **Frente dona:** `Produto` (especificação, conteúdo, modelos, UX), `Engenharia` (implementação/infra), `IA` (modelos, prompts, avaliação), `LGPD` (Guardião LGPD & Segurança — políticas, controles de privacidade). Toda microparte com **Dado sensível = S** passa por revisão obrigatória do Guardião antes do merge, mesmo quando a dona for outra frente.
- **Dado sensível (S/N):** `S` quando a microparte cria, lê, transmite ou armazena dado pessoal sensível (saúde, biometria, imagem clínica, dado de criança/adolescente vinculado a atendimento) ou credencial/segredo crítico. Dado pessoal comum (nome, telefone) sem vínculo clínico = `N`, mas continua sob LGPD.
- **Fase:** `MVP` (Fase 1), `F2`, `F3` — ver [roadmap.md](./roadmap.md).
- **Critério de pronto (DoD)** listado é o específico da microparte. Vale também o **DoD global**: testes automatizados (unitários + integração) passando, testes de isolamento de tenant quando houver dado de tenant, logs sem PII, documentação de API, acessibilidade mínima nas telas, revisão de código, revisão do Guardião se `S`, métricas de uso instrumentadas.

## Sumário dos módulos

| # | Código | Módulo | Partes | Micropartes | MVP | F2 | F3 |
|---|---|---|---|---|---|---|---|
<!-- SUMARIO -->

---

## 1. NUC — Núcleo / Plataforma

Partes: **01** Tenancy e organização · **02** Identidade e acesso · **03** Permissões e sigilo · **04** Auditoria · **05** Plataforma técnica

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| NUC-01.1 | Modelo multi-tenant | Isolamento lógico por `tenant_id` com Row-Level Security no banco e contexto de tenant obrigatório em toda requisição | Engenharia | — | S | MVP | Suíte de testes prova que usuário do tenant A não lê/escreve dado do tenant B em 100% dos endpoints; RLS ativo em todas as tabelas com dado de tenant |
| NUC-01.2 | Onboarding da clínica | Wizard de criação de conta: dados da clínica, nicho(s), profissionais, horário, importação opcional | Produto | NUC-01.1, BIL-01.2 | N | MVP | Conta criada e primeira agenda configurada em < 5 min em teste de usabilidade com 5 usuários |
| NUC-01.3 | Unidades, salas e recursos | Cadastro de unidades (endereço, CNES opcional), salas e equipamentos agendáveis | Engenharia | NUC-01.1 | N | MVP | CRUD completo; sala vinculável a agendamento; unidade aparece na página pública |
| NUC-01.4 | Configurações da clínica | Fuso, horário de funcionamento, logo, papel timbrado, dados cadastrais e de contato | Engenharia | NUC-01.1 | N | MVP | Configurações refletidas em documentos, lembretes e página pública |
| NUC-01.5 | Multiunidade / franquias | Grupo econômico com várias clínicas, consolidação gerencial e políticas centralizadas | Engenharia | NUC-01.3, REL-03.1 | N | F3 | Usuário de grupo vê relatórios consolidados sem acessar prontuários de outras unidades sem permissão |
| NUC-02.1 | Usuários e convites | Convite por e-mail/WhatsApp, ativação, desativação e transferência de responsabilidades | Engenharia | NUC-01.1 | N | MVP | Usuário desativado perde acesso imediato; histórico e autoria preservados |
| NUC-02.2 | Autenticação | Login e-mail + senha (hash forte), política de senha, recuperação, bloqueio por tentativas | Engenharia | NUC-02.1 | S | MVP | Aprovado em checklist OWASP ASVS nível 2 para autenticação; senhas com Argon2/bcrypt |
| NUC-02.3 | MFA | Segundo fator TOTP/app obrigatório para papéis com acesso clínico e financeiro | Engenharia | NUC-02.2 | S | MVP | Impossível acessar prontuário sem MFA configurado; recuperação de MFA auditada |
| NUC-02.4 | Sessões e dispositivos | Expiração por inatividade, lista de sessões ativas, logout remoto | Engenharia | NUC-02.2 | N | MVP | Sessão expira conforme configuração; logout remoto efetivo em < 1 min |
| NUC-02.5 | SSO corporativo | SAML 2.0 / OIDC para redes Enterprise | Engenharia | NUC-02.2 | N | F3 | Login via IdP testado com 2 provedores; provisionamento JIT |
| NUC-02.6 | Perfil profissional | Conselho (CRM, CRO, CRP, CRN, CREFITO, CRFa…), nº, UF, especialidades, RQE, assinatura visual | Produto | NUC-02.1 | N | MVP | Campos de conselho cobrem todos os nichos do PRD; dados usados em documentos e guias |
| NUC-03.1 | RBAC — papéis padrão | Papéis: administrador, profissional, recepção, financeiro, faturista, gestor | Engenharia | NUC-02.1 | S | MVP | Matriz papel × recurso documentada e testada; recepção não acessa conteúdo clínico |
| NUC-03.2 | Permissões granulares | Papéis customizados por recurso/ação e por unidade | Engenharia | NUC-03.1 | S | F2 | Admin cria papel customizado; testes cobrem combinações críticas |
| NUC-03.3 | Sigilo do prontuário | Acesso clínico restrito ao profissional assistente e a quem ele compartilhar; anotações privadas não compartilháveis | LGPD | NUC-03.1 | S | MVP | Testes provam que outro profissional/gestor não lê registro sem compartilhamento; aprovado pelo Guardião |
| NUC-03.4 | Acesso de emergência | "Quebra de vidro" com justificativa obrigatória, tempo limitado e alerta ao responsável | LGPD | NUC-03.3, NUC-04.1 | S | F2 | Acesso gera alerta e registro de auditoria destacado; expira automaticamente |
| NUC-04.1 | Trilha de auditoria | Log imutável (append-only, hash encadeado) de leituras e escritas em dado sensível: quem, o quê, quando, IP, dispositivo | Engenharia | NUC-01.1 | S | MVP | 100% dos acessos a prontuário/documentos auditados; adulteração detectável; retenção ≥ 20 anos para eventos clínicos |
| NUC-04.2 | Consulta de auditoria | Tela para admin/encarregado filtrar por paciente, usuário, período, ação | Engenharia | NUC-04.1 | S | MVP | Consulta de 1 ano de eventos de um paciente em < 3 s; exportável |
| NUC-04.3 | Alertas de acesso anômalo | Detecção de padrões suspeitos (acesso em massa, fora de horário, paciente não atendido) | Engenharia | NUC-04.1 | S | F2 | Regras configuráveis; alerta entregue ao admin; taxa de falso positivo monitorada |
| NUC-05.1 | Criptografia e chaves | Criptografia em repouso (AES-256) e trânsito (TLS 1.2+), KMS, criptografia de campo para dados clínicos | Engenharia | — | S | MVP | Varredura confirma TLS em todos os endpoints; chaves rotacionáveis; aprovado pelo Guardião |
| NUC-05.2 | Armazenamento de arquivos | Object storage com URLs assinadas de curta duração, antivírus no upload, limites por plano | Engenharia | NUC-05.1 | S | MVP | Arquivo nunca acessível sem URL assinada; upload infectado bloqueado |
| NUC-05.3 | Notificações internas | Centro de notificações in-app para usuários da clínica | Engenharia | NUC-02.1 | N | MVP | Notificações em tempo real; marcar como lida; sem conteúdo clínico no preview |
| NUC-05.4 | Eventos e jobs | Barramento de eventos de domínio e agendador de jobs com retentativa e idempotência | Engenharia | — | N | MVP | Eventos com garantia at-least-once e consumidores idempotentes; painel de filas |
| NUC-05.5 | Observabilidade | Logs estruturados sem PII, métricas, tracing, alertas e SLOs | Engenharia | — | N | MVP | Dashboards de SLO; varredura automática de PII em logs sem achados |
| NUC-05.6 | Backup e recuperação | Backups criptografados, point-in-time recovery, teste de restauração periódico, DR em outra zona | Engenharia | NUC-05.1 | S | MVP | RPO ≤ 15 min e RTO ≤ 4 h comprovados em simulação |
| NUC-05.7 | Feature flags | Liberação de recursos por tenant, plano e percentual | Engenharia | NUC-01.1 | N | MVP | Flag ligada/desligada sem deploy; auditada |
| NUC-05.8 | Busca global | Busca unificada (pacientes, agendamentos, documentos) respeitando permissões | Engenharia | NUC-03.1, PAC-02.1 | S | F2 | Resultado em < 500 ms; nunca exibe item sem permissão |

## 2. PAC — Cadastro de pacientes

Partes: **01** Cadastro · **02** Organização e histórico

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| PAC-01.1 | Ficha do paciente | Dados pessoais, contatos, CPF (opcional), CNS, nome social, gênero, endereço, profissão, como conheceu | Produto | NUC-01.1 | S | MVP | Cadastro com apenas nome + telefone permitido (minimização); nome social exibido em toda a interface |
| PAC-01.2 | Responsáveis e acompanhantes | Responsável legal (menores, TEA, curatela), contatos de emergência e permissões do responsável | Produto | PAC-01.1 | S | MVP | Menor de idade exige responsável; responsável recebe comunicações conforme configuração |
| PAC-01.3 | Deduplicação e mesclagem | Detecção de duplicados (CPF, telefone, nome + nascimento) e mesclagem auditada | Engenharia | PAC-01.1, NUC-04.1 | S | MVP | Alerta de possível duplicado na criação; mesclagem preserva todo o histórico e é reversível em 30 dias |
| PAC-01.4 | Pré-cadastro / autocadastro | Link enviado por WhatsApp para o paciente completar dados antes da consulta | Engenharia | PAC-01.1, COM-03.3 | S | MVP | Paciente completa cadastro em < 2 min no celular; dados validados entram na ficha |
| PAC-01.5 | Dados de convênio do paciente | Operadora, plano, nº de carteirinha, validade, titular | Engenharia | PAC-01.1, CNV-01.1 | S | F2 | Carteirinha validada por regra de dígito da operadora; alerta de validade vencida |
| PAC-01.6 | Campos personalizados | Campos extras definidos pela clínica no cadastro | Engenharia | PAC-01.1 | N | F2 | Admin cria campo; campo aparece em filtros e exportação |
| PAC-02.1 | Busca e listagem | Lista com filtros (nome, telefone, CPF, tag, profissional, último atendimento) | Engenharia | PAC-01.1 | N | MVP | Busca por nome parcial/sem acento em < 300 ms com 100 mil pacientes |
| PAC-02.2 | Tags e segmentos | Etiquetas manuais e segmentos salvos | Engenharia | PAC-02.1 | N | MVP | Tags filtráveis; tags não podem conter diagnóstico (validação + orientação) |
| PAC-02.3 | Anexos administrativos | Documentos de identificação, carteirinha, termos assinados | Engenharia | NUC-05.2 | S | MVP | Upload por arrastar ou câmera do celular; acesso auditado |
| PAC-02.4 | Linha do tempo do paciente | Visão cronológica de agendamentos, atendimentos, documentos, pagamentos e mensagens, filtrada por permissão | Engenharia | PAC-01.1, AGD-02.2 | S | MVP | Recepção vê apenas eventos administrativos; profissional vê também os clínicos |
| PAC-02.5 | Alertas no cadastro | Alergias, necessidades de acessibilidade, pendências financeiras exibidos em destaque | Produto | PAC-01.1, PRO-02.2 | S | F2 | Alerta clínico só visível a quem tem permissão clínica |
| PAC-02.6 | Inativação e retenção | Arquivamento do paciente respeitando guarda legal de prontuário (20 anos) | LGPD | PAC-01.1, LGP-03.3 | S | MVP | Paciente inativado some das listas mas prontuário fica preservado e exportável |

## 3. AGD — Agenda

Partes: **01** Configuração · **02** Operação · **03** Automação e políticas

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| AGD-01.1 | Grade de horários | Disponibilidade por profissional, unidade, sala e dia da semana, com intervalos | Engenharia | NUC-01.3, NUC-02.6 | N | MVP | Profissional configura semana em < 3 min; grade respeita fuso da clínica |
| AGD-01.2 | Tipos de atendimento | Duração, preço, cor, modalidade (presencial/online), preparo, profissionais habilitados | Produto | AGD-01.1 | N | MVP | Tipo vinculado define duração e preço sugerido da cobrança |
| AGD-01.3 | Bloqueios e feriados | Bloqueios pontuais, férias, feriados nacionais/municipais | Engenharia | AGD-01.1 | N | MVP | Feriados nacionais pré-carregados; bloqueio impede agendamento online |
| AGD-01.4 | Recursos compartilhados | Salas e equipamentos com checagem de conflito | Engenharia | NUC-01.3, AGD-01.1 | N | MVP | Impossível alocar a mesma sala em sobreposição sem override explícito |
| AGD-02.1 | Visões de agenda | Dia, semana, mês, lista; múltiplos profissionais lado a lado | Engenharia | AGD-01.1 | N | MVP | Carrega semana de 10 profissionais em < 1 s; funciona em tablet |
| AGD-02.2 | CRUD de agendamento | Criar, mover (arrastar), editar e cancelar com motivo, validando conflito | Engenharia | AGD-02.1, PAC-01.1 | N | MVP | Conflitos bloqueados; histórico de alterações auditado; motivo de cancelamento obrigatório |
| AGD-02.3 | Encaixe | Encaixe fora da grade com sinalização visual e limite configurável | Engenharia | AGD-02.2 | N | MVP | Encaixe visível e contabilizado separadamente nos relatórios |
| AGD-02.4 | Recorrência e pacotes | Séries recorrentes (semanal, quinzenal) vinculadas a pacote de sessões | Engenharia | AGD-02.2, FIN-01.5 | N | MVP | Série de 20 sessões criada em 1 ação; edição "só esta / todas as próximas" |
| AGD-02.5 | Lista de espera | Lista de espera por profissional/serviço/período preferido | Engenharia | AGD-02.2 | N | MVP | Recepção vê candidatos compatíveis quando uma vaga é liberada |
| AGD-02.6 | Oferta automática de vaga | Ao cancelar, bot oferece a vaga a pacientes da lista de espera por ordem | Engenharia | AGD-02.5, COM-03.2 | N | F2 | Primeira aceitação confirma vaga; demais recebem aviso de vaga preenchida |
| AGD-02.7 | Status e check-in | Agendado → confirmado → chegou → em atendimento → atendido / faltou / cancelado; tempo de espera | Engenharia | AGD-02.2 | N | MVP | Transições válidas aplicadas; tempo de espera calculado; faltas alimentam relatório |
| AGD-02.8 | Agendamento em sequência | Vários procedimentos/profissionais em sequência para o mesmo paciente | Engenharia | AGD-02.2 | N | F2 | Bloco multi-etapa reservado atomicamente |
| AGD-02.9 | Painel de chamada | Tela para TV da recepção chamando por nome social/iniciais | Engenharia | AGD-02.7 | N | F3 | Exibição configurável (iniciais por padrão, minimização) |
| AGD-03.1 | Regras de confirmação | Quando e por qual canal pedir confirmação, nº de tentativas, escalonamento para a recepção | Produto | AGD-02.7, COM-03.2 | N | MVP | Regras por tipo de atendimento; não confirmados aparecem em fila da recepção |
| AGD-03.2 | Autorremarcação/cancelamento | Paciente remarca/cancela via WhatsApp/portal respeitando antecedência mínima | Engenharia | AGD-02.2, COM-03.2, POR-02.1 | N | MVP | Remarcação libera vaga e notifica profissional; regra de antecedência aplicada |
| AGD-03.3 | Política de no-show | Taxa de falta, sinal obrigatório após X faltas, bloqueio de autoagendamento | Produto | AGD-02.7, PAG-02.1 | N | F2 | Política configurável; paciente informado previamente da política |

## 4. AON — Agendamento online

Partes: **01** Página pública de agendamento · **02** Agendamento pelo WhatsApp

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| AON-01.1 | Página da clínica/profissional | Página pública com bio, especialidades, endereço, serviços, preços opcionais, convênios aceitos | Produto | NUC-01.4, AGD-01.2 | N | MVP | Lighthouse ≥ 90 mobile; WCAG 2.1 AA; SEO básico (schema.org) |
| AON-01.2 | Seleção de horário | Escolha de serviço → profissional → horário com disponibilidade em tempo real | Engenharia | AON-01.1, AGD-02.2 | N | MVP | Sem double-booking em teste de concorrência; agendamento em ≤ 4 passos |
| AON-01.3 | Identificação do paciente | Verificação por OTP (WhatsApp/SMS) e pré-cadastro mínimo | Engenharia | AON-01.2, COM-04.2, PAC-01.4 | S | MVP | Paciente existente reconhecido; aceite de política de privacidade registrado |
| AON-01.4 | Sinal/pré-pagamento | Cobrança de sinal via Pix para confirmar a reserva | Engenharia | AON-01.2, PAG-01.2 | N | F2 | Reserva expira se Pix não pago no prazo; vaga liberada automaticamente |
| AON-01.5 | Widget e links | Widget embutível, link curto para Instagram/Google e QR code | Engenharia | AON-01.1 | N | MVP | Widget funciona em site de terceiros sem conflitos de CSS |
| AON-01.6 | Diretórios externos | Reserve with Google e diretórios parceiros | Engenharia | AON-01.2 | N | F3 | Agendamento originado em diretório chega à agenda com origem rastreada |
| AON-01.7 | Proteção anti-abuso | Rate limit, detecção de reservas falsas, bloqueio de número abusivo (sem CAPTCHA intrusivo) | Engenharia | AON-01.2 | N | MVP | Teste de carga de reservas falsas bloqueado sem afetar usuário legítimo |
| AON-02.1 | Fluxo conversacional | Bot de agendamento no WhatsApp: botões/listas + linguagem natural para marcar | Produto | COM-01.1, IA-04.1, AGD-02.2 | N | MVP | ≥ 70% dos agendamentos iniciados pelo bot concluídos sem humano em piloto |
| AON-02.2 | Regras de autoagendamento | Quais serviços/profissionais/horários o bot pode oferecer | Produto | AON-02.1, AGD-01.2 | N | MVP | Clínica restringe serviços (ex.: primeira consulta só por humano) |
| AON-02.3 | Handoff para humano | Transferência para a inbox com contexto da conversa | Engenharia | AON-02.1, COM-02.1 | N | MVP | Paciente digita "atendente" ou bot detecta impasse → conversa na fila da inbox em < 5 s |

## 5. COM — Comunicação (WhatsApp, SMS, e-mail)

Partes: **01** Infraestrutura WhatsApp · **02** Inbox compartilhada · **03** Mensagens automáticas · **04** Outros canais e templates

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| COM-01.1 | Conexão WhatsApp Business Platform | Integração com Cloud API oficial (ou BSP) com embedded signup do número da clínica | Engenharia | NUC-01.1 | N | MVP | Clínica conecta número em < 10 min sem suporte; envio/recebimento funcionando |
| COM-01.2 | Gestão de templates | Criação, submissão e acompanhamento de aprovação de templates (utility/marketing) | Engenharia | COM-01.1 | N | MVP | Biblioteca de templates padrão aprovados; status sincronizado com a Meta |
| COM-01.3 | Opt-in e preferências | Registro de opt-in/opt-out por canal e finalidade (lembrete vs. marketing) | LGPD | COM-01.1, LGP-01.2 | N | MVP | Nenhuma mensagem de marketing sem opt-in; "SAIR" processado automaticamente |
| COM-01.4 | Status e retentativas | Webhooks de entregue/lido/falha, retentativa e fallback para SMS/e-mail | Engenharia | COM-01.1, NUC-05.4 | N | MVP | Falha de WhatsApp gera fallback em < 5 min; status visível no agendamento |
| COM-01.5 | Qualidade e custos | Monitor de qualidade do número, limites de envio e custo por conversa por tenant | Engenharia | COM-01.1, BIL-01.4 | N | MVP | Alerta quando qualidade cai; custo mensal por tenant disponível no billing |
| COM-02.1 | Inbox multiatendente | Caixa compartilhada com filas, atribuição, status (aberta/pendente/resolvida) | Engenharia | COM-01.1, NUC-03.1 | S | MVP | 3 atendentes simultâneos sem colisão; histórico completo por paciente |
| COM-02.2 | Painel de contexto | Lateral com dados do paciente, próximos agendamentos e pendências financeiras (sem conteúdo clínico por padrão) | Produto | COM-02.1, PAC-02.4 | S | MVP | Recepção agenda/remarca sem sair da inbox; nenhum dado clínico exibido a perfil sem permissão |
| COM-02.3 | Respostas rápidas e mídia | Atalhos de resposta, envio de documentos, áudio, imagem, localização | Engenharia | COM-02.1 | S | MVP | Envio de PDF de documento clínico só por link seguro (DOC-03.1) |
| COM-02.4 | Notas internas e transferência | Notas visíveis só à equipe, transferência entre atendentes/filas | Engenharia | COM-02.1 | N | MVP | Nota nunca é enviada ao paciente (teste automatizado) |
| COM-02.5 | SLA e horário de atendimento | Metas de tempo de resposta, mensagem de ausência, relatório de SLA | Engenharia | COM-02.1 | N | F2 | Relatório de tempo de 1ª resposta por atendente |
| COM-02.6 | Outros canais na inbox | Instagram Direct e Messenger na mesma caixa | Engenharia | COM-02.1 | N | F3 | Conversas de 3 canais unificadas por paciente |
| COM-03.1 | Lembretes de consulta | Lembretes configuráveis (D-2, D-1, H-2) com endereço e preparo | Produto | COM-01.2, AGD-02.2, COM-04.4 | N | MVP | Lembretes enviados no horário com desvio < 5 min; sem dado clínico no texto |
| COM-03.2 | Confirmação interativa | Botões Confirmar / Remarcar / Cancelar atualizando o status do agendamento | Engenharia | COM-03.1, AGD-02.7 | N | MVP | Clique no botão atualiza agenda em < 10 s |
| COM-03.3 | Instruções e pré-cadastro | Envio de preparo, localização, link de pré-cadastro e formulários | Engenharia | COM-03.1 | N | MVP | Mensagens configuráveis por tipo de atendimento |
| COM-03.4 | Pós-consulta | Disparo de documentos, cobrança e NPS após "atendido" | Produto | COM-03.1, DOC-03.1, PAG-02.1, CRM-01.1 | S | MVP | Sequência pós-consulta configurável; nenhuma mensagem duplicada |
| COM-03.5 | Mensagens de relacionamento | Aniversário, retorno programado, reativação | Produto | COM-03.1, CRM-03.3 | N | F2 | Envio só com base legal/opt-in válido |
| COM-04.1 | E-mail transacional | Envio com domínio próprio da clínica (SPF/DKIM/DMARC) ou domínio da plataforma | Engenharia | NUC-01.4 | N | MVP | Taxa de entrega ≥ 98%; bounces tratados |
| COM-04.2 | SMS | SMS para OTP e fallback | Engenharia | NUC-01.1 | N | MVP | OTP entregue em < 30 s em operadoras nacionais |
| COM-04.3 | Push notifications | Notificações push para apps do paciente e do profissional | Engenharia | POR-03.2 | N | F2 | Push entregue com conteúdo genérico (sem dado clínico na tela bloqueada) |
| COM-04.4 | Motor de templates multicanal | Templates com variáveis, prévia, versões por canal e idioma simples | Engenharia | COM-01.2 | N | MVP | Prévia idêntica ao enviado; variáveis inexistentes bloqueiam o salvamento |

## 6. PRO — Prontuário eletrônico

Partes: **01** Construtor de modelos · **02** Registro clínico · **03** Módulos por nicho

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| PRO-01.1 | Editor de formulários | Construtor drag-and-drop: seções, texto, número, data, escolha única/múltipla, tabela, imagem anotável | Engenharia | NUC-01.1 | N | MVP | Profissional cria modelo de 15 campos em < 10 min sem ajuda |
| PRO-01.2 | Biblioteca de componentes clínicos | Componentes prontos: sinais vitais, alergias, medicações em uso, CID, queixa/HDA, conduta | Produto | PRO-01.1, INT-01.4 | N | MVP | ≥ 20 componentes reutilizáveis documentados |
| PRO-01.3 | Modelos prontos por nicho | Modelos validados por profissionais de cada nicho: medicina (clínica, pediatria, endócrino), odonto, psico, nutri, fisio/TO, estética, fono/TEA | Produto | PRO-01.2 | N | MVP | ≥ 2 modelos por nicho revisados por profissional do nicho; selecionados no onboarding |
| PRO-01.4 | Versionamento de modelos | Alterar modelo não altera registros antigos (cada registro guarda a versão) | Engenharia | PRO-01.1 | N | MVP | Registro antigo renderiza exatamente como foi assinado |
| PRO-01.5 | Lógica condicional e cálculos | Campos condicionais e fórmulas (IMC, escores, idade gestacional) | Engenharia | PRO-01.1 | N | F2 | Fórmulas testadas com casos de referência; erros de fórmula impedem publicação |
| PRO-01.6 | Galeria de modelos da comunidade | Compartilhamento opcional de modelos entre clínicas (sem dados) | Produto | PRO-01.4 | N | F3 | Modelo importado em 1 clique; curadoria antes de publicar |
| PRO-02.1 | Atendimento / evolução | Abertura do atendimento a partir da agenda, registro no modelo escolhido, cronômetro | Engenharia | PRO-01.1, AGD-02.7, NUC-03.3 | S | MVP | Atendimento iniciado em 1 clique da agenda; salvamento automático a cada 10 s |
| PRO-02.2 | Anamnese e antecedentes | Antecedentes pessoais/familiares, alergias, medicações em uso, hábitos — persistem entre atendimentos | Produto | PRO-02.1 | S | MVP | Dados de anamnese reaproveitados no próximo atendimento com indicação de última atualização |
| PRO-02.3 | Finalização e bloqueio | Finalizar/assinar registro; após assinado só aceita adendo datado | Engenharia | PRO-02.1, NUC-04.1 | S | MVP | Edição de registro assinado impossível (teste); adendos exibidos com autoria e data |
| PRO-02.4 | Assinatura ICP-Brasil do prontuário | Assinatura digital qualificada dos registros (requisito NGS2/eliminação de papel) | Engenharia | PRO-02.3, DOC-02.1 | S | F2 | Registro assinado validável no verificador do ITI |
| PRO-02.5 | Anexos clínicos | Exames, imagens, laudos externos com visualizador (PDF, imagem, DICOM básico em F3) | Engenharia | NUC-05.2, PRO-02.1 | S | MVP | Visualização inline; anexos vinculados ao atendimento |
| PRO-02.6 | Anotações privadas | Anotações pessoais do profissional (ex.: psicologia) separadas do prontuário, nunca compartilhadas nem exportadas para terceiros sem decisão do profissional | LGPD | PRO-02.1, NUC-03.3 | S | MVP | Gestor/admin não acessa; regra documentada no RIPD e aprovada pelo Guardião |
| PRO-02.7 | Histórico clínico | Linha do tempo clínica com filtros por tipo, profissional e período; comparação de registros | Engenharia | PRO-02.1 | S | MVP | Histórico de 5 anos carrega em < 2 s |
| PRO-02.8 | Prontuário multiprofissional | Compartilhamento entre equipe com permissões por área (ex.: fono vê psico só resumo) | Produto | PRO-02.1, NUC-03.2 | S | F2 | Matriz de compartilhamento configurável; auditoria de cada visualização |
| PRO-02.9 | Ditado por voz em campo | Ditado pontual em qualquer campo de texto (sem escriba completo) | IA | IA-01.2 | S | F2 | WER ≤ 10% em vocabulário clínico do nicho |
| PRO-03.1 | Odontograma básico | Dentição permanente/decídua, estados por dente e face, legenda padrão, histórico | Produto | PRO-02.1 | S | MVP | Validado por 3 dentistas; registro por face em ≤ 2 cliques |
| PRO-03.2 | Plano de tratamento odontológico | Procedimentos por dente/face com valores, orçamento, aprovação do paciente e execução por etapa | Produto | PRO-03.1, FIN-01.6 | S | F2 | Orçamento aprovado gera cobranças/parcelas; execução marca procedimento no odontograma |
| PRO-03.3 | Periograma | Profundidade de sondagem, sangramento, mobilidade | Produto | PRO-03.1 | S | F3 | Validado por periodontista; gráfico comparativo entre exames |
| PRO-03.4 | Antropometria | Peso, altura, circunferências, dobras cutâneas, IMC, % gordura (protocolos de referência), gráficos de evolução | Produto | PRO-02.1 | S | MVP | Cálculos conferidos com casos de referência; gráfico de evolução por medida |
| PRO-03.5 | Bioimpedância | Registro manual e importação de arquivos de balanças | Engenharia | PRO-03.4 | S | F2 | Importação de ≥ 2 marcas de mercado |
| PRO-03.6 | Plano alimentar e recordatório | Plano alimentar com base de alimentos (TACO), substituições, cálculo de macros; recordatório 24 h | Produto | PRO-03.4, INT-01.4 | S | F2 | Plano gera PDF e aparece no portal; macros conferidos |
| PRO-03.7 | Plano de sessões | Plano terapêutico com nº de sessões, metas, evolução por sessão e vínculo com pacote/agenda (fisio, TO, fono, psico) | Produto | PRO-02.1, AGD-02.4 | S | MVP | Sessão realizada decrementa saldo do plano; progresso de metas visível |
| PRO-03.8 | Escalas e testes padronizados | EVA de dor, goniometria, escalas funcionais e questionários de domínio público; licenciados em F2 | Produto | PRO-01.2 | S | MVP | ≥ 10 escalas de domínio público; escore calculado automaticamente; licenças verificadas |
| PRO-03.9 | Fotos clínicas antes/depois | Captura guiada (grade/sobreposição), comparação lado a lado, vínculo com consentimento de imagem | Produto | NUC-05.2, LGP-01.2 | S | MVP | Foto só capturável com consentimento de imagem registrado; fotos nunca em galeria do celular (captura direto no app/web) |
| PRO-03.10 | Mapa de aplicação (estética) | Mapa facial/corporal com pontos de aplicação, produto, lote, unidades/volume | Produto | PRO-03.9, EST-01.4 | S | F2 | Lote vinculado ao paciente para rastreabilidade; impressão do mapa |
| PRO-03.11 | Plano terapêutico multiprofissional (TEA) | Metas compartilhadas entre fono, TO, psico; relatórios para família, escola e operadora | Produto | PRO-03.7, PRO-02.8 | S | F2 | Relatório consolidado gerado por período com aprovação de cada profissional |
| PRO-03.12 | Curvas de crescimento | Curvas OMS (peso, estatura, IMC, PC) para pediatria e nutrição infantil | Produto | PRO-03.4 | S | F2 | Percentis/escore-z conferidos com tabelas OMS |
| PRO-03.13 | Termos de consentimento por procedimento | Modelos de TCLE por procedimento, assinatura eletrônica do paciente, anexação ao prontuário | Produto | DOC-02.4, PRO-02.1 | S | MVP | Procedimento configurado como "exige termo" não pode ser finalizado sem termo assinado |
| PRO-03.14 | Pré-natal / obstetrícia | DUM, idade gestacional, cartão da gestante | Produto | PRO-01.5 | S | F3 | Cálculo de IG e DPP conferidos |

## 7. DOC — Prescrição, atestados e assinatura digital

Partes: **01** Documentos clínicos · **02** Assinatura e validação · **03** Entrega

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| DOC-01.1 | Receituário simples | Prescrição com busca em base de medicamentos (ANVISA/CMED), posologia, favoritos e modelos | Produto | INT-01.4, PRO-02.1 | S | MVP | Receita gerada em < 60 s; layout conforme normas do conselho |
| DOC-01.2 | Controle especial | Receituário de controle especial conforme Portaria SVS/MS 344/98 (vias, campos obrigatórios) | Produto | DOC-01.1 | S | MVP | Validação de campos obrigatórios; geração em 2 vias; revisado por farmacêutico/consultor |
| DOC-01.3 | Atestados e declarações | Atestado (com CID apenas se o paciente autorizar), declaração de comparecimento | Produto | PRO-02.1 | S | MVP | CID só incluído com marcação explícita de autorização do paciente |
| DOC-01.4 | Pedidos de exame e encaminhamentos | Solicitação de exames (TUSS opcional), encaminhamentos e contrarreferência | Produto | INT-01.4 | S | MVP | Pedidos agrupáveis; favoritos de painéis de exames |
| DOC-01.5 | Modelos de documentos | Editor de relatórios, laudos, orientações e declarações com variáveis | Engenharia | PRO-01.1 | S | MVP | Clínica cria modelo com variáveis do paciente/atendimento |
| DOC-01.6 | Prescrição de exercícios | Biblioteca de exercícios com imagens/vídeos para fisio/TO e envio ao portal | Produto | DOC-01.5, POR-02.8 | S | F3 | Biblioteca com ≥ 200 exercícios; paciente vê no portal |
| DOC-02.1 | Assinatura ICP-Brasil em nuvem | Integração com PSCs (certificado em nuvem) para assinatura qualificada de documentos | Engenharia | DOC-01.1 | S | MVP | Documento assinado validado no verificador oficial do ITI; ≥ 2 PSCs suportados |
| DOC-02.2 | Assinatura em lote | Assinar vários documentos/registros em uma autorização | Engenharia | DOC-02.1 | S | F2 | 20 documentos assinados em uma autenticação |
| DOC-02.3 | Verificação de autenticidade | QR code / código de verificação em cada documento com página pública de validação (sem exibir conteúdo clínico) | Engenharia | DOC-02.1 | N | MVP | Farmácia valida documento pelo QR sem acessar dados além do necessário |
| DOC-02.4 | Assinatura eletrônica do paciente | Assinatura do paciente em termos (desenho na tela, OTP, evidências de IP/horário) | Engenharia | PAC-01.1, COM-04.2 | S | MVP | Evidências de assinatura armazenadas e exportáveis em dossiê |
| DOC-03.1 | Envio seguro ao paciente | Envio por WhatsApp/e-mail/portal com link seguro expirável e autenticação | Engenharia | DOC-02.1, COM-02.3, POR-01.1 | S | MVP | Link expira (configurável, padrão 7 dias); acesso exige OTP; abertura auditada |
| DOC-03.2 | Impressão | Impressão com papel timbrado, margens configuráveis | Engenharia | DOC-01.5 | S | MVP | Impressão correta em A4 e A5 |
| DOC-03.3 | Integração Memed | Alternativa de prescrição via Memed para quem já usa | Engenharia | INT-01.1 | S | F2 | Prescrição Memed retorna e é anexada ao prontuário |

## 8. TEL — Teleconsulta

Partes: **01** Sessão de vídeo · **02** Conformidade e integração

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| TEL-01.1 | Sala de vídeo WebRTC | Vídeo no navegador, sem instalação, criptografado ponta a ponta quando possível, servidores no Brasil | Engenharia | AGD-02.2 | S | F2 | Chamada estável em 4G com 1 Mbps; nenhuma mídia gravada por padrão |
| TEL-01.2 | Sala de espera virtual | Paciente aguarda; profissional admite; aviso de atraso | Engenharia | TEL-01.1 | S | F2 | Paciente nunca entra sem admissão do profissional |
| TEL-01.3 | Link de acesso | Link único por agendamento enviado por WhatsApp/portal com autenticação OTP | Engenharia | TEL-01.1, COM-03.1 | S | F2 | Link não reutilizável após a consulta |
| TEL-01.4 | Chat e compartilhamento | Chat, compartilhamento de tela e arquivos na sessão | Engenharia | TEL-01.1 | S | F2 | Arquivos compartilhados vão para anexos do atendimento com aceite do profissional |
| TEL-01.5 | Resiliência de conexão | Teste prévio de câmera/microfone, fallback para só áudio, reconexão automática | Engenharia | TEL-01.1 | N | F2 | Reconexão em < 10 s após queda breve |
| TEL-01.6 | Multiparticipante | Inclusão de familiar, intérprete de Libras ou outro profissional | Engenharia | TEL-01.1 | S | F3 | Até 4 participantes com permissão do paciente |
| TEL-02.1 | Consentimento de teleconsulta | TCLE específico conforme normas do CFM e demais conselhos, registrado antes da chamada | LGPD | TEL-01.2, LGP-01.2 | S | F2 | Chamada não inicia sem consentimento registrado |
| TEL-02.2 | Escriba na teleconsulta | Captura do áudio da sessão para o escriba, com consentimento explícito | IA | TEL-01.1, IA-01.1 | S | F2 | Mesmo fluxo de revisão do escriba presencial; áudio descartado conforme política |

## 9. FIN — Financeiro

Partes: **01** Contas a receber · **02** Contas a pagar e fluxo de caixa · **03** Repasse · **04** Contabilidade

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| FIN-01.1 | Cobrança do atendimento | Lançamento automático da cobrança ao concluir atendimento, preço do tipo, descontos | Engenharia | AGD-02.7, AGD-01.2 | N | MVP | Atendimento concluído sem cobrança aparece em pendências |
| FIN-01.2 | Caixa diário | Abertura, fechamento, sangria, conferência por forma de pagamento | Engenharia | FIN-01.1 | N | MVP | Fechamento de caixa com diferenças destacadas; relatório imprimível |
| FIN-01.3 | Formas de pagamento | Dinheiro, Pix, cartão, transferência, convênio, parcelamento | Engenharia | FIN-01.1 | N | MVP | Configuração de taxas por forma para cálculo de líquido |
| FIN-01.4 | Recibos | Recibo com dados do profissional/clínica para reembolso de plano e IR (sem diagnóstico) | Produto | FIN-01.1 | S | MVP | Recibo aceito em teste com 3 operadoras para reembolso; numeração sequencial |
| FIN-01.5 | Pacotes e créditos | Venda de pacotes de sessões pré-pagas com controle de saldo | Engenharia | FIN-01.1 | N | MVP | Saldo debitado a cada sessão concluída; alerta de saldo baixo |
| FIN-01.6 | Orçamentos | Orçamento com itens, validade, aprovação do paciente (assinatura) e conversão em cobranças | Produto | FIN-01.1, DOC-02.4 | N | F2 | Orçamento aprovado vira parcelas automaticamente |
| FIN-01.7 | Inadimplência e régua de cobrança | Lista de inadimplentes, régua de lembretes de pagamento por WhatsApp | Engenharia | FIN-01.1, COM-03.4 | N | F2 | Régua configurável; mensagem com tom não constrangedor validado por UX |
| FIN-02.1 | Contas a pagar | Despesas, fornecedores, recorrências, anexos de comprovante | Engenharia | NUC-01.1 | N | F2 | Lançamentos recorrentes gerados automaticamente |
| FIN-02.2 | Plano de contas e centros de custo | Plano de contas padrão para clínicas, centros de custo por unidade/profissional | Produto | FIN-02.1 | N | F2 | Plano padrão revisado por contador |
| FIN-02.3 | Fluxo de caixa | Realizado e projetado (recebíveis, convênios, despesas) | Engenharia | FIN-02.1, FIN-01.1 | N | F2 | Projeção de 90 dias com recebíveis de cartão e convênio |
| FIN-02.4 | Conciliação bancária | Importação OFX e Open Finance com conciliação sugerida | Engenharia | FIN-02.3 | N | F3 | ≥ 85% dos lançamentos conciliados automaticamente |
| FIN-03.1 | Regras de repasse | % ou valor fixo por profissional, serviço, convênio x particular, descontos de taxas | Produto | FIN-01.1 | N | MVP | Regras cobrem casos de 5 clínicas piloto sem planilha paralela |
| FIN-03.2 | Fechamento de repasse | Extrato por período, aprovação do gestor, demonstrativo para o profissional | Engenharia | FIN-03.1 | N | MVP | Profissional vê o próprio extrato; fechamento bloqueia alterações retroativas |
| FIN-03.3 | Repasse automático | Execução do repasse via split/subconta | Engenharia | FIN-03.2, PAG-03.1 | N | F2 | Repasse executado no dia configurado com comprovante |
| FIN-04.1 | Exportação contábil | Exportação para escritórios/sistemas contábeis (layouts comuns) | Engenharia | FIN-02.2, FIS-01.7 | N | F3 | Arquivo importado sem erro em ≥ 2 sistemas contábeis |

## 10. PAG — Pagamentos (Pix, cartão, split)

Partes: **01** Pix · **02** Cartão, link e boleto · **03** Split e conciliação

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| PAG-01.1 | Integração com PSP e conta da clínica | Gateway/PSP autorizado pelo BCB; onboarding KYC da conta/subconta da clínica | Engenharia | NUC-01.4 | S | MVP | Clínica ativa recebimentos em ≤ 2 dias úteis; dados KYC nunca armazenados fora do PSP além do necessário |
| PAG-01.2 | Cobrança Pix imediata | QR dinâmico e copia-e-cola vinculados à cobrança | Engenharia | PAG-01.1, FIN-01.1 | N | MVP | QR gerado em < 2 s; valor e identificação corretos |
| PAG-01.3 | Pix com vencimento | Cobrança com vencimento, juros e multa | Engenharia | PAG-01.2 | N | F2 | Cálculo de encargos conferido |
| PAG-01.4 | Baixa automática | Webhook de pagamento confirmado dá baixa na cobrança e dispara recibo/NFS-e | Engenharia | PAG-01.2, NUC-05.4 | N | MVP | Baixa em < 30 s após pagamento; idempotente a webhooks repetidos |
| PAG-01.5 | Devolução Pix | Estorno total/parcial com permissão específica e auditoria | Engenharia | PAG-01.4, NUC-04.1 | N | MVP | Só papel autorizado devolve; devolução reflete no caixa e no repasse |
| PAG-01.6 | Pix Automático | Recorrência via Pix Automático para mensalidades/pacotes | Engenharia | PAG-01.2 | N | F2 | Autorização do pagador registrada; cobrança recorrente executada |
| PAG-02.1 | Link de pagamento | Link (Pix + cartão) enviado por WhatsApp/e-mail com descrição genérica do serviço | Engenharia | PAG-01.2, PAG-02.2, COM-03.4 | N | MVP | Link expira; descrição nunca contém diagnóstico/procedimento sensível por padrão |
| PAG-02.2 | Cartão online | Crédito/débito online com tokenização no gateway (fora do escopo PCI da plataforma) | Engenharia | PAG-01.1 | S | MVP | Nenhum PAN armazenado/trafegado nos servidores da plataforma |
| PAG-02.3 | Maquininha integrada | POS/TEF com baixa automática no caixa | Engenharia | PAG-02.2, FIN-01.2 | N | F3 | Transação na maquininha baixa a cobrança sem digitação |
| PAG-02.4 | Boleto | Boleto registrado para pacotes e orçamentos | Engenharia | PAG-01.1 | N | F2 | Boleto pago dá baixa automática |
| PAG-03.1 | Split de pagamento | Divisão automática clínica/profissional por regra de repasse | Engenharia | PAG-01.1, FIN-03.1 | N | F2 | Split executado conforme regra em 100% dos casos de teste; KYC de profissionais |
| PAG-03.2 | Conciliação automática | Conciliação de Pix e cartão online (taxas, prazos, líquido) | Engenharia | PAG-01.4, PAG-02.2 | N | MVP | ≥ 90% dos recebimentos conciliados sem ação manual |
| PAG-03.3 | Antecipação de recebíveis | Antecipação via parceiro, com simulação de custo | Engenharia | PAG-03.2 | N | F3 | Simulação exibe custo efetivo total antes do aceite |
| PAG-03.4 | Chargeback e disputas | Gestão de contestações com envio de evidências | Engenharia | PAG-02.2 | N | F2 | Disputa notificada e respondida dentro do prazo do gateway |

## 11. FIS — Fiscal (NFS-e)

Partes: **01** NFS-e

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| FIS-01.1 | Integração com agregador de NFS-e | Provedor que cobre padrões municipais e NFS-e Nacional | Engenharia | NUC-01.4 | N | MVP | Emissão homologada nos 20 municípios prioritários (lista da Pesquisa de Mercado) |
| FIS-01.2 | Configuração fiscal | CNPJ/CPF, inscrição municipal, regime tributário, código de serviço (LC 116), alíquota ISS, certificado A1 | Engenharia | FIS-01.1, NUC-05.1 | S | MVP | Certificado A1 armazenado criptografado (cofre de segredos), nunca exibido após upload |
| FIS-01.3 | Emissão manual e automática | Emissão avulsa ou automática ao confirmar pagamento | Engenharia | FIS-01.2, PAG-01.4 | N | MVP | NFS-e emitida automaticamente em < 5 min após pagamento; falhas com motivo legível |
| FIS-01.4 | Cancelamento e substituição | Cancelar/substituir nota conforme regras do município | Engenharia | FIS-01.3 | N | MVP | Cancelamento reflete no financeiro e no portal |
| FIS-01.5 | Envio ao tomador | NFS-e enviada ao paciente e disponível no portal | Engenharia | FIS-01.3, POR-02.2 | N | MVP | PDF e XML disponíveis ao paciente |
| FIS-01.6 | Minimização na descrição | Descrição genérica do serviço (ex.: "consulta em saúde") sem CID/procedimento sensível por padrão | LGPD | FIS-01.3 | S | MVP | Validação impede termos clínicos sensíveis na descrição sem confirmação explícita |
| FIS-01.7 | Relatórios fiscais | Livro de notas, exportação para contador (XML em lote) | Engenharia | FIS-01.3 | N | F2 | Exportação mensal em 1 clique |
| FIS-01.8 | Emissão por profissional | Emissão em nome do profissional (PF/PJ próprio) em clínicas de coworking/repasse | Engenharia | FIS-01.2, FIN-03.1 | N | F2 | Nota emitida pelo CNPJ correto conforme regra de repasse |
| FIS-01.9 | Adequação à reforma tributária | Campos e regras de IBS/CBS conforme cronograma de transição | Produto | FIS-01.1 | N | F2 | Campos novos suportados na data de obrigatoriedade |

## 12. CNV — Convênios / TISS

Partes: **01** Cadastros · **02** Guias e autorizações · **03** Faturamento e glosas

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| CNV-01.1 | Operadoras e planos | Cadastro de operadoras (registro ANS), planos, contratos e regras por operadora | Engenharia | NUC-01.1 | N | F2 | Regras de prazo, versão TISS e campos obrigatórios por operadora |
| CNV-01.2 | Tabelas de procedimentos e preços | TUSS e tabelas de preço por operadora (CBHPM, própria) com vigência | Engenharia | CNV-01.1, INT-01.4 | N | F2 | Importação de tabela; preço correto pela vigência na data do atendimento |
| CNV-01.3 | Elegibilidade | Verificação de carteirinha/elegibilidade (manual ou webservice quando disponível) | Engenharia | PAC-01.5 | S | F2 | Status de elegibilidade registrado no agendamento |
| CNV-02.1 | Guia de consulta | Geração pré-preenchida a partir do atendimento | Engenharia | CNV-01.2, PRO-02.1 | S | F2 | Guia válida no schema XSD vigente |
| CNV-02.2 | Guia SP/SADT | Guia de serviços profissionais/SADT com múltiplos procedimentos/sessões | Engenharia | CNV-02.1 | S | F2 | Guia de 10 sessões de fisio gerada sem retrabalho |
| CNV-02.3 | Honorários e odontologia (GTO) | Guia de honorários individuais e guia de tratamento odontológico | Engenharia | CNV-02.1, PRO-03.2 | S | F2 | GTO gerada a partir do plano de tratamento |
| CNV-02.4 | Autorizações | Solicitação e controle de senhas, validade e saldo de sessões autorizadas | Engenharia | CNV-02.2 | S | F2 | Agendamento alerta quando sessões autorizadas acabam ou vencem |
| CNV-02.5 | Validação pré-envio | Validação de schema, campos obrigatórios e regras por operadora antes de fechar lote | Engenharia | CNV-02.1 | S | F2 | 100% das guias com erro detectável barradas antes do envio |
| CNV-02.6 | Token/biometria do beneficiário | Captura de token de atendimento quando exigido pela operadora | Engenharia | CNV-02.1 | S | F3 | Token registrado na guia para operadoras que exigem |
| CNV-03.1 | Lotes XML TISS | Geração de lote, hash, protocolo, envio por portal ou webservice | Engenharia | CNV-02.5 | S | F2 | Lote aceito em homologação por ≥ 3 operadoras |
| CNV-03.2 | Demonstrativos e conciliação | Importação de demonstrativo de retorno/pagamento e conciliação com o enviado | Engenharia | CNV-03.1, FIN-02.3 | S | F2 | Diferenças (glosas) identificadas automaticamente |
| CNV-03.3 | Glosas e recursos | Gestão de glosas por motivo, recurso de glosa e acompanhamento | Engenharia | CNV-03.2 | S | F2 | Taxa de glosa e recuperação em relatório; recurso gerado no padrão TISS |
| CNV-03.4 | Envio via webservice | Envio automático via webservices TISS das operadoras | Engenharia | CNV-03.1 | S | F3 | Envio sem acessar portal da operadora para ≥ 5 operadoras |
| CNV-03.5 | Atualização de versão TISS | Processo de atualização às novas versões do padrão ANS | Produto | CNV-03.1 | N | F2 | Nova versão suportada antes da data de obrigatoriedade |

## 13. EST — Estoque (estética, odonto e procedimentos)

Partes: **01** Estoque e rastreabilidade

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| EST-01.1 | Cadastro de produtos e insumos | Produto, unidade, fornecedor, registro ANVISA, custo | Engenharia | NUC-01.1 | N | F2 | Importação de catálogo por planilha |
| EST-01.2 | Entradas com lote e validade | Entrada por NF de compra (XML) com lote, validade e quantidade | Engenharia | EST-01.1 | N | F2 | Importação de XML de NF-e de compra preenche entrada |
| EST-01.3 | Baixa por procedimento | Ficha técnica/kit por procedimento com baixa automática ao concluir | Engenharia | EST-01.2, AGD-02.7 | N | F2 | Saldo atualizado ao concluir procedimento; FEFO sugerido |
| EST-01.4 | Rastreabilidade lote → paciente | Registro de lote usado em cada paciente (toxina, preenchedor, implante) | Engenharia | EST-01.3, PRO-02.1 | S | F2 | Consulta "quais pacientes receberam o lote X" em < 5 s (para recall) |
| EST-01.5 | Alertas | Estoque mínimo e vencimento próximo | Engenharia | EST-01.2 | N | F2 | Alerta 30/15/7 dias antes do vencimento |
| EST-01.6 | Inventário e ajustes | Contagem, ajustes com motivo e auditoria | Engenharia | EST-01.2 | N | F2 | Ajuste exige motivo; divergência reportada |
| EST-01.7 | Pedidos de compra | Sugestão e emissão de pedidos a fornecedores | Engenharia | EST-01.5 | N | F3 | Pedido gerado a partir do ponto de reposição |
| EST-01.8 | Custo e margem por procedimento | Custo de insumos + tempo para margem por procedimento | Produto | EST-01.3, FIN-03.1 | N | F3 | Margem exibida por procedimento e profissional |

## 14. CRM — Marketing, CRM e NPS

Partes: **01** NPS e satisfação · **02** Leads e funil · **03** Campanhas e relacionamento

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| CRM-01.1 | Pesquisa NPS pós-atendimento | NPS + comentário via WhatsApp após o atendimento | Produto | COM-03.4 | N | MVP | Taxa de resposta medida; 1 pesquisa por paciente a cada X dias (anti-fadiga) |
| CRM-01.2 | Painel NPS | NPS por profissional, unidade, período e comentários | Engenharia | CRM-01.1 | N | MVP | Painel atualizado em tempo real; comentários pesquisáveis |
| CRM-01.3 | Avaliação pública | Convite a promotores para avaliar no Google | Produto | CRM-01.1, INT-02.6 | N | F2 | Convite só para promotores e com opt-in de comunicação |
| CRM-01.4 | Tratamento de detratores | Alerta e tarefa para gestor contatar detratores | Engenharia | CRM-01.1 | N | F2 | Detrator gera tarefa em < 1 min |
| CRM-02.1 | Origem do paciente | Campo "como conheceu" e UTM do agendamento online | Produto | PAC-01.1, AON-01.2 | N | MVP | Origem registrada em 100% dos agendamentos online |
| CRM-02.2 | Captura de leads | Leads de WhatsApp, formulário e Instagram antes de virarem pacientes | Engenharia | COM-02.1 | N | F2 | Lead convertido em paciente preserva histórico |
| CRM-02.3 | Funil de oportunidades | Kanban (ex.: avaliação estética → orçamento → fechado) | Engenharia | CRM-02.2, FIN-01.6 | N | F2 | Taxa de conversão por etapa em relatório |
| CRM-03.1 | Segmentação com base legal | Segmentos para campanhas que só usam dados permitidos (sem dado clínico sem consentimento específico) | LGPD | PAC-02.2, LGP-01.2 | S | F2 | Segmentação por dado de saúde bloqueada sem consentimento de marketing específico; aprovado pelo Guardião |
| CRM-03.2 | Campanhas WhatsApp/e-mail | Disparos segmentados com templates de marketing, opt-in e descadastro | Engenharia | CRM-03.1, COM-01.3 | N | F2 | Descadastro processado em < 1 min; custo estimado antes do envio |
| CRM-03.3 | Retorno e reativação | Lembrete de retorno programado e reativação de inativos | Produto | CRM-03.2 | N | F2 | Pacientes reativados mensurados por campanha |
| CRM-03.4 | Programa de indicação | Indicação de pacientes com acompanhamento | Produto | CRM-02.1 | N | F3 | Indicações rastreadas até o primeiro atendimento |
| CRM-03.5 | Atribuição de receita | Receita atribuída por canal/campanha | Engenharia | CRM-03.2, REL-02.1 | N | F3 | Relatório de ROI por campanha |

## 15. REL — Relatórios e BI

Partes: **01** Operacionais · **02** Financeiros · **03** BI e analytics

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| REL-01.1 | Ocupação da agenda | Taxa de ocupação por profissional, sala, dia/horário | Engenharia | AGD-02.7 | N | MVP | Números batem com contagem manual em 3 clínicas piloto |
| REL-01.2 | No-show e cancelamentos | Taxa de falta/cancelamento por profissional, tipo, canal de confirmação | Engenharia | AGD-02.7, COM-03.2 | N | MVP | Comparativo antes/depois do bot disponível |
| REL-01.3 | Produção por profissional | Atendimentos por tipo, profissional e período | Engenharia | AGD-02.7 | N | MVP | Exportável em CSV/PDF |
| REL-02.1 | Faturamento | Faturamento por profissional, serviço, forma de pagamento, convênio | Engenharia | FIN-01.1 | N | MVP | Conferido com caixa e conciliação |
| REL-02.2 | DRE gerencial | Demonstrativo de resultado com plano de contas | Engenharia | FIN-02.2 | N | F2 | DRE validado por contador de clínica piloto |
| REL-02.3 | Recebíveis e inadimplência | Aging de recebíveis, inadimplência por paciente/convênio | Engenharia | FIN-01.7, CNV-03.2 | N | F2 | Aging 30/60/90 correto |
| REL-03.1 | Dashboard do gestor | Painel inicial com KPIs do dia e do mês (agenda, faturamento, no-show, NPS) | Produto | REL-01.1, REL-02.1, CRM-01.2 | N | MVP | Carrega em < 2 s; testado com 5 donos de clínica |
| REL-03.2 | Coortes e LTV | Retenção de pacientes por coorte, LTV, frequência | Engenharia | REL-02.1 | N | F2 | Coortes mensais com 24 meses |
| REL-03.3 | Construtor de relatórios | Relatórios customizados e exportação com permissões | Engenharia | REL-01.1, NUC-03.2 | S | F2 | Exportação de dado sensível exige permissão e é auditada |
| REL-03.4 | Indicadores clínicos agregados | Indicadores de desfecho/perfil epidemiológico anonimizados para a própria clínica | LGPD | LGP-03.7, PRO-02.1 | S | F3 | k-anonimato mínimo aplicado; aprovado pelo Guardião |
| REL-03.5 | Copiloto de gestão | Perguntas em linguagem natural sobre dados operacionais/financeiros | IA | REL-03.3, IA-05.1 | N | F3 | ≥ 90% de acerto em golden set de 100 perguntas; respeita permissões do usuário |

## 16. POR — Portal e app do paciente

Partes: **01** Acesso e identidade · **02** Funcionalidades · **03** Apps

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| POR-01.1 | Login sem senha | Acesso por OTP (WhatsApp/SMS/e-mail) vinculado ao cadastro na clínica | Engenharia | PAC-01.1, COM-04.2 | S | MVP | Login em < 30 s; proteção contra enumeração de contas |
| POR-01.2 | Dependentes | Responsável acessa dados de dependentes (menores/curatelados) | Engenharia | POR-01.1, PAC-01.2 | S | MVP | Acesso a dependente maior de idade revogado automaticamente na maioridade, salvo curatela |
| POR-01.3 | Identidade multi-clínica | Paciente atendido em várias clínicas da plataforma vê tudo em um só login, com segregação por controlador | LGPD | POR-01.1 | S | F3 | Clínica A nunca vê dados da clínica B; consentimento do paciente para unificação de login |
| POR-02.1 | Minhas consultas | Próximas consultas: confirmar, remarcar, cancelar, endereço, preparo | Engenharia | POR-01.1, AGD-03.2 | N | MVP | Ações refletem na agenda em tempo real |
| POR-02.2 | Meus documentos | Receitas, atestados, pedidos, recibos, NFS-e, com download | Engenharia | POR-01.1, DOC-03.1, FIS-01.5 | S | MVP | Documentos assinados baixáveis e verificáveis |
| POR-02.3 | Meus pagamentos | Cobranças pendentes (pagar com Pix/cartão) e histórico | Engenharia | POR-01.1, PAG-02.1 | N | MVP | Pagamento pelo portal dá baixa automática |
| POR-02.4 | Formulários pré-consulta | Anamnese prévia, questionários e escalas respondidos antes da consulta | Produto | POR-01.1, PRO-01.1 | S | F2 | Respostas aparecem no atendimento para o profissional revisar |
| POR-02.5 | Termos e consentimentos | Assinatura de termos e gestão (ver/revogar) de consentimentos | Engenharia | POR-01.1, LGP-01.2, DOC-02.4 | S | MVP | Revogação efetiva em < 1 min e registrada |
| POR-02.6 | Central de privacidade | Solicitações de direitos do titular (acesso, correção, portabilidade, informação) | LGPD | POR-01.1, LGP-02.1 | S | MVP | Solicitação gera protocolo e entra na fila da clínica com prazo |
| POR-02.7 | Resumo da consulta | Resumo/orientações em linguagem simples revisado e liberado pelo profissional | IA | IA-02.4, POR-01.1 | S | F2 | Nada é exibido ao paciente sem liberação explícita do profissional |
| POR-02.8 | Minha evolução | Gráficos (peso, medidas), plano alimentar, exercícios, metas terapêuticas | Produto | PRO-03.4, PRO-03.6 | S | F2 | Profissional escolhe o que fica visível ao paciente |
| POR-02.9 | Acesso à teleconsulta | Entrada na sala de espera a partir do portal | Engenharia | TEL-01.3 | S | F2 | Entrada em ≤ 2 toques a partir da notificação |
| POR-03.1 | PWA instalável | Portal mobile-first instalável na tela inicial | Engenharia | POR-02.1 | N | MVP | Lighthouse PWA aprovado; WCAG 2.1 AA |
| POR-03.2 | Apps nativos do paciente | iOS/Android com push e biometria do aparelho | Engenharia | POR-03.1 | S | F2 | Publicado nas lojas; dados locais criptografados |
| POR-03.3 | App do profissional | Agenda, prontuário resumido e escriba no celular | Engenharia | IA-01.1, AGD-02.1 | S | F2 | Escriba gravando pelo celular com mesma política de retenção; bloqueio por biometria |

## 17. IA — Inteligência artificial

Partes: **01** Escriba · **02** Assistentes clínicos · **03** Preditivo · **04** Chatbot · **05** Plataforma de IA

> Princípio inegociável: toda saída clínica da IA é **rascunho/sugestão** revisado e assumido por profissional habilitado. Nenhum dado identificável vai para treino sem anonimização e aprovação do Guardião LGPD.

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| IA-01.1 | Captura de áudio com consentimento | Gravação no navegador/celular iniciada só após registro de consentimento do paciente; indicador visível de gravação | Engenharia | LGP-01.2, PRO-02.1 | S | MVP | Gravação impossível sem consentimento registrado; áudio transmitido criptografado |
| IA-01.2 | Transcrição pt-BR clínica | STT com vocabulário clínico e diarização profissional/paciente | IA | IA-01.1, IA-05.1 | S | MVP | WER ≤ 12% em golden set clínico por nicho; diarização ≥ 90% |
| IA-01.3 | Rascunho estruturado | LLM gera rascunho mapeado aos campos do modelo de prontuário do nicho (SOAP, anamnese, evolução) | IA | IA-01.2, PRO-01.3, IA-05.2 | S | MVP | Golden set: ≥ 95% dos fatos relevantes capturados; taxa de alucinação ≤ 2% de afirmações; rascunho < 60 s |
| IA-01.4 | Tela de revisão | Revisão lado a lado, trechos de baixa confiança destacados, vínculo trecho → momento do áudio, aceitar/editar por campo | Produto | IA-01.3, PRO-02.3 | S | MVP | Registro não pode ser finalizado sem ação de revisão; edições medidas para métrica de aceitação |
| IA-01.5 | Retenção do áudio | Áudio e transcrição bruta descartados após finalização (padrão) ou retidos por prazo configurável com justificativa | LGPD | IA-01.3, LGP-03.3 | S | MVP | Job de descarte comprovado; política documentada no RIPD |
| IA-01.6 | Rascunho de documentos | Sugestão de receita, atestado e pedidos a partir da conversa | IA | IA-01.3, DOC-01.1 | S | F2 | Nada é emitido sem confirmação e assinatura do profissional |
| IA-01.7 | Personalização por profissional | Estilo, abreviações e nível de detalhe aprendidos com edições do próprio profissional | IA | IA-01.4, IA-05.5 | S | F2 | Taxa de aceitação do rascunho ↑ ≥ 10 p.p. após 20 consultas |
| IA-01.8 | Upload de gravação / offline | Processar gravação feita offline ou enviada depois | Engenharia | IA-01.2 | S | F3 | Gravação de 60 min processada em < 5 min |
| IA-02.1 | Resumo do histórico | Resumo pré-consulta com pontos-chave dos últimos atendimentos e citação das fontes | IA | PRO-02.7, IA-05.2 | S | MVP | Cada afirmação do resumo linkada ao registro de origem; avaliado por profissionais (≥ 4/5) |
| IA-02.2 | Sugestão de CID | Sugestões de CID-10 a partir do registro, com justificativa, sempre opcionais | IA | IA-01.3, INT-01.4 | S | MVP | Top-3 acerto ≥ 80% em golden set; nunca preenche automaticamente sem clique |
| IA-02.3 | Sugestão de TUSS | Sugestão de códigos TUSS para guias | IA | CNV-01.2, IA-01.3 | S | F2 | Top-3 acerto ≥ 85%; redução de glosa por código medida |
| IA-02.4 | Resumo para o paciente | Orientações em linguagem simples a partir do registro, revisadas pelo profissional | IA | IA-01.3 | S | F2 | Legibilidade adequada (índice de leiturabilidade pt-BR); liberação explícita do profissional |
| IA-02.5 | Auditoria pré-envio de guias | IA aponta inconsistências entre prontuário e guia antes do envio | IA | IA-02.3, CNV-02.5 | S | F3 | Redução de glosa ≥ 20% em clínicas piloto |
| IA-03.1 | Previsão de faltas | Score de risco de falta por agendamento com ação sugerida (reforço de confirmação, encaixe) | IA | AGD-02.7, COM-03.2 | N | F2 | AUC ≥ 0,75; features sem dado clínico; avaliação de viés documentada |
| IA-03.2 | Previsão de abandono | Pacientes com risco de abandonar tratamento/plano | IA | IA-03.1, PRO-03.7 | S | F3 | Precisão@50 ≥ 0,5 em piloto; uso só para ação de cuidado/relacionamento |
| IA-04.1 | NLU do bot | Intenções: agendar, remarcar, cancelar, preço, endereço, convênio aceito, falar com humano | IA | IA-05.1 | N | MVP | Acurácia de intenção ≥ 92% em conjunto de teste de conversas sintéticas/anônimas |
| IA-04.2 | FAQ com RAG da clínica | Base de conhecimento editável pela clínica (preparos, políticas) respondida pelo bot | IA | IA-04.1, IA-05.2 | N | F2 | Respostas citam a base; "não sei" quando fora da base |
| IA-04.3 | Guardrails do bot | Bot não dá orientação clínica; detecta urgência e orienta SAMU 192/pronto-socorro e alerta a clínica | IA | IA-04.1 | S | MVP | 100% dos casos do conjunto de red teaming de urgência roteados corretamente |
| IA-05.1 | Serviço de inferência | Gateway de modelos (LLM própria fine-tuned + fallback), roteamento, cotas e custo por tenant | IA | NUC-01.1 | S | MVP | Latência P95 dentro do SLO; custo por consulta medido; nenhum prompt/saída logado com PII |
| IA-05.2 | RAG isolado por tenant | Indexação vetorial por tenant/paciente com controle de acesso + base clínica curada de referência | IA | IA-05.1, NUC-03.3 | S | MVP | Teste prova que recuperação nunca cruza tenant/permissão |
| IA-05.3 | Avaliação contínua | Golden sets por nicho, métricas de qualidade, alucinação e viés; gate de release | IA | IA-05.1 | N | MVP | Nenhum modelo vai a produção sem passar no gate; relatório por versão |
| IA-05.4 | Pipeline de dados para treino | Coleta, anonimização, revisão e versionamento de datasets com aprovação do Guardião | IA | LGP-03.7 | S | F2 | Dataset com laudo de anonimização aprovado; rastreabilidade de origem e base legal |
| IA-05.5 | Loop de feedback | Edições do profissional como sinal de qualidade, com opt-in da clínica | IA | IA-01.4, LGP-01.2 | S | F2 | Opt-in registrado por tenant; sinais pseudonimizados |
| IA-05.6 | Monitoramento de IA | Drift, latência, custo, taxa de aceitação, incidentes de IA | IA | IA-05.1, NUC-05.5 | N | MVP | Painel com alertas; incidente de IA segue fluxo de incidentes |

## 18. INT — Integrações

Partes: **01** Saúde · **02** Gerais e ecossistema

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| INT-01.1 | Memed | Integração de prescrição Memed (SSO do prescritor, retorno da prescrição) | Engenharia | DOC-01.1 | S | F2 | Prescrição retorna ao prontuário em < 10 s |
| INT-01.2 | Laboratórios | Recebimento de resultados (HL7/FHIR/PDF) de laboratórios parceiros | Engenharia | PRO-02.5 | S | F2 | Resultado vinculado automaticamente ao paciente correto (match ≥ 99,9% ou fila manual) |
| INT-01.3 | RNDS | Credenciamento e envio de registros à Rede Nacional de Dados em Saúde (FHIR/BR Core) | Engenharia | PRO-02.4, LGP-03.2 | S | F3 | Envio homologado em ambiente de homologação do DATASUS |
| INT-01.4 | Bases de referência | CID-10/11, TUSS, medicamentos (ANVISA/CMED), TACO, feriados — com atualização versionada | Engenharia | — | N | MVP | Atualização sem downtime; versão da base registrada em cada uso |
| INT-01.5 | Validação de registro profissional | Consulta ao conselho profissional para validar registro ativo | Engenharia | NUC-02.6 | N | F2 | Validação para ≥ 3 conselhos com fallback manual |
| INT-01.6 | Equipamentos e imagens | Balanças, raio-x odontológico, visualizador DICOM | Engenharia | PRO-02.5 | S | F3 | Importação de imagens de ≥ 2 equipamentos comuns |
| INT-02.1 | Calendários externos | Sincronização com Google/Outlook mostrando só "ocupado" (sem dado do paciente) | Engenharia | AGD-02.2 | N | F2 | Evento externo bloqueia horário; nenhum nome de paciente sai da plataforma |
| INT-02.2 | API pública | REST + OAuth2 com escopos, rate limit e sandbox | Engenharia | NUC-03.2 | S | F3 | Documentação OpenAPI pública; escopos auditados |
| INT-02.3 | Webhooks | Eventos (agendamento criado, pagamento confirmado…) assinados para sistemas do cliente | Engenharia | INT-02.2, NUC-05.4 | N | F3 | Assinatura HMAC; retentativa com backoff |
| INT-02.4 | Marketplace | Catálogo de integrações de parceiros com consentimento do cliente | Produto | INT-02.2 | N | F3 | Parceiro passa por avaliação de segurança/LGPD antes de listar |
| INT-02.5 | Google Business Profile | Link de agendamento no perfil do Google | Engenharia | AON-01.1 | N | F2 | Botão "Agendar" ativo no perfil da clínica |

## 19. MIG — Migração / importação

Partes: **01** Importadores · **02** Processo de migração assistida

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| MIG-01.1 | Importador de planilha de pacientes | CSV/XLSX com mapeamento assistido de colunas e validação | Engenharia | PAC-01.3 | S | MVP | 10 mil pacientes importados em < 5 min com relatório de erros |
| MIG-01.2 | Importação de agenda | Agendamentos futuros (e histórico opcional) | Engenharia | MIG-01.1, AGD-02.2 | N | MVP | Agendamentos importados sem conflito ou com conflitos listados |
| MIG-01.3 | Importador concorrente A | Pacientes, agenda, prontuário, documentos e financeiro a partir da exportação do concorrente nº 1 (definir com Pesquisa) | Engenharia | MIG-01.1, PRO-02.1 | S | MVP | Migração de clínica piloto com 100% dos registros conferidos por amostragem |
| MIG-01.4 | Importador concorrente B | Idem para o concorrente nº 2 | Engenharia | MIG-01.3 | S | MVP | Idem |
| MIG-01.5 | Demais importadores | Outros concorrentes por demanda comercial | Engenharia | MIG-01.3 | S | F2 | ≥ 4 importadores adicionais |
| MIG-01.6 | Importação de anexos em massa | Arquivos/imagens associados ao paciente por convenção de nome ou mapa | Engenharia | MIG-01.1, NUC-05.2 | S | MVP | 50 GB importados com checagem de integridade (hash) |
| MIG-01.7 | Prontuário legado em PDF | Importar PDFs como histórico + extração estruturada opcional por IA | IA | MIG-01.6, IA-05.1 | S | F2 | Extração revisável; original preservado |
| MIG-02.1 | Dry-run e divergências | Simulação completa com relatório de divergências antes de efetivar | Engenharia | MIG-01.1 | S | MVP | Cliente aprova relatório antes da efetivação |
| MIG-02.2 | Rollback | Desfazer importação inteira com segurança | Engenharia | MIG-02.1 | S | MVP | Rollback total em < 30 min sem afetar dados criados depois (ou bloqueio explícito) |
| MIG-02.3 | Painel de migração assistida | Backoffice: status, responsável, checklist e comunicação com o cliente | Produto | ADM-01.1 | N | MVP | Tempo médio de migração medido; SLA ≤ 5 dias úteis |
| MIG-02.4 | Termo e segurança da migração | Instrução do controlador, canal seguro de envio de arquivos, descarte dos arquivos brutos | LGPD | MIG-02.3, LGP-01.4 | S | MVP | Arquivos brutos descartados em ≤ 30 dias após aceite; evidência registrada |

## 20. EXP — Exportação de dados

Partes: **01** Exportação

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| EXP-01.1 | Exportação total | Pacientes, agenda, prontuários, documentos, financeiro, anexos em CSV/JSON + PDFs, com dicionário de dados | Engenharia | PRO-02.1, FIN-01.1 | S | MVP | Exportação completa de clínica com 50 mil pacientes concluída em < 2 h; reimportável pelo próprio importador |
| EXP-01.2 | Exportação FHIR | Prontuário em FHIR R4 (perfis BR Core quando aplicável) | Engenharia | EXP-01.1 | S | F2 | Bundle válido no validador FHIR |
| EXP-01.3 | Prontuário individual | PDF/pacote do prontuário de um paciente para atender pedido do titular ou de outro profissional | Engenharia | PRO-02.7 | S | MVP | Gerado em < 1 min com assinatura/hash de integridade |
| EXP-01.4 | Exportação agendada | Exportação recorrente para storage do cliente (S3/Drive) | Engenharia | EXP-01.1 | S | F3 | Credenciais do destino em cofre; execução auditada |
| EXP-01.5 | Segurança da exportação | Só admin com MFA, link expirável, arquivo criptografado, auditoria e alerta | LGPD | EXP-01.1, NUC-02.3 | S | MVP | Exportação total gera alerta a todos os admins; link expira em 24 h |
| EXP-01.6 | Saída da plataforma | Fluxo de encerramento: exportação garantida, período de guarda, devolução/eliminação conforme contrato | LGPD | EXP-01.1, BIL-01.9 | S | MVP | Dados disponíveis para exportação por ≥ 90 dias após cancelamento; eliminação certificada |

## 21. BIL — Billing da plataforma (assinaturas dos clientes)

Partes: **01** Assinaturas e cobrança

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| BIL-01.1 | Catálogo de planos | Planos, preços públicos, add-ons e cotas (escriba, WhatsApp, NFS-e) | Produto | — | N | MVP | Preços do site e do sistema vêm da mesma fonte |
| BIL-01.2 | Trial | Trial de 14 dias sem cartão, com limites e conversão | Engenharia | BIL-01.1 | N | MVP | Conversão em ≤ 3 cliques; dados preservados ao converter |
| BIL-01.3 | Assinatura recorrente | Cobrança mensal/anual por cartão, Pix Automático ou boleto | Engenharia | BIL-01.1, PAG-01.1 | N | MVP | Renovação automática com recibo; falhas tratadas pelo dunning |
| BIL-01.4 | Medição de uso | Profissionais ativos, horas de escriba, conversas WhatsApp, NFS-e, armazenamento | Engenharia | IA-05.1, COM-01.5 | N | MVP | Medição conferida com logs de provedores (desvio < 1%); visível ao cliente |
| BIL-01.5 | Upgrade/downgrade | Mudança de plano com proporcionalidade | Engenharia | BIL-01.3 | N | MVP | Cálculo pro rata conferido; mudança imediata de cotas |
| BIL-01.6 | Faturas e NFS-e da plataforma | Nota fiscal da assinatura emitida automaticamente | Engenharia | BIL-01.3, FIS-01.1 | N | MVP | NFS-e emitida em 100% das cobranças pagas |
| BIL-01.7 | Dunning e suspensão | Régua de inadimplência; suspensão em modo somente leitura (nunca bloqueia prontuário nem exportação) | Produto | BIL-01.3 | N | MVP | Cliente suspenso ainda consulta prontuários e exporta dados |
| BIL-01.8 | Cupons e parceiros | Cupons, programa de indicação de clientes, parceiros/revendas | Engenharia | BIL-01.1 | N | F2 | Comissão de parceiro calculada automaticamente |
| BIL-01.9 | Cancelamento self-service | Cancelar sem falar com vendedor, com oferta de exportação | Produto | BIL-01.3, EXP-01.1 | N | MVP | Cancelamento em ≤ 3 cliques; pesquisa de motivo opcional |

## 22. ADM — Admin / backoffice

Partes: **01** Backoffice

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| ADM-01.1 | Console de tenants | Busca de clientes, status, plano, uso, saúde da conta | Engenharia | NUC-01.1, BIL-01.4 | N | MVP | Console não exibe nenhum dado clínico |
| ADM-01.2 | Impersonação auditada | Acesso de suporte à conta com autorização do cliente, tempo limitado, sem acesso a conteúdo clínico por padrão | LGPD | ADM-01.1, NUC-04.1 | S | MVP | Toda sessão de impersonação visível ao cliente na auditoria; conteúdo clínico mascarado |
| ADM-01.3 | Gestão de flags e rollout | Ativar recursos por tenant/plano, canário | Engenharia | NUC-05.7 | N | MVP | Rollback de flag em < 1 min |
| ADM-01.4 | Gestão de bases de referência | Publicação de atualizações de CID, TUSS, medicamentos, TACO | Engenharia | INT-01.4 | N | MVP | Atualização com dupla aprovação e versão |
| ADM-01.5 | Modelos globais por nicho | Publicação/versão de modelos de prontuário e documentos padrão | Produto | PRO-01.3 | N | MVP | Modelo novo disponível a todos os tenants sem deploy |
| ADM-01.6 | Métricas de negócio | MRR, churn, ativação, uso por módulo, North Star | Produto | BIL-01.4, NUC-05.5 | N | MVP | Métricas batem com o financeiro; North Star semanal automatizada |
| ADM-01.7 | Acesso privilegiado interno | Papéis internos mínimos, aprovação para acesso a produção, gravação de sessões administrativas | LGPD | ADM-01.1 | S | MVP | Nenhum colaborador com acesso permanente a dados de produção |
| ADM-01.8 | Health score de clientes | Pontuação de saúde da conta para Customer Success | Produto | ADM-01.6 | N | F2 | Score prevê churn com AUC ≥ 0,7 |

## 23. SUP — Suporte

Partes: **01** Atendimento ao cliente

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| SUP-01.1 | Central de ajuda | Base de conhecimento pública com artigos e vídeos por módulo e nicho | Produto | — | N | MVP | ≥ 80 artigos cobrindo todos os fluxos MVP |
| SUP-01.2 | Chat de suporte | Chat in-app com humanos, tickets, SLA | Engenharia | NUC-02.1 | N | MVP | 1ª resposta < 15 min em horário comercial; CSAT coletado |
| SUP-01.3 | Mascaramento em tickets | Detecção/mascaramento de dados de saúde e documentos enviados em tickets/prints | LGPD | SUP-01.2 | S | MVP | Prints com dados de paciente mascarados automaticamente ou bloqueados; retenção de tickets definida |
| SUP-01.4 | Onboarding guiado | Checklist de ativação, tours e dicas contextuais | Produto | NUC-01.2 | N | MVP | Ativação (PRD 5.2) ↑ medida em teste A/B |
| SUP-01.5 | Assistente de suporte por IA | Respostas com RAG na central de ajuda, escalonamento para humano | IA | SUP-01.1, IA-05.2 | N | F2 | ≥ 40% de deflexão com CSAT ≥ 85% |
| SUP-01.6 | Status page | Página pública de status e comunicação de incidentes | Engenharia | NUC-05.5 | N | F2 | Atualização automática por monitoramento |
| SUP-01.7 | Roadmap público e feedback | Coleta de sugestões e votação | Produto | — | N | F2 | Sugestões vinculadas a itens do roadmap |

## 24. LGP — LGPD (privacidade by design)

Partes: **01** Bases legais e consentimento · **02** Direitos do titular · **03** Governança e segurança

| ID | Microparte | Descrição curta | Frente dona | Dependências | Dado sensível | Fase | Critério de pronto |
|---|---|---|---|---|---|---|---|
| LGP-01.1 | Mapa de finalidades e bases legais | Matriz finalidade × dado × base legal (ex.: tutela da saúde, obrigação legal, consentimento para marketing/IA de treino) | LGPD | — | S | MVP | Matriz aprovada pelo Guardião e assessoria jurídica; refletida no código (enum de finalidades) |
| LGP-01.2 | Gestão de consentimentos | Consentimentos granulares e versionados (gravação/escriba, imagem, teleconsulta, marketing, compartilhamento) com evidência e revogação | Engenharia | LGP-01.1, PAC-01.1 | S | MVP | Toda funcionalidade dependente consulta o consentimento em tempo real; revogação efetiva imediatamente |
| LGP-01.3 | Políticas e termos versionados | Política de privacidade e termos da plataforma + modelos para as clínicas usarem com pacientes | LGPD | LGP-01.1 | N | MVP | Aceites registrados por versão; reaceite exigido em mudança material |
| LGP-01.4 | Contrato de operador (DPA) | Plataforma como operadora, clínica como controladora; lista pública de suboperadores | LGPD | LGP-01.3 | N | MVP | DPA aceito no onboarding; mudança de suboperador notificada |
| LGP-02.1 | Fluxo de direitos do titular | Recebimento de solicitações (acesso, correção, portabilidade, informação, revisão de decisão automatizada) roteadas ao controlador | Engenharia | POR-02.6, LGP-01.1 | S | MVP | Solicitação com protocolo, prazo e trilha de evidências |
| LGP-02.2 | Fila de atendimento da clínica | Painel para a clínica responder solicitações com modelos de resposta | Produto | LGP-02.1, EXP-01.3 | S | MVP | Prazos com alerta; resposta enviada pelo portal |
| LGP-02.3 | Eliminação e anonimização | Eliminação de dados não sujeitos a guarda obrigatória; anonimização onde aplicável; bloqueio de prontuário até fim da guarda | Engenharia | LGP-03.3 | S | MVP | Eliminação certificada; prontuário preservado pelo prazo legal com justificativa ao titular |
| LGP-03.1 | ROPA | Registro das operações de tratamento da plataforma, atualizado a cada feature | LGPD | LGP-01.1 | N | MVP | ROPA cobre 100% dos módulos MVP |
| LGP-03.2 | RIPD | Relatório de impacto do produto e por feature de alto risco (escriba, teleconsulta, IA preditiva, RNDS, marketing) | LGPD | LGP-03.1 | S | MVP | RIPD do produto e do escriba aprovados antes do lançamento |
| LGP-03.3 | Retenção e descarte | Tabela de temporalidade por tipo de dado (prontuário 20 anos, áudio do escriba, logs, tickets) com jobs automáticos | LGPD | LGP-01.1, NUC-05.4 | S | MVP | Jobs de descarte executados e evidenciados; nenhum dado retido além da tabela |
| LGP-03.4 | Gestão de incidentes | Detecção, resposta, avaliação de risco, comunicação à ANPD e titulares nos prazos regulamentares | LGPD | NUC-05.5, NUC-04.3 | S | MVP | Plano testado em simulação (tabletop) antes do lançamento |
| LGP-03.5 | Privacy review no SDLC | Checklist do Guardião em PRs que tocam dado sensível; threat modeling por módulo | LGPD | — | N | MVP | 100% dos PRs com flag S têm aprovação do Guardião |
| LGP-03.6 | Painel LGPD da clínica | Encarregado (DPO) da clínica, relatórios de consentimento, solicitações e acessos | Produto | LGP-02.2, NUC-04.2 | S | F2 | Clínica gera relatório de conformidade em 1 clique |
| LGP-03.7 | Anonimização e pseudonimização | Serviço de pseudonimização para analytics e anonimização (com laudo de risco de reidentificação) para treino de IA | LGPD | LGP-01.1 | S | F2 | Laudo de reidentificação aprovado; técnica documentada |
| LGP-03.8 | Transferência internacional | Avaliação e salvaguardas para suboperadores fora do Brasil (preferência por hospedagem nacional) | LGPD | LGP-01.4 | S | MVP | Nenhum dado de saúde sai do país sem salvaguarda aprovada pelo Guardião |
| LGP-03.9 | Conscientização dos usuários | Termo de confidencialidade e microtreinamento de privacidade para usuários das clínicas | Produto | LGP-01.3 | N | F2 | Aceite registrado por usuário com acesso clínico |

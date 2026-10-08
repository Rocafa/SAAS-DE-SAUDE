# Modelo de RIPD — Relatório de Impacto à Proteção de Dados Pessoais

> Base: LGPD art. 5º, XVII (definição), art. 38 (conteúdo mínimo: descrição dos tipos de dados coletados, metodologia de coleta e de garantia da segurança, análise do controlador quanto a medidas, salvaguardas e mecanismos de mitigação de risco), arts. 10, §3º e 55-J, XIII; orientações e perguntas frequentes da ANPD sobre RIPD (portal <https://www.gov.br/anpd> — link exato da página não verificado nesta revisão). A regulamentação específica de RIPD está na Agenda Regulatória ANPD 2025–2026 — revisar este modelo quando publicada.
>
> **Quem usa:** (a) **nós**, para tratamentos em que somos controladores (ex.: analytics de produto, datasets anonimizados, treino de IA) e como insumo às clínicas; (b) **clínicas**, como controladoras dos dados de pacientes (o RIPD é obrigação do controlador; nós apoiamos — art. 39). Não é aconselhamento jurídico; RIPDs de alto risco devem ser revisados por advogado especialista. ⚖️

---

## 0. Identificação

| Campo | Preenchimento |
|---|---|
| Nome do tratamento / funcionalidade | |
| Versão do RIPD / data | |
| Controlador (razão social, CNPJ) | |
| Operador(es) e suboperadores | |
| Encarregado (nome e contato) | |
| Responsável pela elaboração | |
| Partes consultadas (TI, jurídico, clínico, segurança) | |
| Motivo do RIPD | ☐ Dado sensível ☐ Larga escala ☐ Menores ☐ IA/decisão automatizada ☐ Transferência internacional ☐ Nova tecnologia ☐ Solicitação da ANPD ☐ Outro |

## 1. Necessidade do RIPD

Descreva por que o tratamento pode gerar riscos às liberdades civis e direitos fundamentais (art. 5º, XVII). Para dados de saúde, o RIPD é considerado necessário por padrão neste projeto.

## 2. Descrição do tratamento

### 2.1 Natureza
- Como os dados são coletados, armazenados, usados, compartilhados e eliminados (fluxograma anexo).
- Fontes dos dados (paciente, profissional, operadora, integrações).
- Uso de tecnologias novas (IA/LLM, biometria, reconhecimento de voz).

### 2.2 Escopo
| Item | Preenchimento |
|---|---|
| Categorias de titulares | Pacientes / responsáveis / profissionais / colaboradores |
| Inclui crianças e adolescentes? | |
| Categorias de dados pessoais | |
| Categorias de dados sensíveis (saúde, genético, biométrico, vida sexual, origem racial...) | |
| Volume estimado de titulares e registros | |
| Frequência | |
| Prazo de retenção e fundamento | |
| Abrangência geográfica / local de armazenamento | |
| Transferência internacional (país, mecanismo do art. 33) | |

### 2.3 Contexto
- Relação com o titular e expectativa razoável de uso.
- Grau de controle do titular sobre os dados.
- Preocupações públicas conhecidas, incidentes anteriores, padrões do setor (SBIS, normas de conselhos).

### 2.4 Finalidade
- Finalidades específicas e benefícios esperados (para titular, clínica, plataforma).

## 3. Base legal

| Operação | Base legal (art. 7º / art. 11) | Justificativa | Consentimento? Como é coletado e revogado |
|---|---|---|---|
| | | | |

Para legítimo interesse (somente dados não sensíveis): anexar teste de balanceamento (LIA).

## 4. Necessidade e proporcionalidade

- Os dados são os mínimos necessários? O que foi descartado do escopo?
- Há alternativa menos invasiva (anonimização, agregação, processamento local)?
- Como se garante qualidade e exatidão dos dados?
- Como os direitos do art. 18 são atendidos (acesso, correção, portabilidade, revogação, revisão do art. 20)?
- Como os titulares são informados (aviso de privacidade, aviso de IA)?
- Suboperadores: contratos, DPA, cláusulas-padrão ANPD.

## 5. Metodologia de coleta e garantia de segurança (art. 38, parágrafo único)

| Controle | Implementado? | Evidência |
|---|---|---|
| Criptografia em trânsito / repouso / campo | | |
| Isolamento multi-tenant (RLS + testes) | | |
| MFA, RBAC/ABAC, break-glass | | |
| Auditoria imutável | | |
| Backup e restauração testada | | |
| Hospedagem no Brasil | | |
| Gestão de segredos | | |
| Pentest / ASVS | | |
| Plano de resposta a incidentes | | |
| Controles específicos de IA (gateway, pseudonimização, revisão humana, sem treino no provedor) | | |

## 6. Identificação e avaliação de riscos

Escalas: **Probabilidade** 1 (remota) a 5 (quase certa); **Impacto** 1 (mínimo) a 5 (máximo). **Nível = P × I** (1–6 baixo, 8–12 médio, 15–25 alto).

| # | Risco ao titular | Fonte/causa | P | I | Nível |
|---|---|---|---|---|---|
| R1 | Acesso não autorizado a dados de saúde (vazamento entre tenants) | Falha de RLS/autorização | | | |
| R2 | Acesso indevido interno (colaborador da clínica ou nosso) | Perfis amplos, ausência de vínculo | | | |
| R3 | Vazamento por suboperador (LLM, WhatsApp, vídeo) | Retenção/treino no provedor, incidente | | | |
| R4 | Perda/indisponibilidade do prontuário | Ransomware, falha de backup | | | |
| R5 | Uso para finalidade incompatível (marketing, treino de IA, venda) | Desvio de finalidade | | | |
| R6 | Reidentificação de dados "anonimizados" | Anonimização fraca de texto livre | | | |
| R7 | Dano por saída incorreta/enviesada de IA | Alucinação, viés, falta de revisão | | | |
| R8 | Exposição de condição de saúde por mensagens | Conteúdo clínico em WhatsApp/SMS/NFS-e | | | |
| R9 | Discriminação / decisão automatizada sem revisão | Scores sem humano | | | |
| R10 | Tratamento indevido de dados de menores | Falta de consentimento do responsável | | | |
| R… | | | | | |

## 7. Medidas de mitigação

| Risco | Medida(s) | Responsável | Prazo | Risco residual (P × I) | Aceito? (quem) |
|---|---|---|---|---|---|
| R1 | | | | | |

## 8. Conclusão e aprovação

- Risco residual global: ☐ Baixo ☐ Médio ☐ Alto
- Se **alto** após mitigação: não iniciar o tratamento sem decisão de N0 e parecer jurídico; avaliar consulta à ANPD. ⚖️
- Parecer do encarregado:
- Aprovação do controlador (nome, cargo, data):
- Ciência do Guardião LGPD & Segurança (para tratamentos da plataforma):

## 9. Revisão

| Data | Mudança | Responsável |
|---|---|---|
| | | |

Revisar o RIPD: a cada mudança relevante (novo dado, nova finalidade, novo suboperador, troca de modelo de IA), após incidente, e no mínimo **anualmente**.

---

### Anexo A — RIPDs que a plataforma deve manter desde o início

1. Plataforma base (agenda + prontuário + portal) — insumo para clínicas.
2. Comunicação por WhatsApp (suboperador Meta/BSP, transferência internacional).
3. Teleconsulta (vídeo, gravação opcional).
4. Prescrição e documentos digitais (ICP-Brasil).
5. Faturamento TISS e pagamentos Pix.
6. IA assistiva (gateway + provedor LLM).
7. Datasets anonimizados / treino de LLM (**nós como controladores** — alto risco).
8. Analytics de produto e benchmarks.

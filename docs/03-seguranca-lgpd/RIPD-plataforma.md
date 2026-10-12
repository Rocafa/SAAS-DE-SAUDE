# RIPD da plataforma base (agenda + prontuário + portal + comunicação)

> **Rascunho para o advogado (D8)**, preenchido a partir do [RIPD-modelo.md](RIPD-modelo.md) (Anexo A, item 1). ⚖️ = precisa de validação jurídica.
> Autor: agente `guardiao-lgpd` · Versão 0.1 · 10/10/2026 · **Status: rascunho, não aprovado.** Nenhum dado real foi usado; os volumes são **ESTIMATIVAS** do plano de piloto.
> **Para quem serve:** (a) é o insumo que entregamos a cada clínica, que é a controladora e dona do RIPD do seu tratamento (LGPD art. 38); (b) documenta as decisões que tomamos como operadora (art. 39) e as poucas em que somos controladora.
> Fora do escopo deste RIPD (cada um terá o seu, Anexo A do modelo): WhatsApp (item 2), teleconsulta (3), prescrição/ICP-Brasil (4), TISS e Pix (5), IA assistiva (6), datasets e treino (7), analytics (8).

## 0. Identificação

| Campo | Preenchimento |
|---|---|
| Tratamento | Gestão clínica pela plataforma: cadastro de pacientes, agenda, prontuário eletrônico por especialidade, financeiro básico, portal do paciente, exportação e eliminação |
| Versão / data | 0.1 · 10/10/2026 |
| Controladora | Cada clínica ou profissional autônomo contratante (tenant) |
| Operadora | A plataforma (razão social e CNPJ a definir) ⚖️ |
| Suboperadores previstos | AWS (hospedagem em sa-east-1), provedor de e-mail transacional, Sentry ou equivalente (erros, sem conteúdo clínico). Lista pública: [DPA, Anexo III](dpa-minuta.md) |
| Encarregado | A nomear (J4 do relatório da rodada 7) |
| Elaboração | Guardião LGPD; consultar Engenharia, Produto e advogado |
| Motivo do RIPD | ☒ Dado sensível ☒ Larga escala (potencial) ☒ Menores ☐ IA (RIPD próprio) ☒ Transferência internacional (suboperadores de suporte) ☒ Nova tecnologia (SaaS multi-tenant) |

## 1. Necessidade do RIPD

Os dados são de **saúde** (dado sensível, LGPD art. 5º, II), incluem **crianças e adolescentes** (pediatria, TEA) e, somados entre clínicas, chegam a **larga escala**. A Res. CD/ANPD 2/2022 (art. 4º) trata isso como **tratamento de alto risco**, e por isso o regime simplificado de agente de pequeno porte não se aplica. Neste projeto, o RIPD é obrigatório por padrão para qualquer tratamento de dado de saúde.

## 2. Descrição do tratamento

### 2.1 Natureza (ciclo de vida)

```
coleta (recepção / profissional / paciente no portal / importação de outro sistema)
  └─► armazenamento (Postgres em sa-east-1, isolado por clínica com RLS; anexos no S3 cifrado)
       └─► uso (agenda, atendimento, evolução, financeiro, relatórios da clínica)
            ├─► compartilhamento (só por ação da clínica: exportação, documentos ao paciente)
            └─► eliminação (prazo legal vencido + aprovação da clínica, ou fim do contrato: retencao-e-descarte.md)
```

- **Fontes:** paciente (presencial ou portal), profissional, recepção, importação de outro sistema (migração).
- **Tecnologia nova relevante:** SaaS multi-tenant. O principal risco técnico é o vazamento entre clínicas, já coberto por RLS forçado + `withTenant` + teste de isolamento no CI (fato do repositório, relatório geral §6).

### 2.2 Escopo

| Item | Preenchimento |
|---|---|
| Titulares | Pacientes; responsáveis legais; profissionais; colaboradores da clínica |
| Crianças e adolescentes? | **Sim.** Conta gerida pelo responsável; ver Lei 15.211/2025 (ECA Digital) ⚖️ |
| Dados pessoais | Nome, CPF (quando exigido), data de nascimento, contato, endereço, convênio, dados de cobrança |
| Dados sensíveis | Saúde (anamnese, evolução, diagnósticos, exames, anexos, registros psicológicos); eventualmente vida sexual e origem racial quando clinicamente relevantes |
| Volume | ESTIMATIVA do piloto: 30 clínicas × ~500 pacientes ativos = ~15 mil titulares; potencial de centenas de milhares após o lançamento |
| Frequência | Contínua (todo atendimento) |
| Retenção | Prontuário 20 anos (psicologia: mínimo 5); demais em [retencao-e-descarte.md](retencao-e-descarte.md) |
| Local | Brasil (AWS sa-east-1), inclusive backups |
| Transferência internacional | Só de **metadados técnicos** para ferramentas de erro/monitoramento, se forem estrangeiras, com cláusulas-padrão da ANPD (Res. 19/2024). **Nenhum conteúdo clínico sai do Brasil** neste tratamento ⚖️ |

### 2.3 Contexto

- **Expectativa do paciente:** que o prontuário fique sob sigilo profissional e só seja visto por quem o atende. Por isso nosso suporte não acessa prontuário sem chamado da clínica e registro (*break-glass*).
- **Controle do titular:** baixo e indireto. Os direitos do art. 18 são exercidos perante a clínica; o portal oferece acesso e cópia.
- **Contexto do setor:** só 30% dos estabelecimentos têm DPO e 42% têm política de segurança (TIC Saúde, citado em [relatório executivo de mercado](../01-mercado/relatorio-executivo-mercado.md)). O mercado tem histórico de prontuário bloqueado por inadimplência, e isso é atacado pelas garantias G1–G3.

### 2.4 Finalidade

Prestar à clínica o serviço contratado de gestão e registro clínico. **Nenhuma finalidade própria** da plataforma sobre dados de pacientes (DPA cl. 10: treino de IA vedado por padrão).

## 3. Base legal (a confirmar com o advogado ⚖️)

A base legal é **da clínica** (controladora); a operadora segue as instruções dela.

| Operação | Base legal | Justificativa |
|---|---|---|
| Prontuário, evolução, anexos | Art. 11, II, "f" (tutela da saúde, por profissional ou serviço de saúde) e "a" (obrigação legal de manter prontuário) | Lei 13.787/2018; normas dos conselhos |
| Agenda e lembretes por e-mail | Art. 7º, V (execução de contrato com o paciente) ou art. 11, II, "f" | Organização do atendimento |
| Financeiro e NFS-e / Receita Saúde | Art. 7º, II (obrigação legal fiscal) e V | CTN; IN Receita Saúde |
| Portal do paciente | Art. 7º, V e art. 18 (atendimento a direitos) | — |
| Exportação total pela clínica | Art. 18, V (portabilidade) e instrução da controladora | G2 |
| Logs de acesso (nós como controladora) | Art. 7º, II (Marco Civil, art. 15) | — |
| Marketing da clínica aos pacientes | **Consentimento** separado (art. 7º, I), fora do escopo padrão | Módulo próprio, desligado por padrão |

## 4. Necessidade e proporcionalidade

- **Minimização:** CPF só quando exigido (NFS-e, convênio, receita); nenhum dado clínico em e-mail, notificação ou descrição de cobrança ([integracoes.md](../04-arquitetura/integracoes.md)).
- **Alternativa menos invasiva:** não há para o prontuário em si (obrigação legal). Para relatórios da clínica, usamos agregados.
- **Qualidade:** edição de prontuário gera nova versão (não sobrescreve), com autoria e horário.
- **Direitos do art. 18:** acesso e cópia pelo portal; correção pela clínica (com histórico); portabilidade pela exportação (G2); revogação de consentimento onde a base é consentimento.
- **Transparência:** modelo de aviso de privacidade da clínica, editável, oferecido pelo produto.
- **Suboperadores:** DPA com obrigações equivalentes; lista publicada; aviso de 30 dias para inclusões.

## 5. Medidas de segurança (art. 38, parágrafo único)

Estado na `main` em 10/10/2026 (fatos do repositório; ver relatório da rodada 7, §1):

| Controle | Implementado? | Evidência / pendência |
|---|---|---|
| Criptografia em trânsito | Parcial | TLS na borda previsto; infraestrutura de produção ainda não existe |
| Criptografia em repouso | 📋 | RDS/S3 cifrados com KMS previstos no Terraform (I2) |
| Criptografia de campo por clínica | ❌ | S5; necessária também para o expurgo de backup ([retencao-e-descarte.md](retencao-e-descarte.md) §4.1) |
| Isolamento multi-tenant | ✅ | RLS forçado + `withTenant` + teste de isolamento no CI; 72 ataques automatizados (PRs #10/#11) |
| MFA, RBAC, *break-glass* | ❌ | Bloqueado pela D4 |
| Auditoria append-only | Parcial | `audit_log` existe; falta encadeamento de hash e interceptor geral (S6) |
| Backup e restauração testada | Parcial | Restauração testada localmente (PR #11); na AWS ainda não |
| Hospedagem no Brasil | 📋 | Decidido (sa-east-1); não montado |
| Gestão de segredos | Parcial | Nada no git (CI com varredura); Secrets Manager previsto |
| Pentest / ASVS | Parcial | ZAP no CI; pentest externo pendente (S8) |
| Plano de resposta a incidentes | ✅ rascunho | [plano-resposta-incidentes.md](plano-resposta-incidentes.md) |

## 6. Riscos (P × I, escala do modelo)

| # | Risco ao titular | Causa | P | I | Nível |
|---|---|---|---|---|---|
| R1 | Vazamento entre clínicas | Falha de RLS/autorização em código novo | 2 | 5 | **10 médio** |
| R2 | Acesso indevido interno (clínica ou plataforma) | Perfis amplos; suporte sem controle | 3 | 4 | **12 médio** |
| R3 | Vazamento por suboperador | Ferramenta de erro recebendo payload clínico | 2 | 4 | 8 médio |
| R4 | Perda ou indisponibilidade do prontuário | Ransomware, falha de backup | 2 | 5 | **10 médio** |
| R5 | Uso para outra finalidade | Pressão comercial (treino de IA, benchmark) | 2 | 5 | **10 médio** |
| R8 | Exposição de condição de saúde por mensagem | Texto clínico em e-mail ou descrição de cobrança | 3 | 3 | 9 médio |
| R10 | Dado de menor tratado sem o responsável | Cadastro sem vínculo de responsável | 2 | 4 | 8 médio |
| R11 | Exfiltração pela exportação total | Conta de admin invadida | 2 | 5 | **10 médio** |
| R12 | Dado "eliminado" sobrevivendo em backup | Backup imutável de 12 meses | 4 | 2 | 8 médio |
| R13 | Prontuário perdido no fim do contrato | Clínica não exporta e a eliminação ocorre | 2 | 5 | **10 médio** |

## 7. Mitigação

| Risco | Medidas | Dono | Prazo | Residual |
|---|---|---|---|---|
| R1 | Teste de isolamento obrigatório para toda tabela nova (DoD); revisão do Guardião em PR com flag S; pentest externo | Engenharia | Antes do piloto | 1×5 = 5 baixo |
| R2 | RBAC + MFA; *break-glass* com chamado e revisão; termo de confidencialidade; alertas de leitura anômala | Engenharia + Sócios | M0 | 2×4 = 8 médio |
| R3 | Scrubbing no SDK de erros; preferência por ferramenta no Brasil; cláusulas-padrão | Engenharia + Advogado | Antes do piloto | 1×4 = 4 baixo |
| R4 | PITR + backup imutável + teste de restauração; RPO ≤ 15 min, RTO ≤ 4 h | DevOps | Antes do piloto | 1×5 = 5 baixo |
| R5 | DPA cl. 10 (vedação padrão); feature de controlador exige RIPD + parecer + N0 | Sócios + Guardião | Contrato | 1×5 = 5 baixo |
| R8 | Textos neutros + link autenticado; teste de template sem campo clínico | Produto | MVP | 1×3 = 3 baixo |
| R10 | Paciente menor exige vínculo com responsável; portal do menor gerido pelo responsável | Produto | MVP | 1×4 = 4 baixo |
| R11 | Controles da G2/EXP-01.5 (MFA recente, aprovação do RT, link não-portador, "não fui eu", janela) | Engenharia | Antes da rota de exportação | 1×5 = 5 baixo |
| R12 | Declarar o prazo (opção B) e implantar a criptografia por clínica (opção C) | Engenharia | C no M0 | 2×2 = 4 baixo |
| R13 | Avisos D-30/D-7/D-1; custódia opcional; registro de exportação oferecida | Produto + Engenharia | MVP | 1×5 = 5 baixo |

## 8. Conclusão (proposta)

- **Risco residual global: médio**, puxado por R2 (acesso interno), até existirem login, RBAC e MFA (D4).
- **Não iniciar o piloto com dado real** enquanto R1, R2, R4 e R11 estiverem sem as medidas acima, o DPA não estiver assinado e o pentest externo não tiver sido feito (coerente com o Gate LGPD do M1 no roadmap).
- Parecer do encarregado: _pendente (encarregado não nomeado)_.
- Aprovação da controladora: _cada clínica, no onboarding do piloto_.
- Ciência do Guardião: rascunho elaborado pelo próprio Guardião; **precisa de revisão independente** (o Guardião não aprova o próprio trabalho).

## 9. Revisão

| Data | Mudança | Responsável |
|---|---|---|
| 10/10/2026 | Versão 0.1 (rascunho) | Guardião LGPD |

Revisar ao implantar login/RBAC (D4), ao montar a AWS, a cada suboperador novo e antes do piloto.

## Fontes (consultadas em 10/10/2026)

- LGPD, arts. 5º, 7º, 11, 18, 37–39: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm>
- Res. CD/ANPD 2/2022 (agentes de pequeno porte e tratamento de alto risco): <https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd>
- Res. CD/ANPD 19/2024 (transferência internacional): mesma página de regulamentações da ANPD
- Lei 13.787/2018: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm>
- Lei 15.211/2025 (ECA Digital): ver [README.md](README.md), linha 29 do mapa regulatório

# Papéis: controlador x operador

> Não é aconselhamento jurídico. ⚖️ = validar com advogado especialista. Base: LGPD arts. 5º (VI, VII, IX), 37–42; Guia Orientativo da ANPD sobre Agentes de Tratamento e Encarregado.

## 1. Regra geral

| Agente | Quem | Por quê |
|---|---|---|
| **Controlador** | **A clínica / o profissional autônomo** (tenant) | Decide **por que** e **como** tratar os dados dos pacientes: atendimento, prontuário, cobrança, lembretes. É quem tem relação com o paciente e o dever legal de guarda do prontuário. |
| **Operador** | **Nós (a plataforma SaaS)** | Tratamos os dados **em nome** da clínica e **segundo suas instruções** (art. 5º, VII e art. 39). |
| **Suboperadores** | Nuvem (AWS sa-east-1), provedor de WhatsApp (Meta / BSP), vídeo, e-mail/SMS, assinatura ICP-Brasil em nuvem, provedor de LLM, NFS-e, backup | Contratados por nós com autorização (geral ou específica) da clínica e com obrigações equivalentes às nossas. |
| **Controladores independentes** | Gateway/PSP de Pix, operadoras de plano (TISS), farmácias que validam receita, autoridade sanitária | Têm finalidade própria e obrigações legais próprias. |
| **Profissional dentro da clínica** | Não é agente de tratamento separado quando atua como empregado/preposto da clínica; é agente quando é **autônomo** que usa a clínica como espaço ("coworking"). | Configurar o tenant corretamente: "clínica" x "profissional autônomo" x "rede". ⚖️ |

### Situações de **co-controladoria** dentro do tenant

Clínicas com profissionais autônomos que alugam sala podem ter cada profissional como controlador do **seu** prontuário e a clínica como controladora de agenda/financeiro. O produto deve permitir **prontuário com titularidade por profissional** e regras de compartilhamento explícitas. ⚖️

## 2. Quando **nós** viramos controladores

| Situação | Somos | Consequência |
|---|---|---|
| Dados cadastrais e de uso das **contas dos profissionais/usuários** (login, cobrança da assinatura, suporte, telemetria do produto) | **Controlador** | Política de privacidade própria; base legal: contrato (art. 7º, V), legítimo interesse (art. 7º, IX) para segurança e melhoria, obrigação legal (fiscal). |
| Logs de segurança e antifraude da plataforma | **Controlador** (em regra) | Marco Civil art. 15 (6 meses mínimo); art. 7º, II e IX. |
| Marketing nosso para os profissionais (leads, newsletter) | **Controlador** | Consentimento ou legítimo interesse com opt-out. |
| **Uso de dados de pacientes para treinar/fine-tunar LLM, gerar benchmarks, analytics de mercado ou qualquer finalidade própria** | **Controlador** (desvio de finalidade em relação ao papel de operador) | Precisamos de **base legal própria** para dado sensível (art. 11) e de transparência. Se fizermos isso sem autorização, respondemos como controlador e solidariamente (art. 42, §1º, I). ⚖️ |
| **Anonimização** de dados para criar dataset | O ato de anonimizar ainda é tratamento de dado pessoal: precisa de instrução/autorização contratual da clínica (como operador) **ou** de base própria (como controlador). | Depois de anonimizado de forma robusta (art. 12), o dataset sai do escopo da LGPD; antes disso, não. |
| Atendimento direto ao paciente por canal nosso (ex.: app/marketplace "encontre um profissional") | **Controlador** | Produto distinto; exige política própria e RIPD. |
| Pedido de autoridade (ordem judicial) sobre dados da clínica | Operador — encaminhar à clínica, salvo vedação legal | Procedimento jurídico definido. |

**Regra do Guardião:** qualquer feature que use dados de pacientes para algo que não seja **prestar o serviço contratado para aquela clínica** é "feature de controlador" e exige RIPD + parecer jurídico + aprovação N0.

## 3. Contrato de operador (DPA) — cláusulas-chave do modelo

> Anexo ao contrato SaaS (Termos de Uso B2B). Redação final com advogado. ⚖️

1. **Objeto e instruções documentadas** — tratamos dados exclusivamente para prestar os serviços descritos (agenda, prontuário, comunicação, faturamento, teleconsulta, receita, IA assistiva), conforme instruções da clínica, que são o contrato, a configuração do produto e instruções escritas posteriores. Instrução ilícita: o operador avisa e pode recusar.
2. **Descrição do tratamento (Anexo I)** — categorias de titulares (pacientes, responsáveis legais, profissionais, colaboradores), categorias de dados (identificação, contato, dados de saúde, dados de menores, imagem/voz em teleconsulta, dados financeiros), finalidades, duração, localização (Brasil).
3. **Confidencialidade e sigilo** — todos os colaboradores com termo de confidencialidade e ciência do sigilo profissional; acesso a dado clínico somente via **acesso emergencial (break-glass)** com chamado aberto pela clínica, registro e revisão.
4. **Segurança (art. 46)** — Anexo II com medidas mínimas (criptografia em trânsito/repouso, isolamento de tenant, MFA, logs de auditoria, backup, pentest anual, gestão de vulnerabilidades). Medidas não podem ser reduzidas unilateralmente.
5. **Suboperadores** — lista publicada (nome, serviço, país, mecanismo de transferência); autorização geral com **aviso prévio de 30 dias** para inclusões, com direito de objeção e rescisão sem multa; contratos com obrigações equivalentes; responsabilidade pelo suboperador.
6. **Transferência internacional** — só com mecanismo do art. 33 e Res. CD/ANPD 19/2024 (cláusulas-padrão da ANPD, texto integral). Hospedagem primária no Brasil.
7. **Incidentes** — aviso à clínica **sem demora indevida e em até 24 horas** após confirmação de que o incidente pode afetar dados pessoais, com informações mínimas do art. 48, §1º e da Res. 15/2024, atualizações contínuas e apoio para a clínica cumprir os **3 dias úteis** perante ANPD e titulares.
8. **Apoio aos direitos dos titulares (art. 18)** — funcionalidades no produto (exportação, correção, portabilidade em formato interoperável) e encaminhamento em até **2 dias úteis** de pedidos recebidos diretamente por nós.
9. **Apoio a RIPD e a auditorias** — fornecemos informações para o RIPD da clínica; relatórios de auditoria (ex.: ISO 27001/SOC 2, pentest resumido) mediante NDA; auditoria in loco com aviso razoável.
10. **Uso de dados para IA e melhoria do produto** — **padrão: vedado** usar dados de pacientes para treinar modelos ou para finalidades próprias. Uso permitido somente: (a) dados de **telemetria técnica sem conteúdo clínico**; (b) dados **anonimizados** conforme procedimento do [lgpd-e-ia.md](lgpd-e-ia.md), mediante **opt-in expresso da clínica**, revogável, com relatório de anonimização disponível. Nunca dados identificáveis ou pseudonimizados para treino de modelo compartilhado entre clientes. ⚖️ (art. 11, §4º)
11. **Provedores de LLM** — vedado que o provedor retenha (zero/curta retenção contratual) ou treine com os dados; processamento preferencialmente no Brasil; listado como suboperador.
12. **Retenção e devolução no término** — ao fim do contrato: exportação completa (prontuário em formato aberto + PDFs assinados + trilha de auditoria) por **90 dias**; depois, eliminação certificada, **exceto** se a clínica optar por contratar **custódia de guarda legal** (prontuário até completar 20 anos do último registro). A clínica continua responsável pela guarda legal. ⚖️
13. **Responsabilidade e limitação** — limitação de responsabilidade não pode afastar a responsabilidade legal (art. 42–45); seguro cyber recomendado.
14. **Encarregados** — contatos dos encarregados de ambas as partes.
15. **Lei e foro** — lei brasileira; foro definido.

## 4. Responsabilidades da clínica (que o produto deve facilitar)

- Informar os pacientes (aviso de privacidade da clínica — o produto oferece modelo editável).
- Coletar consentimentos quando a base for consentimento (marketing, gravação de teleconsulta, uso de IA quando exigido pelo conselho, uso de imagem).
- Nomear encarregado (ou canal, se ATPP elegível).
- Definir perfis de acesso dos colaboradores.
- Elaborar RIPD (modelo em [RIPD-modelo.md](RIPD-modelo.md)).
- Comunicar incidentes à ANPD e aos titulares (com nosso apoio).

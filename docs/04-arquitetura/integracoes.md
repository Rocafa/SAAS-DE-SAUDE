# Integrações externas

> Toda integração fica atrás de uma **interface de domínio** (port) com um ou mais **adapters** — ex.: `PaymentGateway` com `AsaasAdapter`, `EfiAdapter`. Chamadas de saída rodam em **workers BullMQ** (retry com backoff, idempotência, dead-letter). Webhooks de entrada têm assinatura verificada e são persistidos em `webhook_event` antes do processamento.
>
> **Regra LGPD comum a todas:** cada fornecedor é **operador** (ou suboperador) — exige contrato/DPA com cláusulas de confidencialidade, segurança, suboperadores e localização dos dados; registro no inventário de dados (ROPA) e, se houver processamento fora do Brasil, base para transferência internacional (art. 33 + Res. CD/ANPD nº 19/2024). Enviar **apenas o mínimo** necessário. Avaliações de fornecedor ficam com o Guardião LGPD.
>
> Nomes de fornecedores abaixo são candidatos; preços, SLAs e certificações devem ser confirmados pela frente de Pesquisa antes da escolha.
>
> **Atualizado em 29/10/2026** com a pesquisa da [rodada 7](../relatorios/2026-10-10-rodada-7-necessidades-producao.md) §3 (dívida da §7 daquele relatório, dono: Engenharia): cobrança do WhatsApp por mensagem e em BRL, Pix Automático, NFS-e no padrão nacional com IBS/CBS, Receita Saúde por arquivo de lote, SNCR e TISS 04.03.00. Cada afirmação está marcada como **FATO** ou **A CONFIRMAR**; as fontes completas estão no relatório.

## 1. WhatsApp Business Cloud API (Meta)

- **Propósito:** confirmação e lembrete de consulta, link de agendamento online, link de teleconsulta, envio de link de pagamento, atendimento.
- **Como:** templates aprovados pela Meta (mensagens iniciadas pela empresa); janela de 24 h para mensagens livres; webhooks de status/resposta.
- **Alternativas:** BSPs oficiais (Twilio, Gupshup, 360dialog, Blip, Zenvia). **Não** usar APIs não oficiais (risco de banimento e de segurança).
- **Cuidados LGPD:**
  - Dados trafegam por infraestrutura da Meta (fora do Brasil) → transferência internacional documentada.
  - **Nenhum conteúdo clínico** em mensagem (sem diagnóstico, exame, medicamento, especialidade sensível como "psiquiatria" quando evitável). Usar textos neutros + link autenticado para o portal.
  - Opt-in/opt-out registrado em `consent` (finalidade "comunicação por WhatsApp"); respeitar "PARAR".
  - `message_log` guarda metadados (template, status), não o corpo com dados.
- **Cobrança (pesquisa da rodada 7, §3.3):**
  - **FATO:** desde 01/07/2025 a Meta cobra **por mensagem entregue**, por categoria (marketing, utilidade, autenticação) — não mais por conversa de 24 h. Desde 01/07/2026 quem fatura no Brasil pode ser cobrado em **BRL**, e as WABAs elegíveis precisam migrar para BRL **até 30/06/2027**, ou a entrega para. As faixas de volume de utilidade e autenticação só mudam no 1º dia de um trimestre. Fonte: [Meta — Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
  - **Consequência de arquitetura:** lembrete e confirmação são **templates de utilidade**, nunca de marketing (custa de 5 a 8 vezes mais). O `message_log` precisa guardar a **categoria** e o custo devolvido pelo BSP, por clínica, senão não há como medir margem nem detectar reclassificação de utilidade para marketing pela Meta.
  - **A CONFIRMAR:** há relato de BSP de que, desde 01/10/2026, template de utilidade enviado com a janela de 24 h já aberta passou a ser cobrado (antes era grátis). Confirmar com o BSP escolhido antes de prometer "WhatsApp incluso" (D2).

## 2. Gateways de pagamento / Pix

- **Propósito:** cobrança de consultas e pacotes (Pix, boleto, cartão), split para profissionais, assinatura do próprio SaaS, conciliação.
- **Candidatos:** **Asaas** (Pix/boleto/cartão + split, forte no segmento de serviços), **Efí** (ex-Gerencianet, Pix com API Bacen e mTLS), **Pagar.me** (cartão + split, Stone), **Stripe** (Pix disponível no Brasil; excelente DX, bom para cobrança do SaaS).
- **Recomendação inicial:** um gateway "padrão" para o MVP (Asaas ou Efí) com interface `PaymentGateway` permitindo BYO (clínica conecta sua conta).
- **Cuidados LGPD/segurança:**
  - **Nunca** armazenar dados de cartão (PCI DSS) — usar tokenização/checkout do gateway.
  - Descrição da cobrança **sem** procedimento clínico sensível (ex.: "Consulta" em vez de "Consulta psiquiátrica").
  - Webhooks: validar assinatura/mTLS, idempotência por `gateway_event_id`, reprocessamento seguro.
  - CPF do pagador só quando exigido pelo meio de pagamento.
- **Pix Automático para a nossa assinatura (pesquisa da rodada 7, §3.4):**
  - **FATO (documentação do Asaas):** o Pix Automático está em produção para recorrência. Na "Jornada 3", um único QR paga a primeira cobrança e autoriza as seguintes; desde 19/05/2026 as próximas são geradas pelo provedor com `paymentCreationMode: SUBSCRIPTION`. Fonte: [Asaas — Pix Automático](https://docs.asaas.com/docs/pix-automatico).
  - **Lacuna:** não há documentação equivalente localizada da Efí. Comparar antes de fechar a D5.
  - **Consequência de arquitetura:** a D5 são **duas** decisões, e podem ter provedores diferentes: (a) cobrança do **nosso** SaaS da clínica (Pix Automático + cartão, assinatura) e (b) cobrança da **clínica ao paciente** (Pix, boleto, cartão, split). A interface `PaymentGateway` já suporta os dois, mas o fluxo de assinatura precisa do estado da autorização do Pix Automático, que o boleto e o cartão não têm.

## 3. NFS-e

- **Propósito:** emissão de nota fiscal de serviço por consulta/pacote, cancelamento, envio ao tomador.
- **Candidatos:** **Focus NFe**, **eNotas**, **PlugNotas (TecnoSpeed)**, NFE.io. Abstraem a fragmentação de padrões municipais e a transição para o **padrão nacional de NFS-e** (ADN/Receita Federal, reforma tributária).
- **Cuidados LGPD:**
  - NFS-e é documento fiscal, consultável por terceiros com a chave → **discriminação do serviço sem CID, diagnóstico ou detalhes clínicos**.
  - Certificado digital da clínica (e-CNPJ) armazenado no provedor ou cifrado conosco — preferir que o provedor custodie.
  - Retenção de documentos fiscais por prazo legal (5 anos) — base legal: obrigação legal (art. 7º, II).
- **Padrão nacional e IBS/CBS (pesquisa da rodada 7, §3.1):**
  - **FATO:** a LC 214/2025 obriga os municípios a aderir ao ambiente nacional da NFS-e a partir de jan/2026 (emissor próprio integrado ou emissor nacional gratuito); quem não adere perde transferências voluntárias da União. Em 2025 cerca de 1.472 municípios já haviam aderido, somando por volta de 70% das emissões.
  - **FATO:** a Nota Técnica 003/2025 consolidou a 3ª versão do leiaute, com o grupo **IBSCBS** na DPS. **São Paulo, Barueri e Salvador mantêm sistema próprio**, com layout adaptado e envio ao ambiente nacional. O ISS continua pago por guia municipal na maioria das cidades.
  - **A CONFIRMAR:** há leitura jurídica de que a obrigação de 2026 é de compartilhar dados, não de migrar a emissão.
  - **Consequência de arquitetura:** reforça o provedor (N1) em vez de integrar prefeitura por prefeitura. **Critério de escolha:** suportar o padrão nacional, os campos de **IBS/CBS** e as cidades fora do emissor nacional — se o nicho de entrada tiver clínica em São Paulo, isso é eliminatório, não desejável.

## 3-A. Receita Saúde (recibo do profissional pessoa física)

- **Propósito:** o profissional que atende como **pessoa física** emite o recibo pelo Receita Saúde, não por NFS-e. Metade do nicho de entrada (psicólogo autônomo) está nesse caso.
- **FATO (pesquisa da rodada 7, §3.2):** desde 01/01/2025 médicos, dentistas, psicólogos, fisioterapeutas, fonoaudiólogos e terapeutas ocupacionais que atendem como PF **devem** emitir o recibo pelo Receita Saúde; o papel acabou. Quem atende por CNPJ emite NFS-e.
- **FATO:** desde 04/11/2025 a Receita aceita **arquivo de integração** gerado por software de gestão de consultório para emitir vários recibos de uma vez. O formato está nas perguntas 24 e 25 do **Manual do Receita Saúde v2.1**. **Não há API pública documentada:** a integração é por arquivo.
- **Como (MVP):** gerar o arquivo de lote no formato do manual v2.1 a partir dos atendimentos pagos do período, e **conciliar** depois o que foi efetivamente emitido (o retorno é o que o profissional vê no portal, não um callback nosso). Nada de fila de webhook aqui: é geração de arquivo sob demanda, com download pela tela.
- **Consequência comercial (D14):** a promessa é "**gera o lote para o Receita Saúde**", nunca "emite sozinho" (risco R11).
- **ESTIMATIVA:** pela regra de 2025, os atendimentos de 2026 podem ser regularizados até 28/02/2027.
- **Cuidados LGPD:** o arquivo tem nome e CPF do paciente e o valor pago. Gerado sob demanda, entregue pela tela com a mesma trava da exportação, **sem** ficar guardado em disco depois do download, e sem nenhum dado clínico (o recibo é financeiro).

## 4. Assinatura digital ICP-Brasil

- **Propósito:** assinar prescrições (inclusive de controle especial, quando permitido digitalmente), atestados, laudos e o próprio prontuário eletrônico (Lei 13.787/2018 e normas do CFM, SBIS/NGS2 para dispensar papel).
- **Candidatos:** certificados em nuvem **BirdID** (Soluti), **VIDaaS** (Valid), SafeID, NeoID; SDK/serviços de assinatura **Lacuna** (PKI Express, Rest PKI) para montar PAdES/CAdES e validar.
- **Fluxo:** documento gerado → hash → assinatura remota autorizada pelo profissional (OAuth + PIN/OTP do PSC) → PDF PAdES armazenado no S3 → validável no ITI (validar.iti.gov.br).
- **Cuidados LGPD/segurança:**
  - A plataforma **não custodia** a chave privada; tokens OAuth do PSC são de curta duração e cifrados.
  - Enviar ao PSC apenas o **hash** sempre que o fluxo permitir.
  - Registrar evidência (`signature`: sujeito do certificado, carimbo de tempo, hash).

## 5. Memed (prescrição digital)

- **Propósito:** prescrição com bulário, interações medicamentosas, envio da receita ao paciente e integração com farmácias.
- **Como:** SDK web embarcado no prontuário; retorno via callback com o ID da prescrição (`prescription.external_ref`).
- **Alternativas:** Nexodata, prescrição nativa da plataforma (necessária para profissões fora do escopo da Memed e como fallback).
- **Cuidados LGPD:** a Memed recebe dados do paciente e do profissional e é **controladora em parte** do fluxo (ex.: farmácias) — revisar contrato, informar o titular, compartilhar só o necessário (nome, CPF quando exigido, contato se o paciente optar).
- **SNCR — controlados (pesquisa da rodada 7, §3.8):**
  - **FATO:** a RDC 1.000/2025 criou o **SNCR**, com numeração nacional para notificação de receita, receita de controle especial e receita sujeita a retenção (antimicrobianos, GLP-1). Receita eletrônica desses tipos **só vale** se for nata digital e emitida por serviço de prescrição **integrado ao SNCR por API**. Controle especial exige ICP-Brasil; retenção aceita assinatura avançada (gov.br). O prescritor não acessa o SNCR direto. Receita em papel continua existindo.
  - **FATO:** em 27/05/2026 o prazo foi adiado para 30/09/2026, já vencido. **A CONFIRMAR:** a publicação no DOU (uma fonte cita a RDC 1.028/2026), um período de transição até 29/10/2026, e relatos de "Domínio não Autorizado" na API.
  - **FATO:** a Res. CFM 2.299/2021 exige ICP-Brasil **NGS2** para documento médico digital (validável no ITI ou no validador do CFM) e **inscrição no CRM da jurisdição** para plataforma de prescrição eletrônica (art. 5º).
  - **Decisão de arquitetura: não fazer prescrição nativa de controlados.** Para medicina, integrar com quem já é integrado ao SNCR e inscrito no CRM (Memed, Nexodata) e **exigir isso por contrato** (D10, D11) — risco R14. Para o nicho de entrada (fisio/TO + psico) não se aplica: essas profissões não prescrevem medicamento.

## 6. Vídeo para teleconsulta

- **Propósito:** teleconsulta conforme Lei 14.510/2022 e resoluções dos conselhos (CFM 2.314/2022, CFP, CFO etc.).
- **Candidatos:**
  - **Daily** — API simples, salas efêmeras, prebuilt UI; infraestrutura fora do Brasil.
  - **LiveKit** — open source (SFU WebRTC), pode ser **self-hosted em sa-east-1** ou LiveKit Cloud.
  - **Jitsi** — open source, self-hosted; mais operação.
- **Recomendação:** LiveKit (Cloud no MVP, self-host em sa-east-1 quando volume justificar) pelo controle de residência de dados.
- **Cuidados LGPD:** criptografia ponta a ponta/DTLS-SRTP, salas com token de uso único e expiração, sala de espera, **sem gravação por padrão** (gravação só com consentimento específico e armazenamento cifrado), consentimento de teleconsulta registrado, nenhum dado clínico no nome da sala.

## 7. TISS (ANS)

- **Propósito:** faturamento de convênios — guias de consulta, SP/SADT, honorários, odontologia; lotes XML; recursos de glosa; elegibilidade/autorização via webservice quando a operadora oferece.
- **Como:** gerador de XML a partir de XSDs oficiais por versão TISS (versionado em `tiss_guide.tiss_version`); validação contra XSD antes do envio; hash MD5 do lote conforme padrão; envio por portal/webservice da operadora.
- **Alternativas:** bibliotecas/serviços de terceiros para geração TISS; começar por exportação de XML para upload manual no portal da operadora (MVP) e evoluir para webservices.
- **Versão (pesquisa da rodada 7, §3.7):** **FATO (comunicação de operadora citando a ANS):** a versão **04.03.00** é obrigatória desde **01/07/2026** e substitui a 04.02.00; os componentes organizacionais de jan, mai, jul e set/2026 estão publicados. **Consequência:** o gerador nasce em 04.03.00, com a versão como **dado** (`tiss_guide.tiss_version`, já previsto) e uma **rotina mensal** que confere se saiu componente novo — a versão muda sozinha, no calendário da ANS, e lote fora de versão é glosa.
- **Cuidados LGPD:** XML contém dados de beneficiário e clínicos (CID, procedimentos) → armazenamento cifrado (`xml_enc`), acesso restrito ao papel de faturamento, auditoria de geração/download. Base legal: execução de contrato/tutela da saúde; compartilhamento com operadora é necessário à finalidade.

## 8. RNDS (Rede Nacional de Dados em Saúde)

- **Propósito:** interoperabilidade com o SUS/Ministério da Saúde (ex.: registros de imunização, resultados de exames, sumários), padrão **HL7 FHIR R4** com perfis brasileiros.
- **Como:** credenciamento do estabelecimento (CNES) no portal de serviços do DATASUS, certificado digital do estabelecimento (e-CNPJ) com mTLS, ambiente de homologação antes de produção.
- **Fase:** **pós-MVP**, exceto para nichos onde for obrigatório (ex.: laboratórios, vacinação).
- **Cuidados LGPD:** compartilhamento com poder público com base legal específica (art. 11, II, "b"/"f" e normas do MS); log de todo envio; certificado da clínica nunca exposto.

## 9. Provedor de LLM (IA)

- Estratégia em `docs/05-ia-llm/`. Do lado da arquitetura: acesso **somente** via gateway interno que aplica pseudonimização/redação, controle de finalidade por tenant (feature flag + consentimento quando aplicável), contrato com **não-treinamento** e retenção zero, e registro de uso em `ai_interaction` sem conteúdo identificável.

## 10. Resumo

| Integração | Fase | Dado sensível enviado? | Residência | Padrão de chamada |
|---|---|---|---|---|
| WhatsApp Cloud API | MVP | Não clínico (contato) | Exterior | Fila + webhook |
| Pix/Pagamentos | MVP | Financeiro, CPF | Brasil (maioria) | Fila + webhook |
| NFS-e | MVP | Fiscal (sem CID) | Brasil | Fila + webhook/polling |
| Receita Saúde (lote) | MVP (profissional PF) | Financeiro + CPF, sem clínico | Brasil | Arquivo gerado sob demanda (sem API) |
| ICP-Brasil | MVP | Hash do documento | Brasil | Síncrono (interação do profissional) |
| Memed | MVP (medicina) | Sim (prescrição) | Brasil | SDK + callback |
| Vídeo | MVP | Mídia em tempo real | Depende do provedor | Token efêmero |
| TISS | MVP+ | Sim (clínico) | Brasil | Geração + envio assíncrono |
| RNDS | Pós-MVP | Sim (FHIR) | Brasil | Fila + mTLS |
| LLM | Conforme 05 | Minimizado/pseudonimizado | Preferência Brasil | Gateway interno |

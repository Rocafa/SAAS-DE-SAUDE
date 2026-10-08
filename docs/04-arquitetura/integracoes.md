# Integrações externas

> Toda integração fica atrás de uma **interface de domínio** (port) com um ou mais **adapters** — ex.: `PaymentGateway` com `AsaasAdapter`, `EfiAdapter`. Chamadas de saída rodam em **workers BullMQ** (retry com backoff, idempotência, dead-letter). Webhooks de entrada têm assinatura verificada e são persistidos em `webhook_event` antes do processamento.
>
> **Regra LGPD comum a todas:** cada fornecedor é **operador** (ou suboperador) — exige contrato/DPA com cláusulas de confidencialidade, segurança, suboperadores e localização dos dados; registro no inventário de dados (ROPA) e, se houver processamento fora do Brasil, base para transferência internacional (art. 33 + Res. CD/ANPD nº 19/2024). Enviar **apenas o mínimo** necessário. Avaliações de fornecedor ficam com o Guardião LGPD.
>
> Nomes de fornecedores abaixo são candidatos; preços, SLAs e certificações devem ser confirmados pela frente de Pesquisa antes da escolha.

## 1. WhatsApp Business Cloud API (Meta)

- **Propósito:** confirmação e lembrete de consulta, link de agendamento online, link de teleconsulta, envio de link de pagamento, atendimento.
- **Como:** templates aprovados pela Meta (mensagens iniciadas pela empresa); janela de 24 h para mensagens livres; webhooks de status/resposta.
- **Alternativas:** BSPs oficiais (Twilio, Gupshup, 360dialog, Blip, Zenvia). **Não** usar APIs não oficiais (risco de banimento e de segurança).
- **Cuidados LGPD:**
  - Dados trafegam por infraestrutura da Meta (fora do Brasil) → transferência internacional documentada.
  - **Nenhum conteúdo clínico** em mensagem (sem diagnóstico, exame, medicamento, especialidade sensível como "psiquiatria" quando evitável). Usar textos neutros + link autenticado para o portal.
  - Opt-in/opt-out registrado em `consent` (finalidade "comunicação por WhatsApp"); respeitar "PARAR".
  - `message_log` guarda metadados (template, status), não o corpo com dados.

## 2. Gateways de pagamento / Pix

- **Propósito:** cobrança de consultas e pacotes (Pix, boleto, cartão), split para profissionais, assinatura do próprio SaaS, conciliação.
- **Candidatos:** **Asaas** (Pix/boleto/cartão + split, forte no segmento de serviços), **Efí** (ex-Gerencianet, Pix com API Bacen e mTLS), **Pagar.me** (cartão + split, Stone), **Stripe** (Pix disponível no Brasil; excelente DX, bom para cobrança do SaaS).
- **Recomendação inicial:** um gateway "padrão" para o MVP (Asaas ou Efí) com interface `PaymentGateway` permitindo BYO (clínica conecta sua conta).
- **Cuidados LGPD/segurança:**
  - **Nunca** armazenar dados de cartão (PCI DSS) — usar tokenização/checkout do gateway.
  - Descrição da cobrança **sem** procedimento clínico sensível (ex.: "Consulta" em vez de "Consulta psiquiátrica").
  - Webhooks: validar assinatura/mTLS, idempotência por `gateway_event_id`, reprocessamento seguro.
  - CPF do pagador só quando exigido pelo meio de pagamento.

## 3. NFS-e

- **Propósito:** emissão de nota fiscal de serviço por consulta/pacote, cancelamento, envio ao tomador.
- **Candidatos:** **Focus NFe**, **eNotas**, **PlugNotas (TecnoSpeed)**, NFE.io. Abstraem a fragmentação de padrões municipais e a transição para o **padrão nacional de NFS-e** (ADN/Receita Federal, reforma tributária).
- **Cuidados LGPD:**
  - NFS-e é documento fiscal, consultável por terceiros com a chave → **discriminação do serviço sem CID, diagnóstico ou detalhes clínicos**.
  - Certificado digital da clínica (e-CNPJ) armazenado no provedor ou cifrado conosco — preferir que o provedor custodie.
  - Retenção de documentos fiscais por prazo legal (5 anos) — base legal: obrigação legal (art. 7º, II).

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
| ICP-Brasil | MVP | Hash do documento | Brasil | Síncrono (interação do profissional) |
| Memed | MVP (medicina) | Sim (prescrição) | Brasil | SDK + callback |
| Vídeo | MVP | Mídia em tempo real | Depende do provedor | Token efêmero |
| TISS | MVP+ | Sim (clínico) | Brasil | Geração + envio assíncrono |
| RNDS | Pós-MVP | Sim (FHIR) | Brasil | Fila + mTLS |
| LLM | Conforme 05 | Minimizado/pseudonimizado | Preferência Brasil | Gateway interno |

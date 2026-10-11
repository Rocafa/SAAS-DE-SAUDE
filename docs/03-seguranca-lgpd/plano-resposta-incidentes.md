# Plano de resposta a incidentes com dados pessoais

> **Rascunho para o advogado (D8).** ⚖️ = precisa de validação jurídica.
> Autor: agente `guardiao-lgpd` · Versão 0.1 · 10/10/2026 · Detalha [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) §13 e a cl. 7 do [DPA](dpa-minuta.md).
> **Legenda:** **FATO** = está na norma citada; **PROPOSTA** = regra interna nossa.

## 1. O que a norma exige (FATO)

| Regra | Fonte |
|---|---|
| Incidente é "evento adverso confirmado" que viola confidencialidade, integridade, disponibilidade ou autenticidade de dados pessoais | Res. CD/ANPD 15/2024, art. 3º |
| O **controlador** comunica à ANPD e aos titulares quando o incidente puder acarretar **risco ou dano relevante** | LGPD art. 48; Res. 15/2024, art. 4º |
| É relevante quando puder afetar significativamente interesses e direitos fundamentais **e** envolver pelo menos um critério: dados sensíveis, de crianças, adolescentes ou idosos, financeiros, de autenticação, protegidos por sigilo, ou em larga escala | Res. 15/2024, art. 5º |
| Prazo: **3 dias úteis** a partir do conhecimento de que o incidente afetou dados pessoais | Res. 15/2024, art. 6º |
| Agente de pequeno porte: prazo em dobro. **Não vale para nós** se o tratamento for de alto risco (dado de saúde em escala) ⚖️ | Res. CD/ANPD 2/2022, alterada pela 15/2024 |
| Complementação das informações em até **20 dias úteis** | Res. 15/2024, art. 6º, §§ |
| **Registro do incidente**, mesmo quando não comunicado, guardado por **5 anos** | Res. 15/2024, art. 10 |
| Conteúdo mínimo: natureza e categoria dos dados e titulares, medidas de segurança, riscos, motivo da demora, medidas de mitigação e contato do encarregado | LGPD art. 48, §1º |
| Canal: peticionamento eletrônico no **SEI!ANPD**, com o formulário vigente da ANPD, pelo encarregado ou representante legal | [Página oficial da ANPD](https://www.gov.br/anpd/pt-br/assuntos/incidente-de-seguranca), consultada em 10/10/2026 |

> Conteúdo das regras: FATO (Res. 15/2024 e análises citadas). **Numeração dos artigos: A CONFIRMAR** no texto do DOU antes de citar em contrato; só o art. 5º foi conferido em mais de uma fonte.

**Na prática, para nós:** quase todo incidente com prontuário envolve dado sensível e sob sigilo profissional, então deve ser tratado como **comunicável por padrão**. A decisão de não comunicar precisa de justificativa escrita no registro. ⚖️

## 2. Papéis

| Papel | Quem | Faz |
|---|---|---|
| Líder do incidente | Plantonista de engenharia | Contenção, linha do tempo, evidências |
| Encarregado (DPO) | A nomear (J4) | Avaliação de relevância, avisos às clínicas, minutas, protocolo na ANPD quando somos controladora |
| Jurídico | Advogado contratado (D8) | Revisa o enquadramento e os textos |
| Comunicação | Sócio designado | Status page, imprensa, atendimento |
| Decisão | Sócios (N0) | Aprova a comunicação quando somos controladora e os gastos extraordinários |

**Quem comunica à ANPD:** a **clínica** (controladora) para os dados dos pacientes; a **plataforma** para os dados em que é controladora (contas de usuários, logs, cobrança da assinatura). Na dúvida sobre o enquadramento, o jurídico decide em até 24 h. ⚖️

## 3. Linha do tempo (relógio em dias úteis)

```
T0   detecção / alerta
T0+1h   triagem: há dado pessoal? qual severidade? → abrir registro do incidente
T0+4h   contenção inicial (revogar credenciais, isolar, bloquear rota)
D0   CIÊNCIA de que o incidente afetou dados pessoais  ◄── começa o prazo legal
D0+24h  aviso a cada clínica afetada (DPA cl. 7.1) + minuta da comunicação para a ANPD e para os titulares
D0+24h…  atualização a cada 24 h às clínicas
até D+3 dias úteis  clínica comunica à ANPD e aos titulares (nós apoiamos com minuta, lista e ferramenta)
até D+3 + 20 dias úteis  comunicação complementar
até D+10 dias úteis  post-mortem sem culpados
```

Exemplo de contagem (ESTIMATIVA, sem feriados): ciência numa sexta-feira às 16 h → 1º dia útil = segunda, 2º = terça, 3º = quarta. **A clínica protocola até quarta.** Por isso o aviso às clínicas em 24 h é inegociável.

## 4. Severidade (PROPOSTA)

| Nível | Exemplo | Comunicação à ANPD |
|---|---|---|
| S1 crítico | Vazamento de prontuário entre clínicas; banco exposto; ransomware | Sim, sempre |
| S2 alto | Conta de profissional invadida com acesso a prontuários; exportação feita por invasor; e-mail com dado clínico enviado ao destinatário errado | Sim, salvo justificativa forte ⚖️ |
| S3 médio | Indisponibilidade prolongada sem perda; vazamento só de e-mail e nome de profissionais | Avaliar pelo art. 5º da Res. 15/2024 |
| S4 baixo | Tentativa bloqueada, sem acesso confirmado | Não; só registro interno |

## 5. Passo a passo

1. **Detectar e registrar:** abrir o registro (modelo §7.4) com hora, fonte do alerta e quem foi acionado.
2. **Conter:** revogar tokens e sessões, rotacionar segredos, isolar o recurso, pausar exportações, desligar a integração suspeita. Preservar evidências **antes** de apagar (snapshots, logs).
3. **Avaliar:** quais clínicas, quais categorias de dados, quantos titulares, se havia criptografia, se há menores. Responder às perguntas da §7.2.
4. **Avisar as clínicas** em até 24 h (modelo §7.1).
5. **Apoiar a comunicação** à ANPD e aos titulares (modelos §7.2 e §7.3).
6. **Erradicar e recuperar:** corrigir a causa, restaurar o necessário (reaplicando eliminações, ver [retencao-e-descarte.md](retencao-e-descarte.md) §4.1) e monitorar a recorrência.
7. **Aprender:** post-mortem sem culpados, ação corretiva com dono e prazo, atualização do RIPD e dos runbooks.

## 6. Runbooks obrigatórios (já listados no §13 dos requisitos)

Vazamento entre clínicas · credencial de profissional comprometida · ransomware · vazamento por suboperador (inclusive LLM) · mensagem a destinatário errado · bucket exposto · perda de chave KMS · prompt injection com exfiltração · **exportação total feita por conta invadida** (novo, ligado à G2). Simulação de mesa **semestral**, com registro.

## 7. Modelos

> Campos entre colchetes. **Nunca** colar dado de paciente nestes textos: usar quantidades e categorias.

### 7.1 Aviso da plataforma à clínica (até 24 h)

> **Assunto:** [URGENTE] Incidente de segurança que pode afetar dados da [nome da clínica] — ref. [ID]
>
> Prezada equipe da [clínica], responsável técnico e encarregado,
>
> Em [data e hora] confirmamos um incidente de segurança que **pode ter afetado dados pessoais** tratados por nós em nome de vocês.
> - **O que aconteceu:** [descrição objetiva, sem jargão].
> - **Quando:** início estimado [data/hora]; detectado em [data/hora]; contido em [data/hora ou "em contenção"].
> - **Dados possivelmente afetados:** [categorias, ex.: nome e telefone; evolução clínica]. **Quantidade estimada:** [n] pacientes; [há / não há] menores.
> - **Proteções existentes:** [ex.: dados cifrados; a chave não foi exposta].
> - **O que já fizemos:** [medidas].
> - **Prazo legal de vocês:** como controladora, a clínica tem **3 dias úteis** a partir de hoje para comunicar à ANPD e aos titulares, se o incidente for relevante (Res. CD/ANPD 15/2024). Anexamos minutas prontas e podemos enviar a comunicação aos pacientes pelo sistema, se vocês aprovarem.
> - **Próxima atualização:** até [data/hora] (no máximo 24 h).
>
> Contato do nosso encarregado: [nome, e-mail, telefone].

### 7.2 Comunicação à ANPD (roteiro para o formulário do SEI!ANPD)

O protocolo é feito no formulário oficial vigente. Este roteiro organiza as respostas:

| Campo | Resposta a preparar |
|---|---|
| Tipo de comunicação | Completa / preliminar / complementar |
| Agente que comunica | Controlador [clínica]; operador: [plataforma] |
| Encarregado | Nome e contato |
| Data e hora da ciência e do incidente | — |
| Natureza do incidente | Confidencialidade / integridade / disponibilidade / autenticidade |
| Categorias de dados | Marcar dados sensíveis (saúde) e dados de crianças, se houver |
| Quantidade de titulares | Número ou faixa estimada |
| Medidas de segurança anteriores | Criptografia, isolamento, MFA etc. |
| Riscos aos titulares | Ex.: exposição de condição de saúde, discriminação, fraude |
| Medidas de mitigação | O que foi feito e o que será feito, com datas |
| Comunicação aos titulares | Feita / quando / por qual meio; ou motivo de não ter sido feita |
| Motivo de eventual demora | Obrigatório se passou de 3 dias úteis |

### 7.3 Aviso ao paciente (titular)

> **Assunto:** Aviso importante sobre seus dados na [nome da clínica]
>
> Olá, [primeiro nome].
>
> Em [data], identificamos um problema de segurança no sistema que a [clínica] usa para guardar informações de atendimento. **Algumas informações suas podem ter sido acessadas por pessoa não autorizada:** [categorias em linguagem simples, ex.: nome, telefone e anotações de consulta].
>
> **O que isso pode causar:** [risco em linguagem simples].
> **O que já fizemos:** [medidas].
> **O que recomendamos que você faça:** [ex.: desconfiar de mensagens pedindo pagamento ou dados em nome da clínica].
>
> Se tiver dúvidas, fale com nosso encarregado de dados: [nome, e-mail, telefone].
>
> [Clínica] — CNPJ [ ]

Regras do aviso ao paciente:
- linguagem clara, sem termos técnicos;
- nenhum detalhe clínico no texto;
- o envio precisa chegar ao próprio titular (ou ao responsável, se for menor);
- não usar o WhatsApp para o detalhe; ele serve só para avisar que há um comunicado no portal ou por e-mail. ⚖️

### 7.4 Registro interno do incidente (guardar 5 anos)

| Campo | — |
|---|---|
| ID, datas (início, detecção, ciência, contenção, encerramento) | |
| Descrição e causa raiz | |
| Clínicas e categorias de dados afetadas; nº de titulares | |
| Avaliação de relevância (art. 5º da Res. 15/2024) e justificativa | |
| Comunicou à ANPD? Quem, quando, nº do protocolo | |
| Comunicou aos titulares? Quando e como | |
| Medidas adotadas e ações corretivas (dono, prazo) | |
| Link do post-mortem | |

## 8. Pontos para o advogado ⚖️

1. Se nós, como operadora, devemos comunicar à ANPD diretamente quando o incidente é na nossa infraestrutura e a clínica não age no prazo.
2. Critério para não comunicar um S2.
3. Se o regime em dobro do agente de pequeno porte pode valer para clínicas pequenas clientes (elas são controladoras e tratam dado de saúde).
4. Texto do aviso ao paciente menor e ao responsável.

## 9. Fontes (consultadas em 10/10/2026)

- Res. CD/ANPD 15/2024 (DOU de 26/04/2024): <https://www.in.gov.br/en/web/dou/-/resolucao-cd/anpd-n-15-de-24-de-abril-de-2024-556243024>
- ANPD — Comunicação de incidente de segurança (SEI!ANPD, formulário): <https://www.gov.br/anpd/pt-br/assuntos/incidente-de-seguranca>
- Análise da Res. 15/2024 (Mattos Filho): <https://www.mattosfilho.com.br/unico/regulamento-incidente-seguranca/>
- LGPD, art. 48: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm>
- Res. CD/ANPD 2/2022 (pequeno porte): <https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd>

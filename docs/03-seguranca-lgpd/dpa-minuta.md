# Minuta do contrato de operador (DPA): clínica × plataforma

> **Rascunho para o advogado (D8). Não usar com cliente antes da revisão jurídica.** ⚖️ = precisa de validação jurídica.
> Autor: agente `guardiao-lgpd` · Versão 0.1 · 10/10/2026 · Desenvolve as 15 cláusulas-chave de [papeis-controlador-operador.md](papeis-controlador-operador.md) §3. Os números das cláusulas foram mantidos, porque outros documentos citam "DPA cl. 12".
> **Mudanças em relação às cláusulas-chave:** cl. 2 ganhou o Anexo I preenchido; cl. 7 detalha o aviso de incidente; cl. 12 incorpora a retenção de backups e o que a operadora guarda como controladora (ressalva M3); cl. 16 é nova (exportação protegida, ressalvas M1/M2).

---

**ANEXO DE TRATAMENTO DE DADOS PESSOAIS** ao Contrato de Prestação de Serviços SaaS celebrado entre:

- **CONTROLADORA:** [razão social da clínica ou nome do profissional autônomo], [CNPJ/CPF], doravante "Clínica";
- **OPERADORA:** [razão social da plataforma], [CNPJ], doravante "Plataforma".

## Cláusula 1. Objeto e instruções

1.1. A Plataforma trata dados pessoais exclusivamente para prestar os serviços contratados (agenda, prontuário eletrônico, comunicação com pacientes, financeiro, portal do paciente, exportação e, se contratados, teleconsulta, prescrição digital, faturamento de convênios e IA assistiva), em nome da Clínica e segundo as instruções dela (LGPD art. 39).
1.2. São instruções da Clínica: este contrato, a configuração que ela faz no produto e instruções escritas posteriores enviadas pelo canal do encarregado.
1.3. Se uma instrução lhe parecer ilícita, a Plataforma avisa a Clínica e pode recusá-la, sem que isso seja inadimplemento. ⚖️

## Cláusula 2. Descrição do tratamento

Ver **Anexo I**.

## Cláusula 3. Confidencialidade e sigilo profissional

3.1. Toda pessoa da Plataforma com acesso a ambiente de produção assina termo de confidencialidade e de ciência do sigilo profissional (Código Penal art. 154).
3.2. A Plataforma **não acessa conteúdo clínico** salvo por acesso emergencial (*break-glass*): chamado aberto pela Clínica, autorização registrada, escopo e prazo limitados, registro em auditoria e revisão posterior. A Clínica pode consultar os registros desses acessos.

## Cláusula 4. Segurança (LGPD art. 46)

4.1. A Plataforma mantém, no mínimo, as medidas do **Anexo II**.
4.2. A Plataforma não reduz unilateralmente o nível dessas medidas. Pode substituí-las por outras equivalentes ou superiores, avisando a Clínica.

## Cláusula 5. Suboperadores

5.1. A Clínica dá **autorização geral** para os suboperadores do **Anexo III**.
5.2. Inclusões ou trocas são avisadas com **30 dias** de antecedência. A Clínica pode se opor de forma fundamentada e, se não houver alternativa, rescindir sem multa.
5.3. A Plataforma impõe a cada suboperador obrigações equivalentes às deste anexo e responde perante a Clínica pelos atos dele.

## Cláusula 6. Localização e transferência internacional

6.1. Os dados ficam armazenados no **Brasil** (produção, réplicas e backups).
6.2. Transferência internacional só com mecanismo do art. 33 da LGPD. Com suboperador estrangeiro, usamos as **cláusulas-padrão contratuais da ANPD** (Res. CD/ANPD 19/2024), em texto integral. ⚖️
6.3. **Conteúdo clínico não é enviado a provedor de IA fora do Brasil** sem pseudonimização prévia e sem as cláusulas-padrão; registros de psicologia nunca saem do país.

## Cláusula 7. Incidentes de segurança

7.1. A Plataforma avisa a Clínica **sem demora indevida e em até 24 horas** depois de confirmar que um incidente pode afetar dados pessoais dela, mesmo com informações incompletas.
7.2. O aviso traz o que se sabe sobre os itens do art. 48, §1º da LGPD e da Res. CD/ANPD 15/2024 (natureza dos dados, titulares, medidas de segurança, riscos, medidas adotadas, contato) e é atualizado a cada 24 horas.
7.3. A Plataforma apoia a Clínica a cumprir o prazo de **3 dias úteis** perante a ANPD e os titulares: entrega minuta de comunicação, lista de titulares afetados e, se pedido, ferramenta de envio. Modelos em [plano-resposta-incidentes.md](plano-resposta-incidentes.md).
7.4. A comunicação à ANPD e aos titulares cabe à Clínica, como controladora, salvo nos dados em que a Plataforma é controladora. ⚖️

## Cláusula 8. Direitos dos titulares

8.1. O produto oferece funções para a Clínica atender aos direitos do art. 18: acesso, correção, portabilidade em formato aberto e informação sobre compartilhamento.
8.2. Pedido de titular recebido diretamente pela Plataforma é encaminhado à Clínica em até **2 dias úteis**, sem resposta de mérito pela Plataforma.

## Cláusula 9. RIPD e auditoria

9.1. A Plataforma fornece as informações necessárias ao RIPD da Clínica, incluindo o [RIPD da plataforma](RIPD-plataforma.md).
9.2. A Plataforma disponibiliza, mediante NDA, os resumos de pentest e de certificações que tiver. Auditoria presencial pode ocorrer uma vez por ano, com aviso de 30 dias e custo da Clínica, salvo após incidente. ⚖️

## Cláusula 10. Uso de dados para IA e melhoria do produto

10.1. **Padrão: vedado** usar dados de pacientes para treinar modelos ou para qualquer finalidade própria da Plataforma.
10.2. Exceções, somente: (a) telemetria técnica sem conteúdo clínico; (b) dados **anonimizados** conforme [lgpd-e-ia.md](lgpd-e-ia.md), mediante **opt-in expresso** da Clínica, revogável, com relatório de anonimização disponível.
10.3. Nunca dados identificáveis ou pseudonimizados para treino de modelo compartilhado entre clientes (LGPD art. 11, §4º). ⚖️

## Cláusula 11. Provedores de IA

11.1. Provedores de IA são suboperadores (Anexo III), contratados com proibição de treino e com retenção zero ou curta.
11.2. As saídas de IA são rascunhos para revisão do profissional, que decide e assina (Res. CFM 2.454/2026, arts. 4º e 18; ver [checklist-cfm-2454.md](checklist-cfm-2454.md)).

## Cláusula 12. Término: devolução, retenção e eliminação

12.1. Após o fim do contrato, a Clínica tem **no mínimo 90 dias** de acesso em modo leitura e de exportação completa e gratuita: prontuário em formato aberto, documentos assinados em PDF e trilha de auditoria. Há avisos 30, 7 e 1 dia antes do fim.
12.2. A **guarda legal do prontuário é da Clínica** (Lei 13.787/2018 e normas do conselho). A Clínica pode contratar a **custódia** da Plataforma; nesse caso não há eliminação, e o acesso segue em modo leitura.
12.3. Sem custódia, ao fim do prazo a Plataforma elimina os dados em produção e emite **certificado de eliminação** com: a data da eliminação; a data da destruição da chave criptográfica da Clínica, quando houver; e a **data de expiração da última cópia de backup**.
12.4. **Backups:** cópias de segurança não são editadas. Elas expiram por rotação nos prazos da [política de retenção](retencao-e-descarte.md) (hoje até 35 dias nos diários e até 12 meses nos mensais imutáveis). Até expirarem, ficam cifradas, sem acesso ordinário, e não são restauradas para uso. Se houver restauração, a eliminação é reaplicada. ⚖️
12.5. **O que a Plataforma guarda como controladora** (LGPD art. 16, I), pelo prazo legal e só para isso: registros de acesso (Marco Civil art. 15), documentos fiscais e de cobrança da assinatura, registro de incidentes e o próprio certificado de eliminação.

## Cláusula 13. Responsabilidade

13.1. Cada parte responde nos termos dos arts. 42 a 45 da LGPD. A limitação de responsabilidade do contrato principal não afasta a responsabilidade legal perante titulares e a ANPD. ⚖️
13.2. A Plataforma mantém seguro de responsabilidade civil e cyber (valor a definir). ⚖️

## Cláusula 14. Encarregados

Contatos dos encarregados de cada parte no **Anexo IV**. A Clínica que se enquadrar como agente de pequeno porte e não tiver encarregado informa um canal de comunicação (Res. CD/ANPD 2/2022).

## Cláusula 15. Lei e foro

Lei brasileira. Foro [a definir]. ⚖️

## Cláusula 16. Exportação protegida (nova)

16.1. A exportação total é direito da Clínica (G2) e é sempre gratuita.
16.2. Para proteger os pacientes contra uso de conta invadida, a exportação total exige:
- administrador com autenticação em dois fatores feita nos últimos 5 minutos;
- aprovação registrada do responsável técnico da Clínica;
- link pessoal que expira em 24 horas e tem limite de downloads;
- aviso a todos os administradores e ao responsável técnico, com opção "não fui eu".
16.3. Havendo suspeita fundada de comprometimento, a Plataforma pode **pausar** a exportação até a verificação, avisando a Clínica e registrando o motivo. A pausa nunca bloqueia a consulta aos dados. ⚖️
16.4. Quem recebe a exportação continua sujeito ao sigilo profissional. O manifesto identifica as seções com restrição (ex.: registros de psicologia).

---

## Anexo I. Descrição do tratamento

| Item | Conteúdo |
|---|---|
| Titulares | Pacientes, responsáveis legais, profissionais e colaboradores da Clínica |
| Dados pessoais | Identificação, contato, endereço, convênio, dados de cobrança, CPF quando exigido |
| Dados sensíveis | Saúde (prontuário, exames, anexos, registros psicológicos); dados de crianças e adolescentes; imagem e voz se houver teleconsulta |
| Finalidades | As da cl. 1.1 |
| Operações | Coleta, armazenamento, consulta, transmissão às integrações ativadas pela Clínica, exportação e eliminação |
| Duração | Vigência do contrato + prazo da cl. 12 |
| Local | Brasil (AWS sa-east-1) |

## Anexo II. Medidas mínimas de segurança

Isolamento por clínica no banco (RLS forçado) com teste automatizado; criptografia em trânsito (TLS 1.2+) e em repouso (KMS); autenticação em dois fatores para profissionais e administradores; controle de acesso por perfil; trilha de auditoria imutável; backup cifrado com teste de restauração; hospedagem no Brasil; segredos fora do código; teste de intrusão anual por terceiro; gestão de vulnerabilidades; plano de resposta a incidentes com simulação semestral. Detalhes: [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md).

> **FATO (estado em 10/10/2026):** isolamento e auditoria básica existem no código; MFA, RBAC, criptografia de campo e infraestrutura de produção ainda **não** existem ([RIPD-plataforma.md](RIPD-plataforma.md) §5). A minuta não pode ser assinada antes disso.

## Anexo III. Suboperadores (lista inicial, a confirmar)

| Suboperador | Serviço | País do processamento | Mecanismo |
|---|---|---|---|
| Amazon Web Services | Hospedagem, banco, backup, chaves | Brasil (sa-east-1) | DPA do fornecedor |
| [provedor de e-mail transacional] | Login, convites, avisos sem conteúdo clínico | A definir | DPA + CPC se fora do Brasil ⚖️ |
| [ferramenta de erros, ex.: Sentry] | Erros técnicos com scrubbing | A definir | DPA + CPC se fora do Brasil ⚖️ |
| [provedor de LLM, conforme D3] | IA assistiva (se contratada) | Brasil, preferencialmente | DPA + não-treino + CPC se fora ⚖️ |
| [BSP/Meta] | WhatsApp (se contratado) | Exterior | CPC ⚖️ |

## Anexo IV. Encarregados

| Parte | Nome | Contato |
|---|---|---|
| Clínica | | |
| Plataforma | A nomear (J4) | |

---

## Pontos para o advogado ⚖️

1. A cl. 1.3 (recusa de instrução ilícita) e a cl. 16.3 (pausa da exportação) não podem ser lidas como retenção de dados (G1).
2. Se a cl. 12.4 (backups com até 12 meses) atende ao art. 16 da LGPD.
3. Se a comunicação à ANPD em incidente cabe sempre à Clínica (cl. 7.4), inclusive quando o incidente é na nossa infraestrutura.
4. Cl. 9.2 (custo e frequência de auditoria) e cl. 13 (limitação de responsabilidade e seguro).
5. Situação de co-controladoria em clínica com profissionais autônomos ([papeis-controlador-operador.md](papeis-controlador-operador.md) §1).

## Fontes (consultadas em 10/10/2026)

- LGPD (arts. 11, 16, 18, 33, 37–48): <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm>
- Res. CD/ANPD 15/2024 (incidentes): <https://www.in.gov.br/en/web/dou/-/resolucao-cd/anpd-n-15-de-24-de-abril-de-2024-556243024>
- Res. CD/ANPD 2/2022, 18/2024 e 19/2024: <https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd>
- Lei 13.787/2018: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm>
- Marco Civil, art. 15: <https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm>
- Código Penal, art. 154: <https://www.planalto.gov.br/ccivil_03/decreto-lei/del2848compilado.htm>
- Res. CFM 2.454/2026: <https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2026/2454_2026.pdf>

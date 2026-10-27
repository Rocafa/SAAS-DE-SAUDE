# Matriz de retenção por conselho e por tipo de registro (J13)

> ⚖️ **Rascunho para validação jurídica.** Orientação técnico-regulatória para engenharia e produto, **não é parecer jurídico**. Montada pelo agente `guardiao-lgpd` na rodada 8.
> Todas as normas abaixo foram lidas no **texto oficial** em **11/10/2026**, exceto onde está escrito o contrário. Cada linha traz artigo, prazo, termo inicial e fonte.
> Esta matriz é a resposta à pendência **J13** e ao item 21 do [mapa regulatório](README.md). Ela existe para virar uma coisa só na engenharia: **retenção configurável por tipo de registro**.

## 1. A regra que resolve a aparente contradição

As resoluções de conselho e a lei federal parecem se contradizer — CFP e COFFITO falam em 5 anos, a Lei 13.787/2018 fala em 20, e três conselhos falam em "guarda permanente". Não há contradição; há camadas.

**Lei 13.787/2018, art. 6º:** "Decorrido o prazo mínimo de 20 (vinte) anos a partir do último registro, os prontuários em suporte de papel e os digitalizados poderão ser eliminados."

**Art. 6º, §5º** — o dispositivo que decide a questão: "As disposições deste artigo aplicam-se a todos os prontuários de paciente, independentemente de sua forma de armazenamento, inclusive aos microfilmados e aos arquivados eletronicamente em meio óptico, bem como aos constituídos por documentos gerados e mantidos originalmente de forma eletrônica."

Três consequências:

1. A lei fala de **prontuário de paciente**, sem restringir a profissão. Ela não diz "prontuário médico". Logo alcança fisioterapia, psicologia, nutrição, fonoaudiologia e odontologia quando o que existe é prontuário de paciente em serviço de saúde.
2. O §5º fecha a porta de saída mais tentadora: não existe prontuário "nascido digital" fora da regra. O nosso produto gera exatamente esse tipo de prontuário.
3. Os prazos de conselho de 5 anos são **mínimos do conselho**, e os próprios textos dizem que podem ser ampliados "nos casos previstos em lei" (Res. CFP 001/2009, art. 4º §1º; Res. COFFITO 414/2012, art. 6º, I). A Lei 13.787 é o caso previsto em lei.

**Portanto o piso do produto é 20 anos a partir do último registro, para todo prontuário de paciente, de qualquer profissão.** Onde o conselho exige mais — e três exigem — vale o mais longo.

⚖️ Esta é a leitura do Guardião e precisa de confirmação do advogado. A pergunta exata para ele está na seção 6.

## 2. Matriz por conselho — prontuário de paciente

| Profissão / conselho | Norma e artigo | Papel | Eletrônico (o nosso caso) | Termo inicial | Fonte oficial (lida em 11/10/2026) |
|---|---|---|---|---|---|
| **Todas as profissões — piso legal** | **Lei 13.787/2018, art. 6º e §5º** | mínimo 20 anos | mínimo 20 anos (§5º alcança o nascido eletrônico) | último registro | [Planalto](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/L13787.htm) |
| **Medicina — CFM** | Lei 13.787/2018 art. 6º; Res. CFM 1.821/2007 (requisitos do S-RES) | mínimo 20 anos | mínimo 20 anos | último registro | Planalto; [CFM 1.821/2007](https://sistemas.cfm.org.br/normas/visualizar/resolucoes/BR/2007/1821) (a 1.821 não foi relida nesta rodada) |
| **Odontologia — CFO** | **Res. CFO-SEC-91/2009, art. 7º e art. 8º** | mínimo **10 anos** (art. 8º, só para papel não digitalizado) | **guarda permanente** (art. 7º: "Estabelecer a guarda permanente, considerando a evolução tecnológica, para os prontuários dos pacientes arquivados eletronicamente em meio óptico, microfilmado ou digitalizado") | último registro (art. 8º) | [CFO — Res. CFO-SEC-91/2009](https://sistemas.cfo.org.br/visualizar/atos/RESOLU%C3%87%C3%83O/SEC/2009/91) |
| **Psicologia — CFP** | **Res. CFP 001/2009, art. 4º §1º** (guarda do registro documental); **art. 6º** (prontuário único) | mínimo **5 anos**, ampliável "nos casos previstos em lei" | o mínimo do conselho é 5 anos, mas o piso legal de 20 anos prevalece quando há prontuário de paciente em serviço de saúde | último registro | [CFP — PDF oficial](https://site.cfp.org.br/wp-content/uploads/2009/04/resolucao2009_01.pdf) |
| **Fisioterapia e Terapia Ocupacional — COFFITO** | **Res. COFFITO 414/2012, art. 6º, I, III e IV** | mínimo **5 anos** a contar do último registro, ampliável por lei, por determinação judicial ou por necessidade específica | mesmo raciocínio do CFP: 5 anos é o mínimo do conselho; o piso legal de 20 anos prevalece. O inciso IV autoriza manter cópia digital **após** o prazo | último registro | [COFFITO — Res. 414/2012](https://www.coffito.gov.br/nsite/?p=1727) (D.O.U. nº 99, Seção 1, 23/05/2012) |
| **Nutrição — CFN** | **Res. CFN 594/2017, art. 3º, VI, "a" e "b"**; art. 12; parágrafo único | mínimo **20 anos** após o último registro (alínea "a") | **guarda permanente**, podendo ser eliminado 20 anos após o último registro, com o meio de armazenamento mantido atualizado (alínea "b") | último registro | [CFN — Res. 594/2017](https://cfn.org.br/wp-content/uploads/resolucoes/resolucoes_old/Res_594_2017.htm) |
| **Fonoaudiologia — CFFa** | **Res. CFFa 777/2025, art. 8º** (o art. 19 revogou as Res. 579/2020 e 649/2022) | mínimo **20 anos** após o último registro | **guarda permanente**, podendo ser eliminado 20 anos após o último registro | último registro | [Res. CFFa 777/2025, de 08/04/2025](https://www.legisweb.com.br/legislacao/?id=476640) (**compilação de terceiro; confirmar no site do CFFa**) |

### Leituras que a matriz derruba

- **"Psicólogo guarda 5 anos, então o sistema pode apagar em 5 anos."** Não. O mínimo do conselho não é autorização de descarte quando existe prazo legal maior, e o próprio art. 4º §1º da Res. CFP 001/2009 diz que o prazo é ampliável nos casos previstos em lei.
- **"Vinte anos é o teto."** Não. Para CFO (eletrônico), CFN e CFFa o valor é **permanente**, com eliminação apenas *facultada* depois de 20 anos. Um sistema que force exclusão no dia 7.300 quebra a conformidade dessas três profissões.
- **"O prazo conta da alta."** Não. Em todas as normas lidas o termo inicial é o **último registro** — não a alta, não a primeira consulta, não o fim do contrato com a clínica. Um atendimento novo dez anos depois reinicia a contagem inteira.

## 3. Outros tipos de registro (não prontuário)

Estes prazos são diferentes dos do prontuário, e é justamente por isso que a retenção precisa ser por **tipo de registro** em vez de um número só para o tenant.

| Tipo de registro | Prazo | Base | Observação |
|---|---|---|---|
| **Registros de acesso a aplicação** (log de requisição) | mínimo **6 meses** | Marco Civil da Internet, art. 15; Decreto 8.771/2016, art. 13 | Piso legal. Guardar sob sigilo e em ambiente controlado. |
| **Auditoria de acesso a prontuário** (quem leu o quê) | **decisão pendente — D7** | LGPD art. 37; Res. CFM 1.821/2007 (trilha de auditoria) | Recomendação do Guardião: **o mesmo prazo do prontuário a que o acesso se refere.** Trilha que morre antes do documento não prova nada no dia em que a clínica for questionada sobre quem viu o prontuário. É o insumo que faltava ao memo D07. |
| **Registro interno de incidentes de segurança** | **5 anos** | Res. CD/ANPD 15/2024 | Prazo próprio, independente do prontuário. |
| **Consentimento e registro de recusa de IA** | enquanto durar o tratamento **+ prazo de prova** | LGPD arts. 37 e 42; Res. CFM 2.454/2026 arts. 5º §3º e 11 | O registro da recusa precisa sobreviver mais que a sessão: é a prova de que não usamos IA sobre quem recusou. Tratar como registro do prontuário. |
| **Contador de rate limit** | TTL igual à janela | LGPD art. 6º, III (necessidade) | Ver a linha correspondente no ROPA ([bases-legais-e-consentimento.md](bases-legais-e-consentimento.md)). |
| **Documentos fiscais e financeiros** | **5 anos** ⚖️ | CTN art. 174; efeitos da LC 214/2025 ainda por confirmar | Fora do escopo do Guardião; confirmar com contador. |
| **WhatsApp — conteúdo do lembrete** (texto renderizado e número de destino, cifrados) | **30 dias** do envio | LGPD art. 6º, III (necessidade); parecer do #69 (prazo aprovado) | Job da clínica `app_whatsapp_content_retention_run()` (0032), com o relógio do banco; o banco recusa limpar antes e recusa reescrever. O texto é reconstituível pelo modelo da plataforma + a consulta. |
| **WhatsApp — linha presa na fila** | `agendado` de consulta já começada: cancelada na próxima limpeza; `enviando` há mais de **24 h**: `falhou` com fallback | R2 do parecer #69 | Assim nenhuma linha fica fora da limpeza de 30 dias. |
| **WhatsApp — metadado** (status, datas, códigos, HMAC do número na fila; resposta só com interpretação e resultado) | **acompanha o cadastro do paciente**: sai com a eliminação/anonimização dele | R3 do parecer #69; LGPD art. 16 | Prova do que foi combinado com o paciente (confirmou/cancelou). Não há texto nem número em claro. A eliminação junto com a do paciente entra no fluxo de eliminação do titular (pendente na engenharia, antes do piloto). |
| **WhatsApp — resposta livre do paciente** | **não é guardada** | R1 do parecer #69; LGPD art. 6º, III | Sem inbox com leitor, o texto é descartado e o paciente recebe a orientação fixa de ligar para a clínica. O prazo de 12 meses do RIPD-whatsapp vale só quando existir o inbox. |
| **WhatsApp — opt-in e prova** (meio, comprovante, número que consentiu, quem registrou, revogação) | **enquanto vigente + 5 anos após a revogação** (PROPOSTA) ⚖️ | LGPD arts. 8º §2º e 37 (ônus da prova do consentimento); prazo prescricional a confirmar | Pergunta ao advogado: o prazo prescricional aplicável à prova do consentimento (5 anos, CDC art. 27? 3 anos, CC art. 206 §3º, V?). |
| **Backups** | igual ao dado de origem | LGPD art. 46; [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) | Exclusão em produção se reflete no backup pelo ciclo de expiração, não por edição de backup. Documentar isso ao titular. |

## 4. Requisito técnico para a engenharia

A matriz vira **um** requisito, com sete propriedades. Nenhuma é opcional, e quatro são do tipo que, se não entrar no modelo de dados desde o começo, custa migração dolorosa depois.

**RT-RET-01 — Retenção configurável por tipo de registro.**

1. **A política é por tipo de registro, não por tenant.** A unidade de configuração é (tipo de registro × profissão/conselho), e a política resolvida para um registro é sempre **o maior prazo aplicável** entre o piso legal, a regra do conselho e a configuração da clínica. A clínica pode aumentar; nunca diminuir.
2. **O valor "permanente" existe.** O campo de prazo não é um inteiro de anos; é uma união: `{ anos: n }` ou `permanente`. CFO (eletrônico), CFN e CFFa exigem o segundo. Um `int years` no schema é o defeito mais provável desta feature.
3. **O termo inicial é o último registro, e ele se move.** O prazo não é calculado na criação do prontuário: cada registro novo recalcula a data de elegibilidade de descarte do prontuário inteiro. Isso precisa ser campo derivado e indexado (`ultimo_registro_em`), não conta feita na hora do descarte.
4. **Exclusão física bloqueada durante a guarda.** Durante o prazo, nem a clínica, nem o suporte, nem rotina de limpeza, nem pedido de eliminação do titular (LGPD art. 16, I, que preserva o cumprimento de obrigação legal) apagam prontuário. O que existe é **bloqueio ou anonimização de dados em excesso**, nunca `DELETE` no documento. O teste que prova isso pertence à suíte de segurança.
5. **Descarte é processo, não job.** A Lei 13.787 exige análise de **comissão permanente de revisão de prontuários** antes de destruir originais (art. 3º), que a eliminação resguarde intimidade e sigilo (art. 6º §3º) e que a destinação final seja **registrada** (art. 6º §4º). Logo: o fim do prazo gera uma *proposta* de descarte, que passa por aprovação registrada na clínica, e o evento de eliminação entra na trilha de auditoria com quem aprovou.
6. **Devolver ao paciente é alternativa prevista em lei.** O art. 6º §2º da Lei 13.787 e o parágrafo único do art. 3º, VI da Res. CFN 594/2017 (entrega aos herdeiros em caso de morte) pedem uma rota de exportação do prontuário no fim da guarda. Isso conversa direto com as [garantias ao cliente](../02-produto/garantias-ao-cliente.md): a mesma exportação serve à garantia de não aprisionar o prontuário.
7. **A política resolvida é auditável.** Dado um prontuário, o sistema tem de responder: qual prazo se aplica, por qual norma, qual a data de elegibilidade, e quando ela foi recalculada pela última vez. Sem isso não se responde à fiscalização e não se depura o item 4.

**Nota de arquitetura, derivada do art. 6º da Res. CFP 001/2009:** em atendimento multiprofissional o registro deve ser feito em **prontuário único**, o que contradiz o modelo intuitivo de um prontuário por profissional. O caminho é prontuário único do paciente com **compartimentos por natureza do registro**, e o compartimento de notas psicológicas visível apenas ao psicólogo autor. Decidir isso depois de ter dado real é refatoração de prontuário, que é a pior que existe. ⚖️

## 5. Resumo operacional

| Pergunta | Resposta |
|---|---|
| Qual o piso para todo prontuário? | 20 anos do último registro (Lei 13.787/2018, art. 6º e §5º) |
| Quais profissões pedem mais? | Odontologia (eletrônico), nutrição e fonoaudiologia: **guarda permanente**, com eliminação apenas facultada após 20 anos |
| Os 5 anos de CFP e COFFITO liberam descarte? | Não. São mínimos do conselho, ampliáveis por lei — e a lei amplia |
| Quando o prazo começa? | No último registro, e ele se move a cada registro novo |
| Posso apagar a pedido do titular? | Não durante a guarda legal (LGPD art. 16, I). Bloqueia-se excesso; não se apaga prontuário |
| Qual prazo para a trilha de auditoria? | Pendente (D7). Recomendação: o mesmo do prontuário a que o acesso se refere |

## 6. Perguntas para o advogado (⚖️)

1. A leitura do art. 6º §5º da Lei 13.787/2018 se sustenta — o piso de 20 anos alcança prontuário de paciente de **todas** as profissões de saúde, e não apenas o médico?
2. "Guarda permanente" (CFO-SEC-91/2009 art. 7º; CFN 594/2017; CFFa 777/2025) é compatível com o princípio de necessidade do art. 6º, III da LGPD? Se for, qual a justificativa a registrar no ROPA para retenção sem prazo final?
3. O art. 6º da Res. CFP 001/2009 (prontuário único em serviço multiprofissional) obriga arquitetura de prontuário compartilhado, ou admite prontuários separados por profissional com visão consolidada?
4. Qual o prazo defensável para a trilha de auditoria de acesso a prontuário (D7), considerando o art. 37 da LGPD, o prazo prescricional do CDC e o prazo do próprio prontuário?
5. Confirmar a vigência da Res. CFFa 777/2025 e a revogação da 649/2022 no site do conselho — a fonte usada aqui é compilação de terceiro, não o texto do CFFa.
6. Ao encerrar o contrato com a clínica, de quem é a guarda dos anos restantes: da clínica (controladora), nossa (operador), ou há dever de entrega formal? Isso define se o nosso custo de armazenamento tem fim.

---

**Histórico desta matriz**

| Data | Mudança |
|---|---|
| 2026-10-22 | Rodada 19 (#69, R3): prazos do WhatsApp — conteúdo 30 dias, linhas presas, metadado com o cadastro, resposta livre não guardada, opt-in vigente + 5 anos (proposta ⚖️). |
| 2026-10-11 | Criada na rodada 8 (J13). Lidas no texto oficial: Lei 13.787/2018, Res. CFP 001/2009, Res. COFFITO 414/2012, Res. CFO-SEC-91/2009, Res. CFN 594/2017. Res. CFFa 777/2025 lida em compilação de terceiro. |

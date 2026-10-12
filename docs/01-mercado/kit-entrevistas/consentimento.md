# Consentimento para entrevista de pesquisa

> **Status:** revisado pelo Guardião LGPD em 13/10/2026: APROVADO com ressalvas ([parecer](../../03-seguranca-lgpd/revisoes/2026-10-13-kit-entrevistas.md)). Antes da 1ª entrevista, preencher os campos entre colchetes e registrar o tratamento no ROPA (item 10 da §3).
> Base: plano de piloto §7 ("gravação só com consentimento", controladores neste tratamento, registro no ROPA, retenção de 12 meses, armazenamento no Brasil com acesso restrito).

## 1. Texto para ler no início (cerca de 1 minuto)

> "Antes de começar, preciso da sua autorização. Esta conversa é uma **pesquisa de mercado** de [nomes dos sócios, ou razão social quando a empresa existir], que está desenvolvendo um software para clínicas. A finalidade é **só** entender a rotina e as necessidades de clínicas como a sua, para decidirmos o que construir e quanto cobrar. Não é venda.
>
> Vou **anotar** suas respostas. Se você autorizar, também vou **gravar só o áudio**, para não perder detalhes. Você pode dizer não à gravação e continuar a conversa normalmente, e pode pedir para parar a gravação a qualquer momento; nesse caso, apagamos o áudio.
>
> As anotações ficam **sem o seu nome**: usamos um código. Seu nome e contato ficam numa lista separada, com acesso só dos dois sócios. Em até **12 meses** a partir de hoje apagamos a gravação, as anotações brutas, seu nome, seu contato e a ligação entre você e o código; depois disso sobram só respostas que não permitem saber quem respondeu. Não vendemos nem repassamos essas informações. Se usarmos alguma frase sua em material interno, ela vai sem identificação.
>
> [Só se a entrevista for por videochamada e a gravação for feita pela própria ferramenta:] A gravação é feita pelo [nome da ferramenta], que pode guardar ou processar o áudio fora do Brasil. Se preferir, gravamos só no nosso computador, ou não gravamos.
>
> **Por favor, não mencione nome ou qualquer informação que identifique pacientes.** Se acontecer, eu não vou anotar e apago o trecho da gravação.
>
> Você pode parar a qualquer momento, pular perguntas e, depois, pedir para ver, corrigir ou apagar o que registramos, ou retirar esta autorização, pelo e-mail [e-mail de contato dos sócios].
>
> Você autoriza: (1) que eu anote? (2) que eu grave o áudio?"

Registre na planilha (colunas `consent_anotar` e `consent_gravar`) a resposta **com a data**, e diga em voz alta no início da gravação: "Hoje é [data], entrevista [código], e a pessoa autorizou a gravação." Se a pessoa disser não para anotar, agradeça e encerre: sem consentimento, não há registro.

## 2. Versão escrita (para enviar por e-mail ou WhatsApp antes, se a pessoa preferir)

> **Autorização para entrevista de pesquisa**
> - **Quem trata os dados (controladores):** [nomes dos sócios, ou razão social e CNPJ quando a empresa existir], contato [e-mail].
> - **Finalidade única:** pesquisa de mercado para definir o produto e o preço de um software para clínicas.
> - **Base legal:** seu consentimento (LGPD, art. 7º, I), que você pode retirar a qualquer momento.
> - **O que registramos:** porte e tipo da clínica, UF, sistemas usados, respostas às perguntas e, se você autorizar, o áudio. Seu nome e contato ficam numa lista separada.
> - **O que não registramos:** nenhum dado de paciente, nem vídeo ou tela.
> - **Prazo:** em até 12 meses a partir da data da entrevista apagamos áudio, anotações brutas, nome, contato e a ligação entre você e o código. Ficam só respostas sem identificação.
> - **Onde fica:** pasta com acesso restrito aos dois sócios, em serviço com dados no Brasil [indicar o serviço]; nunca no repositório de código. Se a entrevista for por videochamada gravada pela própria ferramenta [indicar qual], o áudio pode ser processado fora do Brasil; você pode recusar essa forma de gravação.
> - **Seus direitos:** recusar, parar a qualquer momento, pedir acesso, correção ou eliminação e retirar a autorização pelo e-mail acima (LGPD, arts. 8º, §5º, e 18). Respondemos em até 15 dias.
>
> ( ) Autorizo anotações  ( ) Autorizo gravação de áudio  ( ) Não autorizo gravação
> ( ) Se a gravação for feita pela ferramenta de videochamada, estou ciente de que o áudio pode ser processado fora do Brasil
> Data: ____/____/______

## 3. Regras de dados para os sócios (não ler para o entrevistado)

1. **Nunca coletar dado de paciente.** Não anotar nome, idade, diagnóstico, caso clínico identificável, prints ou arquivos do sistema da clínica. Se o entrevistado mostrar uma tela com paciente, peça para fechar e não grave a tela. Exemplos de casos só no genérico ("uma paciente de pós-operatório").
2. **Sem gravação de vídeo nem de tela.** Só áudio, e só com o "sim" do item 1.
3. **Paciente citado por engano:** se um paciente for identificado na conversa (nome ou detalhe que permita reconhecê-lo), não anote e, se houver gravação, apague o áudio inteiro em até 7 dias, depois de conferir as anotações. Na coluna `observacoes`, registre só "áudio apagado por menção a paciente".
4. **Separação:** o `planilha-respostas.csv` e qualquer nota no repositório levam **só o código** (E01...). Nome, telefone, e-mail, nome da clínica, termo assinado e a chave código ↔ pessoa ficam na planilha privada dos sócios, fora do git.
5. **Nada de anotação que identifique por contexto:** no CSV, cidade só em UF ou "capital/interior"; a coluna `data` só com ano e mês (AAAA-MM), porque o dia exato fica na planilha privada; nada de nome de clínica, bairro, sistema muito raro ou detalhe que torne a pessoa reconhecível. `citacao_chave` e `observacoes` sem nome e sem detalhe identificador.
6. **Áudio e gravação:** fora do git, em pasta restrita no Brasil. Prefira gravar no computador do sócio, não na nuvem da ferramenta de videochamada. Se usar a gravação da própria ferramenta (Google Meet, Zoom etc.), avise a pessoa (texto do item 1), obtenha o "ciente", baixe o arquivo para a pasta restrita e **apague a cópia da ferramenta** no mesmo dia. Não envie áudio, transcrição ou anotação bruta a ferramenta de transcrição ou de IA de terceiros (incluindo assistentes de IA usados pelos sócios) sem o Guardião aprovar o fornecedor e o mecanismo de transferência internacional (LGPD, art. 33).
7. **Retenção de 12 meses:** crie um lembrete na agenda para a data de exclusão de cada entrevista (data + 12 meses, coluna `data_exclusao`). Apague áudio, anotações brutas, contato, termo assinado e a chave código ↔ pessoa; o CSV sem identificação e o resumo agregado podem ficar. Se a pessoa recusar a entrevista ou não responder ao convite, apague o contato dela da lista de prospecção em até 30 dias.
8. **Pedido do titular** (ver, corrigir, apagar, retirar o consentimento): atender em até 15 dias e registrar que foi atendido. A retirada do consentimento apaga o áudio e as anotações da pessoa; a linha do CSV também sai enquanto ainda for possível ligá-la à pessoa.
9. **Controladores:** neste tratamento os controladores somos nós (os sócios, ou a empresa quando constituída), identificados por nome e e-mail no texto do item 1. Não usar só "o projeto".
10. **ROPA:** antes da 1ª entrevista, pedir ao Guardião para registrar este tratamento: finalidade; base legal (consentimento, art. 7º, I, para a entrevista; legítimo interesse, art. 7º, IX, para o contato de prospecção pelo canal público); retenção; local; ferramentas usadas.
11. **Contato de prospecção:** convites só pelo canal público ou indicado; sem scraping, compra de lista ou disparo em massa (README).

# Consentimento para entrevista de pesquisa

> **Status:** rascunho, pendente de revisão do Guardião LGPD e, quando houver, do advogado (D8). Não usar antes do OK do Guardião.
> Base: plano de piloto §7 ("gravação só com consentimento", controladores neste tratamento, registro no ROPA, retenção de 12 meses, armazenamento no Brasil com acesso restrito).

## 1. Texto para ler no início (cerca de 1 minuto)

> "Antes de começar, preciso da sua autorização. Esta conversa é uma **pesquisa de mercado** de [nome do projeto/empresa ou nomes dos sócios], que está desenvolvendo um software para clínicas. A finalidade é **só** entender a rotina e as necessidades de clínicas como a sua, para decidirmos o que construir e quanto cobrar. Não é venda.
>
> Vou **anotar** suas respostas. Se você autorizar, também vou **gravar só o áudio**, para não perder detalhes. Você pode dizer não à gravação e continuar a conversa normalmente.
>
> As anotações ficam **sem o seu nome**: usamos um código. Seu nome e contato ficam numa lista separada, com acesso só dos dois sócios. Tudo, incluindo a gravação, é **apagado em até 12 meses** a partir de hoje. Não vendemos nem repassamos essas informações. Se usarmos alguma frase sua em material interno, ela vai sem identificação.
>
> **Por favor, não mencione nome ou qualquer informação que identifique pacientes.** Se acontecer, eu não vou anotar.
>
> Você pode parar a qualquer momento, pular perguntas e, depois, pedir para ver, corrigir ou apagar o que registramos, pelo e-mail [e-mail de contato dos sócios].
>
> Você autoriza: (1) que eu anote? (2) que eu grave o áudio?"

Registre na planilha (colunas `consent_anotar` e `consent_gravar`) a resposta **com a data**, e diga em voz alta no início da gravação: "Hoje é [data], entrevista [código], e a pessoa autorizou a gravação." Se a pessoa disser não para anotar, agradeça e encerre: sem consentimento, não há registro.

## 2. Versão escrita (para enviar por e-mail ou WhatsApp antes, se a pessoa preferir)

> **Autorização para entrevista de pesquisa**
> - **Quem trata os dados:** [nome do projeto/empresa ou nomes dos sócios], contato [e-mail].
> - **Finalidade única:** pesquisa de mercado para definir o produto e o preço de um software para clínicas.
> - **O que registramos:** porte e tipo da clínica, cidade/UF, sistemas usados, respostas às perguntas e, se você autorizar, o áudio. Seu nome e contato ficam numa lista separada.
> - **O que não registramos:** nenhum dado de paciente.
> - **Prazo:** apagamos tudo (anotações, áudio e contato) em até 12 meses a partir da data da entrevista.
> - **Onde fica:** pasta com acesso restrito aos dois sócios, em serviço com dados no Brasil [indicar o serviço]; nunca no repositório de código.
> - **Seus direitos:** recusar, parar a qualquer momento, pedir acesso, correção ou eliminação pelo e-mail acima (LGPD, art. 18).
>
> ( ) Autorizo anotações  ( ) Autorizo gravação de áudio  ( ) Não autorizo gravação
> Data: ____/____/______

## 3. Regras de dados para os sócios (não ler para o entrevistado)

1. **Nunca coletar dado de paciente.** Não anotar nome, idade, diagnóstico, caso clínico identificável, prints ou arquivos do sistema da clínica. Se o entrevistado mostrar uma tela com paciente, peça para fechar e não grave a tela. Exemplos de casos só no genérico ("uma paciente de pós-operatório").
2. **Sem gravação de vídeo nem de tela.** Só áudio, e só com o "sim" do item 1.
3. **Separação:** o `planilha-respostas.csv` e qualquer nota no repositório levam **só o código** (E01...). Nome, telefone, e-mail, nome da clínica e a chave código ↔ pessoa ficam na planilha privada dos sócios, fora do git.
4. **Nada de anotação que identifique por contexto:** no CSV, cidade só em UF ou "capital/interior"; nada de nome de clínica, bairro ou detalhe que torne a pessoa reconhecível. Citações sem nome.
5. **Áudio:** fora do git, em pasta restrita no Brasil. Não enviar a ferramenta de transcrição ou IA de terceiros sem o Guardião aprovar o fornecedor.
6. **Retenção de 12 meses:** criar um lembrete na agenda para a data de exclusão de cada entrevista (data + 12 meses). Apagar áudio, anotações brutas e contato; o CSV anonimizado e o resumo agregado podem ficar.
7. **Pedido do titular** (ver, corrigir, apagar): atender em até 15 dias e registrar que foi atendido.
8. **ROPA:** antes da 1ª entrevista, pedir ao Guardião para registrar este tratamento (finalidade, base legal: consentimento, art. 7º, I; retenção; local).
9. **Contato de prospecção:** convites só pelo canal público ou indicado; sem scraping, compra de lista ou disparo em massa (README).

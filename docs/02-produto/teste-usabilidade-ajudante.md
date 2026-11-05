# Teste de usabilidade do Ajudante

> Frente: FRONT (rodada 8) · Versão 0.1 · 12/10/2026
> Objetivo: confirmar que profissionais com pouca familiaridade com tecnologia fazem as tarefas principais **sem manual**.
> Regra do produto: se precisar de manual, a tela está errada.

## Quem participa

5 pessoas reais, uma de cada perfil:

1. recepcionista de clínica de fisioterapia;
2. fisioterapeuta autônomo;
3. psicóloga que atende sozinha;
4. terapeuta ocupacional;
5. dona ou gerente de clínica pequena.

Critério de escolha: usa computador ou celular no trabalho, mas **não** se considera "boa com tecnologia". Ninguém da equipe do produto.

## Regras de privacidade (inegociáveis)

- Só a **demonstração com pacientes fictícios** (o aviso aparece no topo de toda tela). Nenhum dado real.
- Pedir ao participante que **não digite nome de paciente de verdade**. Se digitar, apagar na hora e anotar só "digitou nome real" (sem o nome).
- Gravação de tela só com consentimento escrito, só da tela (sem rosto, sem voz), guardada fora do git e apagada em 30 dias.
- O texto digitado no Ajudante não sai do navegador (é a regra do código); ainda assim, o moderador não copia o que foi digitado para as anotações, só a ideia ("procurou pelo telefone").

## Preparação (5 min)

- Notebook com a demonstração aberta em `/inicio` e um celular com a mesma tela (para a tarefa 5).
- Dizer só isto: "Você vai usar um sistema novo de clínica. Faça do jeito que achar melhor. Não existe resposta errada; quem está sendo testado é o sistema. Pense em voz alta."
- **Não** explicar o Ajudante, os atalhos nem o menu.

## As 5 tarefas

| # | Tarefa (lida em voz alta, sem dar o caminho) | Sucesso quando | Tempo-alvo |
|---|---|---|---|
| 1 | "A paciente Maria Silva ligou. Abra a ficha dela." | Ficha da Maria Silva aberta | ≤ 30 s |
| 2 | "Marque uma consulta para o João Pereira na próxima quinta, às 14h." | Consulta gravada com dia e hora certos (a pessoa apertou "Confirmar consulta") | ≤ 60 s |
| 3 | "Quem ainda não confirmou a consulta de hoje?" | Lista "Falta confirmar" na tela e a pessoa lê pelo menos um nome | ≤ 30 s |
| 4 | "A Ana Souza pediu para mudar a consulta dela para sexta. Faça isso." | Consulta da Ana remarcada para sexta | ≤ 90 s |
| 5 | (no celular) "Você não sabe como cancelar uma consulta. Descubra como." | A pessoa chega ao passo a passo "Como cancelar uma consulta" ou cancela de fato | ≤ 60 s |

Observar, sem ajudar:

- a pessoa achou o botão "Ajudante" sozinha? Em quanto tempo?
- escreveu do jeito dela ("marca o joão quinta 2 da tarde")? O Ajudante entendeu?
- escolheu "Fazer por mim" ou "Me mostra como"? Entendeu que precisava apertar "Confirmar"?
- usou o "Desfazer" quando errou?
- em que ponto parou, voltou ou perguntou algo.

Ajuda do moderador: só depois de 2 minutos travada na mesma tarefa, e conta como **falha** daquela tarefa.

## Perguntas depois (5 min)

1. De 1 a 5, quão fácil foi? (1 = muito difícil, 5 = muito fácil)
2. Teve alguma palavra que você não entendeu?
3. O Ajudante fez algo que você não esperava?
4. Você confiaria em deixar o Ajudante preencher para você? Por quê?

## Métrica de sucesso

| Métrica | Meta para aprovar | Como medir |
|---|---|---|
| Taxa de sucesso por tarefa | ≥ 80% (4 de 5 pessoas) em **cada** tarefa | Sucesso sem ajuda do moderador |
| Taxa de sucesso geral | ≥ 90% (≥ 23 de 25 tarefas) | Soma das 5 tarefas × 5 pessoas |
| Tempo | Mediana dentro do tempo-alvo em pelo menos 4 das 5 tarefas | Cronômetro do moderador |
| Descoberta do Ajudante | ≥ 4 de 5 pessoas acham o botão sozinhas na tarefa 1 ou 2 | Observação |
| Entendimento da confirmação | 5 de 5 entendem que o Ajudante não grava sozinho | Pergunta 3 + observação |
| Facilidade percebida | Média ≥ 4,0 (de 5) | Pergunta 1 |
| Palavras difíceis | Nenhuma palavra citada por 2 pessoas ou mais | Pergunta 2 |

Se alguma meta não for atingida, a tela ou a frase do Ajudante é corrigida e a tarefa é repetida com outras 3 pessoas.

## Resultado

Preencher depois das sessões (sem nome dos participantes, só o perfil):

| Perfil | T1 | T2 | T3 | T4 | T5 | Nota (1–5) | Observações |
|---|---|---|---|---|---|---|---|
| Recepção | | | | | | | |
| Fisioterapia | | | | | | | |
| Psicologia | | | | | | | |
| Terapia ocupacional | | | | | | | |
| Gestão | | | | | | | |

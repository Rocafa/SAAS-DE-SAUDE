# Parecer do Guardião LGPD: kit de entrevistas com clínicas

> Data: 13/10/2026 · Escopo: `docs/01-mercado/kit-entrevistas/consentimento.md`, cabeçalho de `planilha-respostas.csv` e as seções de canais e formato do `README.md`. Só documentação, nenhum dado real.
> Não é parecer jurídico. Neste tratamento **nós somos os controladores**: os sócios, ou a empresa quando for constituída.

## Veredito: APROVADO com ressalvas

Os ajustes necessários **já foram aplicados** em `consentimento.md`. As ressalvas R1 a R3 abaixo são condições para usar o kit, não correções de texto.

## O que estava bom

- A finalidade é única e declarada, e o texto avisa que a entrevista não é venda.
- A base legal é o consentimento (art. 7º, I), adequado aqui: a pessoa entrevistada não depende de nós e pode recusar sem prejuízo.
- Anotar e gravar são autorizações separadas, a recusa da gravação não encerra a conversa e o consentimento fica registrado com data.
- O texto proíbe dado de paciente, vídeo e gravação de tela.
- Quem respondeu é identificado por código, e a chave código ↔ pessoa fica fora do git.
- O CSV não tem coluna de nome, contato ou clínica.
- A retenção de 12 meses tem coluna `data_exclusao`.
- O README proíbe scraping, compra de lista e disparo em massa, e o convite dá opção de não receber mais mensagens.

## Ajustes aplicados em `consentimento.md`

| # | Problema | Correção |
|---|---|---|
| A1 | O texto prometia "apagamos tudo" em 12 meses, mas as regras mantêm o CSV. É promessa falsa ao titular. | O texto agora diz o que é apagado (áudio, anotações brutas, contato, termo e a chave código ↔ pessoa) e o que fica (respostas sem identificação). |
| A2 | A entrevista é por videochamada (README, formato), e a gravação nativa de Meet ou Zoom pode processar o áudio fora do Brasil. Não havia aviso nem mecanismo (art. 33). | Inclui aviso e "ciente" opcional, preferência por gravar no computador do sócio e cópia da ferramenta apagada no mesmo dia. Áudio, transcrição ou nota bruta só vão a IA ou transcrição de terceiros com fornecedor aprovado. |
| A3 | Não havia regra para paciente citado por engano na gravação. | Áudio apagado inteiro em até 7 dias, com registro neutro na planilha. |
| A4 | Faltava dizer que é possível retirar o consentimento da gravação durante a conversa e depois dela. | Incluído o direito de retirar o consentimento (art. 8º, §5º) e o efeito disso: apagar áudio, anotações e a linha do CSV enquanto ela ainda puder ser ligada à pessoa. |
| A5 | O risco de reidentificação no CSV, que vai para o git, era alto: são poucas entrevistas e havia data exata, nicho, subnicho, UF e campos livres. | A coluna `data` passa a ter só AAAA-MM no CSV. `citacao_chave` e `observacoes` ficam sem detalhe identificador. |
| A6 | O controlador estava indefinido ("projeto"). A versão escrita não citava a base legal. | Os controladores aparecem por nome e e-mail, e a base legal está na versão escrita. |
| A7 | Os contatos de prospecção (de quem recusou ou não respondeu) não tinham prazo de eliminação nem base legal registrada. | Contatos apagados em até 30 dias; o ROPA registra legítimo interesse (art. 7º, IX) para a prospecção pelo canal público. |

## Ressalvas (condições para usar)

- **R1:** registrar o tratamento no ROPA antes da 1ª entrevista (item 10 da §3).
- **R2:** preencher os colchetes antes de usar: nomes dos controladores, e-mail de contato, serviço de armazenamento no Brasil e ferramenta de videochamada. O kit não pode ser usado com `[...]` em aberto.
- **R3:** se for usada alguma ferramenta de transcrição ou de IA, ela passa antes pelo Guardião.

## Observação fora do escopo

O `planilha-respostas.csv` está correto como modelo. Quando for preenchido, cada linha nova no git passa pela regra 5 da §3.

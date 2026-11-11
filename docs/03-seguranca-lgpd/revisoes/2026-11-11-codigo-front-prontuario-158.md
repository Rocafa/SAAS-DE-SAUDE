# Parecer do Guardião: código do prontuário do front na API real (S1 do E4)

> 11/11/2026 · Guardião LGPD & Segurança · revisão de **código**, PR #158 (autor Lopesloro), commit `52ab4bd`.
> Referência: plano do E4 no PR #157 (`docs/04-arquitetura/front-na-api-real.md`, regras R-A e R-C).
> Conferido contra `origin/main`: `apps/api/src/modules/records/prontuario.controller.ts`, `prontuario.service.ts`, `prontuario.validation.ts` e `modelos.ts`. Não rodei a bateria; a análise é de leitura.

## Veredito: **VETADO**

A parte de sigilo está certa. O adaptador não recalcula visibilidade, nenhuma mensagem leva valor clínico, não há log nem storage, a URL só leva ids, e `entrarComo`/`usuariosDemo` recusam com 501 no modo http. O veto vem de outro lugar. Duas das cinco rotas não funcionam contra a API real, e os testes passam porque o mock devolve o que a API nunca devolveria. É o verde falso que o plano proíbe. Um dos defeitos ainda faz a tela abrir vazia um registro que já existe, o que fere a integridade do prontuário.

## Conferência

| Ponto | Resultado |
|---|---|
| Sigilo decidido só pelo servidor (`paraRegistro`) | ok. `conteudoOculto` e `motivoOculto` passam direto (`http.ts:79-98`); ver R3 |
| Valor de campo clínico fora de mensagem de erro | ok. 400 e 409 `registro_incompleto` usam só nomes de campo (`http.ts:270-300`); 501 `campo_sem_lugar` cita só ids |
| Nada em log, storage ou URL | ok. Varredura existente cobre `http.ts`; URLs só com uuid e `encodeURIComponent` |
| `mfa_recente_obrigatorio` traduzido | parcial. Ok quando vem como `motivoOculto` na lista (`page.tsx:23`); falha quando vem como 403 (R1) |
| 501 em vez de cair no fake (`listarAnexos`, `linhaDoTempo`) | ok (`http.ts:808-809`) |
| `entrarComo`/`usuariosDemo` recusados no modo http | ok (`selecionar.ts:66-73`), com teste (`http.test.ts:826`) |
| Contrato das rotas | **falha** em `obterRegistroDoAgendamento` e `salvarRascunho` (V1, V2) |
| Testes provam o comportamento | **falha** (V3) |

## Pendências que bloqueiam

- **V1 — `obterRegistroDoAgendamento` chama a rota errada (`http.ts:787-794`).** `GET /atendimentos/:id` procura pelo id do **atendimento** (`prontuario.service.ts:488-495`, `eq(encounters.id, id)`). O adaptador passa o id do **agendamento**. A resposta é sempre 404, e o `catch` transforma o 404 em `null`. Resultado: a tela abre o formulário vazio mesmo quando já existe rascunho ou registro assinado. É o "cair no vazio" que a R-A proíbe, e induz o profissional a reescrever a evolução sobre uma versão que ele não viu. Correção: não há rota de leitura por agendamento na API. Ou se cria uma (`GET /atendimentos?agendamentoId=` ou similar, com auditoria de leitura), ou o método recusa com 501 até ela existir. Não use `POST /atendimentos` para ler: ele é escrita, exige check-in e grava trilha de abertura. O 404 → `null` só vale quando a rota certa disser "não existe".
- **V2 — `salvarRascunho` não manda `versaoBase` e erra o formato da medida (`http.ts:123-134`, `:796-800`).** (a) `validarSalvamento` exige `versaoBase` (`prontuario.validation.ts:75-77`). Sem ele, todo salvamento leva 400. (b) A trava de versão é o controle de integridade do registro (`versao_desatualizada`, 409). A correção **não** pode ser copiar `aberto.versao` da resposta do `POST` feito logo antes. Isso anula a trava e sobrescreve o que outra aba gravou. O `versaoBase` tem de ser a versão que a tela leu. Para isso, `Registro` precisa carregar `versao`, e `salvarRascunho` precisa recebê-la. Traduza o 409 `versao_desatualizada` para uma mensagem própria ("o registro mudou; recarregue"). (c) A API espera `Medida` com `tipo` e `valor: number` (`modelos.ts:18-22`). O adaptador manda `{ nome: 'dor', valor: '7' }`, que leva 400. Use o tipo EVA da lista `TIPOS_DE_MEDIDA`, converta para número e recuse com mensagem própria se não for inteiro de 0 a 10.
- **V3 — Testes com verde falso (`http.test.ts:736-800`).** Os testes de rascunho, de medida e do registro por agendamento simulam respostas que a API real não dá. O de rascunho aceita um corpo sem `versaoBase`. O de medida fixa `{ nome, valor: '7' }`, formato que a API recusa. O de 404 prova o `catch`, mas não que a rota é a certa. O teste de contrato (`:790-813`) compara a tela com uma lista **copiada à mão** de `modelos.ts`. Ele também declara `plano: 'plano'` como traduzido, mas `paraConteudoDaApi` não traduz `plano`: com valor preenchido, recusa com 501. O teste diz que existe uma tradução que o código não faz. Correção: (1) o teste de rascunho confere o corpo exato do `PUT`, `{ conteudo, versaoBase }`, com a versão lida pela tela; (2) o de medida confere o formato de `modelos.ts`; (3) a lista do teste de contrato vem de fonte única. Exportar os textos por modelo em `@plataforma/shared` resolve, ou um teste na API que falhe se a lista mudar. (4) `plano` vira `planoDeSessoes` de verdade, ou sai de `traduzidos` e aparece como "sem campo na API". (5) Um caso de `obterRegistroDoAgendamento` confere o caminho chamado.

## Recomendações (não bloqueiam)

- **R1 — 403 `mfa_recente_obrigatorio` cai na mensagem genérica (`http.ts:281-285`).** `obter`, `salvar`, `finalizar` e `adendo` da psicologia recusam com **403** e esse código (`prontuario.service.ts:213`, `:581-591`). O front mostra `MENSAGENS.proibido`, que é a mensagem errada que o próprio PR corrigiu na lista. Acrescente o código ao ramo 403 com a mesma mensagem de `page.tsx:23`, mais um teste.
- **R2 — Histórico truncado sem aviso (`http.ts:783-786`).** A API pagina com limite de 20 (máximo 50) e devolve `temMais`. O adaptador lê só a página 1 e ignora `temMais`. A pessoa vê um prontuário incompleto como se fosse completo. Use `comTruncado` (já existe em `tipos.ts`) ou pagine até um teto, como a busca de pacientes já faz (`http.ts:611`).
- **R3 — Defesa em profundidade no `paraRegistro` (`http.ts:79-98`).** Com `conteudoOculto: true`, zere `campos` e `adendos` mesmo se o servidor mandar conteúdo por engano. Isso não é recalcular sigilo. É obedecer à bandeira do próprio servidor, como o fake já faz (`fake.ts:263`).
- **R4 — A mensagem de MFA promete um fluxo.** "Confirme o código de verificação outra vez" só vale se a tela oferecer esse caminho. Confirme que existe, ou ajuste o texto até existir.

## Notas

- **N1 —** A mensagem de `campo_sem_lugar` mostra ids técnicos ("objetivo, atividades"). Passe pelos rótulos de `NOMES_CAMPOS`. Não é risco; é clareza.
- **N2 —** Na terapia ocupacional, `objetivo` e `atividades` são obrigatórios na tela e não existem na API. Todo salvamento de TO vai dar 501. A recusa explícita é correta, mas o produto precisa saber que a TO fica sem prontuário no modo http.
- **N3 —** Positivo: a recusa de `entrarComo`/`usuariosDemo` fecha de vez o achado ALTA do #92 do lado da função, não só do botão.

Corrigidos V1 a V3, basta nova conferência dos testes, sem nova rodada de desenho.

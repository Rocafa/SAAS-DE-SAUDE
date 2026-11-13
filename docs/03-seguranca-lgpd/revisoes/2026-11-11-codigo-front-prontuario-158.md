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

---

## Reconferência: 12/11/2026

> Guardião LGPD & Segurança · commit `e7fd34a` ("encolhe o S1 ao que de fato funciona contra a API"), head atual do PR #158.
> Conferido contra `origin/main` (`prontuario.controller.ts`, `prontuario.validation.ts`, `auth/mfa.ts`) e contra as telas que chamam o adaptador (`app/(app)/atendimento/page.tsx`, `atendimento/[id]/page.tsx`, `pacientes/[id]/prontuario/page.tsx`). Leitura; não rodei a bateria.

### Veredito: **APROVADO COM RESSALVAS**

O autor escolheu encolher a fatia em vez de remendar, e a escolha é a correta. As duas rotas quebradas passaram a recusar com 501 e mensagem própria. Os testes de verde falso saíram. Nenhuma rota cai no fake em silêncio. O sigilo continua decidido só pelo servidor. Há uma condição antes do merge (C1, uma linha de texto) que não pede nova conferência.

### V1–V3

| Ponto | Resultado |
|---|---|
| V1, `obterRegistroDoAgendamento` | **resolvido.** Recusa com 501 (`semRegistroPorAgendamento`). Não há mais `catch` 404 → `null`, e a tela não abre vazio um registro que existe. |
| V2, `salvarRascunho` | **resolvido.** Recusa com 501 (`semSalvarEvolucao`). Não copia `aberto.versao`, então a trava não foi anulada. O 409 `versao_desatualizada` já tem mensagem própria. `paraConteudoDaApi` e a `Medida` inventada foram removidas. |
| V3, verde falso | **resolvido.** Os testes de rascunho, de medida e de 404 → `null` foram apagados. O teste novo (`V1/V2 do parecer`) prova o 501 dos dois métodos. `plano` deixou de aparecer como "traduzido". Ficaram dois resíduos menores, descritos em R5. |

### R1–R4 e N1–N3

- **R1: feito.** O 403 `mfa_recente_obrigatorio` tem mensagem própria e teste. O mesmo ramo também cobre `mfa_obrigatorio`, que a API usa quando a sessão **nunca** fez MFA (`auth/mfa.ts:39`). Para esse caso, "confirme o código... outra vez" fica impreciso. Ver N4.
- **R2: não feito, registrado no #180.** `listarRegistros` continua lendo só a primeira página (20 itens) e ignora `temMais`. Agora essa é a **única** leitura clínica da fatia, e o prontuário longo aparece incompleto sem aviso. Continua não bloqueando, mas é a próxima correção da fila.
- **R3: não feito, registrado no #180.** Aceito como está. O servidor zera o conteúdo, e o adaptador não o recria.
- **R4: não feito, registrado no #180.** Confirmei que a aplicação não tem caminho de reconfirmar o código. O único MFA do front está em `convite/page.tsx`. A mensagem continua prometendo um fluxo que não existe.
- **N1:** perdeu o objeto, porque o uso de `campoSemLugar` saiu. A chave `MENSAGENS.campoSemLugar` ficou órfã em `http.ts:196`. É limpeza.
- **N2:** registrado no #180 (§4). Ok.
- **N3:** mantido. `selecionar.ts` não mudou.

### O que o encolhimento abriu

- **C1: condição antes do merge. A mensagem de 501 manda o profissional para a demonstração.** O texto atual de `MENSAGENS.semSalvarEvolucao` (`http.ts:198`) diz:

  > "Esta versão ainda não salva a evolução contra o servidor. Use a demonstração até a próxima versão."

  Esse texto orienta a pessoa a escrever uma evolução real no modo fake. Lá não há persistência, auditoria nem retenção de 20 anos (CFM 1.821/2007, Lei 13.787/2018), e o dado real se mistura com dados fictícios. Isso contraria a regra 5 do AGENTS.md e a base de registro do prontuário. Hoje a mensagem não é alcançada pela tela, porque `atendimento/[id]` falha antes (veja A1). Mesmo assim, ela é a mensagem pronta para quando alguém religar a tela. Correção: tirar a orientação. Uma redação possível: "Esta versão ainda não salva a evolução. Registre-a no prontuário que a clínica usa hoje e peça ao suporte." Não precisa de nova conferência.
- **A1: a área de Atendimento fica inteira indisponível no modo http. É fail-closed, sem risco de dado, mas a fatia precisa dizer isso com clareza.**
  - `atendimento/page.tsx:25` faz `Promise.all` de `obterRegistroDoAgendamento` para cada agendamento do dia. Um único 501 derruba a lista toda, e a tela mostra o `Erro` com o texto "Abra pelo prontuário do paciente". Com zero agendamentos no dia, a lista abre vazia normalmente.
  - Em `atendimento/[id]/page.tsx:33`, a consulta falha antes do formulário. Por isso a tela **não oferece "salvar"** e não há digitação perdida. Isso é bom.
  - Consequência: `assinarRegistro` e `adicionarAdendo` só são chamados dessa tela (`:105`, `:120`). Eles funcionam no adaptador, mas **não são alcançáveis pela interface** no modo http. A página do prontuário do paciente só lista. A frase "ficam funcionando na API: listar, assinar e adendo" do commit e do comentário vale para o adaptador, não para o produto. Ajuste o texto do PR e do #180 para "no modo http, a interface só lê o histórico (`listarRegistros`)". O botão "Tentar de novo" do `Erro` repete o 501. Não é risco, só ruído.
- **R5: resíduos de teste (não bloqueiam).** (a) O teste de contrato continua comparando a tela com uma lista copiada à mão. O comentário dele ainda afirma que "o adaptador os converte (dor → medida, plano → planoDeSessoes) ou recusa", e o código já não faz nenhuma das duas coisas. Corrija o comentário agora. A fonte única fica no #180. (b) Sem `salvar`, o teste não protege nada em tempo de execução. Ele vira documentação até o #180.
- **N4: `mfa_obrigatorio` (não bloqueia).** Separe a mensagem de `mfa_obrigatorio`, algo como "Ative o código de verificação para abrir este conteúdo", da de `mfa_recente_obrigatorio`. Pode entrar junto com R4.
- **Sem achado novo de sigilo.** Nenhuma rota cai no fake por herança: `listarAnexos`, `linhaDoTempo`, `entrarComo` e `usuariosDemo` continuam com 501. Nenhuma mensagem leva valor clínico, e a varredura de log e storage segue cobrindo `http.ts`. `finalizar` manda `{}`, como `validarCorpoVazioClinico` exige, e `adendo` manda `{ texto }`, como `validarAdendo` exige.

### Pendências

1. **Antes do merge:** C1 (texto de `semSalvarEvolucao`) e o comentário do teste de contrato (R5a). Não precisam de nova conferência.
2. **Na descrição do PR e no #180:** A1. No modo http, a interface só lê o histórico. Assinar e adendo ficam inalcançáveis até as rotas do #180.
3. **No #180, com prioridade:** R2, porque o histórico truncado é agora a única leitura clínica. Depois R4 e N4, a rota de leitura por agendamento com auditoria e `versao` no contrato.

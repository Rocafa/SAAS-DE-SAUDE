# Re-revisão LGPD & Segurança: correções dos vetos do front (PRs #44, #46 e #47, @Lopesloro)

> Revisor: agente `guardiao-lgpd` (N1, veto) · Data: 2026-10-24 · Repo: `Rocafa/SAAS-DE-SAUDE`.
> Parecer original: [2026-10-12-front-r8.md](2026-10-12-front-r8.md) (vetos B1/B2 no #44, B1 no #46, B3 no #47).
> Commits revisados: #44 `e869470` + `b40d3dd` (base `front/agenda-e-pacientes`); #46 `4fd3bcb`, um merge que traz o #44 corrigido (`7465d1c`) mais a correção própria (base `front/financeiro-guias-mensagens-relatorios`); #47 `380d205` (base `front/configuracoes-ajuda-acesso`). Também conferi a compatibilidade do portal do #47 com o backend do portal em `origin/eng/integracao-r19` (`apps/api/src/modules/portal/`).
> Não é parecer jurídico. Os itens ⚖️ vão para o advogado (D8).

## Vereditos

| PR | Veto original | Resultado da re-revisão |
|---|---|---|
| #44 | B1 (conteúdo clínico), B2 (atestado) | **APROVADO COM RESSALVAS**: B1 e B2 resolvidos |
| #46 | B1 (tabela de permissões) | **APROVADO**: B1 resolvido, mais R11, G6, G7 e G10 |
| #47 | B3 (portal com contrato da clínica) | **APROVADO COM RESSALVAS**: B3 resolvido como desenho de tela. **Ligar o portal à API real fica bloqueado** até os itens P1 a P6 abaixo |

Os vetos estão levantados e a pilha #44 → #47 pode seguir para o merge, desde que o CI rode verde (veja "Verificação").

## Verificação feita

- Li os diffs de cada correção contra a base do PR (`git show`, `git diff`).
- Testes unitários rodados localmente (worktree temporário, já removido):
  - No topo do #44 (`b40d3dd`): `prontuario.test.ts` e `busca.test.ts` deram **51/51**.
  - No topo do #47 (`380d205`): **169/170**, e `tsc --noEmit` passou limpo. As 3 falhas de arquivo (`design.test.ts`, `privacidade.test.ts` e a varredura do `portal.test.ts`) vêm de `new URL('..', import.meta.url).pathname`, que no Windows vira `C:\C:\…`. É problema do teste, não do código.
  - Rodei a varredura do portal à mão (`grep` em `app/(portal)` e `components/portal`) e ela saiu **limpa**: nenhum `DadosProvider`, `ApiClinica`, `lib/api/cliente`, `lib/api/fake` ou `pacienteId`. Também não há `localStorage`, `sessionStorage`, IndexedDB, cookie nem `console`.
- **Não rodei os E2E (Playwright).**
- **O CI dos três PRs não roda.** Todos os jobs falham em cerca de 2 s (infraestrutura do Actions) e "Lint, typecheck e testes" fica `skipping`. **Condição de merge:** CI verde, incluindo os E2E novos de B1/B2/R11 e a troca para `fileURLToPath(new URL('..', import.meta.url))` nos três testes, para rodarem também no Windows.

## #44: B1 e B2 resolvidos

**B1. Conteúdo clínico só para quem cuida do paciente.** Os 7 itens da correção foram atendidos:
1. **Contrato** (`lib/api/cliente.ts`): `listarRegistros` e `obterRegistroDoAgendamento` só devolvem `campos` e `adendos` a quem tem perfil clínico e vínculo de cuidado. A psicologia fica só para o autor. Os demais recebem só metadados, com `conteudoOculto`.
2. **Fake** (`lib/api/fake.ts`): `motivoOculto()` aplica perfil clínico, depois sigilo da psicologia, depois vínculo. Isso vale tanto em `listarRegistros` quanto em `obterRegistroDoAgendamento`. Escrever, assinar e adicionar adendo continuam restritos ao profissional do atendimento.
3. **Flag explícito:** `conteudoOculto` com `motivoOculto` (`perfil_nao_clinico`, `sem_vinculo`, `sigilo_psicologia`). O rascunho vazio deixou de aparecer como "restrito".
4. **Telas:** "Abrir prontuário", "Ver prontuário completo" e o Histórico do atendimento ficam escondidos para perfil não clínico. A rota mostra "Seu perfil não tem acesso ao conteúdo clínico".
5. **Ajudante:** `abrir_prontuario` só para `profissional`. Admin que também é profissional entra como clínico por `ehPerfilClinico` (perfil com `profissionalId`).
6. **Usuários da demonstração:** `u1` virou "Administradora (demonstração)" e entrou `u5`, admin que também é TO.
7. **Testes:** unitário (admin e recepção sem conteúdo, fisio com vínculo lê, `u5` sem vínculo não lê, anexos). E2E com admin no prontuário e no `/atendimento/a02`, recepção na ficha e fisio com vínculo.
- R3 foi corrigido junto: anexo clínico sem nome na lista e na linha do tempo, documento administrativo visível.

**B2. Atestado só pelo profissional que atendeu.** Resolvido.
- O atestado some para perfil não clínico.
- O assinante é fixo no usuário logado, sem seletor.
- Sem vínculo com o paciente, a tela bloqueia.
- `registrarEmissaoDocumento` repete as três checagens no "servidor" (fake) e registra a emissão sem o texto (R5).
- A busca do Ajudante não oferece atestado a admin nem a recepção.
- Testes unitários e E2E cobrem os casos.

**Ressalvas (não bloqueiam; valem para a API real):**
- **R-44a. Definição de vínculo.** O fake considera "qualquer agendamento, passado ou futuro, inclusive cancelado". Na API, o vínculo deve sair do servidor, e não da agenda carregada no navegador como faz o aviso `semVinculo` em `documentos/page.tsx`, que é só usabilidade. Também precisa de regra de expiração, por exemplo alta ou N meses sem atendimento, definida pelo produto com o RT. Agendamento cancelado não deve criar vínculo.
- **R-44b.** `ehPerfilClinico` = "tem `profissionalId`". Na API, a decisão é do servidor (papel e registro profissional ativo) e a tela só reflete. Não pode haver regra de acesso que dependa só do front.
- **R-44c.** Continuam valendo R6 (break-glass) e R12 (leitura de prontuário auditada no servidor).

## #46: B1 resolvido

- A tabela "O que cada um pode fazer" (`components/app/configuracoes.tsx`) agora está assim:
  - Administrador = **Não** para "Ler prontuário dos pacientes que atende", "Assinar o próprio registro", "Ler registro de psicologia" e "Emitir atestado".
  - Profissional: "Sim", "Sim", "Só o autor" e "Sim, em nome próprio".
  - Uma nota explica que o admin que também é profissional segue a coluna Profissional.
  - E2E cobre a linha.
- R11 foi feito: `SoAdmin` em "Usuários e permissões" e "Plano e assinatura"; "Quem acessou o quê" só para admin. Há E2E com a recepção.
  - **Ressalva:** a auditoria também deve ficar visível ao encarregado e ao RT quando esses papéis existirem.
  - O fake não barra `convidar`/`cancelar` por papel. O servidor precisa barrar, como já dito no parecer original.
- G6 ("não pode ser alterado"), G7 (eliminação com certificado) e G10 (dica na lista de espera) foram feitos.
- R9 e R10 (RT separado na exportação, janela de segurança e estado "pausada") **continuam abertos**, com o prazo já definido: antes da API de exportação.

## #47: B3 resolvido no desenho

- **Contrato e provedor próprios.**
  - `lib/api/portal.ts` (`ApiPortal`) não tem `pacienteId` em nenhum método.
  - `PortalProvider` (`components/portal/dados-portal.tsx`) não carrega usuário da clínica, lista de pacientes nem agenda.
  - O layout do portal não usa mais `DadosProvider`.
  - `alterarStatus` genérico foi trocado por `confirmarPresenca`, `avisarAusencia` e `desfazerResposta`. O fake confere a titularidade e responde igual para "não existe" e "não é sua" (IDOR).
  - Teste de varredura impede o portal de importar o contrato ou o provedor da clínica.
- **Junto:**
  - R15: consentimento como histórico append-only, com evento `desfeito`.
  - R8: impressão do recibo no portal.
  - R16: 15 min vindo de `TEMPO_SESSAO_MINUTOS`. Ainda é constante, não configuração por clínica, o que é aceitável até a API.
  - Recibo do portal com "atendimento em saúde" (G2).
- **Ressalva R-47a.** `portal-fake.ts` importa `criarApiFake` (o fake inteiro da clínica). Na demonstração é aceitável, porque simula o servidor. O adaptador HTTP do portal não pode importar `lib/api/fake`, `lib/api/cliente` nem `lib/api/http` da clínica. Estender a varredura a `lib/api/portal*.ts` e a `app/(acesso)/portal/**`.

## Compatibilidade do portal do front (#47) com o backend real (`eng/integracao-r19`)

**O que já está alinhado:**
- O backend separa `/portal/*` (PortalGuard, só a sessão do portal) de `/clinica/portal/*`. Nenhuma rota do portal aceita id de paciente ou de clínica: GET sem query é 400, e id alheio de consulta ou recibo é 404. As escritas passam por transições fechadas (`transicaoDoPortal`). Isso bate com o `ApiPortal` do front.
- **Responsável vê só agenda, financeiro e cadastro.**
  - O backend expõe consultas, recibos, meus-dados, solicitações, consentimentos e `documentos`, que hoje volta vazio (`disponivel: false`).
  - Nenhum conteúdo de prontuário sai pelo portal.
  - O front tem as mesmas 4 áreas e nada clínico.
- **Sigilo do adolescente.**
  - O backend esconde do responsável a consulta e o recibo de área sensível de paciente com 12 anos ou mais. A regra falha fechada: idade desconhecida conta como sigilo.
  - O recibo fica escondido mesmo como "restrito", exceto para o pagador congelado. Há dupla barreira: policy RLS da 0037 e serviço.
  - Paciente com menos de 18 anos agindo como titular não consente (409 `consentimento_pelo_responsavel`). Sem data de nascimento, também não (409 `nascimento_nao_informado`).
  - O front só mostra o que o servidor devolve e não calcula nada disso. **Esse é o comportamento certo e precisa continuar assim.**
- **Convite.**
  - Token só no corpo (query dá 400). O link leva o token no `#fragmento`.
  - Resgate em 2 passos: o OTP vai ao telefone **do cadastro** (do responsável, quando o convite é dele), e quem resgata não informa o destino.
  - Falha sempre igual (409 `convite_invalido`), uso único, hashes no banco.

**O que o front precisa mudar para falar com o backend real.** P1 a P6 bloqueiam ligar a API; P7 e P8 entram junto.

- **P1. Contrato compartilhado.** O pedido citava "`ApiPortal` em `packages/shared`", mas **ele não existe**. `packages/shared/src` só tem `context`, `enums` e `ids`. O contrato vive em dois lugares: no front (`apps/web/lib/api/portal.ts`) e nos DTOs do backend (`portal.service.ts`), e eles divergem (veja P3 e P4).
  - Mover os DTOs (`VinculoDaContaDto`, `ConsultaPortalDto`, `ReciboPortalResumoDto`, `ReciboPortalDto`, `PedidoPortalDto`, `ConsentimentoPortalDto`) e os tipos de pedido e finalidade para `packages/shared`, e fazer o front e a API importarem de lá.
  - Teste de contrato no adaptador.
- **P2. Login e sessão (R14, D4).**
  - **Backend:** ainda não existe login real do portal. Só há `DevPortalSessionProvider` (`Authorization: Bearer ptl_…`, apenas em dev/test, e a API não sobe sem D4). Também não existe rota de OTP de entrada. O OTP que existe é só o do resgate de convite.
  - **Front:** `app/(acesso)/portal/entrar` continua fake (`123456`).
  - Para o navegador, a sessão real deve ser **cookie HttpOnly, Secure, SameSite=Strict, com nome próprio**, separado do cookie da clínica, de preferência em subdomínio do portal, com proteção CSRF. Isso evita token em JS. O adaptador do portal **nunca** guarda o token em `localStorage`, `sessionStorage` ou memória persistente.
  - Requisitos do OTP de entrada: limite de tentativas, validade de 10 min, uso único, mesma resposta para número existente ou não. Retirar o "use 123456" (G8).
- **P3. Vínculos (menores e vários titulares, R13a).**
  - O front não tem a escolha "de quem". Precisa: `GET /portal/vinculos` depois do login; tela de escolha quando houver mais de um; `POST /portal/sessao/vinculo`.
  - Tratar 409 `escolher_vinculo` e `sem_vinculo` e 403 `vinculo_inativo`.
  - Saudação via `GET /portal/sessao` (`primeiroNome`, `clinica`, `agindoComo`), no lugar de `primeiroNome()`. Mostrar "Você está agindo como responsável de X".
  - Na troca de vínculo, descartar todo o estado do `PortalProvider`.
- **P4. Convite do paciente.** O front **não tem** a tela de resgate. `/convite` é o convite da equipe. Criar `/portal/convite` com este fluxo:
  - ler o token de `location.hash` e apagá-lo na hora (`history.replaceState`);
  - fazer `POST /portal/convites/resgate {token}` e mostrar o `destino` mascarado;
  - pedir o código e fazer `POST /portal/convites/resgate/confirmar {token, codigo}`.
  - Regras: nunca levar o token para query, rota, log, analytics ou `Referer`. Usar `Referrer-Policy: no-referrer` na página. Mensagem única para qualquer falha. Opção de digitar o código do convite.
  - O resgate exige sessão do portal (PortalGuard), então a ordem é entrar → resgatar.
- **P5. Consultas.**
  - O DTO traz `status: StatusFront`, que é mais amplo que o `agendado | confirmado | cancelado` do front, mais `podeConfirmar` e `podeCancelar`. Os botões devem seguir **esses flags**, e não o status calculado no front.
  - `avisarAusencia` → `POST /portal/consultas/:id/cancelar`. `desfazerResposta` → `POST …/desfazer-confirmacao`, **que só desfaz confirmação**. O backend não "descancela", então o "Desfazer" depois de "Não vou conseguir ir" tem de sair. No lugar, um passo de confirmação já existente ou o texto "para remarcar, fale com a clínica".
  - Mapear os 409 `prazo_de_cancelamento_encerrado`, `consulta_ja_comecou` e `status_nao_permite` para mensagens claras.
- **P6. Consentimentos.**
  - O backend devolve uma **lista** `ConsentimentoPortalDto` com `titulo`, `explicacao` e `versaoTexto`. O front usa um `Record` e textos próprios (`lib/portal.ts`).
  - Para valer o hash e a versão do texto apresentado (R15), **a tela deve mostrar o texto que veio do servidor**, não o local.
  - Rotas: `POST /portal/privacidade/consentimentos/:finalidade {resposta}` e `…/desfazer`. Tratar 409 `consentimento_pelo_responsavel`, `nascimento_nao_informado` e `nada_a_desfazer` com texto que explique o art. 14 §1º.
- **P7. Recibos e dados.**
  - A lista vem em `valorCentavos`, com `numero` e `situacao` e sem `texto`. Na impressão, buscar `GET /portal/recibos/:id` (`ConteudoDoRecibo`: emitente, pagador, beneficiário, `descricao` neutra, `pendencias`) e montar a folha a partir dele, mostrando "cancelado" quando for o caso. 409 `recibo_eliminado_por_retencao_fiscal` precisa de mensagem.
  - `meusDados`: `telefone` e `cpfMascarado` podem vir `null`, e o DTO traz `nascimento`. Como o front não mostra nascimento, propor tirar o campo do DTO (minimização) ou mostrá-lo como dado do titular.
  - Correção cadastral: `POST /portal/meus-dados/correcao {detalhe}` (mínimo de 3 caracteres).
- **P8. Pedidos do titular.**
  - `POST /portal/solicitacoes {tipo, detalhe?}`. O backend aceita os apelidos do front (`ver_dados`, `corrigir`, `baixar`, `apagar`), mas **devolve o tipo canônico** (`acesso`, `correcao`, `portabilidade`, `eliminacao`, `compartilhamento`), mais `id` e `resposta`. Mapear na exibição.
  - O formato de protocolo e prazo vem do servidor. Não recalcular no front: tirar `prazoResposta` e `protocolo` do caminho real.
  - Tratar 429 (teto diário).
- **Gerais do adaptador:** `credentials: 'include'` só para a origem do portal; `Cache-Control: no-store` nas respostas (R1e); o service worker continua sem cache de `/portal` e da API (G3); a varredura de privacidade também cobre o adaptador.

## O que bloqueia

| Item | Bloqueia? | Quando |
|---|---|---|
| CI verde (unit + E2E) nos 3 PRs e os testes com `fileURLToPath` | **Sim, para o merge** | Agora |
| R-44a, R-44b, R-47a | Não | Antes da API de prontuário e do adaptador HTTP do portal |
| P1 a P6 | **Sim, para ligar o portal à API** | Com D4 / adaptador HTTP do portal |
| P7, P8 | Não, mas entram no mesmo PR do adaptador | Idem |
| R9, R10, R12, R13c ⚖️, R6 | Não | Na história correspondente (já registrado em 12/10) |

## Conferência do contrato ApiPortal (24/10/2026)

**Escopo:** `git diff b6bccfc..origin/eng/integracao-r19` (PR #73): `packages/shared/src/api-portal.ts`, `forma.ts`, `apps/api/src/modules/portal/` (controller, service, `portal-respostas.ts`, `portal-regras.ts`), `portal-contrato.test.ts`, `test/portal.rls.test.ts` (bloco "contrato ApiPortal") e §10h do `api-dominio.md`. Li o código e os testes. Não rodei a suíte. Os números do executor (turbo 12/12, rls 589/589, security 81) ficam como declarados, e a CI do #73 deve confirmá-los.

**Veredito: APROVADO com ressalvas.** P1 está atendido. Nenhuma ressalva bloqueia o merge. C1 e C2 entram antes do adaptador HTTP do front, e C3 a C5 podem entrar no mesmo PR.

### 1. Nada clínico e nada de terceiro no contrato
- **OK.** As formas do contrato não têm conteúdo clínico, especialidade nem tipo de atendimento. Prontuário não sai pelo portal, e `documentos` é a lista vazia literal (`f.vazia`). Nenhuma rota recebe id de paciente ou de clínica (há teste para isso). O titular sai da sessão.
- **OK. A conferência é estrita** (campo a mais = erro) e roda contra as respostas HTTP reais (titular e responsável, Postgres real). Os DTOs são literais tipados com `RespostaPortal<…>`, então o excesso de propriedade também falha no `tsc`. As mensagens de divergência citam só caminho e tipo, nunca o valor.
- **Limite da lista `CAMPOS_CLINICOS_PROIBIDOS`:** ela confere **nomes**, não **valores**. Sozinha, não basta: um campo neutro (`descricao`, `profissional`, `emitente.nome`) pode carregar algo clínico no conteúdo. A proteção real vem de três coisas juntas: (a) a conferência estrita, que obriga qualquer campo novo a mudar o contrato e passar pelo guardião; (b) o filtro no servidor (sigilo da 0037 + RLS); (c) a origem neutra dos valores (`descricao` configurada pela clínica, `registroConselho` só com `show_council_on_receipt`). Por isso, a lista funciona como alarme, não como barreira. **C5:** registrar isso no §10h para ninguém tratá-la como garantia suficiente.
- **Dado de outra pessoa:** o recibo mostra o nome do pagador. Quando o pagador é terceiro, o CPF sai mascarado (`***.***.***-NN`). É o mínimo para o recibo servir ao IR, então aceito. O telefone do convite sai mascarado, com teste de que o número não aparece no corpo.
- **C3 (minimização):** `emitente.profissionalId` é um UUID interno que o front não usa para nada. Retirar do `ReciboPortal`, ou fixar `null` no portal. Hoje a montagem campo a campo copia esse id do retrato.

### 2. Recibo de área sensível do adolescente (regra da 0037)
- **OK.** Para o responsável que **não** é o pagador congelado, o recibo de área sensível (ou de profissional desconhecido, que falha fechado) **não vem na lista**, e o detalhe dá **404 antes de decifrar o retrato**. A barreira está no serviço (`reciboRestrito`) e também na policy `portal_sigilo_adolescente`. Por isso, `reciboParaPortal` nunca recebe um retrato restrito. Quando o responsável é o pagador congelado, o recibo é dele (decisão R1/N1 do #68, mantida). A montagem campo a campo impede que um campo novo do retrato chegue ao portal. Além disso, a asserção de tipo `keyof ConteudoDoRecibo ⇔ keyof ReciboPortal` obriga a decidir cada campo novo de topo.
- **C4 (texto desatualizado):** o comentário de `reciboRestrito` (`portal.service.ts`) ainda diz que o recibo "fica sem profissional e data". O comportamento atual é **404 / fora da lista**. Corrigir o comentário para ninguém reintroduzir a versão "neutra" (que vazava a categoria; N1 do #68).
- **Lacuna de teste (não bloqueia):** o bloco "contrato ApiPortal" do responsável usa um menor de 9 anos sem recibos (lista vazia). O sigilo está provado nos testes do N1 do #68, mas falta um caso de contrato com adolescente: recibo sensível de pagador terceiro (ausente da lista + 404) **e** recibo sensível pago pelo responsável (presente e conforme o contrato). Acrescentar no próximo PR do portal.

### 3. Decisão: `nascimento` em "meus dados"
**Decisão: entra, completo, no formato `AAAA-MM-DD`, para o titular e para o responsável legal.** Não entra como "só ano", e o campo não sai do contrato.

Por quê:
- **Direito do titular (LGPD art. 18, I a III) e qualidade dos dados (art. 6º, V).** "Meus dados" existe para o titular ver e pedir a correção do próprio cadastro. Um dado que a clínica guarda e o titular não vê não pode ser corrigido.
- **A data muda o regime de proteção.** Ela decide a faixa etária, que por sua vez decide o sigilo do adolescente (12+), o consentimento pelo responsável (art. 14 §1º), o fim da representação aos 18 (R3, 0050) e o erro `nascimento_nao_informado`. Uma data errada, se ficar escondida, aplica a regra errada em silêncio. "Só ano" não serve para conferir as fronteiras de 12 e 18 anos.
- **O responsável é o representante legal** do menor (CC arts. 1.634 e 1.690) e exerce os direitos do art. 18 por ele. A data não é clínica e ele já a conhece, então mostrá-la não acrescenta exposição.
- **Base legal:** cumprimento de obrigação legal e exercício de direitos (art. 7º, II e VI). É dado cadastral, não dado sensível do art. 11.

Condições (**C1**, antes do adaptador):
- (a) Tipar o campo no contrato como data `AAAA-MM-DD` (comentário na forma + teste de formato). Hoje é `f.texto` livre.
- (b) A data **não se edita pelo portal**: muda só por `POST /portal/meus-dados/correcao`, analisado pela clínica. Correção vinda do responsável que **reduza a idade** de um adolescente (12+), tirando-o do sigilo, exige conferência documental pela clínica. Registrar isso no fluxo de atendimento do pedido.
- (c) Com `agindoComo = responsavel_legal`, o front rotula a tela como "dados de <primeiro nome do paciente>", e não como dados do responsável.
- (d) Atualizar o §10h e o P7 deste parecer ("em aberto" → esta decisão).

### 4. O guia "como o front liga" (§10h)
O guia está correto no essencial (fonte única, sem cópia local, botões pelos flags, texto de consentimento do servidor, token só no `#fragmento`, cookie da D4). Mas tem pontos que podem induzir a erro (**C2**):
- **`nascimento` "em aberto"**: trocar pela decisão do item 3.
- **`Cache-Control: no-store`** aparece em "O que depende da D4". Ele **já** é enviado pela API (`security/http-security.ts`). Mover para "já vale": o front não deve sobrescrevê-lo, nem cachear em service worker, `localStorage` ou estado persistente.
- **"Nada clínico para o responsável"** pode ser lido como "o recibo é inócuo". Acrescentar: o recibo detalhado pode identificar o profissional (`emitente.nome`, e o conselho quando a clínica o habilita). O front não deve enriquecê-lo (especialidade, ícone por área), nem pré-carregar ou guardar a folha, e deve imprimir só por ação do usuário.
- **`conferirRespostaPortal` no adaptador:** deixar explícito que, em produção, divergência de contrato **não** loga o corpo da resposta (só a rota e as mensagens de caminho).
- **Lista de campos proibidos:** registrar a limitação do item 1 (C5).

| Item | Bloqueia? | Quando |
|---|---|---|
| C1 (`nascimento`: formato, correção só pela clínica, rótulo) | Não para o merge do #73 | Antes do adaptador HTTP do portal |
| C2 (ajustes do §10h) | Não | Antes do adaptador HTTP do portal |
| C3 (`profissionalId` fora do portal), C4 (comentário), C5, teste do adolescente | Não | Próximo PR do portal / do adaptador |

## Conferência C1–C5 (24/10/2026)

**Escopo:** `git diff 668a886..origin/eng/integracao-r19` (PR #73, até `faceb21`): migração `0051_portal_correcao_do_nascimento.sql`, `packages/shared/src/api-portal.ts` e `forma.ts`, `apps/api/src/modules/portal/` (controller, `portal.service`, `portal-clinica.service`, `portal-regras`, `portal-respostas`, `portal-fields`, `portal-export`), `portal-contrato.test.ts`, `portal-regras.test.ts`, `test/portal.rls.test.ts` e §10h do `api-dominio.md`. Também li o `PATCH /pacientes/:id` (`patients.service.ts`, `atualizar` e `recalcularSigiloDoPortal`) e as migrações 0038/0039. Li o código e os testes, mas não rodei a suíte. Os números do Maestro (`faceb21`, banco recriado: turbo 12/12, rls 592/592, security 81) ficam como declarados.

**Veredito: APROVADO com ressalvas.** C2, C3, C4 e C5 estão resolvidas, e o teste do adolescente com responsável não pagador está feito. Da C1, os itens (a), (c) e (d) estão resolvidos. O item (b) está **atendido só na forma**: a conferência de documento trava o *status* do pedido, mas não a *mudança da data*, e dá para contorná-la na ordem normal de trabalho (item C1-b′ abaixo). Isso não bloqueia o merge do #73. **Bloqueia o adaptador HTTP do portal**, como a C1 original.

### O que está resolvido
- **C1 (a):** `nascimento` virou `f.data` (`AAAA-MM-DD` que existe). Há teste para texto livre, data inexistente, só ano e data com hora. Data guardada fora do formato sai `null` (falha fechada).
- **C1 (b), parte que vale:** o portal não tem rota que edite o cadastro (teste: 404). A data proposta vai **cifrada** (`birth_date_proposed_enc`, AAD com a clínica, a tabela, a coluna e o id do pedido), só em pedido `correcao` (CHECK + API) e fica imutável (gatilho). A marca de conferência (`document_checked_by/at`) não pode ser gravada pelo portal, tem autor e hora da sessão da clínica, é única e imutável. A trilha registra só `has_birth_date`, `document_required` e `document_checked`, nunca a data (há teste de que o valor proposto não aparece no `audit_log`). O 400 traz o nome do campo, não o valor. A data atual desconhecida exige documento (falha fechada). O G2 exporta a data proposta e a conferência, o que é coerente com o art. 18, II.
- **C1 (c):** `rotulo` `meus_dados` / `dados_do_paciente`, tipado e testado (inclusive com `seus_dados` recusado).
- **C1 (d):** o §10h e o P7 trazem a decisão.
- **C2:** `no-store` foi para "já vale", o recibo pode identificar o profissional, o front não enriquece, não guarda e não pré-carrega a folha, e divergência de contrato não loga o corpo. Tudo no §10h.
- **C3:** `profissionalId` saiu da forma e da montagem. A asserção de tipo `Exclude<keyof emitente, 'profissionalId'>` obriga a decidir cada campo novo do emitente. Há teste unitário (o campo extra é recusado) e teste HTTP (o UUID não aparece no corpo).
- **C4:** o comentário de `reciboRestrito` agora descreve o comportamento real (404 / fora da lista, sem versão "neutra").
- **C5:** o limite de `CAMPOS_CLINICOS_PROIBIDOS` (só compara nomes, é alarme e não barreira) está registrado no `api-portal.ts` e no §10h.
- **Teste do adolescente:** adolescente de 14 anos, profissional de área sensível. O responsável não pagador não vê o recibo na lista e recebe 404 sem nada do profissional no corpo. O pagador congelado vê o recibo conforme o contrato, sem `profissionalId`. Os dois veem o nascimento completo com `dados_do_paciente`.

### C1-b′ (aberta): a conferência trava o status, não a data
1. **Contorno pela ordem dos passos.** `nascimentoDoPedido` compara a data proposta com a data **atual** do cadastro, no momento de atender. O §10h diz que a troca no cadastro é feita pela clínica no `PATCH /pacientes/:id`. Na ordem natural (corrigir o cadastro e depois marcar o pedido como atendido), quando a clínica atende, `atual == proposto`, então `proposto <= atual` e `exigeDocumento = false`. O pedido fecha sem documento, e o detalhe mostra `exigeConferenciaDeDocumento: false`. O teste RLS só cobre a ordem inversa (atender antes de mudar o cadastro).
   **Correção:** decidir `exigeDocumento` **na abertura** do pedido, contra a data vigente naquele momento. A API calcula esse valor e o grava numa coluna `document_required boolean NOT NULL`, imutável no gatilho da 0051 como `birth_date_proposed_enc`. No atendimento, usar o valor gravado, nunca recalcular contra o cadastro. Teste: abrir o pedido → `PATCH` com a data proposta → atender sem `documentoConferido` → 400.
2. **O caminho direto da clínica não tem a trava (pergunta do Maestro): deve ter.** Hoje `PATCH /pacientes/:id` (permissão `pacientes:escrever`, normalmente a recepção) reduz a idade de um adolescente sem nenhuma conferência. Pelo recálculo da 0038, isso pode **desligar o sigilo do adolescente** e devolver ao responsável o acesso ao que estava protegido, ou **religar a representação** de quem já tinha 18 anos. A 0039 só **avisa depois** (`clinical_notices` + `anomaly_alert`), quando o dano de confidencialidade já pode ter acontecido. Exigir o documento no portal e não exigir na clínica cria uma assimetria: a trava vale só para o caminho que tem menos poder. Além disso, a mudança real da data sempre passa pelo `PATCH`, então hoje a C1 não protege nada na prática.
   **Correção:** no `PATCH /pacientes/:id`, quando `nascimentoMudou` e a data nova **reduz a idade** de paciente com 12 anos ou mais pela data atual (ou a data atual é desconhecida ou ilegível e o paciente tem vínculo ou convite de responsável aberto), exigir `documentoConferido: true` no corpo. Sem ele, responder 400 `campos: ['documentoConferido']`. Reusar `correcaoDeNascimentoExigeDocumento`, para a regra ser a mesma nos dois caminhos. Registrar quem conferiu e quando: na trilha, `document_checked: true` com o usuário da sessão (sem a data), e opcionalmente o `request_id` do pedido de correção quando a mudança vier dele. O cadastro inicial (`POST /pacientes`) fica fora da regra. Testes: (i) recepção reduz a idade de um adolescente de 15 para 11 anos sem a flag → 400, cadastro e sigilo intactos, nenhum aviso gravado; (ii) com a flag → 200, recálculo da 0038 feito, aviso da 0039 gravado, trilha com `document_checked`; (iii) aumentar a idade ou corrigir a de uma criança → 200 sem a flag.
   O ideal é que **atender o pedido aplique a data** na mesma transação (o recálculo da 0038 roda junto), para o pedido e o cadastro não divergirem. Se isso ficar para depois, o item 1 já fecha o contorno.
3. **Observação (não bloqueia):** **aumentar** a idade de forma que o paciente passe dos 18 anos (ou chegue aos 12 anos sendo hoje criança) também muda quem exerce os direitos: a representação acaba e o sigilo é ligado. Isso protege mais a privacidade do paciente, então é aceitável não exigir documento. Mesmo assim, vale gravar `document_required` também nesse caso, se a clínica quiser essa política, e registrar a decisão no §10h.

| Item | Bloqueia? | Quando |
|---|---|---|
| C2, C3, C4, C5, teste do adolescente | — | Resolvidos |
| C1 (a), (c), (d) | — | Resolvidos |
| C1-b′ item 1 (`document_required` gravado na abertura) | Não para o merge do #73 | Antes do adaptador HTTP do portal |
| C1-b′ item 2 (documento também no `PATCH /pacientes/:id`, mesma regra) | Não para o merge do #73 | Antes do adaptador HTTP do portal |
| C1-b′ item 3 (aumento de idade nas fronteiras 12/18) | Não | Decisão de produto, registrar no §10h |

## Conferência 0052 (24/10/2026)

**Escopo:** `git diff faceb21..origin/eng/integracao-r19` (PR #73): `0052_conferencia_de_documento_do_nascimento.sql`, `erros-dominio.ts`, `schema.ts`, `patients.service.ts` e `patients.validation(.test).ts`, `portal.service.ts`, `portal-clinica.service.ts`, `portal-export.ts`, `test/portal.rls.test.ts` (bloco "C1-b′" e os testes antigos ajustados) e §10d/§10h do `api-dominio.md`. Li o código e os testes. Não rodei a suíte: os números do executor (turbo 12/12, rls 596/596, security 81) ficam como declarados.

**Veredito: APROVADO. A C1-b′ itens 1 e 2 está resolvida e o adaptador HTTP do portal está liberado** quanto a esta conferência. As ressalvas abaixo não bloqueiam.

### O que foi conferido
- **Item 1 (`document_required` na abertura).** `POST /portal/meus-dados/correcao` decifra a data vigente e grava `document_required` com `correcaoDeNascimentoExigeDocumento`. A trilha leva `document_required`, sem a data. No banco, a coluna é `NOT NULL`. Quando o pedido é gravado sem essa decisão, o gatilho preenche `true` se houver data proposta (falha fechada). Um CHECK impede `true` sem data proposta, e o campo é imutável no gatilho da 0051. A migração preenche os pedidos antigos com `birth_date_proposed_enc IS NOT NULL`, o que também é falha fechada. O atendimento usa o valor gravado e não recalcula pelo cadastro. O banco recusa `atendida` com `document_required` e sem `document_checked_at` (23514). Há teste da ordem natural que antes contornava a trava (abrir, depois `PATCH` com a data proposta, depois atender sem a flag): resulta em 400 pela API, 23514 por SQL e 42501 ao tentar trocar `document_required`.
- **Item 2 (`PATCH /pacientes/:id`).** A regra é a mesma do portal (mesma função). O 422 `documento_nao_conferido` sai antes do `UPDATE`, e a transação desfaz o resto. O corpo traz só o nome do campo (há teste de que a data não aparece). `documentoConferido` precisa ser booleano, só é aceito junto com `nascimento` e é recusado no `POST /pacientes`. Apagar a data não exige documento: o recálculo fecha, que é a direção segura. Quem conferiu fica na trilha duas vezes, sem a data: no `update` de `patients` (`document_required`/`document_checked`, ator = sessão) e na função do banco (`op: birth_date_document_checked`). Os testes (i), (ii) e (iii) pedidos estão feitos com a sessão da recepção: sem a flag, cadastro, sigilo e avisos ficam intactos; com a flag, o recálculo e o aviso da 0039 acontecem; aumentar a idade ou corrigir a de uma criança passa sem a flag.
- **Trava no banco.** `app_patient_birth_date_document_checked` só aceita a sessão da clínica com usuário, na transação que mudou a data e antes do recálculo (fora disso, 55000). A marca fica na tabela interna da 0038, não numa GUC que daria para forjar, e é zerada se a data mudar de novo. `app_portal_recalc_sigilo` recusa (42501) adiar o dia dos 12 de vínculo ou convite cujo sigilo já valia, quando falta a marca. A conferência final da 0052 checa `SECURITY DEFINER` e dono sem superusuário, sem BYPASSRLS e diferente do runtime. Há teste de SQL arbitrário: sem marca, marca fora de ordem, marca seguida de nova troca da data e sessão do portal são todos recusados.
- **G2.** `documentRequired` é exportado junto com a data proposta e a conferência, coerente com o art. 18, II.
- **Item 3.** A decisão (aumentar a idade não exige documento) está registrada no §10h.

### A lacuna do banco (paciente sem vínculo ou convite de responsável aberto): aceitável
Sem vínculo ou convite aberto, a data errada não muda nenhum acesso no momento: não há responsável no portal para ganhar ou perder sigilo. O risco só aparece depois, se um convite de responsável for criado com a data errada. Para isso acontecer sem a API, é preciso SQL arbitrário na sessão da clínica. É o mesmo resíduo já aceito no R1 (o banco não lê a data cifrada), e esse ator já consegue trocar a cifra e recalcular. A API barra o caminho normal, e a regra está escrita no §10d e no §10h. **Aceito como resíduo**, com as condições abaixo.

### Ressalvas (não bloqueiam)
1. **A conferência é uma declaração de quem está na sessão.** `pacientes:escrever` (a recepção) basta para enviar `documentoConferido: true`, e o banco não tem como saber se o documento foi de fato visto. O que fica é a responsabilização: o ator está na trilha. Recomendo que o front da clínica mostre a confirmação explícita ("conferi o documento original") e que o relatório de anomalias (0039) também conte as mudanças `document_checked: true` por usuário.
2. **Data atual desconhecida exige documento.** Com `atual = null` a função devolve `true`, então informar a data pela primeira vez via `PATCH` (paciente cadastrado sem data) exige a flag até para criança. É falha fechada e aceitável, mas não há teste de `PATCH` nesse caso. Acrescentar um teste e uma linha no §10h.
3. **Código de erro diferente nos dois caminhos.** O `PATCH` responde 422 `documento_nao_conferido` e o atendimento do pedido responde 400 `campos: ['documentoConferido']`. Não é falha de segurança, mas o front precisa tratar os dois. Unificar quando der, ou registrar no §10h.
4. **Resíduo do banco documentado.** Manter no §10d/§10h que a trava do banco cobre só pacientes com vínculo ou convite aberto. Qualquer rotina futura que crie convite de responsável para paciente com 12 anos ou mais deve usar a data vigente (já é o caso) e passar pela API.
5. **Ainda aberto (não bloqueia):** fazer o atendimento do pedido aplicar a data na mesma transação.

| Item | Bloqueia? | Situação |
|---|---|---|
| C1-b′ item 1 (`document_required` na abertura, imutável, banco recusa `atendida`) | — | Resolvido |
| C1-b′ item 2 (documento no `PATCH`, mesma regra, trilha sem a data, trava no recálculo) | — | Resolvido |
| C1-b′ item 3 (aumento de idade nas fronteiras 12/18) | — | Decisão registrada no §10h |
| Lacuna do banco sem vínculo/convite | Não | Resíduo aceito (igual ao R1) |
| Ressalvas 1–5 | Não | Próximas micropartes |
| **Adaptador HTTP do portal** | — | **Liberado** |

## Conferência 0053 (25/10/2026)

**Escopo:** `git diff 17d6887..origin/eng/integracao-r19` (PR #73): `0053_perfil_na_conferencia_de_documento.sql`, `nascimento-do-cadastro.ts` (novo), `patients.service.ts`, `portal-clinica.service.ts`, `portal-export.ts`, `schema.ts`, `test/portal.rls.test.ts` (bloco "Conferência 0052" e os testes antigos ajustados) e §10d/§10h do `api-dominio.md`. Li o código e os testes. Não rodei a suíte: os números do executor (rls 600/600, security 81) ficam como declarados.

**Veredito: APROVADO.** As ressalvas 1, 2, 3 e 5 da Conferência 0052 estão resolvidas, e a 4 está documentada. O adaptador HTTP do portal continua liberado. As ressalvas abaixo não bloqueiam.

### O que foi conferido
- **Ressalva 1 (quem confere).** A trava está no banco e na API. `app_document_check_role` lê o perfil **ativo** em `clinic_members` da clínica da transação (`app_user_has_role` da 0020: `revoked_at IS NULL`). Quem tem os dois perfis fica como `admin`. O perfil nunca vem de quem grava. No pedido, o gatilho sobrescreve `document_checked_role` (há teste de que mandar `'admin'` como profissional grava `profissional`). Ele recusa (42501) quem não tem o perfil, recusa perfil ou autor sem conferência e torna os três campos imutáveis. O CHECK impede perfil sem `document_checked_at`. Na marca da data, `app_patient_birth_date_document_checked` recusa a recepção (42501), grava o perfil na marca e na trilha (`role`, sem a data), e a 0038 zera o perfil junto com a conferência. Um CHECK amarra `document_checked_by` ao `document_checked_role`. A API devolve 403 `conferencia_exige_perfil` antes de qualquer escrita. Há teste de que nada muda: com a recepção registrada no banco, a recusa vem pela API e também pelo SQL na ordem certa. `documentCheckedRole` é exportado no G2. Conferências anteriores à 0053 ficam com perfil nulo e sem backfill. Isso é aceitável: não há como recuperar o perfil da época, e pela API só o admin (`titular:atender`) conferia.
- **Ressalva 2 (data desconhecida).** Com data nula, informar a data de uma criança dá 422, e com a flag dá 200. Com data ilegível, a cifra com AAD de outra linha não vira 500: o erro é isolado num savepoint, conta como desconhecida, exige documento e grava `birth_date_unreadable` na trilha. Apagar a data não exige documento. Há teste dos dois casos, e a trilha não traz a data.
- **Ressalva 3 (um código só).** Os dois caminhos devolvem 422 `documento_nao_conferido` com corpo idêntico (há teste com `toEqual`). O 400 ficou só para corpo inválido. No atendimento, a exigência é a gravada na abertura **ou** a regra contra o cadastro de agora, o que é falha fechada. Há teste de cadastro mudado depois da abertura.
- **Ressalva 5 (atender grava a data).** O fluxo trava a linha do paciente (`FOR UPDATE`), decifra a data vigente e cifra a proposta. Depois roda, na mesma transação, o UPDATE do pedido (o gatilho da 0052 ainda recusa `atendida` sem conferência), o UPDATE de `patients`, a trilha (`request_id`, flags, sem a data), a marca e `app_portal_recalc_sigilo`, e por fim a revogação do titular menor (0050). Com 422 nada muda: o teste confere cadastro, vínculo e pedido. Paciente inativo recebe 409. `em_andamento` e `recusada` não tocam o cadastro.
- **Conferência final da 0053.** `SECURITY DEFINER` e dono sem superusuário, sem BYPASSRLS e diferente do runtime, nas duas funções redefinidas.

### Testes antigos ajustados: não enfraqueceram
- `adminA` passou a ser membro `admin` no banco (`api.membro`). O efeito é só **somar** um destinatário admin real.
- **N1 do #73 (a):** a recepção virou profissional porque o teste chama `app_patient_birth_date_document_checked`, que agora recusa a recepção. O que o teste prova (devolver a cifra na mesma transação fecha o sigilo e volta a representação, com o ator na trilha) não mudou. A recusa da recepção ficou coberta à parte, em "item 2 no banco".
- **O1 (avisos):** o "outro" que não deve ler era `adminA`, que antes era admin só de sessão. Agora é um admin novo só de sessão, então o caso negativo é o mesmo. Ganhou ainda uma asserção positiva: `adminA` recebe `representacao_estendida`.
- **R3 do #68:** `notified: 2 → 3` reflete o admin a mais. A contagem continua exata (`toEqual`), sem afrouxar.
- **Item 2 / item 2 no banco:** os casos positivos passaram ao profissional. Os negativos (sem marca, marca fora de ordem, marca zerada, portal) continuam, e a recepção ganhou recusas novas (403 e 42501). O caso (iii) (aumentar a idade ou corrigir a de uma criança sem a flag) continua com a recepção. Isso **reforça** a cobertura.

### Ressalvas (não bloqueiam)
1. **Atendimento de pedido já conferido antes.** Se a conferência foi gravada num `em_andamento` anterior, a marca da data no atendimento sai em nome de quem atende, e não de quem conferiu. A trilha do pedido tem os dois, mas a marca e o `op: birth_date_document_checked` apontam o atendente. Registrar no §10h ou levar `request_id` na trilha da marca.
2. **Sessão com perfil no token e sem `clinic_members`.** A API passa no 403, mas o banco recusa com 42501, que tende a virar 500. Mapear 42501 da conferência para 403 `conferencia_exige_perfil`, ou garantir que todo usuário de sessão é membro.
3. **Membro revogado.** Falta um teste de que um perfil `admin`/`profissional` com `revoked_at` preenchido não confere. O SQL já cobre esse caso, então o teste serve de regressão.
4. **`nascimentoVigente` engole qualquer erro** (inclusive a falta de chave e erros do banco) e trata como "ilegível". O resultado é falha fechada, porque exige documento e a cifração da data nova falha sem chave. Mas `nascimento: null` com chave ausente passa a apagar a data com `birth_date_unreadable`. Restringir o `catch` aos erros de decifração quando der.
5. **Resíduo da 0052 mantido:** sem vínculo ou convite aberto, só a API protege (§10d/§10h).

| Item | Bloqueia? | Situação |
|---|---|---|
| Ressalva 1 (perfil admin/profissional, banco + API, perfil gravado e exportado) | — | Resolvido |
| Ressalva 2 (data nula/ilegível exige documento) | — | Resolvido, com teste |
| Ressalva 3 (422 único) | — | Resolvido |
| Ressalva 4 (resíduo documentado) | — | Registrado no §10d/§10h |
| Ressalva 5 (atender grava a data na mesma transação) | — | Resolvido |
| Testes antigos ajustados | — | Sem perda de cobertura |
| Ressalvas 1–4 desta conferência | Não | Próximas micropartes |
| **Adaptador HTTP do portal** | — | **Continua liberado** |

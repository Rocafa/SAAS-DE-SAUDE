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

# E4 — o front na API real, por fatias

> Estado em 05/11/2026, contra a `main` em `ac8f2e6` (pilha do front já mergeada pelo #86).
> Este documento é o mapa e a ordem do trabalho. Cada fatia é um PR com teste antes da correção.

## 1. O tamanho real do buraco (medido, não estimado)

O contrato `ApiClinica` (`apps/web/lib/api/cliente.ts`) tem **54 membros**. O adaptador HTTP cobre
**20** (`ApiHttpPacientesAgenda = Pick<…>` em `apps/web/lib/api/http.ts`). Os outros **34 continuam
vindo do adaptador falso**, inclusive no modo `http`, porque `criarApi` faz `{ ...fake, ...http }`
(`lib/api/selecionar.ts`).

```bash
# como reproduzir a conta
sed -n '/export interface ApiClinica/,/^}/p' apps/web/lib/api/cliente.ts | grep -cE "^  [a-zA-Z]+"
sed -n '/ApiHttpPacientesAgenda = Pick</,/>;/p' apps/web/lib/api/http.ts | grep -cE "'[a-zA-Z]+'"
```

Isso é mais do que dívida: hoje, num build apontado para a API real, metade das telas mostraria dado
fictício com a cara de dado real. É por isso que a trava do #100 existe e é por isso que ela **não
pode sair antes desta tabela zerar**.

## 2. O que já tem rota e o que não tem

Contagem sobre as 163 rotas declaradas em `apps/api/test/cobertura-auditoria/lista.ts`:

| Área do contrato | Métodos no fake | Rotas na API | Fatia |
|---|---|---|---|
| Prontuário e atendimento (`listarRegistros`, `obterRegistroDoAgendamento`, `salvarRascunho`, `assinarRegistro`, `adicionarAdendo`, `linhaDoTempo`) | 6 | **15** (`GET /pacientes/:id/prontuario`, `GET /atendimentos/:id`, `GET /atendimentos/:id/versoes`, `POST /atendimentos`, `PUT /atendimentos/:id/registro`, `POST /atendimentos/:id/finalizar`, `POST /atendimentos/:id/adendos`, …) | **S1** |
| Financeiro (`listarRecibos`, `registrarPagamento`, `removerRecibo`, `listarPacotes`) | 4 | **14** (`GET /financeiro/recibos`, `GET /pacotes`, `GET /pacotes/:id/historico`, …) | **S2** |
| Convênios (`listarGuias`, `criarGuia`, `removerGuia`) | 3 | **10** (`GET /guias`, `GET /guias/:id/consumos`, `GET /guias/alertas`, `PATCH /guias/:id`, …) | **S3** |
| Clínica, equipe e trilha (`obterClinica`, `salvarClinica`, `listarEquipe`, `convidar`, `removerAcesso`, `devolverAcesso`, `listarAuditoria`) | 7 | **14** (`GET /clinica/membros`, `POST /clinica/membros`, `DELETE /clinica/membros/:usuarioId/:perfil`, `GET /clinica/auditoria`, …) | **S4** |
| Documentos (`registrarEmissaoDocumento`) | 1 | 1 | **S5** |
| Assinatura do SaaS (`obterAssinatura`, `cancelarAssinatura`, `reativarAssinatura`) | 3 | 1 | **S5** |
| Exportação total (`pedirExportacao`, `aprovarExportacao`) | 2 | 0 (a rota HTTP da G2 entra com a D4) | **S6** |
| Fila de espera (`listarEspera`, `adicionarEspera`, `removerEspera`, `devolverEspera`) | 4 | **0** | **sem rota** |
| Mensagens (`listarConversas`) | 1 | 0 | **sem rota** |
| Anexos (`listarAnexos`) | 1 | 0 | **sem rota** |
| Demonstração (`entrarComo`, `usuariosDemo`) | 2 | — | **morrem no modo http** |

## 3. As três regras que valem para toda fatia

**R-A — nada de cair no fake em silêncio.** Enquanto um método não tem rota, o modo `http` devolve
`ErroApi(501)` com mensagem própria, como `reativarPaciente` já faz (`http.ts`). Hoje o que acontece
é pior que erro: a tela mostra lista vazia ou dado fictício e quem usa acredita. "Ainda não
disponível nesta versão" é informação; `[]` é mentira.

**R-B — a trava de papel migra com a rota.** `exigirAdmin` do fake confere a identidade do fake. Ao
migrar cada rota, o teste de 403 vai para `http.test.ts` e o fake perde a responsabilidade (issue
#148, R5 do parecer do #103).

**R-C — o que é da demonstração não existe no modo http.** `entrarComo` e `usuariosDemo` saem do
objeto montado por `criarApi` quando o modo é `http`, em vez de continuarem vindo do fake — é troca
de papel pelo cliente, e foi o achado ALTA do #92.

## 4. S1 — prontuário e atendimento (a primeira fatia)

Mapa método → rota, para o PR não precisar descobrir isto de novo:

| Contrato | Rota | Observação |
|---|---|---|
| `listarRegistros(pacienteId)` | `GET /pacientes/:id/prontuario` | a redação do sigilo é do SERVIDOR; o adaptador só repassa `conteudoOculto`/`motivoOculto`, nunca decide |
| `obterRegistroDoAgendamento(id)` | `GET /atendimentos/:id` | 404 vira "sem registro ainda", não erro de tela |
| `salvarRascunho(agendamentoId, campos)` | `POST /atendimentos` (primeiro) + `PUT /atendimentos/:id/registro` | idempotência: se o atendimento já existe, é `PUT` |
| `assinarRegistro(id)` | `POST /atendimentos/:id/finalizar` | 422 de campo obrigatório tem de chegar à tela como falta nomeada |
| `adicionarAdendo(id, texto)` | `POST /atendimentos/:id/adendos` | assinado não muda: adendo é a única escrita depois da assinatura |
| `linhaDoTempo(pacienteId)` | `GET /atendimentos/:id/versoes` + prontuário | confirmar no PR se a linha do tempo sai de uma chamada ou de duas |
| `listarAnexos(pacienteId)` | — | **501** até existir rota |

Erros que a fatia tem de traduzir, porque são regra de domínio e não falha técnica:
`mfa_recente_obrigatorio` (pedir o código e repetir), `sigilo_psicologia`, `somente_o_autor`,
`sem_vinculo_de_cuidado`, `perfil_nao_clinico`. Hoje o fake já devolve `motivoOculto` com esses
nomes: a tradução existe e precisa continuar valendo com a resposta do servidor.

## 5. Ordem e por quê

1. **S1 prontuário** — é o fluxo que vende e o que tem mais rota pronta.
2. **S2 financeiro** — recibo é o que o profissional PF precisa todo mês (Receita Saúde).
3. **S3 convênios** — guia simples já está no M1.
4. **S4 clínica, equipe e trilha** — destrava tirar `exigirAdmin` do fake (R-B).
5. **S5 documentos e assinatura** — dependem de pouco e fecham a P3 da issue #148 (o atestado não
   pode sair com o nome de outra clínica).
6. **S6 exportação total** — entra junto com a rota da G2, depois da D4.

Fila de espera, mensagens e anexos ficam explicitamente **sem rota**: viram `501` no modo `http` e
continuam na demonstração, até alguém decidir criar as rotas.

## 6. Como cada fatia prova que funciona

- `http.test.ts` com `fetch` simulado: rota, método, corpo, mapeamento de campo, e **cada erro**
  (401, 403, 404, 409, 422, 429, 503, timeout, corpo não-JSON) com a mensagem que a tela mostra.
- O teste de paridade do contrato: o que entra no `Pick` **sai** do fake no modo `http` (R-A e R-C).
- E2E do Playwright no fluxo da fatia, com a API real de desenvolvimento, quando a D4 permitir sessão.

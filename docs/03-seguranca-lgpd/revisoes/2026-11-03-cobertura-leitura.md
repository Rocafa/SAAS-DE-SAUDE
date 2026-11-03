# Parecer do Guardião LGPD: PR #119 (`eng/cobertura-leitura`)

- **Data:** 03/11/2026
- **Escopo:** `git diff main...eng/cobertura-leitura` (commit `eb42eeb`, 6 arquivos): `apps/api/test/cobertura-auditoria/{analise.ts,lista.ts,cobertura-auditoria.test.ts,fixtures/rotas-ficticias.ts}`, `docs/04-arquitetura/auditoria-encadeada.md` §4d e `docs/00-governanca/fila.md`. Faz a R5 do [parecer do #117](2026-11-03-cobertura-auditoria.md): declaração obrigatória de auditoria também para rotas `GET`.
- **Testes:** rodei `npx vitest run test/cobertura-auditoria` — 16/16 verdes, ~18 s, sem banco. Li os handlers das 14 exceções até o SQL e o DTO devolvido.

## Veredito: **VETADO** (duas correções pequenas desbloqueiam; R1 a R3 são condição para o merge)

O mecanismo está certo e o analisador não tem defeito (R6). O problema está na classificação: uma das 14 exceções
devolve dado de paciente e abre o contexto do paciente sem trilha (`GET /portal/sessao`, R1), e a trava
`CAMINHOS_CLINICOS` deixa de fora prefixos que já devolvem dado de paciente ou de saúde (R2). Com a trava assim,
uma rota dessas poderia virar exceção sem o teste reclamar. Para a lista "toda leitura sensível grava trilha"
(CFM 1.821/2007, art. 37 e 46 da LGPD) servir de prova, ela precisa estar correta.

**Correção do meu parecer anterior.** No #117 contei "50 de 63 `GET` gravam". O número estava errado: `GET /portal/sessao`
só chegava à trilha pela vigilância do portal (`alertar`), que a R1 daquele parecer passou a tratar como gravador
incidental. O número certo era 49/14, como diz este PR. A conclusão "não há lacuna atual" também estava errada
para esta rota (R1).

## Conferência das 14 exceções

| Rota | Devolve | Conclusão |
|---|---|---|
| `GET /health`, `/health/ready` | estado do processo, sem sessão | ok |
| `GET /sessao` | ids e perfis do próprio contexto | ok |
| `GET /clinica/membros` | `usuarioId`, `perfil`, `concedidoPor`, `concedidoEm` (só admin, `cadastros:gerir`) | ok. Dado da equipe, não de paciente. O motivo omite `concedidoPor` (R3) |
| `GET /clinica/vinculo-de-cuidado` | `{dias, teto}` | ok |
| `GET /financeiro/retencao-fiscal` | política (prazos) | ok |
| `GET /importacoes/termo` | constantes | ok |
| `GET /profissionais` | `nome`, `especialidade`, `capacidade`, `areaSensivel` dos profissionais | ok. Dado da equipe, exibido ao agendar. O motivo omite `areaSensivel` e `capacidade` (R3) |
| `GET /tipos-atendimento` | `nome`, `minutos`, `capacidade` | ok |
| `GET /whatsapp/configuracao`, `/whatsapp/modelos`, `/whatsapp/webhook` | config da clínica, constantes, desafio do provedor | ok |
| `GET /avisos` | aviso `portal_sigilo_transicao` com **`pacienteId`** + `transicao` (`sigilo_desligado`, `representacao_estendida`, `titular_menor_revogado`) | **aceito como exceção, mas o motivo está errado** (R3). O `pacienteId` é dado pessoal pseudonimizado (art. 5º I; art. 13 §4º), e `representacao_estendida` deixa inferir que um adulto segue representado, o que é indício de incapacidade, logo dado sensível por inferência. Aceito sem trilha de leitura porque: (a) a RLS filtra pelo destinatário; (b) o destinatário é designado pelo sistema (admin/profissional); (c) a criação do aviso já é auditada; (d) o id sozinho não identifica, e o passo seguinte (`GET /pacientes/:id`) é auditado. Se algum tipo de aviso passar a levar nome, contato ou conteúdo clínico, a rota vai para `AUDITADAS_LEITURA` |
| `GET /portal/sessao` | nome da clínica + **primeiro nome do paciente** + `agindoComo` | **não pode ser exceção** (R1) |

## Ressalvas

**R1 (bloqueante) — `GET /portal/sessao` passa a gravar trilha e vai para `AUDITADAS_LEITURA`.**
O motivo está errado em dois pontos. (a) A rota não serve só "o próprio titular": com `agindoComo = responsavel`,
o primeiro nome do **paciente** e o nome da clínica vão para um terceiro. O vínculo paciente–clínica é dado de saúde
por inferência (o nome da clínica costuma dizer a especialidade). (b) Não é verdade que "a escolha do vínculo é
auditada (`POST /portal/sessao/vinculo`)". Em `PortalService.noVinculo`
(`apps/api/src/modules/portal/portal.service.ts`, ~l. 633–639), uma conta com **um só** vínculo tem o vínculo
escolhido automaticamente (`provider.escolherVinculo`) sem nenhuma linha na trilha. Nesse caso, o
`Login/select_link` que o POST grava nunca acontece. Para essas contas (a maioria), a abertura do contexto do
paciente no portal fica sem registro.
Correção sugerida:
1. Em `noVinculo`, na seleção automática, gravar o mesmo `AuditAction.Login`, `scope: 'portal_session'`,
   `op: 'select_link'`, com `auto: true` em `metadata`, na transação do vínculo. Isso fecha a lacuna em todas as
   rotas do portal.
2. Em `sessaoAtual`, gravar `AuditAction.Read`, `scope: 'portal_session'`, `op: 'current_link'`, `link_id`, como
   `GET /portal/vinculos` já faz com os mesmos dados (`list_links`).
3. Teste RLS do portal: conta com um vínculo, `GET /portal/sessao` sem POST antes → uma linha `select_link`
   `auto: true` e uma `current_link`.

**R2 (bloqueante) — `CAMINHOS_CLINICOS` deixa de fora prefixos sensíveis.**
Rotas que hoje gravam a trilha e devolvem dado de paciente ou de saúde, mas ficam fora da expressão (nada impede
movê-las para exceção):
- `GET /agendamentos`: paciente + horário + profissional/especialidade. É dado de saúde.
- `GET /importacoes`, `/importacoes/:id`, `/importacoes/:id/divergencias`: linhas do CSV de pacientes.
- `GET /whatsapp/envios`: `pacienteId` + resposta ao lembrete de consulta.
- `GET /portal/vinculos` (e, depois da R1, `GET /portal/sessao`): primeiro nome do paciente.
- `GET /suporte/autorizacoes`: autorizações de acesso do suporte a dado da clínica.
- Prefixo `responsaveis` (controller `responsaveis/descarte`; hoje sem `GET`, mas o domínio é de responsável do paciente).

Correção: incluir `agendamentos`, `importacoes/(?!termo$)` (ou equivalente que deixe só o termo de fora),
`whatsapp/envios`, `responsaveis`, `suporte` e o **portal inteiro** (`portal(\/|$)` no lugar da lista de subcaminhos).
Para o financeiro, inverter: tudo sob `financeiro/` é clínico, menos `retencao-fiscal`, `configuracao` e
`profissionais` (recibo, cobrança, nota ou pagamento novo nasce protegido). Atualizar o teste de sanidade da expressão
com um exemplo positivo por prefixo novo, e `GET /portal/sessao` passa a ser exemplo **positivo**.

**R3 (bloqueante, só texto) — motivos exatos.** O motivo é o registro da decisão (art. 37) e tem de dizer o que a
rota devolve.
- `GET /avisos`: dizer que o tipo `portal_sigilo_transicao` devolve `pacienteId` e a transição. Registrar as quatro
  razões da tabela acima e a condição de mudança.
- `GET /clinica/membros`: incluir `concedidoPor`.
- `GET /profissionais`: incluir `areaSensivel` e `capacidade`; "dado da equipe, não de paciente".
- O nome `LEITURA_SEM_DADO_PESSOAL` não é exato, porque membros, profissionais e sessão devolvem dado pessoal da
  equipe. Renomear para `LEITURA_SEM_DADO_DE_PACIENTE`, ou ao menos corrigir o comentário do cabeçalho.

**R4 (fila, antes do piloto com dado real) — a prova de alcance é mais fraca na leitura.** "Existe caminho até
`insertAudit`" não garante que a trilha é gravada na mesma transação da leitura, em todo ramo que devolve dado
(ex.: `GET /portal/vinculos` grava dentro do laço e só para vínculo que abre). Cada rota de `AUDITADAS_LEITURA`
precisa de ao menos um teste RLS/integração que confira a linha `Read` gravada com o dado devolvido. Hoje isso
existe para prontuário e ficha. Levantar quais das 49 (50 depois da R1) ainda não têm teste e fechar por módulo.

**R5 (não bloqueante) — números da doc.** Depois da R1, `auditoria-encadeada.md` §4d e a linha da fila passam a
dizer 50 auditadas e 13 exceções. Registrar na §4d que `portal/sessao` saiu das exceções por este parecer.

**R6 (não bloqueante) — analisador.** `verboDaRota(cx, dec, tipo)` está correto. `@Options/@Head/@Search/
@RequestMapping` e decorator composto continuam falhando alto nas duas passadas. `@All` segue como escrita, então
exige trilha, o que é o lado seguro. Conferi que não há rota `GET` fora de controller do Nest hoje (a de auth está
na condição da D4). Dois detalhes de qualidade: o tipo `RotaDeEscrita` agora também descreve leitura (renomear para
`RotaAnalisada`), e o programa TS é montado duas vezes (escrita e leitura). Uma passada só que devolva as duas
listas corta o tempo do teste.

## Checklist mínimo

- Base legal / minimização: R1 e R3 (DTOs conferidos; o `AvisoDto` por tipo já é minimizado).
- Controle de acesso / isolamento por tenant: sem mudança; as exceções usam `@Permissao` e RLS (avisos com filtro por destinatário).
- Log de auditoria: objeto do PR; lacuna real em R1, trava incompleta em R2.
- Segredos e dados reais: nada no diff; fixtures fictícios.
- CFM 1.821/2007 (registro de acesso ao prontuário): coberto para os prefixos de prontuário. R4 para a prova por rota.

## Depois das correções

R1 a R3 neste PR. Volto a revisar o diff das correções; R4 vai para a fila, R5 e R6 podem vir junto.

## Nota do Maestro (03/11/2026)

- **R1 (feita, código de produção):** em `PortalService.noVinculo`, a escolha automática do vínculo grava `login`/`portal_session` com `op: select_link` e `auto: true`, na mesma transação da ação. A sessão só guarda o vínculo depois que essa transação confirma. Antes, a sessão guardava o vínculo antes de abrir a transação. `sessaoAtual` grava `read`/`portal_session` com `op: session_greeting`. `GET /portal/sessao` passou para `AUDITADAS_LEITURA`. Teste RLS novo em `portal.rls.test.ts`, no bloco "auditoria e limite por conta": a primeira chamada grava a escolha automática e a leitura, e a segunda grava só a leitura.
- **R2 (feita):** `ehCaminhoClinico` por prefixo, do lado seguro:
  - cobre pacientes, prontuário, atendimentos, notas privadas, custódias, agenda, guias, pacotes e convênios;
  - cobre o financeiro inteiro (menos retenção fiscal, configuração e perfil fiscal), importações (menos o termo), responsáveis, o portal inteiro, o portal da clínica, os envios do WhatsApp e o suporte;
  - na sanidade, `/portal/sessao` passa a exemplo positivo.
- **R3 (feita):** motivos exatos para `avisos` (pacienteId e transição, com a justificativa), `membros` (`concedidoPor`) e `profissionais` (capacidade e área sensível). A lista foi renomeada para `LEITURA_SEM_DADO_DE_PACIENTE`.
- **R4:** está na fila.
- **R5 (feita):** a doc e a fila passam a 50 rotas auditadas e 13 exceções.
- **R6 (feita, em parte):** o tipo foi renomeado para `RotaAnalisada`. A passada única ficou para depois, porque o custo é baixo (cerca de 6 s).

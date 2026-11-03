# Parecer do Guardião LGPD: PR #123, política de MFA independente do provedor (issue #106, S3)

- **Data:** 03/11/2026
- **Branch:** `eng/mfa-politica` (commit `a801293`)
- **Base:** regra 2 do memo [D04-recomendacao.md](../../00-governanca/memos/D04-recomendacao.md); [requisitos-tecnicos-seguranca.md](../requisitos-tecnicos-seguranca.md) §1, §4 e §5; [dpa-minuta.md](../dpa-minuta.md) cláusula 16.2; LGPD arts. 6º VII/VIII e 46.
- **Verificação:** `npx vitest run src/modules/auth` deu 13/13 verdes; `tsc --noEmit` limpo. O `test/mfa.rls.test.ts` não rodou (não há Postgres local).

## Veredito: **VETADO**

O desenho está certo: a obrigatoriedade fica no servidor, no `SessaoGuard`, antes de qualquer leitura, e não depende do provedor. O provedor só informa `mfaEm`. Data no futuro falha fechado, e a sessão fictícia continua presa a development/test (`auth-provider.factory.ts`).

Dois problemas impedem o merge: a lista de perfis contraria um requisito MUST, e o guard tira da trilha tentativas que hoje são auditadas.

## Bloqueios (corrigir neste PR)

### B1. A recepção precisa ser obrigada a usar MFA
- O requisito diz: "MFA obrigatório para todos os perfis com acesso a C3/C4 e para administradores" (`requisitos-tecnicos-seguranca.md` §4, **MUST**).
- A recepção acessa dado **C3**. Ela lê e escreve agenda (profissional e especialidade), cadastro de paciente com CPF, dados de menores e emancipação, responsáveis e convênio/guias.
- Ela também tem `financeiro:ler` e `financeiro:operar`, ou seja, recebe dinheiro, abre caixa e emite recibo. Por isso também se encaixa em "perfis financeiros" da regra 2 do memo.
- A justificativa do PR, "não vê conteúdo clínico **nem dado financeiro**" (comentário em `mfa.ts` e §17 de `api-dominio.md`), é **falsa** diante de `perfis.ts`.
- **Correção:** incluir `recepcao` em `PERFIS_COM_MFA_OBRIGATORIO`. Na prática, todos os perfis da clínica passam a ser obrigados. Ajustar o comentário, o §17 e os testes (`mfa.test.ts` e `mfa.rls.test.ts`, onde a recepção sem MFA hoje passa).
- Recepção sem MFA só seria aceitável se o perfil deixasse de tocar C3 e financeiro. Hoje não é o caso, e mudar isso exigiria alterar o requisito com aprovação dos sócios.

### B2. A recusa por MFA nas rotas sensíveis precisa ir para a trilha
- Hoje, uma tentativa de ler a nota privada de outro autor gera 404 e uma linha `clinical_access_denied` na trilha (HU-PRO-006/022, `acesso-clinico.ts`).
- Com o PR, a mesma tentativa feita com MFA antigo morre no guard com `403 mfa_recente_obrigatorio` e **não deixa rastro**.
- Esse é justamente o caso de sessão roubada (MFA feito há horas) tentando abrir o conteúdo mais sensível. O alerta de "leituras anômalas" (§5) fica cego para ele.
- **Correção:** nas rotas marcadas com `@ExigeMfaRecente()`, gravar a recusa (`mfa_obrigatorio` ou `mfa_recente_obrigatorio`) na trilha antes de lançar o 403.
  - Usar a clínica e o usuário da sessão, em transação própria, com escopo próprio (sugestão: `mfa_step_up_denied`).
  - O metadata leva só ids: rota (template, sem valores), `patient_id`/`custody_id` quando houver e o código da recusa. **Nunca** gravar `mfaEm` em claro nem o conteúdo.
  - Teste RLS: recusa por MFA em `/notas-privadas/:id` deixa uma linha na trilha.
- Nas rotas comuns, o `mfa_obrigatorio` pode esperar a D4 (ver R5).

## Ressalvas (não bloqueiam este PR; cada uma tem prazo)

| # | Ressalva | Prazo |
|---|---|---|
| **R1** | **Exportação total (G2): janela de 5 min, não 15.** A cláusula 16.2 da minuta de DPA promete ao cliente "autenticação em dois fatores feita nos últimos 5 minutos". O §17 diz que a rota "nasce marcada" com a janela padrão de 15 min, o que quebra a promessa contratual. Fazer `@ExigeMfaRecente({ janelaMs })` aceitar janela por rota e usar 5 min na exportação, ou levar aos sócios e ao advogado a troca do DPA para 15 min. Corrigir o texto do §17. | Antes da rota HTTP da G2 |
| **R2** | **MFA recente nas operações irreversíveis ou de poder** (só falta o decorator na rota): eliminação (`POST /pacientes/:id/responsaveis/eliminacao`) e descarte (`POST /responsaveis/descarte`) de responsáveis; retirada da retenção legal e a aprovação dela (`/prontuario/pacientes/:id/retencao-legal/retirada[/aprovacao]`); importação (`POST` de aplicar e desfazer em `/importacoes/:id/...`); `POST /suporte/autorizacoes` (abre acesso externo); `POST`/`DELETE /clinica/membros` (concede e retira perfil); `PUT /prontuario/configuracao` (sigilo da psicologia), ciclo das notas, desligamento de profissional e designação de custódia; atendimento do titular (`POST /clinica/portal/solicitacoes/:id/...`); `POST /financeiro/receita-saude/lotes` (CPFs em lote) e via oficial do recibo (CPF completo). | Antes do primeiro dado real (Portão B). De preferência já na próxima rodada, porque é trabalho mecânico |
| **R3** | **Prontuário de área sensível com MFA recente condicional.** A regra 2 pede MFA recente "para abrir prontuário sensível". Exigir isso em `GET /pacientes/:id/prontuario` e `GET /atendimentos/:id` para qualquer registro obrigaria o profissional a repetir o MFA a cada 15 min o dia todo, um atrito que leva a contornos. O recomendado: exigir MFA recente **quando** o atendimento ou a seção pertence ao compartimento de psicologia/área sensível. Para isso o serviço precisa receber `mfaEm` (hoje `RequestContext` não carrega o campo) e expor um `exigirMfaRecente(ctx)`, chamado depois do porteiro do vínculo e auditado como em B2. Atendimento comum fica só com MFA de sessão. | Antes do Portão B |
| **R4** | **Teste de inventário das rotas marcadas.** Um teste que percorre os controllers e compara a lista de handlers com `MFA_RECENTE_KEY` contra uma lista esperada, para que tirar o decorator de uma rota quebre o CI. Hoje a custódia não tem nenhum teste RLS de MFA. | Junto com R2 |
| **R5** | **Trilha dos eventos de MFA com o provedor real (D4):** cadastro e remoção de fator, verificação ok e falha, bloqueio após 5 falhas em 15 min (Redis), **reset com justificativa obrigatória** e quem fez, recusa `mfa_obrigatorio` em rota comum (com amostragem ou agregação por sessão, para não inundar a trilha) e alerta ao admin no reset. | PR de integração da D4 |
| **R6** | **Contrato do adaptador real.** `mfaEm` vem **somente** da sessão guardada no servidor e é atualizado no step-up. Nunca vem de cabeçalho, corpo ou claim não verificado. Sem informação do provedor, vale `null` (falha fechado), ao contrário do padrão "agora" da sessão fictícia. Trocar de clínica, de perfil ou de senha zera ou reavalia o MFA. Incluir um teste de contrato para todo `AuthProvider`: sem fator, `mfaEm === null`. | PR de integração da D4 |
| **R7** | **Sessão fictícia com MFA "agora" por padrão:** aceitável. O provider só sobe em development/test e há teste de que produção lança erro. O risco é a suíte esconder regressões de MFA, e por isso os testes de rota sensível devem passar `mfaEm` explícito, como o `mfa.rls.test.ts` já faz. Registrar no §17 que esse padrão **não** é contrato para o provedor real (ver R6). | Junto com B1 |
| **R8** | **`GET /sessao` com `mfaEm`:** aceitável. É dado pessoal do **próprio** usuário (horário em que se autenticou), devolvido a ele mesmo na própria sessão. Não é dado de paciente e não serve para enumerar contas. Por minimização, prefira devolver `mfaRecenteAte` (ISO) ou um booleano, que é o que o cliente precisa. O campo nunca vai para logs técnicos (§5), nem esta resposta. Hoje, admin, profissional e financeiro sem MFA recebem 403 até no `/sessao`. O cliente se orienta pelo `codigo`, o que é suficiente; só não pode haver caminho em que o 403 vire tela em branco. | Opcional; antes da tela de login real |

## Itens conferidos sem achado
- **Data no futuro:** recusada na janela recente (falha fechado). Na obrigatoriedade simples, uma data no futuro conta como "fez MFA". Isso é aceitável, porque a presença do fator é o que importa ali. Com o provedor no mesmo processo (Better Auth), não há diferença de relógio. Se a D4 for Zitadel, tolerar no máximo 30 s.
- **Ordem no guard:** sessão (401), depois permissão (403), depois MFA (403). A recusa vem antes de qualquer leitura. A clínica continua vindo só da sessão (regra 1).
- **Isolamento por clínica, criptografia, segredos, dados reais:** o PR não toca nesses pontos. Os testes usam dados fictícios (`Paciente Ficticia MFA`, telefone 119000000xx).
- **Portal do paciente:** usa `PortalGuard` e continua fora desta política, como manda a regra 5 do memo.

## O que vai para a trilha agora × o que espera a D4
- **Agora (B2):** recusa por MFA nas rotas com `@ExigeMfaRecente()`, depois nas rotas de R2 e na checagem condicional de R3.
- **D4 (R5):** os eventos do próprio fator (cadastro, verificação, falha, bloqueio, reset com justificativa), a recusa em rota comum e o alerta de reset.

## Nota do Maestro (03/11/2026)

- **B1 (feita):** `recepcao` entrou em `PERFIS_COM_MFA_OBRIGATORIO`, agora com todos os perfis. O comentário, o §17 e os testes foram ajustados.
- **B2 (feita):** em rota com `@ExigeMfaRecente`, o `SessaoGuard` grava a recusa na trilha antes do 403. A linha tem ação `read`, escopo `mfa_denied` e metadata `{ op: "<Controller>.<handler>", reason, target_id? }`, na clínica da sessão. Se a gravação falhar, a recusa continua e o log não leva dado. Teste RLS confere a linha e confere que a recusa em rota comum não grava.
- **R1 (feita):** a janela é por rota (`@ExigeMfaRecente(janelaMs)`), e a exportação total usa `MFA_RECENTE_EXPORTACAO_MS` (5 min).
- **R2 (feita):** o decorator foi posto em todas as rotas listadas, 24 no total, contando notas privadas e custódia.
- **R3:** está na fila, antes do Portão B.
- **R4 (feita):** a análise anota os decorators nossos (`marcas`), e a lista fechada `ROTAS_COM_MFA_RECENTE` quebra o CI se alguém tirar ou puser o decorator sem atualizar a lista. A custódia ganhou teste RLS de MFA.
- **R5 e R6:** estão na fila, como condição da D4.
- **R7 (feita):** os testes de rota sensível passam `mfaEm` explícito, e o §17 diz que o padrão da sessão fictícia não vale para o provedor real.
- **R8 (feita):** `GET /sessao` devolve só `mfaRecenteAte`.

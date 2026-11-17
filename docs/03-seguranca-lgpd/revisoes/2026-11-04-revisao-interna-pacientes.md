# Revisão interna de segurança e LGPD: lado do paciente (portal, site e app)

- **Data:** 2026-11-04
- **Revisor:** Guardião LGPD & Segurança (revisão interna, antes da revisão externa)
- **Escopo:**
  - API: `apps/api/src/modules/portal/*` (rotas `/portal/*`, sessão, OTP do resgate, convite, vínculos, direitos do titular, consentimentos, vigilância), o que o portal usa de `patients/` (responsáveis, faixa etária) e a borda HTTP (`security/http-security.ts`, `lifecycle/all-exceptions.filter.ts`). Código em `main` (`12595f5`).
  - Site e app (PWA): branch `origin/front/pendencias-da-revisao-r8` (`7ee2f3a`): `app/(portal)`, `app/(acesso)/portal/*`, `app/portal.webmanifest`, `public/sw.js`, `components/app/registrar-sw.tsx`, `app/offline`, `lib/api/portal-*.ts`, `lib/portal-convite.ts`, `next.config.ts`.
- **Limite:** não há Postgres local, então os testes RLS (`test/portal.rls.test.ts`) **não foram rodados** nesta revisão. As garantias do banco citadas abaixo vêm dos pareceres anteriores e do código das migrações.
- **Critérios:** OWASP ASVS 4.0 nível 2, OWASP MASVS (para o PWA), LGPD arts. 6, 9, 11, 14, 18, 37 e 46, CFM 2.454/2026 quando cabe.
- **Pareceres anteriores considerados:** [20/10 portal](2026-10-20-portal.md), [22/10 #68](2026-10-22-pr68.md), [24/10 front](2026-10-24-front-vetos.md), [29/10 #103](2026-10-29-pr103-front.md), [29/10 sigilo do adolescente](2026-10-29-sigilo-adolescente.md), [03/11 cobertura da auditoria](2026-11-03-cobertura-auditoria.md), [03/11 MFA](2026-11-03-mfa-politica.md).

## Resumo (5 linhas)

1. O desenho do portal está sólido: o paciente nunca informa de quem é o dado. A API descobre o titular pela sessão e pelo banco, e ids de outra pessoa dão 404.
2. Os vetos e ressalvas anteriores (V1, V2, A1 a A5, R1 a R4, N1 a N3) estão resolvidos no código e nenhum voltou. Os logs e as mensagens de erro do portal não carregam dado pessoal.
3. **Não existe login real do paciente (D4).** Fora de `development`/`test`, a API se recusa a subir, e o build de produção do site força o portal em modo demonstração.
4. Também faltam o envio real do código por SMS, o "Sair" com fim de sessão no servidor e o registro dos eventos de segurança do login.
5. **Veredito para produção: NÃO PRONTO.** O lado do paciente hoje falha fechado, o que é seguro mas não funciona. Ele fica PRONTO COM CONDIÇÕES quando P1 a P5 estiverem feitos e P6 a P11 estiverem antes do piloto.

## O que está bom (não precisa mexer)

- **Sessão separada da clínica.** Token `ptl_` com formato próprio, guardado só como SHA-256. O token da clínica não abre `/portal/*` e o do portal não abre a clínica (`portal-auth.ts:50-52,127-138`). A sessão fictícia não sobe fora de dev/test (`portal-auth.ts:62-66,108-117`).
- **Controle de acesso (ASVS V4).** Nenhuma rota recebe id de paciente ou de clínica. Query em GET dá 400 e campo extra no corpo dá 400 (`portal.controller.ts:16-18`). O vínculo é conferido no banco a cada requisição (`portal.service.ts:634-695`). Consulta ou recibo de outra pessoa dá 404.
- **Sigilo do adolescente e menores (art. 14; CEM art. 74).** O responsável não vê consultas nem recibos de área sensível de paciente com 12 anos ou mais, e idade desconhecida conta como sensível (`portal.service.ts:279-284,357-363,397-399`). O banco repete a regra (policy da 0037). Menor e titular sem data de nascimento não consentem (`portal.service.ts:576-583`).
- **Convite.** Token de 256 bits e código de 6 dígitos enviado ao telefone **do cadastro**. O código é guardado como HMAC com o token como chave. Toda falha responde igual (409 `convite_invalido`). No site, o token chega no `#fragmento`, é apagado da barra na hora e a página manda `no-referrer` (`portal-convite.ts:28-32`; `next.config.ts:122`).
- **Direitos do titular (art. 18) e consentimento.** Pedidos ficam cifrados, com teto de 5 por dia e aviso aos admins. O consentimento é append-only, com versão e hash do texto do servidor.
- **Erros.** O filtro global devolve 500/503 genéricos e só loga o nome e o código do erro (`all-exceptions.filter.ts:39-47`). O adaptador do site descarta `message` e só aproveita `codigo` e `campos` filtrados (`portal-http.ts:153-168`).
- **Armazenamento no navegador (MASVS-STORAGE).** Nada do portal vai para localStorage, sessionStorage, IndexedDB ou cookie legível. O token de dev fica só na memória e é enviado com `credentials: 'omit'`. O service worker guarda **só** `/offline` e os estáticos de `/_next/static` e `/icones`. Ele não intercepta a API (outra origem) e só cacheia resposta `ok` (`sw.js:24-48`). A API responde `Cache-Control: no-store` em tudo (`http-security.ts:74-77`).
- **Cabeçalhos.** A API tem helmet com CSP `default-src 'none'`, HSTS, `no-referrer` e CORS por lista exata. O site tem CSP, HSTS, COOP/CORP, `frame-ancestors 'none'` e Permissions-Policy fechada (`next.config.ts:37-76`).
- **Trilha (o que já se registra).** Toda leitura e escrita do portal grava na trilha da clínica com ator `paciente_portal`, só com ids, códigos e contagens: lista de vínculos, escolha (inclusive automática), saudação, consultas, ação na consulta, recibos, documentos, meus dados, pedido, consentimento, histórico, envio do código do resgate e `anomaly_alert` do limite por conta e do teto de pedidos.
- **Logger (o que já se registra).** Só marcadores fixos sem dado pessoal: `PORTAL_RESGATE_RECUSADO`, `ALERTA_ANOMALIA regra=…`, `RATE_LIMIT_FAIL_OPEN`, `AVISO_PEDIDO_TITULAR_NAO_GRAVADO (<nome do erro>)` e `PORTAL_VINCULO_NAO_GUARDADO_NA_SESSAO (<nome do erro>)`. Conferi todos os `logger.*` do módulo e não achei telefone, CPF, nome, token nem código.

## Achados

| Id | Severidade | Arquivo:linha | Problema | Risco | Correção |
|---|---|---|---|---|---|
| **P1** | **Bloqueia produção** | `apps/api/src/modules/portal/portal-auth.ts:104-117`; front `apps/web/next.config.ts:82-90`, `apps/web/lib/api/portal-selecionar.ts:37-39` | Não existe login real do paciente (D4). Só há a sessão fictícia de dev/test. Fora de dev/test a API não sobe, e o build de produção do site só aceita o portal em modo demonstração. | O portal não funciona em produção. É seguro (falha fechada), mas não entrega nada ao paciente. | Implementar o provedor real do portal, separado do da clínica: login por OTP no telefone do cadastro; sessão guardada no servidor (Redis/banco compartilhado entre instâncias, só o hash do id); cookie `__Host-` HttpOnly, Secure e SameSite=Strict; CSRF nos POST; id de sessão novo no login e ao trocar de vínculo; fim por inatividade (sugestão: 15 a 30 min) e prazo absoluto (sugestão: 12 h); "encerrar todas as sessões". Passar no mesmo contrato de provedor do #128 (versão do portal) e liberar `NEXT_PUBLIC_PORTAL_MODO=http` em produção só junto com ele. |
| **P2** | **Bloqueia produção** | `apps/api/src/modules/portal/portal-otp.ts:70-75` | Não existe envio real do código (SMS ou WhatsApp). Só há o `DevPortalOtpSender`. | Sem esse envio não há resgate de convite nem login. | Adaptador real com: contrato de operador com o provedor (art. 39, DPA, transferência internacional se houver, art. 33); texto **neutro**, sem nome da clínica nem especialidade, porque nome de clínica de psiquiatria num SMS já revela dado de saúde (art. 11); nada do código ou do telefone nos logs do provedor nem nos nossos; tempo limite e um erro genérico. |
| **P3** | **Bloqueia produção** | `apps/api/src/modules/portal/portal.controller.ts:30-204` (não há rota); front `apps/web/app/(portal)/layout.tsx` (não há botão) | Não existe "Sair": nenhuma rota encerra a sessão do portal e nenhuma tela tem o botão. | Celular compartilhado na família é o caso comum. Sem sair, o próximo que pegar o aparelho vê agenda, recibos e dados de outra pessoa (ASVS 3.3.1; LGPD art. 46). | `POST /portal/sessao/encerrar` invalida a sessão no servidor e apaga o cookie. O botão "Sair" fica no menu do portal. Ao sair, o site limpa o estado em memória e manda o navegador para `/portal/entrar` com `replace`. A ação grava trilha (ver P4). |
| **P4** | **Bloqueia produção** | `apps/api/src/modules/portal/portal.service.ts:229-231,252-254`; `portal-vigilancia.ts:104-110` | Os eventos de segurança do paciente não são registrados. Faltam: login com sucesso ou falha, código enviado ou errado, bloqueio por tentativas, logout, sessão expirada, 401 e 404 em id alheio (tentativa de IDOR em `consultas/:id` e `recibos/:id`). E `PORTAL_RESGATE_RECUSADO` sai sem contexto nenhum: sem conta, IP ou id de requisição. | Sem isso não dá para investigar uma invasão de conta nem cumprir o art. 37 e o art. 48 (comunicar incidente com dados de quem foi afetado e quando). | Criar uma trilha de segurança **da conta do portal**, fora do tenant porque o login acontece antes de escolher a clínica, append-only e encadeada como a `audit_log`. Ela grava `HMAC(contaId)`, `HMAC(IP)`, id da requisição, evento e resultado, **nunca** o telefone, o código ou o token. Os 404 do portal em rotas com id também entram na trilha da clínica do vínculo, com `op: 'not_found'`. Incluir esses eventos na lista de cobertura de auditoria (#117/#119). É o mesmo pedido da R6 do #117 para a clínica. |
| **P5** | **Bloqueia produção** | `apps/api/test/portal.rls.test.ts` | Nesta revisão, os testes RLS do portal não rodaram (não há Postgres local). Toda a defesa no banco (sessão do portal, `portal_fora`, sigilo do adolescente, `audit_log` e chaves) depende deles. | Uma regressão no banco passaria sem ser vista. | Antes de subir: `test:rls` e `test:security` verdes no CI do commit que vai para produção, com o link da execução anexado a este parecer. |
| **P6** | Antes do piloto | front `apps/web/next.config.ts:118-123` | O HTML de `/portal/*` sai sem `Cache-Control: no-store`. As telas buscam os dados no navegador, mas o bfcache guarda a página **com os dados** renderizados. | Depois de "Sair", o botão Voltar mostra consultas e dados de outra pessoa (ASVS 8.2.1; MASVS-STORAGE). | `Cache-Control: no-store` em `/portal/:path*` e `/portal`. No evento `pageshow` com `persisted`, recarregar. Teste e2e: sair e depois voltar não mostra nenhum dado. |
| **P7** | Antes do piloto | `apps/api/src/modules/portal/portal-vigilancia.ts:116-124` | Os contadores do portal falham aberto: com o Redis fora, não há limite. O limite do resgate é só por conta, e no login real criar conta será livre. | Hoje o risco é baixo, porque o banco limita 5 tentativas por convite e o token tem 256 bits. No login por OTP, falhar aberto permite força bruta do código e "bombardeio" de SMS (custo e assédio). | Para os contadores de **autenticação** (login, envio e conferência do OTP, resgate): falhar **fechado** (429). Limites por telefone de destino, por IP e por conta, além do limite por convite. Teto diário de SMS por telefone e por clínica, com alerta. |
| **P8** | Antes do piloto | front `apps/web/next.config.ts:42` | A CSP de produção ainda tem `script-src 'unsafe-inline'` (o próprio arquivo registra que espera a CSP com nonce). | Um XSS em qualquer tela do portal roda livre e lê os dados de saúde na tela (ASVS 14.4.3 e 5.3). | CSP com nonce via `proxy.ts`/middleware, sem `unsafe-inline` em `script-src`, pelo menos nas rotas `/portal/*`. |
| **P9** | Antes do piloto | front `apps/web/app/(acesso)/portal/entrar/page.tsx:19-31`; `next.config.ts:84` | O build de produção publica o portal em **modo demonstração**: a tela de entrada pede o celular, aceita o código fixo `123456` e mostra dados fictícios (com a faixa "demonstração"). | Um paciente real pode digitar o próprio celular e achar que entrou na clínica. Isso confunde e abre espaço para golpe parecido com phishing ("o portal aceita qualquer código"). | Em produção sem a D4, `/portal/*` responde 404 ou uma página "em breve" sem formulário. A demonstração fica só em ambiente de demonstração identificado. |
| **P10** | Antes do piloto | front ainda em `origin/front/pendencias-da-revisao-r8` (32 commits fora da `main`) | O site e o app que revisei não estão na `main`. | O que vai para produção pode ser diferente do que foi revisado. | Fazer o merge do front com parecer, e a revisão externa usar o commit exato do deploy. |
| **P11** | Antes do piloto | pacote do advogado, pergunta 1.15 (D8) | As regras do adolescente (sigilo, titular de 12 a 17 anos, consentimento do menor) estão no código de forma conservadora, mas ainda sem a confirmação jurídica. | O critério de idade e de escopo pode estar errado diante do ECA, do CEM e do art. 14. | Parecer D8 antes de abrir o portal a responsáveis de adolescentes. Até lá, manter o padrão mais restritivo, como está hoje. |
| **P12** | Melhoria | `apps/api/src/modules/portal/portal.service.ts:218-233` | A trilha grava `redeem_code_sent` **antes** do envio. Se o SMS falhar, a trilha diz que o código foi enviado, e a API devolve 500 em vez do 409 genérico. | Trilha imprecisa. O 500 diferente é um pequeno oráculo (só para quem já tem um token válido). | Gravar depois do envio, ou gravar `redeem_code_failed` quando der erro. Uma falha do provedor responde como as demais (409 genérico) e grava o motivo só na trilha. |
| **P13** | Melhoria | front `apps/web/app/offline/page.tsx:10` | Na tela "sem conexão", "Tentar de novo" leva a `/inicio` (área da equipe), não a `/portal`. | Dentro do app do paciente, o link sai do escopo do PWA e cai no login da equipe, o que confunde. | Voltar para a página de onde veio (`location.reload()`) ou uma tela offline própria do portal. |
| **P14** | Melhoria | `apps/api/src/modules/portal/portal.controller.ts` | O titular não consegue, sozinho, desfazer o vínculo com a clínica nem apagar a conta do portal. Isso só acontece por pedido à clínica. Ele também não vê quem acessou seus dados. | Art. 18, VI e IX, e art. 9º: o caminho existe (pedido), mas é mais lento do que precisa. | "Sair desta clínica" (revoga o próprio vínculo, com trilha) e "excluir minha conta do portal" (não apaga prontuário: a retenção de 20 anos continua). Mais adiante, "acessos aos meus dados" com um resumo da trilha. |
| **P15** | Melhoria | P1/P2 | SMS é autenticador "restrito" no ASVS (2.7.1), porque está sujeito a troca de chip e interceptação. | Alguém toma a conta do portal e vê dado de saúde. | Avisar o paciente de cada login novo e de cada vínculo novo, por canal neutro. Mais adiante, oferecer passkey (WebAuthn) como segundo fator ou alternativa. Registrar o risco aceito no RIPD. |

**Nenhuma ressalva antiga voltou.** V1 e V2 (20/10), A1 a A5, R1 a R4 e N1 a N3 (22/10), P1 a P6 do front (24/10) e as notas do #103 continuam resolvidos no código lido. Continuam abertas, como estavam: a A5/R6 (o escriba usar só `consentimentoIaDoPaciente`), que não é do lado do paciente, e a parte D4 da R5 (link e login reais), que este parecer detalha em P1 a P4.

## Itens para a revisão EXTERNA (pentest e auditoria)

Rodar contra o **commit exato do deploy**, em staging com dados fictícios, com o login real (D4) já ligado.

**Autenticação e sessão (caixa-preta, site e app)**
1. Força bruta do OTP de login e do resgate: tentativas por código, por telefone, por IP e por conta; troca de IP; corrida (várias tentativas em paralelo no mesmo código).
2. Bombardeio de SMS: muitos pedidos de código para um telefone de vítima. Medir o teto e se o 429 aparece.
3. Enumeração: a resposta, o tempo e o tamanho são iguais para telefone cadastrado e não cadastrado, e para convite válido, usado, vencido e de outra pessoa?
4. Cookie: `__Host-`, HttpOnly, Secure, SameSite=Strict; CSRF nos POST (`confirmar`, `cancelar`, `consentimentos`, `solicitacoes`); fixação de sessão (o id muda no login e na troca de vínculo).
5. Fim da sessão: inatividade, prazo absoluto, "Sair" invalida no servidor (reusar o cookie antigo dá 401), botão Voltar e bfcache depois de sair, duas abas abertas.
6. O token da clínica não abre `/portal/*` e o do portal não abre rota da clínica.

**Controle de acesso (IDOR e lógica)**
7. Trocar o id em `consultas/:id/*` e `recibos/:id` por id de outro paciente, da mesma clínica e de outra. Esperado: 404 igual a inexistente.
8. Mandar `pacienteId`, `tenantId` ou `vinculoId` em query, corpo ou cabeçalho. Esperado: 400 ou ignorado, nunca acesso.
9. `POST /portal/sessao/vinculo` com o vínculo de outra conta, com vínculo revogado e com paciente inativo.
10. Responsável de adolescente: tentar ver consulta ou recibo de psicologia ou psiquiatria pela lista, pelo detalhe e pela ação (confirmar ou cancelar). Esperado: invisível e 404. Repetir no dia em que o paciente faz 12 anos e no dia dos 18.
11. Menor como titular: tentar consentir. Esperado: 409. Titular sem data de nascimento: idem.
12. Teto de pedidos do titular (5 por dia), corrida para passar do teto, cancelar consulta fora do prazo e consulta já começada.

**Convite**
13. O token nunca aparece em URL, Referer, logs do proxy ou do CDN, nem no histórico do navegador. Testar convite encaminhado: outra pessoa com o link e sem o telefone do cadastro não resgata.
14. Reuso do convite, convite vencido, convite revogado e corrida entre duas contas resgatando o mesmo token.

**PWA e navegador (MASVS)**
15. Depois de usar o portal, inspecionar Cache Storage, localStorage, sessionStorage, IndexedDB, cookies e o cache HTTP do aparelho (Android Chrome e iOS Safari "adicionar à tela inicial"). Esperado: nenhum dado pessoal ou de saúde.
16. Modo avião: só a tela "sem conexão", sem dado nenhum. Atualização do service worker entre versões: cache antigo apagado.
17. Escopo e deep links: o manifesto abre em `/portal`; links de convite abertos de dentro do WhatsApp, SMS e e-mail (navegador embutido) não vazam o `#fragmento`.
18. Captura de tela e alternância de apps: avaliar se as telas sensíveis precisam de proteção (no PWA isso é limitado; registrar como risco aceito, se for o caso).
19. XSS em todo campo que volta na tela (nome social, detalhe do pedido, resposta da clínica) e conferência da CSP efetiva.

**Infra, logs e LGPD**
20. TLS: só TLS 1.2 ou mais, HSTS com preload, sem conteúdo misto.
21. Logs do balanceador, do WAF, do APM e do provedor de SMS: conferir que nenhum guarda corpo de `/portal/convites/resgate*`, o código OTP ou o telefone.
22. Mensagens de erro: provocar 400, 401, 403, 404, 409, 413, 429 e 500 e conferir que nenhuma traz stack, SQL ou dado pessoal.
23. Auditoria: sortear eventos do paciente (login, falha, sair, IDOR, consentimento, pedido) e conferir que estão na trilha, sem dado pessoal, com a cadeia de hash íntegra.
24. Teste de multi-instância: sessão e limites valem igual com 2 ou mais réplicas da API (Redis compartilhado).
25. Conferir o texto do SMS e da tela de consentimento contra o art. 9º (finalidade, controlador, direitos) e o art. 14 (linguagem acessível para o responsável).

## Resumo para a fila

| Item | Bloqueia produção? | Quando |
|---|---|---|
| P1, P2, P3, P4, P5 | **Sim** | Com a D4, antes de qualquer paciente real |
| P6 a P11 | Não | Antes do piloto |
| P12 a P15 | Não | Melhoria |

# Revisão interna de segurança e LGPD: lado do profissional (equipe da clínica)

- **Data:** 04/11/2026
- **Revisor:** agente `guardiao-lgpd` (N1, veto)
- **Escopo:** o que a equipe usa (admin, profissional, recepção, financeiro).
  - API em `main` (`12595f5`): `apps/api/src/modules/*` menos `portal`, mais `security/` e `lifecycle/`.
  - Site/PWA em `origin/front/pendencias-da-revisao-r8` (`7ee2f3a`): `app/(app)`, `app/(acesso)`, `lib/`, `public/sw.js` e `next.config.ts`.
  - O portal do paciente fica de fora (revisado em paralelo).
- **Critérios:** OWASP ASVS 4.0 nível 2; LGPD arts. 6º, 11, 37, 46 e 48; Res. CFM 1.821/2007 e Lei 13.787/2018 (prontuário); sigilo da psicologia.
- **Como revisei:** li o código e os pareceres anteriores. Não rodei testes RLS (não há Postgres local) nem E2E.
- **Atenção:** há trabalho **não commitado** no branch `eng/log-de-seguranca` (log de segurança estruturado em `security/log-de-seguranca.ts`, ligado ao `SessaoGuard`, à exportação e ao webhook). Ele **não foi revisado aqui**: precisa de parecer próprio quando virar PR. Os números de linha abaixo são do `main` (HEAD).
- Não é parecer jurídico.

## Resumo (5 linhas)

1. A base da API é boa: a clínica vem só da sessão, há RLS, criptografia de campo com KMS, trilha append-only encadeada, MFA decidido no servidor e logs sem dado pessoal.
2. **Não existe login real.** A API se recusa a subir em produção, e o site de produção só funciona em modo demonstração (código fixo `123456`). Isso já está nas issues #107 e #106.
3. Fora da D4, faltam três coisas para produção: os perfis da sessão não seguem o banco (revogar acesso não corta a sessão), não há desligamento de usuário com logout global e não há expiração por inatividade.
4. Antes do piloto: proteção contra CSRF quando a sessão for cookie, CSP sem `unsafe-inline`, MFA recente em mais quatro rotas de poder, origem (sessão e IP com hash) na trilha, uma tela para a clínica consultar a trilha e o alerta `vinculo_cruzado` do #61, que ficou pendente.
5. **Veredito para produção: NÃO PRONTO.** Os bloqueios são E1 a E5. Com a D4 entregue junto com E2 a E5, o lado da equipe fica PRONTO COM CONDIÇÕES (E6 a E14).

## O que está bem (não precisa mexer)

- **Tenant:** o `SessaoGuard` não lê nenhum cabeçalho de clínica. O contrato do provedor testa cabeçalhos forjados (`contrato-provedor.test.ts:123`). Uma rota sem `@Permissao` é negada (falha fechada).
- **Sessão fictícia:** só sobe em `development`/`test` (`auth-provider.factory.ts:20-27`). Guarda só o SHA-256 do token.
- **Erros:** o `AllExceptionsFilter` e o `safeErrorHandler` nunca devolvem stack, SQL ou SQLSTATE. Os logs levam só o nome e o código do erro (`all-exceptions.filter.ts:39-47`; `graceful-shutdown.ts:79-83`).
- **Logger:** revisei todos os `Logger` fora do portal. Nenhum leva nome, CPF, telefone, e-mail ou conteúdo clínico, só marcadores fixos, UUIDs de clínica e contagens. O webhook loga a assinatura inválida sem o corpo. O IP do rate limit vai em HMAC.
- **Trilha:** o `assertAuditMetadata` barra dado pessoal no metadata. A negação de acesso clínico é gravada em transação própria (`acesso-clinico.ts`). Recusa por MFA em rota sensível também vai para a trilha, com teto (B2/R9 do #123). Concessão e revogação de perfil vão para a trilha e avisam os outros admins (`membros.ts`).
- **Criptografia de campo:** CPF, telefone, nascimento, conteúdo clínico, notas, decisão judicial e números de guia/carteirinha são cifrados (`*_enc`, `FieldCipher`/KMS). O CPF tem índice cego.
- **Prontuário:** conteúdo clínico só para perfil `profissional` com vínculo de cuidado calculado no servidor. Notas privadas só para o autor (outro autor recebe 404, e a tentativa vai para a trilha). MFA recente nas notas, na custódia, na retenção legal e na configuração do sigilo.
- **Navegador:** não há `localStorage`, `sessionStorage`, IndexedDB, cookie legível, `console` nem `innerHTML` nas telas da equipe. O service worker só guarda `/offline`, `/_next/static/` e `/icones/`, nunca API ou página com dado (`public/sw.js:24-45`). Na URL só vão ids. A API manda `Cache-Control: no-store`. As travas do build de produção funcionam (`next.config.ts:84-103`; resolve o que a #100 pedia neste branch).
- **IA:** sem rota HTTP e só o provedor falso. A política de roteamento falha fechada (consentimento em três estados, psicologia só no Brasil).

## Achados

Severidade: **Bloqueia produção** · **Antes do piloto** (antes do primeiro dado real) · **Melhoria**.

| Id | Severidade | Arquivo:linha | Problema | Risco | Correção |
|---|---|---|---|---|---|
| **E1** | Bloqueia produção | `apps/api/src/modules/auth/auth-provider.factory.ts:20-27`; front `app/(acesso)/entrar/page.tsx:31`; `next.config.ts:98-103` | Não há provedor de autenticação real (D4). A API não sobe fora de dev/test. A tela de entrar aceita qualquer e-mail com o código fixo `123456`. O build de produção fica preso no modo demonstração. Não há cadastro de TOTP/passkey, bloqueio por tentativas, recuperação de senha nem logout de verdade. | Sem identificação e autenticação, não há controle de acesso (LGPD art. 46; ASVS V2/V3). | Entregar a D4 (#107 e #106) com a bancada do contrato preenchida pelos 6 ganchos (`contrato-provedor.test.ts:31-47`), cookie `__Host-` `HttpOnly` `Secure` `SameSite=Lax`, bloqueio 5 tentativas/15 min, recuperação sem enumeração e os eventos de E11. O PR passa por parecer próprio. |
| **E2** | Bloqueia produção | `sessao.guard.ts:82-88`; `membros.ts:140-175` | Existem duas fontes de perfil. O guard autoriza só por `auth.perfis`, que vem do provedor. `DELETE /clinica/membros/:usuarioId/:perfil` muda `clinic_members`, mas a sessão continua com o perfil. Só as rotas que chamam `exigirPerfilNoBanco` (ou têm trigger) percebem. O gancho `trocarPerfis` do contrato só cobre a troca feita **pelo provedor**. | Funcionário que perde o perfil (ou é demitido) continua lendo cadastro, agenda e financeiro até a sessão vencer. Uma revogação que "não pega" é falha de controle de acesso (ASVS 4.1.3 e 3.3.x; LGPD art. 46). | O adaptador real deriva os perfis de `clinic_members` (ativos) **a cada requisição**, ou usa cache de no máximo 60 s invalidado na revogação. Perfil que existe só no provedor é ignorado. Teste de contrato: revogar no banco faz a próxima requisição receber 403. |
| **E3** | Bloqueia produção | (não existe) `membros.ts`, `auth.module.ts` | Não há como **desligar um usuário**: tirar todos os perfis de uma vez e encerrar todas as sessões dele (logout global). O requisito está em `requisitos-tecnicos-seguranca.md` §3 (MUST) e na regra 3 do memo D04 ("desativação valendo na próxima requisição"). | Na saída de um funcionário, o acesso fica aberto (é o incidente mais comum em clínica). | Rota `POST /clinica/membros/:usuarioId/desligamento` com `@ExigeMfaRecente()`: revoga tudo, encerra as sessões no provedor e grava `permission_change` com `op: member_offboard`. Avisar os outros admins. Teste: a sessão antiga recebe 401. |
| **E4** | Bloqueia produção | front `lib/api/selecionar.ts:66`; `lib/api/http.ts:61-82` | Mesmo no modo `http`, só pacientes e agenda falam com a API. Prontuário, atendimento, documentos, financeiro, recibos, guias, mensagens e configurações continuam no adaptador **falso** (em memória). As travas de papel do fake (#95) não valem como segurança. | Em produção, a equipe digitaria evolução e recebimentos em telas que não gravam nada (perda de prontuário: CFM 1.821 e Lei 13.787), ou veria dado fictício misturado com dado real. Hoje o build de produção impede isso, e essa trava não pode ser afrouxada antes do fim da integração. | Ligar cada área à API antes de liberar o modo `http` em produção. Enquanto houver área no fake, o `conferirConfigClinica` continua barrando. Pedir o código antes das rotas sensíveis usando `mfaRecenteAte` (R10 do #123). |
| **E5** | Bloqueia produção | front `lib/conta.ts:64-67`; `app/(acesso)/sessao-expirada/page.tsx:12` | Não há expiração por inatividade. `TEMPO_SESSAO_MINUTOS = 15` é só texto da tela "sessão expirada": nenhum timer no cliente e nenhuma regra no servidor. Requisito MUST (§3: 15 min para perfil clínico em estação compartilhada). | Computador da recepção ou do consultório largado aberto com a ficha do paciente. É o vetor mais provável de acesso indevido interno. | No servidor (provedor): expiração por inatividade de 15 min para `profissional` e configurável para os outros perfis, mais um limite absoluto (ex.: 12 h). No cliente: timer que, ao vencer, chama `limpar()`, apaga o retrato em memória e vai para `/sessao-expirada`. |
| **E6** | Antes do piloto | `apps/api/src/security/http-security.ts:69` (e `:61` `credentials: true`) | A API aceita `application/x-www-form-urlencoded`, e os controllers leem `@Body() unknown`. Quando a sessão virar cookie `SameSite=Lax`, um formulário em **subdomínio irmão** (mesmo site, ex.: outra app no mesmo domínio) faz POST autenticado. Não há conferência de `Origin` nem token anti-CSRF. | CSRF em ações como conceder perfil, receber dinheiro ou ligar informação clínica para o responsável (ASVS 4.2.2 e 13.2.3). | Tirar o parser `urlencoded` (a API é só JSON; o webhook usa JSON). Responder 415 a método de escrita sem `Content-Type: application/json`. Conferir `Origin` contra a allowlist em POST/PUT/PATCH/DELETE. Usar cookie com prefixo `__Host-`. Teste ofensivo em `test/security`. |
| **E7** | Antes do piloto | front `next.config.ts:42` | A CSP do site tem `script-src 'self' 'unsafe-inline'`, então a CSP não protege contra XSS. | Um XSS em qualquer tela da equipe lê tudo que a sessão vê (prontuário, CPF) e age em nome do usuário (ASVS 14.4.3; LGPD art. 46). | CSP com nonce por requisição (middleware/`proxy.ts`) mais `'strict-dynamic'` e sem `unsafe-inline` em `script-src`. Manter o teste em `security-headers.test.ts`. |
| **E8** | Antes do piloto | `auth.module.ts:35` (`PUT /clinica/vinculo-de-cuidado`); `whatsapp.controller.ts:22` (`PUT /whatsapp/configuracao`); `scheduling.controller.ts:91` e `:97` (`POST /profissionais`, `POST /profissionais/:id/area-sensivel`); `financeiro.controller.ts:54` e `:68` | Rotas de poder sem `@ExigeMfaRecente()`. A janela de vínculo amplia o acesso clínico de todos para até 180 dias. O número do WhatsApp redireciona mensagens. O cadastro de profissional amarra um `usuarioId` ao vínculo de cuidado. **Desmarcar área sensível** tira o MFA recente e o tratamento de sigilo de um psicólogo. Emitente e perfil fiscal entram no recibo. | Sessão roubada amplia o próprio acesso clínico ou desvia o canal sem passar pelo segundo fator (complemento da R2 do #123). | Pôr `@ExigeMfaRecente()` nessas 6 rotas. Na área sensível, avisar o profissional afetado e os outros admins (`clinical_notices`) quando ela for desmarcada. |
| **E9** | Antes do piloto | `apps/api/src/db/schema.ts:827-839` (`audit_log`) | A trilha não tem origem: falta sessão (referência com hash), origem (HMAC do IP), id da requisição e dispositivo. Só quem, o quê e quando. | Num incidente (art. 48) não dá para separar a ação do dono da conta da ação de uma sessão roubada, nem ligar a trilha ao log de segurança. Fica fraco como prova de rastreabilidade (CFM 1.821; ASVS 7.1.3). | Migração com `session_ref` (hash do id da sessão do provedor), `origem` (o mesmo HMAC do rate limit) e `request_id`, preenchidas pelo contexto da requisição em `recordAudit`, nunca vindas do corpo. O `request_id` também vai no log de segurança. |
| **E10** | Antes do piloto | (não existe) módulo `audit` | A clínica não tem rota nem tela para **consultar a trilha** ("quem abriu o prontuário do paciente X", acessos de um usuário, recusas e alertas de anomalia). Os alertas `anomaly_alert` são gravados, mas ninguém da clínica os vê. | O controlador não consegue investigar, responder ao titular sobre os acessos (art. 18, 19 e 37) nem agir sobre o alerta, e a vigilância fica sem efeito. A fila já pede um relatório trimestral para o suporte. | `GET /clinica/auditoria` só para admin, com filtros por paciente, usuário e período, com MFA recente e paginação. A própria consulta vai para a trilha. Alerta de anomalia vira aviso aos admins. Sem conteúdo, só ids, ações e datas. |
| **E11** | Antes do piloto (com a D4) | `packages/shared/src/enums.ts:48-72`; `sessao.guard.ts` | Faltam eventos de segurança da equipe. Login com sucesso e com falha (`Login`/`LoginFailed` existem, mas ninguém grava para a equipe), logout, troca e recuperação de senha, cadastro e reset de MFA, bloqueio por tentativas e troca de clínica. No `main`, o 403 por perfil e o 401 não vão para lugar nenhum (o WIP `eng/log-de-seguranca` começa a tratar isso). A exportação total ainda não tem rota. | Ataque de força bruta ou abuso interno sem detecção (ASVS 7.1.2 e 7.2.1; plano de incidentes). | No PR da D4, gravar esses eventos pelos hooks do provedor (item da fila, R6 do #117 e R5/R6 do #123). Trilha para login, falha, troca de credencial e MFA. Log de segurança para 401/403 em volume. Alarme para falhas seguidas por conta e por origem. Revisar o `eng/log-de-seguranca` como PR. |
| **E12** | Antes do piloto (**voltou**) | `scheduling.service.ts` (`criar`) | A R6 do parecer do #61 (`creator_role` no audit de `create` e alerta `vinculo_cruzado` quando um profissional cria agendamento para **outro** profissional e isso vira atendimento) **não foi implementada**. Não há ocorrência no código. | Um profissional dá ao colega acesso ao prontuário inteiro de qualquer paciente (`agenda_do_dia`) e nada alerta. | Implementar como pedido no #61, com teste. |
| **E13** | Antes do piloto | front `app/(acesso)/sessao-expirada/page.tsx:12` | A tela promete "o que você estava escrevendo ficou guardado", mas isso não existe. Se for feito no navegador (localStorage/IndexedDB), vira conteúdo clínico parado no aparelho. | Dado de saúde em armazenamento local de estação compartilhada (contraria o que o SW e a varredura de privacidade garantem). | O rascunho fica **só na API** (o `PUT /atendimentos/:id/registro` já guarda rascunho, cifrado). Até lá, tirar a frase. Pôr a regra "nada de storage com conteúdo" na varredura de privacidade (#102). |
| **E14** | Antes do piloto | `records/prontuario.service.ts` (finalizar = `AuditAction.Sign`) | "Finalizar" o registro não usa assinatura ICP-Brasil, e não há certificação SBIS (D12). Atestado e declaração saem para impressão (`documentos/page.tsx:278`). | Prontuário só digital, sem papel, exige NGS2 com ICP-Brasil (CFM 1.821/2007; Lei 13.787/2018). Documento médico digital exige assinatura qualificada (Res. CFM 2.299/2021). Prometer "sem papel" seria propaganda enganosa e risco ético para o profissional. | No contrato e no onboarding, dizer que o registro é eletrônico **sem** validade de documento sem papel até o ICP-Brasil/NGS2. O documento impresso é assinado à mão. Pôr o fluxo de assinatura ICP-Brasil no roadmap (D12). Pergunta ao advogado (D8). |
| **E15** | Melhoria | `scheduling.controller.ts:84`; `GET /profissionais` | Qualquer perfil vê `areaSensivel` e `especialidade` dos profissionais, e a agenda junta paciente com profissional. A recepção deduz que "o paciente X faz psicologia". | Dado de saúde por inferência (art. 11) visto por quem precisa para agendar. É aceitável, mas precisa estar escrito. | Registrar no RIPD como tratamento necessário à recepção. Não mostrar `areaSensivel` para quem não é admin. Na agenda, mostrar só o nome do profissional. |
| **E16** | Melhoria | front `app/(app)/layout.tsx` | O layout da área logada não confere a sessão no servidor (nenhum middleware). O controle é todo no cliente. Os dados vêm da API, então não há vazamento hoje. | Com a D4, uma tela pode renderizar casca e metadados antes do 401. | Com a D4: middleware que redireciona para `/entrar` sem o cookie de sessão, sem ler dado. |
| **E17** | Melhoria | `scheduling.validation.ts:105-113` | Ao criar um profissional, o admin escolhe qualquer `usuarioId` (sem conferir que ele é membro com perfil `profissional` em `clinic_members`). | Vínculo de cuidado ligado a uma conta errada (por erro ou má-fé), dando acesso clínico a quem não atende. | Exigir que o `usuarioId` seja membro ativo com perfil `profissional` (API e trigger) e avisar o usuário vinculado. |

### Issues do front que continuam abertas e valem aqui (não redescrevo)

- **#95:** travas de papel no adaptador falso (relevante para E4).
- **#94:** captura de telas sem conferir o modo.
- **#102:** exportação total aprovada por quem pediu; varredura de privacidade sem as telas da clínica (relevante para E13).
- **#93:** documento com registro profissional e clínica fixos (relevante para E14).
- **#100:** trava do modo http em produção. Já está corrigida neste branch (`next.config.ts:98-103`); fechar quando o branch entrar.
- **#96, #97, #98, #99, #101:** funcionais. A #97 (start_url do manifesto) só importa para o portal.

### Itens de pareceres anteriores que seguem abertos

- **R2 do #123:** quase toda feita. Faltam as rotas de E8.
- **R12 do #123 (exportação com MFA de 5 min):** depende da rota, que ainda não existe. Correto que não exista.
- **R6 do #61:** é o E12 (voltou).
- **Suporte depois da D4 (parecer da 0059):** continua na fila.

## Logs: o que a equipe gera hoje

| Tipo | O que vai | Dado pessoal? |
|---|---|---|
| Trilha (`audit_log`) | Leituras auditadas (50 rotas GET); criação e alteração de cadastro, agenda, financeiro, guias, prontuário e notas; finalização e adendo; negação de acesso clínico; recusa por MFA em rota sensível; mudança de perfil; vínculo de cuidado; importação; opt-in de WhatsApp; anomalia (lista e busca, autoagendamento, volume de recusas MFA); falha de exportação | Não: só ids, códigos e contagens (`assertAuditMetadata`). Falta origem e sessão (E9) |
| Logger (stdout/CloudWatch) | Erros genéricos (nome e código), jobs, KMS do importador (id da clínica), webhook inválido, rate limit fail-open, alertas de anomalia por regra | Não. Conferido em todas as chamadas fora do portal |
| Faltam | Login e falha, logout, troca e recuperação de senha, cadastro e reset de MFA, bloqueio, troca de clínica, desligamento de usuário, 401/403 em volume (no `main`), consulta da trilha, exportação (rota futura) | E11, E3, E10 |

## Itens para a revisão EXTERNA (pentest e auditoria do lado da equipe)

A revisão externa entra **depois da D4**, contra o staging com dado fictício, nos dois modos: navegador desktop e PWA instalado (Android e iOS).

**Autenticação e sessão (caixa-preta)**
1. Força bruta e credential stuffing no login e no código MFA: confirmar bloqueio 5/15 min, que a mensagem não revela se o e-mail existe e que a recuperação de senha também não.
2. Pular a etapa do MFA: chamar a API com a sessão criada depois da senha e antes do código. Repetir o código TOTP (replay). Trocar o fator sem MFA recente.
3. Cookie de sessão: `__Host-`, `HttpOnly`, `Secure`, `SameSite`. Fixação de sessão (o id muda no login e na troca de clínica). Logout invalida no servidor. Inatividade de 15 min. Limite absoluto.
4. Revogação: o admin revoga um perfil ou desliga um usuário e a sessão aberta perde o acesso na próxima requisição (E2/E3), no navegador e no PWA.
5. CSRF a partir de outro subdomínio e de outro site, com formulário `urlencoded` e `text/plain` (E6).

**Controle de acesso por perfil e por clínica**
6. Matriz completa com uma conta de cada perfil (admin não clínico, profissional, psicólogo, recepção, financeiro) contra todas as rotas de `PERMISSOES` (`perfis.ts`). Conferir que recepção, financeiro e admin não clínico nunca recebem conteúdo clínico, nem em listas, contagens ou mensagens de erro.
7. IDOR entre clínicas: usuário da clínica A com ids (paciente, atendimento, nota, recibo, guia, custódia, lote de importação) da clínica B. Esperado: 404 sem diferença de tempo ou de mensagem. Mesmo teste entre profissionais da mesma clínica (nota privada, psicologia).
8. Vínculo de cuidado: fabricar vínculo (autoagendamento, remarcação, encaixe criado por outro profissional, recepção marcando consulta de hoje) e conferir os alertas (E12).
9. Cabeçalhos forjados (`x-tenant-id`, `x-user-id`, `x-perfis`, `x-mfa`) e parâmetros extras no corpo, tentando escolher clínica ou perfil.
10. Rotas com MFA recente: usar uma sessão com MFA de mais de 15 min e conferir o 403 e a linha na trilha. Rotas de E8.

**Entrada, saída e navegador**
11. XSS armazenado em todo campo livre que a equipe vê (nome social, observação, motivo, texto do recibo, modelo de prontuário, nome da clínica no atestado), com e sem a CSP de nonce (E7).
12. Importação de planilha: CSV injection (fórmulas `=`, `+`, `-`, `@` na exportação e no relatório de divergências), arquivo grande, codificação e zip bomb.
13. Webhook do WhatsApp: assinatura ausente ou inválida, replay, volume (100 eventos), número de negócio de outra clínica.
14. Mensagens de erro e cabeçalhos: nenhum stack, SQL ou versão; `no-store`; CORS só para a origem do site; HSTS; CORP.
15. PWA: com o app instalado, deslogar, ficar sem rede e reabrir. Conferir o Cache Storage, o IndexedDB e o histórico do navegador (nenhum dado de paciente). Conferir o print do atestado (cache de impressão) e o título da aba e do histórico (sem nome de paciente). Mesma checagem no app em segundo plano (miniatura do alternador de apps).

**Logs, trilha e incidente**
16. Para cada teste acima, conferir se a trilha e o log de segurança registraram e se **nada** do log tem nome, CPF, telefone, e-mail ou conteúdo.
17. Integridade da trilha: tentar UPDATE/DELETE pelo papel da aplicação e conferir que a cadeia de hash acusa quebra.
18. Simulação de incidente (art. 48): com o que a trilha e os logs têm, dá para dizer, em 72 h, quais pacientes uma sessão roubada viu? (testa E9 e E10)

**Auditoria documental (fora do código)**
19. RIPD da plataforma frente aos fluxos reais da equipe (inferência de especialidade, E15). Bases legais por finalidade (art. 7º/11). DPA com a promessa de MFA de 5 min na exportação.
20. Prontuário: guarda de 20 anos, retenção legal, eliminação, e o que a plataforma afirma sobre assinatura e documento sem papel (E14).
21. Segredos: rotação (`RATE_LIMIT_HASH_KEY`, `PAGINATION_CURSOR_KEY`, app secret do WhatsApp, KMS) e ausência de segredo e de dado real no git (gitleaks em todo o histórico).

## Veredito

**NÃO PRONTO para produção.** Bloqueiam: **E1** (sem login real, D4), **E2** (revogar perfil não corta a sessão), **E3** (sem desligamento de usuário e logout global), **E4** (site com prontuário, financeiro e documentos ainda no adaptador falso) e **E5** (sem expiração por inatividade). Depois disso, E6 a E14 precisam estar fechados antes do primeiro dado real (piloto). E15 a E17 podem ir para a fila.

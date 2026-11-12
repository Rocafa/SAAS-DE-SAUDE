# Roteiro do teste de fumaça do login real no staging (item B8)

> 12/11/2026 · Maestro · **rascunho conferido pelo Guardião (ver o fim)**. Item B8 do checklist (`docs/03-seguranca-lgpd/prontidao-producao.md`). Roda depois do [runbook do primeiro dia do staging](runbook-primeiro-dia-staging.md), com a pilha do login (#149 → #179) na `main` e a imagem publicada. O B9 (#179, chaves de HMAC por uso) já tem de estar no ar: o B8 roda com as chaves derivadas.

> ⚠️ **Só contas fictícias.** Nomes e e-mails inventados, num domínio de teste sob nosso controle, e nenhum CPF. Nada deste roteiro entra em print, HAR, log ou PR com segredo, código TOTP, `totpURI`/QR do cadastro do fator, token de convite ou de recuperação (os dois voltam **no corpo da resposta** ao admin), ou cookie. A evidência é o **status HTTP**, o **nome do evento** no log de segurança e a **linha da trilha** (só ids e `op`).

## 0. Preparação

| # | O quê | Como confere |
|---|---|---|
| 0.1 | API no staging com `AUTH_PROVIDER=better-auth` e os segredos versionados do B1 | `/health/ready` 200; o boot não sobe sem os segredos (falha fechada) |
| 0.2 | TLS `verify-full` no Postgres **para `app_user` e para `app_auth`, cada um** e `rediss://` com AUTH no Redis, com o certificado validado (B4) | log do boot sem `RATE_LIMIT_FAIL_OPEN`; conexão recusada com CA errada, nos dois papéis |
| 0.3 | `HTTP_TRUST_PROXY_HOPS` conferido atrás do ALB (B3) | duas origens diferentes contam separado no bloqueio (passo 7) |
| 0.4 | Uma clínica fictícia criada pelo fluxo de provisionamento, com o fundador fictício (com TOTP) | linha em `clinic_members` com `role=admin`; trilha `tenant_create` e `member_found` |
| 0.5 | Um aplicativo autenticador num aparelho de teste, sem conta pessoal de ninguém | — |
| 0.6 | Entrega do convite e da recuperação | **Não depende de e-mail.** `POST /clinica/convites` e `POST /clinica/membros/:usuarioId/recuperacao` devolvem o token **uma vez**, no corpo, ao admin, que o entrega fora da plataforma (§9). No teste, o token passa de um terminal a outro sem ir para print, chat ou PR |
| 0.7 | Convites criados **depois** do deploy do B9 | convite pendente de antes do B9 não é aceito (o `email_hmac` mudou, N4 do parecer do #179): reemitir |
| 0.8 | Cookie de sessão no staging | `Set-Cookie` sai como `__Host-sessao`, com `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` e sem `Domain` (R8 do PR 1). Conferir só os atributos, nunca o valor |

## 1. Rotas do roteiro

Better Auth em `/api/auth/*` (lista fechada em `montagem.ts`): `sign-in/email`, `two-factor/enable`, `two-factor/verify-totp`, `sign-out`, `get-session`. Rotas nossas: `POST /clinica/convites`, `POST /convites/aceitar`, `GET /sessao/clinicas`, `POST /sessao/clinica`, `GET /sessao/sessoes`, `DELETE /sessao/sessoes/:id`, `POST /sessao/encerrar-todas`, `POST /sessao/senha`, `PUT /clinica/vinculo-de-cuidado`, `POST /clinica/membros/:usuarioId/desbloqueio`, `POST /clinica/membros/:usuarioId/recuperacao`, `POST /recuperacao/usar`, `DELETE /clinica/membros/:usuarioId/:perfil`.

## 2. Passos

| # | Passo | Esperado | Evidência |
|---|---|---|---|
| 1 | Fundador entra com senha e depois com o código (`sign-in/email`, `two-factor/verify-totp`) | `sign-in/email` 200 com `twoFactorRedirect`, **sem** cookie de sessão; o código abre a sessão | status; ausência do cookie no 1º passo; evento `LOGIN_SENHA_OK` (motivo `aguardando_fator`) e depois `LOGIN_OK`; trilha `mfa_verified` |
| 2 | Fundador convida uma pessoa fictícia (`POST /clinica/convites`) | sem MFA recente: 403 com `codigo: mfa_recente_obrigatorio`; com MFA: 201 (token no corpo, ver 0.6) | status; evento `MFA_RECUSADO`; trilha `mfa_denied` na recusa e `member_invite` na criação |
| 3 | A pessoa aceita (`POST /convites/aceitar`), cria a senha e cadastra o TOTP (`two-factor/enable` + `verify-totp`) | aceite 204 com cookie de uma sessão **de cadastro** (15 min, R8), que não acessa rota de negócio (401); o primeiro código troca a sessão e grava `mfa_em` | trilha `member_grant` (com `via: convite`), `mfa_enrolled`, `mfa_verified`; evento `LOGIN_OK` com motivo `cadastro_do_fator` |
| 4 | Mesmo código TOTP outra vez (no login em duas etapas) | 401 `INVALID_CODE` (reuso, RFC 6238 §5.2) | status; evento `MFA_FALHOU` com motivo `codigo_reutilizado` |
| 5 | Escolha de clínica (`GET /sessao/clinicas`, `POST /sessao/clinica`) | só a clínica do vínculo aparece; escolha 204; clínica sem vínculo 404. Para provar que trocar de clínica zera o MFA, é preciso **uma segunda clínica fictícia** com a mesma pessoa | trilha `session_tenant_selected` |
| 6 | Rota sensível com reverificação: **só** `PUT /clinica/vinculo-de-cuidado` (nada de prontuário ou evolução: nenhum paciente, nem fictício, neste roteiro) | sem reverificação recente: 403 `mfa_recente_obrigatorio`; depois do código: 200 | status; trilha `mfa_denied` e depois a da rota |
| 7 | Bloqueio 5/15: cinco senhas erradas para a pessoa fictícia | sexta tentativa recusada **com a mesma resposta da senha errada** (401 `INVALID_EMAIL_OR_PASSWORD`) mesmo com a senha certa; outra origem conta separado (B3) | evento `LOGIN_FALHOU` e `LOGIN_BLOQUEADO` (motivo `bloqueio_de_login`); nenhum e-mail ou IP em claro no log |
| 8 | Desbloqueio pelo admin (`POST /clinica/membros/:usuarioId/desbloqueio`) | exige MFA recente; 204; depois disso, login volta a funcionar | trilha `member_unlock`; evento `BLOQUEIO_ZERADO` |
| 9 | Recuperação pelo admin (`POST /clinica/membros/:usuarioId/recuperacao`, depois `POST /recuperacao/usar`), uma vez com `tipo=senha` (pede o código TOTP) e outra com `tipo=fator` (pede a senha atual e abre sessão de cadastro) | emissão 201; uso 204 e as sessões da pessoa caem; segundo uso 404; emitir de novo invalida o pendente anterior da mesma clínica | trilha `credential_recovery_issued` e `credential_recovery_used`; eventos `RECUPERACAO_EMITIDA` e `RECUPERACAO_USADA` |
| 10 | Troca de senha (`POST /sessao/senha`, exige MFA recente) com a senha atual errada | 409 `senha_atual_errada`; conta no bloqueio | evento `LOGIN_FALHOU` (motivo `senha_errada`) |
| 11 | Duas sessões da mesma pessoa; `POST /sessao/encerrar-todas`; depois um `sign-out` numa terceira sessão | as duas param de valer no servidor: `GET /sessao/sessoes` com qualquer um dos cookies antigos dá **401** (não "lista vazia"); o `sign-out` encerra a terceira | evento `LOGOUT` (motivo `logout_global`, `contagem: 2`); trilha `session_logout_global`; no `sign-out`, trilha `session_ended` (`reason: logout`) |
| 12 | Desligamento (`DELETE /clinica/membros/:usuarioId/:perfil` do último perfil) | 204; a próxima requisição da pessoa dá 401 (sem vínculo); login não abre outra clínica. Revogar o último admin dá 409 `ultimo_admin` | trilha `member_revoke`; evento `SESSAO_INVALIDA`. `CONTA_DESLIGADA_SEM_VINCULO` só sai quando o job `identidade-expurgo` roda (passo 15) |
| 13 | CSRF (C1), nas duas portas: `POST /api/auth/sign-in/email` sem `Origin`, e `POST` numa rota nossa com `Origin` fora da allowlist | 403 nos dois | status; evento `CSRF_RECUSADO` |
| 14 | Log de segurança do dia | nenhum e-mail, nome, IP em claro, token ou código; só pseudônimos e ids. Com o D15 na opção D e sem NAT, `CONFERENCIA_DE_SENHA_INDISPONIVEL` é **esperado** | busca no CloudWatch pelos e-mails fictícios: **zero resultados** |
| 15 | Rodar o job `identidade-expurgo` uma vez | a conta do passo 12 fica inativa e as sessões dela somem; o job aparece nas métricas `JOB_ATRASADO`/`JOB_ALARME` (R7 do parecer do 3c parcial) | evento `CONTA_DESLIGADA_SEM_VINCULO`; contagens do job (sem dado pessoal) |
| 16 | Segredo versionado (B1): com um fator cadastrado na versão 1, tornar a versão 2 a atual | o código TOTP da pessoa fictícia continua sendo aceito | status; evento `LOGIN_OK` |

## 3. Depois

- As contas fictícias são desligadas e a clínica fictícia segue o fluxo normal de saída.
- A evidência (status, nomes de evento, ids da trilha) vai para um PR do devops-ci, e o Guardião escreve o resultado no parecer final da abertura.
- Qualquer passo fora do esperado trava a abertura (`AMBIENTES_POR_TIPO['better-auth']` não inclui `production`) até a correção e uma nova rodada.

## Conferência do Guardião (12/11/2026)

**Veredito: APROVADO COM RESSALVAS como roteiro.** Não aprova a abertura; o B8 só fecha com a rodada no staging e a evidência no PR.

Corrigido neste arquivo (fato errado contra o código da pilha em `eng/hmac-por-uso`):
- 0.6: o roteiro não para sem e-mail. Convite e recuperação devolvem o token ao admin (`convites.ts:40-44`, `credenciais.ts:162-172`).
- Passo 2: a trilha é `member_invite`, não `invite_created` (`convites.ts:100`).
- Passo 3: o aceite grava `member_grant` (`convites.ts:176` e `:226`) e responde 204 (`convites.ts:292`).
- Passo 11: o logout global grava `session_logout_global`, não `session_ended` (`provedor.ts:233`). E o `GET /sessao/sessoes` depois dele dá 401, porque a sessão que pergunta também caiu (`provedor.ts:231`).
- Passo 12: `CONTA_DESLIGADA_SEM_VINCULO` só sai no job de expurgo (`provedor.ts:290`), não na revogação (`membros.ts:171`).
- Passos 1, 4, 7 a 10 e 13: status e eventos completados (`instancia.ts:177-183`, `protecao.ts:65-67`, `:221`, `:272-273`, `provedor.ts:391`, `:411`, `credenciais.ts:100-112`, `montagem.ts:66-69`).
- Passo 6: a evolução de psicologia saiu. A fumaça do login não precisa de dado de saúde, nem fictício.
- Acrescentados os passos 15 e 16 e os itens 0.7 e 0.8.

Ficou em aberto:
1. **Anonimização (R18):** `anonimizarConta` não tem rota (`provedor.ts:845`). Ela só é testável pelo procedimento de suporte. Antes da abertura, rodar esse procedimento uma vez numa conta fictícia e conferir `CONTA_ANONIMIZADA`, `account_anonymized` e `invite_pseudonym_dropped`.
2. **B2/D15:** falta o voto do @Lopesloro. Até ele chegar, o passo 14 só prova que a falha é aberta e registrada.
3. **Queda do Redis (D15 §2):** é opcional no B8, mas recomendado. Aceite e recuperação devem dar 503 com `BLOQUEIO_INDISPONIVEL`, e o login deve seguir com o alarme `RATE_LIMIT_FAIL_OPEN`.
4. **Passo 5:** provar que o MFA zera na troca de clínica exige uma segunda clínica fictícia.
5. **B9:** precisa estar no ar antes da rodada, com os convites reemitidos (0.7).

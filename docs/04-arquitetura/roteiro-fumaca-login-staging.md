# Roteiro do teste de fumaça do login real no staging (item B8)

> 12/11/2026 · Maestro · **rascunho para o Guardião conferir antes do dia**. Item B8 do checklist (`docs/03-seguranca-lgpd/prontidao-producao.md`). Roda depois do [runbook do primeiro dia do staging](runbook-primeiro-dia-staging.md), com a pilha do login (#149 → #179) na `main` e a imagem publicada.

> ⚠️ **Só contas fictícias.** Nomes e e-mails inventados, num domínio de teste sob nosso controle, e nenhum CPF. Nada deste roteiro entra em print ou log com segredo, código TOTP, token de convite ou de recuperação, ou cookie. A evidência é o **status HTTP**, o **nome do evento** no log de segurança e a **linha da trilha** (só ids e `op`).

## 0. Preparação

| # | O quê | Como confere |
|---|---|---|
| 0.1 | API no staging com `AUTH_PROVIDER=better-auth` e os segredos versionados do B1 | `/health/ready` 200; o boot não sobe sem os segredos (falha fechada) |
| 0.2 | TLS `verify-full` no Postgres e `rediss://` com AUTH no Redis (B4) | log do boot sem `RATE_LIMIT_FAIL_OPEN`; conexão recusada com CA errada |
| 0.3 | `HTTP_TRUST_PROXY_HOPS` conferido atrás do ALB (B3) | duas origens diferentes contam separado no bloqueio (passo 7) |
| 0.4 | Uma clínica fictícia criada pelo fluxo de provisionamento, com o fundador fictício | linha em `clinic_members` com `role=admin` |
| 0.5 | Um aplicativo autenticador num aparelho de teste, sem conta pessoal de ninguém | — |
| 0.6 | Forma de receber o convite e a recuperação no staging | **Em aberto:** depende do provedor de e-mail do staging. Sem ele, o roteiro para no passo 2 |

## 1. Rotas do roteiro

Better Auth em `/api/auth/*`: `sign-in/email`, `two-factor/enable`, `two-factor/verify-totp`, `sign-out`. Rotas nossas: `POST /clinica/convites`, `POST /convites/aceitar`, `GET /sessao/clinicas`, `POST /sessao/clinica`, `GET /sessao/sessoes`, `DELETE /sessao/sessoes/:id`, `POST /sessao/encerrar-todas`, `POST /sessao/senha`, `POST /clinica/membros/:usuarioId/desbloqueio`, `POST /clinica/membros/:usuarioId/recuperacao`, `POST /recuperacao/usar`, `DELETE /clinica/membros/:usuarioId/:perfil`.

## 2. Passos

| # | Passo | Esperado | Evidência |
|---|---|---|---|
| 1 | Fundador entra com senha | `sign-in/email` 200 com `twoFactorRedirect`, **sem** cookie de sessão | status; ausência do cookie |
| 2 | Fundador convida uma pessoa fictícia (`POST /clinica/convites`) | sem MFA recente: 403 `mfa_recente_obrigatorio`; com MFA: 201 | status; trilha `invite_created` |
| 3 | A pessoa aceita (`POST /convites/aceitar`), cria a senha e cadastra o TOTP (`two-factor/enable` + `verify-totp`) | sessão de cadastro não acessa rota de negócio; o primeiro código troca a sessão e grava `mfa_em` | trilha `mfa_enrolled`, `mfa_verified`; evento `LOGIN_OK` com motivo `cadastro_do_fator` |
| 4 | Mesmo código TOTP outra vez | 401 `INVALID_CODE` (reuso, RFC 6238 §5.2) | status |
| 5 | Escolha de clínica (`GET /sessao/clinicas`, `POST /sessao/clinica`) | só a clínica do vínculo aparece; trocar de clínica zera o MFA | trilha `session_tenant_selected` |
| 6 | Rota sensível com reverificação (`PUT /clinica/vinculo-de-cuidado` ou a evolução de psicologia) | sem reverificação recente: 403; depois do código: 200 | status; trilha da rota |
| 7 | Bloqueio 5/15: cinco senhas erradas para a pessoa fictícia | sexta tentativa recusada mesmo com a senha certa; outra origem conta separado (B3) | evento do bloqueio; nenhum e-mail ou IP em claro no log |
| 8 | Desbloqueio pelo admin (`POST /clinica/membros/:id/desbloqueio`) | exige MFA recente; depois disso, login volta a funcionar | trilha; evento |
| 9 | Recuperação pelo admin (`POST /clinica/membros/:id/recuperacao`, depois `POST /recuperacao/usar`) | token de uso único; segundo uso recusado; emitir de novo invalida o anterior | trilha; evento `RECUPERACAO_*` |
| 10 | Troca de senha (`POST /sessao/senha`) com a senha atual errada | conta no bloqueio | evento |
| 11 | Duas sessões da mesma pessoa; `POST /sessao/encerrar-todas` | as duas param de valer no servidor | `GET /sessao/sessoes` vazio; trilha `session_ended` |
| 12 | Desligamento (`DELETE /clinica/membros/:id/:perfil` do último perfil) | sessões da pessoa caem; login não abre outra clínica | trilha; evento `CONTA_DESLIGADA_*` quando for o caso |
| 13 | CSRF (C1): `POST` sem `Origin` válido | 403 | status |
| 14 | Log de segurança do dia | nenhum e-mail, nome, IP em claro, token ou código; só pseudônimos e ids | busca no CloudWatch pelos e-mails fictícios: **zero resultados** |

## 3. Depois

- As contas fictícias são desligadas e a clínica fictícia segue o fluxo normal de saída.
- A evidência (status, nomes de evento, ids da trilha) vai para um PR do devops-ci, e o Guardião escreve o resultado no parecer final da abertura.
- Qualquer passo fora do esperado trava a abertura (`AMBIENTES_POR_TIPO['better-auth']` não inclui `production`) até a correção e uma nova rodada.

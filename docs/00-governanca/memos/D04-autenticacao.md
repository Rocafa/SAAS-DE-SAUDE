# Memo D4 — Autenticação: Zitadel self-hosted × Better Auth

Data da medição: 2026-10-11 · Frente: QA-TESTES (N3) · Branch: `poc/d4-autenticacao`

**Este memo não decide nada.** A decisão D4 é dos sócios. O que está aqui é o resultado de
rodar os dois candidatos na mesma máquina, contra o mesmo Postgres, e medir os critérios
um por um. Onde não houve medição, está escrito que não houve.

Versões medidas: **Zitadel v4.19.4** (binário oficial, `darwin-arm64`, sha256 conferido
contra o `checksums.txt` do release) e **Better Auth 1.7.7** dentro de um NestJS 11 mínimo
(`poc/d4/`, fora do workspace do pnpm). Postgres 16.15 local na porta 5444, bancos
separados (`zitadel` e `poc_betterauth`). Zitadel na 8084, PoC do Better Auth na 8085.

## Tabela de resultados

Legenda: **MEDIDO** = observado na execução desta sessão. **FATO (doc)** = afirmação de
documentação ou de base pública, com fonte. Nada aqui é opinião.

| Critério | Zitadel v4.19.4 | Better Auth 1.7.7 |
|---|---|---|
| **MFA TOTP** | MEDIDO: `secondFactors` da política de login traz `SECOND_FACTOR_TYPE_OTP` | MEDIDO: `POST /two-factor/enable` devolve `totpURI` |
| **MFA WebAuthn** | MEDIDO: `SECOND_FACTOR_TYPE_U2F` e `MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION`; `passwordlessType: PASSWORDLESS_TYPE_ALLOWED` | MEDIDO: `/passkey/generate-register-options` devolve desafio (plugin `@better-auth/passkey`) |
| **MFA obrigatório por perfil** | MEDIDO: `forceMfa` vem **falso** por padrão. A política é por **instância/organização**, não por cargo — não há "obrigatório só para gestor" nativo | MEDIDO: não existe política de MFA; `twoFactorEnabled` é **por usuário**. Obrigar por cargo é código da aplicação |
| **Usuário em várias clínicas** | MEDIDO: o mesmo usuário aparece com membership em 2 organizações (`PoC D4` e `ZITADEL`) na busca de memberships | MEDIDO: `/organization/list` devolve **2 clínicas** para o mesmo usuário |
| **Troca de clínica** | MEDIDO: contexto trocado por organização no pedido (cabeçalho `x-zitadel-orgid`) / escopo `urn:zitadel:iam:org:id:<id>` | MEDIDO: `/organization/set-active` troca e `/whoami` passa a responder a 2ª clínica |
| **Clínica chega ao `withTenant` sem confiar no cliente** | **PARCIAL, MEDIDO:** o `x-zitadel-orgid` é enviado pelo cliente; o servidor só valida se o usuário é membro. A fonte não forjável é o claim do token assinado (`urn:zitadel:iam:user:resourceowner:id`) — usar o claim, nunca o cabeçalho | MEDIDO: `/whoami` resolve pela **sessão no banco**. Mandei `x-tenant-id: <outra clínica>` e a resposta manteve a clínica da sessão (`tenant ignora o que o cliente manda: SIM`) |
| **Recuperação sem revelar se o usuário existe** | **MEDIDO: falha na API de gestão** — `POST /v2/users/<id>/password_reset` devolve `404 "User could not be found"`, e a criação de sessão distingue usuário inexistente (`QUERY-Dfbg2`) de existente. Ressalva: esses endpoints exigem token; **sem token o retorno é 401** e não há vazamento público | MEDIDO: `POST /request-password-reset` devolve **HTTP 200 com o mesmo corpo** para e-mail existente e inexistente |
| **Cookie HttpOnly** | NÃO MEDIDO nesta sessão (exigiria o fluxo de navegador da login UI v2) | MEDIDO: `better-auth.session_token` com `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=28800`. `Secure` ausente só porque a PoC roda em `http://localhost` |
| **Access token ≤ 15 min** | **MEDIDO: 43.200 s (12 h)** no padrão — `client_credentials` devolveu `expires_in: 43199` e o JWT trouxe `exp - iat = 43200`. Precisa ser reduzido por configuração; não vem pronto | MEDIDO: **900 s (15 min)** — plugin `jwt` com `expirationTime: '15m'`, conferido em `exp - iat` do token de `/token` |
| **Refresh rotativo com detecção de reuso** | FATO (doc): o Zitadel emite refresh token rotativo e invalida a família no reuso — não medi o reuso nesta sessão (exigiria fluxo `authorization_code` com navegador) | **NÃO TEM, por desenho:** a sessão é cookie opaco no banco, sem refresh token. Rotação/detecção de reuso não se aplica; o que existe é expiração de sessão (8 h aqui) e revogação no servidor |
| **Logout global** | MEDIDO (capacidade): o discovery publica `end_session_endpoint`, `revocation_endpoint` e `backchannel_logout_supported: true` | MEDIDO: depois de `/sign-out`, o cookie antigo reapresentado dá **401** — a sessão morre no servidor, não só no navegador |
| **Proteção contra CSRF** | NÃO MEDIDO | MEDIDO: `POST` sem cabeçalho `Origin` é **recusado com 403** (`MISSING_OR_NULL_ORIGIN`) |
| **Política de senha / bloqueio** | MEDIDO: complexidade mínima 8 com maiúscula, minúscula e número; **política de bloqueio vem vazia** (sem limite de tentativas no padrão) | MEDIDO: mínimo 8 caracteres no padrão; bloqueio por tentativa não configurado |
| **Tempo para subir (frio)** | MEDIDO: **1,4 s** do processo até `server is listening`, criando 144 tabelas no banco vazio (`start-from-init`) | MEDIDO: `pnpm install` 4 s + migração 1 s (10 tabelas) + servidor no ar em 2 s |
| **Esforço de operação** | 1 binário de 169 MB + 1 banco. Serviço separado para operar, atualizar e monitorar; traz console de administração, OIDC/SAML e auditoria prontos | Biblioteca dentro da nossa API: nada novo para operar, mas **nós** passamos a ser responsáveis por telas de login, MFA, convites e auditoria |
| **Dados no Brasil** | FATO: self-hosted — fica onde a gente puser (AWS São Paulo, conforme CONTEXTO.md §6). Sem dependência de nuvem do fornecedor | FATO: biblioteca na nossa API, no nosso Postgres. Nenhum dado sai da nossa infra |
| **CVEs recentes** | MEDIDO + FATO (doc): 6 avisos de 2026, vários altos (XSS com tomada de conta no `/saml-post`, escopo de organização não aplicado no OIDC, link de reset montado a partir de cabeçalho `Host`). Corrigidos até 4.12.3 — **a versão que medi, 4.19.4, está acima de todos** | MEDIDO + FATO (doc): vários avisos altos em 2026 (bypass de 2FA por cache de sessão, limite de taxa por IPv6, plugin de device authorization, replay de refresh token em OAuth). Corrigidos até 1.6.11 — 1.7.7 está acima. **Mas** `pnpm audit` da PoC acusa **1 crítico e 16 altos**: a maioria vem do `@better-auth/cli`, que **pina um better-auth antigo** (1.4.x) como dependência |

## Dois achados que valem mais que a tabela

1. **O CLI oficial do Better Auth está atrasado em relação à biblioteca.** `better-auth` está
   em 1.7.7; `@better-auth/cli` em 1.4.21. O CLI é o caminho oficial de migração do banco, e
   arrasta uma cópia vulnerável da própria biblioteca (1 aviso crítico no `pnpm audit`). É
   dependência de desenvolvimento, não vai para produção, mas é atrito real de manutenção.
   Medido: sem o CLI 1.4.21 não há migração; com ele, o `audit` fica vermelho.
2. **Os dois chegam ao requisito "clínica sem confiar no cliente", por caminhos diferentes.**
   No Better Auth a clínica ativa vive na linha da sessão — medi mandando outra clínica no
   cabeçalho e sendo ignorado. No Zitadel, a forma mais usada (`x-zitadel-orgid`) **é** um
   cabeçalho do cliente, validado por membership; para não confiar no cliente, a API tem de
   ler o claim do token assinado. Se a escolha for Zitadel, isso precisa virar regra escrita,
   porque o caminho fácil é o errado.

## Como reproduzir

```sh
# Better Auth
cd poc/d4 && cp .env.example .env   # preencha POC_DATABASE_URL (banco local, sintético)
pnpm --ignore-workspace install
pnpm migrate && pnpm start          # porta 8085
pnpm medir                          # imprime uma linha por critério

# Zitadel (binário oficial, fora do repositório)
# v4.19.4 darwin-arm64, sha256 25e01928885d4a4a64a1157902809528337a78374ba94f390fd0ef8892149f3f
zitadel start-from-init --config zitadel.yaml --steps steps.yaml \
  --masterkey <32 bytes> --tlsMode disabled   # porta 8084
```

## Limites honestos desta medição

- Esta máquina **não tem runtime de container**. O pedido original dizia "Zitadel
  self-hosted (docker)"; rodei o **binário oficial** por autorização da ORDEM-001. O
  comportamento da aplicação é o mesmo, mas **não medi** a operação em container
  (imagem, healthcheck, recursos).
- Nada que exija navegador foi medido: fluxo `authorization_code`, cookie da login UI do
  Zitadel, registro real de passkey e detecção de reuso de refresh token. Está marcado
  como NÃO MEDIDO, nunca como aprovado.
- Nenhum teste de carga, nenhum teste de disponibilidade.
- Tudo com dados sintéticos, em bancos locais descartáveis. Nenhum segredo commitado.

## Fontes

- Release do Zitadel v4.19.4 (publicado 2026-10-01): https://github.com/zitadel/zitadel/releases/tag/v4.19.4
- CVE-2026-29191 (XSS no `/saml-post`, correção 4.12.0): https://advisories.gitlab.com/golang/github.com/zitadel/zitadel/CVE-2026-29191/
- CVE-2026-33132 (escopo de organização não aplicado, correção 3.4.9 e 4.12.3): https://advisories.gitlab.com/golang/github.com/zitadel/zitadel/CVE-2026-33132/
- CVE-2026-29067 (reset por cabeçalho `Host`, correção 4.7.1): https://cvefeed.io/vuln/detail/CVE-2026-29067
- CVE-2026-29192 e CVE-2026-29193 (login v2): https://db.gcve.eu/vuln/CVE-2026-29193
- CVE-2026-27945 (SSRF em Actions): https://www.cvelogic.com/cve/CVE-2026-27945
- CVE-2026-45364 (limite de taxa por IPv6 no Better Auth): https://advisories.gitlab.com/npm/better-auth/CVE-2026-45364/
- CVE-2026-45337 (device authorization no Better Auth): https://advisories.gitlab.com/npm/better-auth/CVE-2026-45337/
- GHSA-xg6x-h9c9-2m83 (bypass de 2FA, correção 1.4.9): https://advisories.gitlab.com/npm/better-auth/GHSA-xg6x-h9c9-2m83/
- Todas as fontes de CVE consultadas em 2026-10-11. Os avisos vêm de espelhos (GitLab,
  cvefeed, GCVE); antes de decidir, conferir a aba de Security Advisories de cada projeto.

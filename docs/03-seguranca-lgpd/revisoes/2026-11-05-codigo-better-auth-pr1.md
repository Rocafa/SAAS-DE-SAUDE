# Parecer do Guardião LGPD: código do PR 1 da autenticação real (D4, Better Auth, PR #149)

> Data: 05/11/2026. Branch: `eng/better-auth-base` (até `ed2721e`). Base: o parecer do desenho (`2026-11-05-desenho-better-auth.md`, R1–R20) e a §12 de `docs/04-arquitetura/autenticacao-better-auth.md`. Revisão estática do diff `main...eng/better-auth-base` e do código da biblioteca instalada (`better-auth@1.7.12`, `dist/cookies/index.mjs`). Sem Postgres local: RLS não rodado aqui; o CI do RLS passou, segundo o pedido.

## Veredito: **VETADO até corrigir a ressalva 1. Depois disso, APROVADO COM RESSALVAS.**

O núcleo está certo: o papel `app_auth` isola o schema `identidade`, a allowlist é fechada e falha fechada, o provedor confere o vínculo a cada requisição sob RLS, o MFA fica preso aos perfis, o scrypt está acima do padrão da biblioteca e o IP e o user-agent só entram em HMAC. O veto vem só da R8: o cookie de produção **não** sai como `__Host-sessao` (o §2 da arquitetura diz que sai), e a escolha entre dev e produção não falha fechada. Produção ainda não sobe com `better-auth` (R13), então não há exposição hoje. Mas a R8 era condição do PR 1, a correção é curta e, do jeito que está, o teste dá uma garantia falsa.

## Ressalvas

### Bloqueia (corrigir neste PR)

1. **R8: cookie de produção e falha fechada.**
   - (a) Com `useSecureCookies: true`, a biblioteca **prefixa** o nome customizado (`createCookie`: `` `${secureCookiePrefix}${name}` ``). O cookie sai como `__Secure-__Host-sessao`. O navegador trata esse nome só como `__Secure-`, e as garantias do `__Host-` (sem `Domain`, `Path=/` obrigatório) deixam de valer. Para corrigir: em produção, configurar o nome sem o prefixo que a biblioteca acrescenta e conferir o nome final, ou aceitar e documentar `__Secure-` e corrigir o §2.
   - (b) Em `boot.ts`, `producao = env.NODE_ENV === 'production'`. Com isso, `staging`, vazio ou qualquer outro valor perdem `Secure`. A R8 pede o contrário: só `development` e `test` perdem. Usar `!AMBIENTES_SESSAO_FICTICIA.has(env.NODE_ENV ?? '')`.
   - (c) Hoje o teste confere `nomeDoCookie(true)`, uma função nossa. Ele não confere o `Set-Cookie` real. Falta um teste com a instância montada em modo produção (`producao: true`, `baseURL` https) que liste **todos** os `Set-Cookie` do login, inclusive o `dont_remember` com `rememberMe: false`, e confira nome, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` e ausência de `Domain`.

### Antes do PR 3 (antes de abrir produção ou de entrar dado real)

2. **Conta inativa no login.** Hoje o login de uma conta com `ativo = false` cria a sessão e grava `LOGIN_OK`; o provedor só a derruba na requisição seguinte. A recusa precisa acontecer no `databaseHooks.session.create.before`, com `LOGIN_FALHOU`.
3. **Limite de corpo na montagem.** A montagem roda antes do parser JSON, e a biblioteca lê o corpo cru sem o `bodyLimit` da borda. Recusar com 413 quando o `Content-Length` passar do limite ou faltar no `POST /sign-in/email`.
4. **ROPA, RIPD e retenção (R11).** O prazo está na §12, mas `RIPD-plataforma.md` e `matriz-retencao.md` ainda não têm o schema `identidade`: e-mail, nome, sessão, HMAC de IP e user-agent, log de segurança de 180 dias e expurgo diário de sessão e verificação. A base legal é o art. 7º V e IX.
5. **Segredos de infraestrutura (R2).** `BETTER_AUTH_SECRET`, `DATABASE_AUTH_URL` e `APP_AUTH_PASSWORD` precisam vir do Secrets Manager no Terraform, com `BETTER_AUTH_SECRET` na lista de variáveis obrigatórias da API.
6. **Renovação do cookie.** O `getSession` do provedor estende a sessão no banco, mas o `Set-Cookie` não chega à resposta. O cookie expira 15 min depois do login mesmo com a sessão em uso. É falha fechada, mas a solução precisa respeitar a R19 (polling não renova).
7. **R3 na montagem sem teste.** O dublê devolve `null` no `getSession`, então o ramo do prazo absoluto de 12 h em `get-session`/`sign-out` nunca roda. Acrescentar um caso com sessão de 13 h.

### Fila

8. **Espelho de vínculos.** O trigger cobre só `INSERT` e `UPDATE OF revoked_at`. Hoje está correto porque `clinic_members_guard` só permite a revogação, o `app_user` não tem `DELETE` e o índice único parcial permite um só perfil ativo por pessoa e clínica (isso também serializa a corrida entre revogar e conceder de novo). Registrar no guard que qualquer mudança nele exige rever o espelho, e criar uma conferência periódica de que espelho e `clinic_members` batem. O `NOT EXISTS` dentro do trigger roda como dono, sob FORCE RLS, e na prática não é usado.
9. Pôr `returned: false` em `user.ativo`, que hoje sai no `get-session`.
10. `LOGIN_FALHOU` grava `motivo: 'senha_errada'` para qualquer resposta diferente de 200 (400, 403, 500). Usar um motivo genérico, ou o status.
11. A chave do rate limit também gera o HMAC de origem e de user-agent; a separação hoje é só pelo prefixo `ua:`. Melhor derivar uma chave por uso (HKDF).
12. Em `main.ts`, `bootDoBetterAuth` abre os pools antes de a fábrica recusar o ambiente. Conferir o ambiente primeiro.

## Conferido sem achado

| Item | Situação |
|---|---|
| R1 papel `app_auth` | GRANTs só para `app_auth`; o bootstrap falha se o `app_user` tiver `USAGE` em `identidade` ou se o `app_auth` tiver BYPASSRLS; teste do `app_user` negado em `sessao` e `vinculo`. ✅ |
| R2 segredo | Obrigatório, ≥ 32 bytes, sem padrão; `baseURL` vem da configuração; rotação descrita na §12. ✅ (infraestrutura na ressalva 5) |
| R3 prazo absoluto de 12 h | Provedor e montagem apagam a sessão vencida; no provedor, coberto por teste. ✅ (teste da montagem na ressalva 7) |
| R4 allowlist | Comparação exata de método e caminho; variantes (barra final, `%2F`, `..`, maiúsculas) dão 404 ou caem fora do prefixo; o handler só é alcançável pela montagem. ✅ |
| R5 `input: false` | Nos três campos da sessão e em `ativo`; `returned: false`; teste. ✅ |
| R6 vínculo por requisição | Perfis lidos de `clinic_members` sob RLS a cada requisição; sem perfil, `null` e clínica zerada; teste. Falhas de leitura voltam `null` (fecham). ✅ |
| R7 espelho e trigger | SECURITY DEFINER aceitável: `EXECUTE` revogado de PUBLIC; função só de trigger (o `app_user` não tem privilégio `TRIGGER` para ligá-la a outra tabela); `search_path` fixo; `NEW` já passou pelo guard BEFORE; escreve só ids e papel. `NO FORCE` temporário dentro de `sql.begin` (transacional). ✅ |
| R9 senha | scrypt N=2^16, r=8, p=2; NFKC; `timingSafeEqual`; faixa de parâmetros contra DoS. ✅ |
| R10 HMAC de IP e user-agent | Cabeçalho do cliente apagado; gancho grava só 16 hex; CHECK no banco; `trust proxy` = 1 salto em staging; rate limit da biblioteca desligado. ✅ |
| R12 auditoria | Logger sem mensagem (o e-mail não vaza); `session_tenant_selected` na trilha da clínica; handler declarado em `HANDLERS_FORA_DE_CONTROLLER`; eventos no guia de logs. ✅ |
| R13 seis ganchos e bloqueio | Contrato com os 6 ganchos na bancada; `better-auth` só sobe em dev/test. ✅ |
| `perfis_no_mfa` | Gravado só por `marcarMfa`, que nenhuma rota HTTP chama no PR 1; o MFA cai se os perfis mudarem. É uma impressão sem chave de um conjunto pequeno e não secreto, aceitável. ✅ |
| Dados reais e segredos no git | Só contas e senhas fictícias e a senha efêmera do CI. ✅ |
| CFM, ANS e ICP-Brasil | Não toca prontuário, TISS nem assinatura; NGS2 depende do MFA do PR 2. ✅ |

## Nota do Maestro (05/11/2026)

- **R8, o veto (feito):** `useSecureCookies: false`. O `Secure` vem dos atributos, para a biblioteca não acrescentar `__Secure-` ao nosso nome. O modo seguro agora falha fechado: vale em tudo que não for development ou test (staging e NODE_ENV vazio também). Teste RLS novo: a instância em modo produção faz login, e **todo** `Set-Cookie` sai com `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` e sem `Domain`; a sessão sai exatamente como `__Host-sessao`, e nenhum cookie começa com `__Secure-__Host`.
- **Antes do PR 3, feitos agora:**
  - conta inativa não abre sessão nem gera `LOGIN_OK` (o gancho `session.create.before` recusa), com teste RLS;
  - corpo do login com teto de 4 KiB, e chunked dá 413, com teste;
  - teste do prazo absoluto de 12 h na montagem.
- **Antes do PR 3, abertos:**
  - RIPD e matriz de retenção do schema `identidade`;
  - segredos no Secrets Manager via Terraform (depende da AWS);
  - `Set-Cookie` renovado quando o provedor estende a sessão.
- **Fila:** os itens do §3 do parecer.

## Veredito final (reconferido em `4191525`): **APROVADO COM RESSALVAS**
Reconferi no código o que a nota acima diz:
- **Veto R8 resolvido:** `useSecureCookies: false`; o `Secure` vem dos atributos. A escolha do modo usa `!AMBIENTES_SESSAO_FICTICIA.has(NODE_ENV)`, e só development e test ficam sem `Secure`. O teste em modo produção, com `rememberMe: false`, confere todos os `Set-Cookie`, o nome `__Host-sessao` e a ausência de `__Secure-__Host`.
- **Fechados:** ressalva 2 (o gancho `session.create.before` recusa conta inativa, com teste), ressalva 3 (teto de 4 KiB e 413 para chunked, com teste) e ressalva 7 (12 h na montagem, com teste).
- **Seguem abertas antes do PR 3:** as ressalvas 4, 5 e 6. A fila (8–12) fica como está.
- Os testes RLS novos não rodaram aqui (sem Postgres local). A aprovação depende do CI do RLS verde neste commit.

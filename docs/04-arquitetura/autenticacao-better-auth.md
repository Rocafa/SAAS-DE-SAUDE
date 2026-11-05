# Autenticação com Better Auth (D4): desenho

> 05/11/2026 · frente Engenharia · base: D4 decidida em 05/11 (#142), [memo de recomendação](../00-governanca/memos/D04-recomendacao.md) com as 6 regras, contrato do provedor (#128), pareceres do #117 (R6) e do #123 (R5 e R6). **Este documento passa pelo Guardião antes do código.**

## 1. Princípio

O Better Auth cuida da **credencial**: senha, sessão, cookie e, no PR 2, o TOTP. **Tudo o que é autorização continua nosso**: qual clínica, quais perfis, quando o MFA é obrigatório e recente, a auditoria. A API nunca confia em algo que a biblioteca não grava no servidor. O `AuthContext` sai do `BetterAuthProvider`, que precisa passar no contrato do #128 com os 6 ganchos.

## 2. Versão e cadeia de suprimentos (regra 6)

- `better-auth` **1.7.12**, versão exata no `package.json`. É a mais nova da linha 1.7 com 2 semanas ou mais, e nenhum aviso do GitHub Advisory atinge a ≥ 1.7.7 (conferido em 05/11).
- `telemetry: { enabled: false }`, explícito.
- **Sem o CLI** da biblioteca, que puxa uma versão antiga e vulnerável. O schema é migração nossa.
- Revisão mensal dos avisos: um item no checklist do GA e no `docs/04-arquitetura/dependencias.md`. Atualizar exige parecer.

## 3. Dados de identidade (regra 4)

- **Schema `identidade`**, separado das tabelas da clínica, na migração **0064**:
  - `usuario`: id, e-mail, nome de exibição, se o e-mail foi verificado, datas;
  - `sessao`: id, token, expiração, usuário, IP e user-agent em HMAC (§7), mais os campos nossos de §5;
  - `conta`: credencial, com a senha em hash scrypt (padrão da biblioteca);
  - `verificacao`: tokens de uso único.
  - O TOTP entra no PR 2, em `identidade.dois_fatores`, cifrado.
- **Não tem `tenant_id` nem RLS por clínica:** identidade é da pessoa, que pode estar em várias clínicas. O acesso fica restrito por GRANT: o `app_user` lê e grava só o que a biblioteca usa, e `DELETE` só em `sessao` e `verificacao`. Nenhuma tabela de clínica referencia o schema `identidade`, nem o contrário. O vínculo pessoa×clínica continua em `clinic_members`.
- **E-mail e nome são dado pessoal**, então entram no ROPA e no RIPD da plataforma. Nunca vão para log, trilha nem exportação de clínica: a exportação continua levando só ids da equipe.

## 4. Cookie e sessão (regra 3)

- **Cookie `__Host-sessao`**, com `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` e sem `Domain`. Em desenvolvimento local (http), o nome perde o prefixo `__Host-`, porque o navegador recusa o prefixo sem `Secure`. A fábrica escolhe pelo `NODE_ENV`, em lista fechada.
- **Inatividade de 15 min** (E5): `expiresIn = 15 min`, renovado a cada uso (`updateAge = 1 min`). Sem uso, a sessão morre no servidor.
- **Prazo absoluto de 12 h:** o provedor recusa sessão com `createdAt` de mais de 12 h, mesmo se ela estiver ativa.
- **`cookieCache` desligado.** A sessão é lida do banco em toda requisição. Foi esse cache que causou o bypass de MFA do GHSA-xg6x-h9c9-2m83.
- **Logout** apaga a sessão no servidor, e o cookie antigo recebe 401 (gancho `encerrar` da bancada). **Logout global** (PR 3) apaga todas as sessões do usuário.
- **Substitui o "refresh rotativo com detecção de reuso"** de `seguranca-na-arquitetura.md` §2. Com sessão opaca e curta no banco, não existe refresh token para reusar, e a revogação é imediata. **Precisa do aval do Guardião.**
- Sem plugin `jwt` nem `bearer`: o cookie é a única credencial. Token entre serviços fica para quando houver um segundo serviço.

## 5. Clínica ativa e perfis (regra 1, contrato R6)

- **Campo nosso na `sessao`: `clinica_ativa`** (uuid ou nulo). Só a nossa rota `POST /sessao/clinica {clinicaId}` grava esse campo (PR 3). Ela confere o vínculo ativo pela função `app_clinicas_do_usuario(usuario)` (SECURITY DEFINER, só ids, migração 0064), porque a RLS de `clinic_members` exige o contexto da clínica. Com uma clínica só, a escolha é automática no login.
- **Trocar de clínica zera o `mfa_em`** da sessão (gancho `trocarClinica`) e grava `session_tenant_selected` na trilha da clínica nova.
- **Perfis só do banco:** o provedor devolve exatamente os perfis ativos em `clinic_members`. A transição "sem linha = vale o provedor" do #130 acaba para este provedor. O guard continua conferindo (dupla checagem).
- **A clínica nunca vem do cliente.** O teste "cabeçalho forjado não muda nada" do contrato roda contra a bancada real.

## 6. MFA (regra 2; PR 2)

- Plugin `twoFactor` (TOTP). **A obrigatoriedade continua no nosso código** (`mfa.ts`, todos os perfis).
- **`mfa_em`**, campo nosso na `sessao`, só é gravado pelo nosso gancho depois da verificação do TOTP pela biblioteca. No login nasce nulo. **Nunca vem de claim nem de cabeçalho** (R6 do #123).
- **Step-up:** a rota de reverificação atualiza o `mfa_em` (gancho `stepUp`). Trocar senha ou perfil zera o campo (ganchos `trocarSenha` e `trocarPerfis`).
- **Eventos do fator na trilha** (R5 do #123): cadastro, remoção, verificação ok e falha, bloqueio, e reset com justificativa obrigatória, com alerta aos admins.

## 7. Login montado fora de controller (R6 do #117) e auditoria

- O handler da biblioteca (`toNodeHandler`) entra em `/api/auth/*` e é declarado em `HANDLERS_FORA_DE_CONTROLLER`, com o motivo.
- **Só os endpoints usados ficam expostos:** e-mail e senha, sessão, logout e, no PR 2, TOTP. O cadastro público fica **desligado** (`disableSignUp`): a conta nasce pelo convite da clínica (PR 3), e em teste e dev pela API do servidor.
- **Auditoria pelos ganchos da biblioteca**, em dois registros:
  - **Log de segurança**, sempre: `LOGIN_OK`, `LOGIN_FALHOU`, `LOGOUT` e `CONTA_BLOQUEADA`, com `userId` quando houver e a `origem` em HMAC, **nunca o e-mail**.
  - **Trilha da clínica**, quando há clínica: a seleção da clínica, o logout com clínica ativa e os eventos de MFA. Falha de login sem usuário identificado não tem clínica e fica só no log de segurança.
- **IP e user-agent na `sessao` em HMAC**, nunca em claro. A guarda do IP em claro exigida pelo Marco Civil fica nos logs do ALB (pendência AWS/D8).
- **Bloqueio** (PR 2): 5 falhas em 15 min por e-mail em HMAC e por origem, no store do rate limit (Redis), com resposta idêntica para conta existente e inexistente.

## 8. CSRF e origem

O cookie `SameSite=Strict` soma com o `protecaoCsrf` da borda (#132), que já recusa escrita de origem fora da allowlist, e com a checagem de origem da própria biblioteca, que recebe a mesma allowlist em `trustedOrigins`. Vale a R1 do parecer do #132: escrita com cookie de sessão e **sem** `Origin` válido dá 403. Isso entra no PR 1, com teste.

## 9. Recuperação de senha

A resposta é idêntica para e-mail existente e inexistente (HU-NUC-012). **Fica desligada até existir o provedor de e-mail** (decisão dos sócios pendente). Até lá, a recuperação é pelo admin da clínica, com auditoria.

## 10. Portal do paciente (regra 5)

Fora deste desenho. Terá instância, cookie e sessão separados, com login por SMS (D4), e PoC própria. Nenhuma sessão da equipe vale no portal, nem o contrário.

## 11. Entrega

| PR | Conteúdo | Testes |
|---|---|---|
| **1. Base** | Migração 0064 (`identidade` e a função de clínicas); instância com a configuração das §§2–4 e 7–8; `BetterAuthProvider`; fábrica como mapa por tipo (R4 do #128); handler declarado; eventos de login, logout e falha | Bancada `better-auth` no contrato, com os 6 ganchos e banco real (RLS); cookie e atributos; logout; prazo absoluto; cabeçalho forjado; 403 sem `Origin` |
| **2. MFA e proteção** | TOTP, `mfa_em`, step-up, bloqueio 5/15 e eventos do fator | Ganchos `stepUp` e `trocarSenha`; bloqueio com resposta idêntica |
| **3. Clínica e equipe** | `POST /sessao/clinica`, perfis só do banco, convite, logout global e desligamento | Gancho `trocarClinica`; `trocarPerfis`; desligado perde todas as sessões |

O dev provider continua para dev e testes. Produção sobe só com `AUTH_PROVIDER=better-auth`, e a trava de produção da fábrica segue valendo.

## 12. Decisões depois do parecer do Guardião (05/11, `revisoes/2026-11-05-desenho-better-auth.md`)

O Guardião aprovou com ressalvas e **deu o aval para substituir o refresh rotativo**, com a condição de reescrever o §2 de `seguranca-na-arquitetura.md` no PR 1. As ressalvas R1 a R13 valem para o PR 1:

| R | Decisão |
|---|---|
| 1 | O papel de banco **`app_auth`** é o único com GRANT no schema `identidade`, e a biblioteca usa um pool próprio com ele. O `app_user` não tem nenhum GRANT ali, e um teste confere o erro de permissão. |
| 2 | **`BETTER_AUTH_SECRET`** vem do Secrets Manager, com 32 bytes ou mais, sem valor padrão. A API não sobe sem ele fora de dev/test. O `baseURL` vem da configuração, nunca do `Host`. Plano de rotação: trocar o segredo derruba todas as sessões, o que é aceitável. |
| 3 | O **prazo absoluto de 12 h** vale em todo caminho: um middleware antes do handler da biblioteca e o provedor **apagam** a sessão vencida e respondem 401, com teste nos dois caminhos. |
| 4 | **Lista fechada de endpoints** da biblioteca na montagem (sessão, e-mail e senha para entrar, sair e, no PR 2, o TOTP). O resto dá 404, com teste para cadastro, troca de e-mail, exclusão e atualização de usuário. |
| 5 | `clinica_ativa`, `mfa_em` e `perfis_no_mfa` com `input: false`, fora das respostas da biblioteca, com teste. |
| 6 | O provedor confere o **vínculo ativo em `clinic_members` a cada requisição**. Sem vínculo, devolve `null` (401) e zera `clinica_ativa`. |
| 7 | A função `app_clinicas_do_usuario` é `SECURITY DEFINER`, com `search_path` fixo, sem acesso público (`EXECUTE` só para o `app_auth`), e devolve só ids de vínculos ativos. Tem teste RLS. |
| 8 | Teste de todos os `Set-Cookie`. `useSecureCookies: true` explícito fora de dev/test. `freshAge` de 15 min. `trustedOrigins` vem da mesma allowlist do CORS, sem curinga. |
| 9 | **Hash de senha:** scrypt nativo do Node com **N=2^16, r=8, p=2** (64 MiB, um dos mínimos da OWASP), por `password.hash/verify` nossos. O padrão da biblioteca (N=2^14, r=16, p=1) fica cerca de 4 vezes abaixo do mínimo. Argon2id exigiria uma dependência nativa a mais. O §2 de `seguranca-na-arquitetura.md` passa a dizer scrypt com esses parâmetros. |
| 10 | O IP e o user-agent da sessão são gravados em **HMAC** (chave secreta) por gancho de banco antes da inserção, com teste. `advanced.ipAddress` usa os proxies confiáveis (`HTTP_TRUST_PROXY_HOPS`). **O rate limit da biblioteca fica desligado:** o nosso, no Redis, cuida do bloqueio no PR 2. |
| 11 | **Retenção:** sessão vencida e `verificacao` usada ou vencida são apagadas por rotina diária (a rotina entra no PR 3, mas o prazo já vale). O log de segurança fica 180 dias (Marco Civil, mínimo de 6 meses). Tudo entra no ROPA. |
| 12 | Teste da R6(b) do #117. O login com clínica automática grava `session_tenant_selected`. O **logger da biblioteca** vai para o nosso log só em nível de erro, com uma mensagem fixa e sem o corpo da requisição, para o e-mail nunca sair por ele. |
| 13 | **Os 6 ganchos entram no PR 1**, pelas nossas funções internas: `trocarClinica` grava a clínica e zera `mfa_em`; `stepUp` marca `mfa_em` (o PR 2 só liga a verificação TOTP a essa função); `trocarSenha` usa a troca da biblioteca com revogação e zera `mfa_em`; `expirar`; `forjarCredencial`. Para `trocarPerfis`, a sessão guarda a **impressão dos perfis no momento do MFA** (`perfis_no_mfa`, hash). Se os perfis mudam no banco, o provedor devolve `mfaEm = null`, sem as rotas de negócio escreverem na sessão (o que a R1 proíbe). **`AUTH_PROVIDER=better-auth` só sobe em dev e teste até o PR 3:** a fábrica recusa esse provedor em produção até lá. |

As ressalvas R14 a R20 ficam para os PRs 2 e 3, como o parecer separa. A R18 (o autor do prontuário identificado por 20 anos depois do desligamento) é decidida no PR 3: a identificação do profissional (nome e registro) fica na tabela `professionals` da clínica, que já existe e já vai no pacote da G2. Assim, apagar `identidade.usuario` não apaga a autoria.

## 13. PR 2: MFA e proteção (TOTP, bloqueio, senha vazada)

Atende às R14 (parte do fator) e R15 do parecer do desenho e à R5 do #123 na parte do próprio fator. Código: `protecao.ts` (ganchos `before`/`after` nossos na biblioteca, que rodam antes dos do plugin), `senha-vazada.ts`, migração 0065.

| Tema | Decisão |
|---|---|
| **Endpoints** | Abertos só `POST /two-factor/enable` (cadastro, exige a senha) e `POST /two-factor/verify-totp` (login em duas etapas, cadastro e reverificação). Ficam **fechados (404)**: desligar o fator, rever o URI, códigos de reserva e OTP por e-mail/SMS. A remoção e a recuperação do fator são pelo admin, com justificativa (R17, PR 3). |
| **`mfa_em`** | Só o nosso gancho `after` grava, depois que a biblioteca aceitou o código (`aposMfaVerificado` no provedor). Com uma clínica só, a clínica é escolhida antes (trocar de clínica zera o MFA). Com várias e nenhuma escolhida, o MFA **não** é marcado: no PR 3 a escolha vem antes da reverificação. |
| **Segredo e códigos de reserva** | Cifrados pela biblioteca com o `BETTER_AUTH_SECRET` antes do banco (`identidade.dois_fatores`). Os códigos de reserva não saem na resposta do cadastro: sem endpoint que os use, só confundiriam. |
| **"Lembrar este aparelho"** | Recusado (400): pular o segundo fator por 30 dias contraria a regra 2 da D4. |
| **Código reutilizado** | A biblioteca aceita a janela de ±1 período (90 s) e não impede o reuso. O nosso gancho registra o código de forma **atômica** antes da conferência e recusa o mesmo código da mesma pessoa por 90 s (RFC 6238 §5.2). |
| **Bloqueio do login** | 5 falhas em 15 min por e-mail (em HMAC) e 30 por origem. A origem tem teto maior porque a clínica inteira sai por um IP (NAT): 5 erros de pessoas diferentes não podem trancar todos. Bloqueado, a resposta é **a mesma** da senha errada (`INVALID_EMAIL_OR_PASSWORD`) e custa o mesmo hash scrypt, com teste de tempo (tolerância de 3x; sem o hash de mentira a diferença seria de dezenas de vezes). Cada tentativa é **reservada** de forma atômica antes da conferência e devolvida no acerto (R1 do parecer do código): requisições em paralelo não passam do teto. Janela fixa: no Redis, ela vence 15 min depois da **primeira** falha (não da quinta), e o bloqueio dura o que falta dela. |
| **Bloqueio do fator** | 5 falhas em 15 min por pessoa e 30 por origem, no store do rate limit (Redis), para a reverificação com sessão aberta, a senha do cadastro e o login em duas etapas (a pessoa vem do desafio assinado pela biblioteca). A biblioteca também tranca a conta no banco no login em duas etapas (5 falhas, 15 min), como segunda camada. Resposta: 429 `ACCOUNT_TEMPORARILY_LOCKED`, a mesma da biblioteca. |
| **Store fora do ar** | O bloqueio segue sem contar (como o rate limit) e alarma `RATE_LIMIT_FAIL_OPEN`. Com o Redis fora, o fallback em memória continua contando por instância. |
| **Senha vazada (R15)** | Toda senha **nova** (troca, reset, definição, cadastro) é conferida por k-anonimato na base pública de senhas vazadas: sai só o prefixo de 5 hex do SHA-1, com enchimento ligado; a comparação do resto é local. Vazou: 400 `PASSWORD_COMPROMISED`. Base fora do ar (prazo de 2 s): a troca segue e alarma `CONFERENCIA_DE_SENHA_INDISPONIVEL`, porque falhar fechado travaria a troca de senha (inclusive a forçada pelo admin) por causa de um terceiro. **Infra:** a saída para `api.pwnedpasswords.com:443` entra na allowlist de egresso. |
| **Trilha da clínica (R5 do #123)** | Com clínica ativa: `mfa_enrolled` e `mfa_verified` (ação `login`), `mfa_failed` e `mfa_locked` (ação `login_failed`), escopo `mfa`, sem nenhum dado além do `op`. Falha no login em duas etapas não tem clínica: fica só no log de segurança. A recusa por MFA em rota comum com os alvos distintos (nota da R9 do #123) vai num PR à parte, no guard. Reset e remoção com justificativa e alerta ao admin: PR 3 (R17). |
| **Rotação do segredo** | O segredo do TOTP é cifrado com o `BETTER_AUTH_SECRET`: trocar esse segredo exige o recadastro do TOTP de todos, até migrarmos para os segredos versionados da biblioteca (R9 do parecer, PR 3). |
| **`LOGIN_OK`** | Continua significando "senha aceita". Com TOTP, a biblioteca abre e apaga uma sessão provisória antes do desafio; o `MFA_VERIFICADO` completa o login. |

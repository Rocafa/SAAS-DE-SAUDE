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
  - **Por que login e falha de login não vão para a trilha** (revisão do #149, corrigida no #166): os dois acontecem **antes** da escolha da clínica, e a trilha é por clínica. Não há tenant onde gravar. O vestígio do login na trilha é o `session_tenant_selected`, gravado quando a sessão ganha a clínica (automática com uma clínica só, ou pela rota de escolha).
  - **Ordem da escolha:** a linha `session_tenant_selected` grava **antes** de `clinica_ativa`. São bancos diferentes; se a trilha falhar, a sessão fica sem clínica (sem acesso) e o log emite `TRILHA_NAO_GRAVADA` com motivo `escolha_de_clinica`. Nunca há acesso sem a linha na trilha. O caso inverso (trilha gravada, `update` falhou) só deixa uma linha a mais.
  - **Trilha fora × TOTP feito sem clínica** (R4 do desenho do PR 3): com a trilha fora, a escolha não acontece e `mfa_sem_clinica_em` **não** é zerado. O TOTP guardado não dá acesso (sem clínica, sem MFA marcado) e só pode ser aproveitado pela primeira escolha que valer, dentro dos mesmos 5 min (o prazo não renova). A troca atômica zera o campo nessa escolha. Testes (a) e (b) em `provedor.test.ts`.
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

## 14. PR 3: clínica, equipe e produção (desenho para o Guardião, antes do código)

Atende às R16 a R20 do parecer do desenho, às pendências "antes do PR 3" dos pareceres do código do #149 e do #152 (R3 a R9), e libera o provedor real em produção. É grande demais para um PR só, então vai em **três**, cada um com parecer próprio. A produção só abre no 3c.

### 14.1 PR 3a: sessão e clínica

| Tema | Decisão |
|---|---|
| **Rotas da sessão sem clínica** | Quem tem várias clínicas fica sem clínica ativa depois do login, e o `SessaoGuard` (que exige clínica) devolve 401. Por isso as rotas abaixo usam um guard próprio, `SessaoDePessoaGuard`. Ele só aceita a sessão do provedor real (com o dev provider, 404), não lê nenhuma clínica e entrega só `{ sessaoId, userId }`. A porta `AuthProvider` não muda. |
| **`GET /sessao/clinicas`** | Clínicas com vínculo ativo (pelo espelho `identidade.vinculo`): id e nome da clínica. O nome da clínica não é dado pessoal. Sem perfis nem contagens. |
| **`POST /sessao/clinica {clinicaId}`** | Usa `definirClinica`: confere o vínculo no espelho e devolve 404 sem vínculo (não 403, para não confirmar que a clínica existe). Grava `session_tenant_selected` na trilha da clínica escolhida e zera o MFA (regra que já existe). |
| **MFA sem clínica (R7 do #152)** | Hoje o código aceito sem clínica escolhida não marca nada. Proposta: o TOTP aceito sem clínica grava `sessao.mfa_sem_clinica_em`. A **primeira** escolha de clínica feita até **5 min** depois converte esse valor em `mfa_em`, com a impressão dos perfis da clínica escolhida, e grava `mfa_verified` na trilha **dela**. Depois disso, ou fora do prazo, a troca de clínica zera o MFA como hoje. `MFA_VERIFICADO` sem clínica sai com `motivo: 'login_em_duas_etapas_sem_clinica'`. |
| **Lista de sessões (R20)** | `GET /sessao/sessoes` mostra só as sessões da própria pessoa: id curto (8 hex do id), criada em, última atividade e se é a atual. **Sem IP, sem user-agent** (nem em HMAC) e sem clínica. |
| **Encerrar sessões** | `DELETE /sessao/sessoes/:id` encerra uma sessão da própria pessoa (outra pessoa recebe 404). `POST /sessao/encerrar-todas` encerra todas, inclusive a atual. Eventos `LOGOUT` com `motivo: 'logout_global'` e trilha nas clínicas do vínculo. |
| **Cookie renovado (pendência do #149)** | Quando o `getSession` estende a sessão (inatividade de 15 min), o `Set-Cookie` novo volta ao navegador. O provedor devolve os cabeçalhos da biblioteca (`returnHeaders`), e o guard os aplica na resposta. Sem isso, o cookie morreria em 15 min mesmo com a sessão em uso. |
| **Polling sem renovar (R19)** | O decorador `@SemRenovarSessao()` nas rotas de polling (contagem de avisos, estado de importação) faz o provedor ler com `disableRefresh`. Teste: 20 chamadas de polling não mudam o `expira_em`. O front passa a usar essas rotas no polling. |
| **`LOGIN_SENHA_OK` (R3 do #152)** | A sessão provisória do login em duas etapas gera `LOGIN_SENHA_OK` com `motivo: 'aguardando_fator'`. `LOGIN_OK` passa a sair só na sessão definitiva. |
| **Expurgo (R11)** | Job diário apaga sessões vencidas e `verificacao` usadas ou vencidas há mais de 24 h. Conta só quantas apagou (sem ids). |

### 14.2 PR 3b: equipe (convite, recuperação e desligamento), revisto depois do veto

**Ainda não existe provedor de e-mail** (§9). Por isso todo token de uso único é mostrado **uma vez** ao admin, para ele entregar **fora da plataforma** (R17). Isso faz do admin alguém que **vê o token**. O veto do parecer do desenho (R1 e R2) mostrou que nenhum token pode, sozinho, dar a conta inteira ao admin nem abrir outra clínica. As regras abaixo partem disso.

**Princípios**
- **(R1) Nenhum token restaura os dois fatores.**
  - O token de senha exige o TOTP atual.
  - O token de fator exige a senha atual.
  - Quem perdeu os dois passa pelo suporte da plataforma, com conferência de identidade, fora deste PR.
- **(R2) O que um admin faz vale só na clínica dele.**
  - Antes do aceite, a clínica não vê nada de `identidade.usuario`.
  - Vínculos que a pessoa tem em outras clínicas não mudam por ação deste admin.

| Tema | Decisão |
|---|---|
| **Convite** | `POST /clinica/convites {email, perfil}` (admin, MFA recente, teto diário por admin, R9). Grava só em `convites_da_clinica` (tabela da clínica, com RLS): e-mail cifrado, perfil, SHA-256 do token, prazo de 72 h e quem convidou. **Não** concede perfil e **não** toca em `identidade.usuario`. A resposta é a mesma exista ou não conta com esse e-mail. A lista de membros só mostra quem aceitou. |
| **Aceite: pessoa nova** | `POST /convites/aceitar {token, senha}` define a senha (com a conferência de senha vazada chamada explicitamente) e cria `identidade.usuario` e a credencial. O vínculo em `clinic_members` nasce **agora**, com `op: member_invite_accepted` e aviso aos admins. A sessão nasce marcada `cadastro_do_fator_pendente`, dura **no máximo 15 min** (R8) e só serve às rotas do cadastro do TOTP (R3). O admin que viu o token poderia aceitar no lugar da pessoa, mas teria apenas uma conta **nova**, sem histórico e só nesta clínica. Isso equivale a o próprio admin criar uma conta falsa, o que ele já pode fazer hoje. Fica registrado no RIPD e no contrato (R14). |
| **Aceite: conta existente** | O mesmo endpoint pede **login completo**: a senha atual e o código TOTP. Ver o token não basta. As falhas contam no bloqueio de login (R9). Só então o vínculo nesta clínica nasce. |
| **Recuperação de senha pelo admin** | `POST /clinica/membros/:usuarioId/recuperacao {tipo: 'senha', justificativa}` (admin, MFA recente, justificativa só na trilha). Gera um token de **15 min**. Usá-lo exige o **código TOTP atual** da pessoa (R1) e define a senha nova (com a conferência de senha vazada). Apaga todas as sessões. Trilha na clínica do admin. Os admins das outras clínicas da pessoa recebem só um aviso de que a credencial mudou, sem detalhe. |
| **Recuperação de fator pelo admin** | `tipo: 'fator'`: o token de 15 min exige a **senha atual** e abre uma sessão de 15 min só para o cadastro de um TOTP novo. O TOTP antigo é apagado **somente** quando o novo é confirmado. |
| **Perdeu os dois** | Fora deste PR: suporte da plataforma com conferência de identidade (processo de suporte da 0059, com autorização da clínica e trilha). Até lá, a pessoa recebe um convite novo e vira uma conta nova. O histórico clínico continua com o id antigo. |
| **Desbloqueio pelo admin (R4 do #152)** | Zera só os contadores de bloqueio da pessoa (e-mail e fator), sem trocar senha nem fator. Fica na trilha. |
| **Troca de senha pela própria pessoa (R16)** | `POST /sessao/senha` (MFA recente): conferência de senha vazada explícita, apaga as outras sessões, `mfa_em` zerado na atual, trilha nas clínicas da pessoa. |
| **Desligamento (R10)** | Revogar o último perfil da pessoa numa clínica apaga as sessões dela **com essa clínica ativa**, pelo trigger de espelho. As sessões em outras clínicas ficam intactas, com teste RLS. Sem vínculo em nenhuma clínica, a conta fica `ativo = false`, e um convite aceito reativa. |
| **Autor do prontuário por 20 anos (R18)** | `identidade.usuario` nunca é apagada. A exclusão a pedido do titular **anonimiza** o e-mail e o nome e apaga a senha, o TOTP, as sessões e os convites (R11). A identificação do autor fica em `professionals`, na clínica, com a retenção do prontuário. |
| **`MFA_BLOQUEADO` no login em duas etapas (R6 do #152)** | A pessoa está identificada, então o bloqueio vira aviso aos admins das clínicas dela, no máximo 1 por dia. |

### 14.3 PR 3c: produção

| Tema | Decisão |
|---|---|
| **Segredos** | `BETTER_AUTH_SECRET`, `DATABASE_AUTH_URL` e `APP_AUTH_PASSWORD` no Secrets Manager, escritos em Terraform (o `apply` depende da AWS). A rotação usa os **segredos versionados** da biblioteca, para não perder o TOTP de todos (R9 do #152). |
| **Egresso** | Saída liberada só para `api.pwnedpasswords.com:443` (R5 do #152). |
| **Proxy** | `HTTP_TRUST_PROXY_HOPS` conferido no staging (R4 do #152; com valor errado, 30 falhas trancam a plataforma inteira). |
| **RIPD e retenção** | Schema `identidade`, segredo do TOTP, contadores de bloqueio, prefixo do SHA-1 enviado para fora e anonimização (R18). |
| **Abertura** | `AMBIENTES_POR_TIPO['better-auth']` passa a incluir `production`, e o dev provider continua proibido em produção. Teste de fumaça no staging com o fluxo completo: convite, aceite, TOTP, escolha de clínica, rota sensível com reverificação e logout global. |

### 14.4 Ressalvas do parecer do desenho do PR 3 incorporadas

- **3a:**
  - **R3:** o guard das rotas sem clínica aplica as mesmas travas do provedor (prazo absoluto, conta ativa), e a sessão com cadastro pendente só acessa o cadastro do fator.
  - **R4:** `mfa_sem_clinica_em` é zerado ao converter e nunca é lido como `mfa_em`, com teste dos três casos.
  - **R5:** o guard repassa só o `Set-Cookie` da sessão; nas rotas de polling, nenhum `Set-Cookie` sai.
  - **R6:** encerrar uma sessão confere o dono no banco pelo id completo.
  - **R7:** o expurgo inclui o cadastro de TOTP não concluído, os convites e os tokens vencidos.
- **3c:**
  - **R12:** TLS verificado no banco e no Redis, a chave do HMAC no Secrets Manager, e a rotação testada no staging.
  - **R13:** checklist assinado e parecer final antes de abrir produção; teste de fumaça só com contas fictícias.
  - **R14:** e-mail da conta não verificado no RIPD; responsabilidade do admin pela entrega dos tokens no contrato.
- **3b, depois da reconferência:**
  - **R15:** os fluxos de token entram no bloqueio 5/15 com reserva atômica. O TOTP pedido na recuperação conta no bloqueio do fator, com a marca de reuso. A senha pedida na recuperação de fator e no aceite de conta existente conta no bloqueio de login. O token é consumido de forma atômica.
  - **R16:** no aceite de conta existente, o e-mail da conta autenticada precisa ser o do convite. Na recuperação, `:usuarioId` precisa ter vínculo ativo na clínica do admin; senão, 404.
  - **R17:** a conta guarda a clínica e o convite de origem; a pessoa vê as próprias clínicas; há procedimento de disputa de e-mail no suporte; a verificação de e-mail fica obrigatória quando houver provedor (inclusive para contas antigas); RIPD e contrato registram que o e-mail é declarado pelo admin.
  - **R18:** quem perdeu os dois fatores recebe a conta nova com **outro** e-mail, até o suporte liberar o antigo pelo procedimento de disputa. O RIPD registra que quem usa o token percebe se a conta já existe.

### 14.5 Mudanças no código do 3b-2 em relação ao desenho (para o Guardião)

- **Motivo da recuperação em lista fechada** (`esqueceu_a_senha`, `perdeu_o_aparelho`, `troca_de_aparelho`, `suspeita_de_invasao`, `conta_bloqueada`), no lugar da justificativa de 10 a 500 caracteres. O contrato da trilha (0005) não aceita texto livre, e assim nenhum texto livre fica para sempre na trilha.
- **O TOTP antigo sai quando o token de fator é usado**, e não só quando o novo é confirmado. A biblioteca recusa um segundo cadastro enquanto existe um verificado. Se a pessoa abandonar o cadastro, o admin emite outra recuperação.
- **Conta existente sem TOTP** não aceita convite (`conta_sem_fator`): o login completo exige o fator. A pessoa passa antes pela recuperação de fator na clínica de origem.
- **Código TOTP conferido fora do login** (só na recuperação de senha), com o segredo decifrado pela própria biblioteca (`better-auth/crypto`) e os mesmos parâmetros do plugin, pelo bloqueio do fator e pela marca de reuso.

### 14.6 Fila da reconferência do #173 (10/11/2026)

- **Conta expurgada** (migração 0072): o expurgo de 90 dias marca `inativa_por = 'expurgada'`, troca o e-mail pelo marcador `.invalid` e tira o nome. O trigger de espelho recusa a concessão de perfil a essa conta (42501), como já fazia com a anonimizada. A marca dispensa o filtro do expurgo pelo e-mail.
- **Teto de recuperações atômico**: contagem, invalidação e inserção numa transação do `app_auth`, serializadas por admin com `pg_advisory_xact_lock`. Teto atingido gera `RECUPERACAO_TETO` (alto, alarme imediato).
- **Troca de senha**: só o código `INVALID_PASSWORD` da biblioteca gasta tentativa do bloqueio. Outro erro devolve a reserva e responde `troca_recusada`.
- **Invalidação limitada à clínica**: o token novo invalida só os pendentes emitidos pela mesma clínica (risco residual no RIPD §3).
- **Testes do trigger da 0071**: o desligamento grava `inativa_desde`, um UPDATE sem mudança não zera a contagem e a recontratação limpa a data.

### 14.7 Ressalvas antigas da fila (3b-1, 3b-2 e 3b-3), 10/11/2026

- **Teto de convites atômico** (R6 do 3b-1): `pg_advisory_xact_lock` por admin na transação da clínica. Teste: rajada de 23 convites gera exatamente 20.
- **Sessão de cadastro órfã** (R7 do 3b-1): se a marca `cadastro_pendente_ate` não gravar, a sessão aberta é apagada na hora.
- **Marca de reuso do TOTP só depois de conferir** (R12 do 3b-2, R7 do 3b-3): um código errado não queima o valor por 90 s.
- **Conta ativa sem vínculo** (R5 do 3b-3): o expurgo diário desliga a conta ativa sem nenhum vínculo há mais de 1 dia (corrida de duas revogações simultâneas), derruba as sessões na mesma transação e registra `CONTA_DESLIGADA_SEM_VINCULO` (G4 do #176). A conta inativa `sem_vinculo` que tem vínculo (corrida com uma concessão) é reativada pelo mesmo job, e o expurgo de 90 dias nunca marca quem tem vínculo (G1).
- **Anonimização**: o convite aceito pela conta perde o HMAC do e-mail na hora, nas clínicas com vínculo e na clínica de origem (G3). Nas demais, em até 30 dias pelo `convites-descarte`.
- **Marca de reuso do TOTP com o contador fora do ar** conta como reuso (falha fechada, G5).
- **Runbook**: efeitos da rotação da `RATE_LIMIT_HASH_KEY` (R5 do 3b-1). **RIPD §5**: procedimento de suporte para quem não tem vínculo em nenhuma clínica (R13 do 3b-2).
- **Clínica cancelada** (R3 do 3a): a lista de clínicas da pessoa e a escolha seguem a mesma regra de leitura das rotas da clínica (`canRead`). A clínica cancelada aparece só dentro da janela de saída.
- **`LOGIN_OK` do cadastro do fator** (R5 do 3a): a troca de sessão no fim do cadastro do TOTP sai com `motivo: cadastro_do_fator`, separada do login.
- **Já resolvida antes:** R7 do 3a (a sessão de cadastro pendente não usa as rotas da pessoa). **Fica na fila:** R4 do 3a (teste pela HTTP do `Set-Cookie` só da sessão, também no polling).

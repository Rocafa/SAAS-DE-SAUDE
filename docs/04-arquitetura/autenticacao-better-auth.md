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

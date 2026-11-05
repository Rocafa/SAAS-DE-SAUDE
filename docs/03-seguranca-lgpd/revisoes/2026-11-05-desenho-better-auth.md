# Parecer do Guardião LGPD: desenho da autenticação com Better Auth (D4, PR #149)

> Data: 05/11/2026. Branch: `eng/better-auth-base` (commit `c56ab00`). Escopo: `docs/04-arquitetura/autenticacao-better-auth.md`, contra o memo `D04-recomendacao.md` (6 regras), `seguranca-na-arquitetura.md` §2, o contrato `apps/api/src/modules/auth/contrato-provedor.test.ts`, os pareceres do #123/#128 (R5, R6) e do #117 (R6), o parecer do #132 (R1) e os tipos de `@better-auth/core@1.7.12` (`init-options.d.mts`).
> Não há código ainda: este parecer vale para o **desenho**. O código do PR 1 passa de novo pelo Guardião.

## Veredito: **APROVADO COM RESSALVAS**

O desenho é bom no que mais importa: a clínica, os perfis e o `mfa_em` ficam na sessão do servidor e no nosso banco, o `cookieCache` sai, a sessão é opaca e revogável, e a obrigatoriedade do MFA continua no nosso código. **R1 a R13 entram antes ou dentro do PR 1** (a maioria é configuração e uma linha no desenho). R14 a R20 ficam para o PR 2/3, com prazo.

## Conferência

| Item | Situação |
|---|---|
| Base legal | Identidade da equipe (e-mail, nome, sessão, IP em HMAC): execução do contrato com a clínica e segurança (LGPD art. 7º V e IX, art. 46). Não é dado sensível do art. 11. Entra no ROPA/RIPD da plataforma (§3). ✅ |
| Minimização | Bom (IP/UA em HMAC, e-mail fora de log e exportação). Falta: `mfa_em`/`clinica_ativa` fora das respostas da biblioteca (R5) e expurgo de sessão/verificação vencidas (R11). ⚠️ |
| Consentimento | Não se aplica (não é a base legal). ✅ |
| Criptografia | Trânsito: TLS + `Secure`. Repouso: RDS cifrado; senha em scrypt (ver R9); TOTP cifrado no PR 2. **Token da sessão fica em claro na tabela** (padrão da biblioteca), compensado por R1. ⚠️ |
| Isolamento por tenant | Clínica só da sessão, perfis só do `clinic_members` sob RLS, teste do cabeçalho forjado. Schema `identidade` sem RLS aceito com R1 e R7. ✅ com ressalvas |
| Controle de acesso | Falta: desligamento/vínculo inativo valer na próxima requisição (R6) e allowlist de endpoints (R4). ⚠️ |
| Auditoria | Atende à R6 do #117 com R12 e R16. ⚠️ |
| Retenção | Prontuário (20 anos) não é tocado; mas a identificação do autor do prontuário precisa sobreviver ao desligamento (R18). Sessões vencidas e log de segurança precisam de prazo (R11). ⚠️ |
| Segredos | **O desenho não fala do `BETTER_AUTH_SECRET`** (R2). ❌ |
| Dados reais fora do git/prompts | Nenhum no diff. Testes e dev com contas fictícias pela API do servidor. ✅ |
| CFM/ANS/ICP-Brasil | Res. CFM 1.821/2007 (identificação e autenticação de quem acessa o prontuário, NGS2): atendida com MFA do PR 2. Não toca assinatura ICP-Brasil nem TISS. ✅ |

## Respostas às perguntas

### 1. Substituir o refresh rotativo por sessão curta revogável: **AVAL CONCEDIDO, com condições**
Sem token portador de longa vida, não há refresh para roubar nem reuso para detectar; a revogação é imediata (logout, desligamento, troca de senha) e a sessão é lida do banco em toda requisição. É **mais forte** que o §2 de hoje para um monólito com cookie. Condições: o prazo absoluto de 12 h vale em **todo** caminho, não só no nosso provedor (R3); a sessão morre na troca de senha e no desligamento (R6, R17); e `seguranca-na-arquitetura.md` §2 é reescrito no PR 1 (sessão opaca, `SameSite=Strict`, inatividade 15 min, absoluto 12 h, sem refresh; e o hash de senha, R9). O memo dizia `Lax`; `Strict` é mais restritivo e fica valendo.

### 2. `identidade` sem RLS, só GRANT; e-mail em claro
**Aceitável.** RLS por clínica não faz sentido para dado da pessoa, e o vínculo continua no `clinic_members` com RLS. Mas, como o token da sessão fica em claro na tabela e o `app_user` é o papel de **todas** as rotas, uma injeção SQL em qualquer módulo leria todas as sessões de todas as clínicas. Por isso, R1: papel de banco próprio para a biblioteca. E-mail em claro: aceito, porque é o identificador do login e precisa de busca exata. Condições: normalizado (minúsculo) com índice único, nunca em log/trilha/exportação (já no desenho), e, quando usado como chave do bloqueio ou do rate limit, **HMAC com chave secreta**, nunca hash puro (dicionário de e-mails) (R10).

### 3. Cookie, inatividade, absoluto, cookieCache
**De acordo**, com: todos os cookies da biblioteca com o mesmo prefixo e atributos, inclusive os auxiliares (`dont_remember` etc.), conferidos num teste que lista todo `Set-Cookie` (R8); a escolha de dev pelo `NODE_ENV` falha fechada: só `development` e `test` perdem `Secure`/`__Host-`, qualquer outro valor (inclusive vazio) usa o de produção (R8); `freshAge` explícito ≤ 15 min, porque o padrão é 1 dia (R8). Nota: chamadas automáticas do front (avisos, polling) renovam a sessão e anulam a inatividade; o absoluto de 12 h limita o estrago, mas o front não deve fazer polling que renove a sessão (R19).

### 4. `clinica_ativa` e `mfa_em` na sessão; `app_clinicas_do_usuario`
**De acordo.** Os dois campos como `additionalFields` com `input: false` (o cliente nunca grava, nem por endpoint da biblioteca) e `returned: false` ou fora das respostas da biblioteca (R5). A função SECURITY DEFINER: `SET search_path = pg_catalog, public`, dono com o mínimo de privilégio, `REVOKE ALL ... FROM PUBLIC` e `GRANT EXECUTE` só ao papel que a usa, `STABLE`, devolve **só ids** de vínculos **ativos** em clínicas **ativas**, e teste RLS de que não devolve nada além disso (R7). O chamador sempre passa o `userId` da sessão, nunca um vindo do cliente.

### 5. Falha de login sem clínica só no log de segurança: atende à R6 do #117?
**Atende**, porque falha sem usuário identificado não pertence a nenhuma clínica e gravá-la numa trilha qualquer seria vazamento entre clínicas. Faltam para fechar a R6: (a) a parte (b) da R6, um teste de que o único handler fora de controller é a lista conhecida, com motivo (o desenho declara, falta o teste existir no PR 1) (R12); (b) **login OK com clínica escolhida automaticamente** vai também à trilha da clínica (`session_tenant_selected`) (R12); (c) **troca de senha e reset pelo admin** são "troca de credencial" e não aparecem nos eventos (R16); (d) `CONTA_BLOQUEADA` de usuário identificado gera aviso/`anomaly_alert` nas clínicas onde ele tem vínculo ativo (R16). O log de segurança precisa de retenção definida (Marco Civil art. 15: mínimo 6 meses) (R11).

### 6. Cadastro público e recuperação desligados
**De acordo.** Mas `disableSignUp` desliga só um endpoint: a biblioteca expõe vários outros (troca de e-mail, exclusão de usuário, atualização de usuário, verificação, listagem de contas). "Só os endpoints usados" tem de ser uma **allowlist** na nossa montagem, que recusa (404) todo caminho fora da lista antes do `toNodeHandler`, com teste; `disabledPaths` é lista negativa e não basta sozinha (R4). A recuperação pelo admin (PR 3) não pode deixar o admin definir uma senha que ele conhece e entrar como o usuário (R17).

## Ressalvas

### Antes do PR 1 (no desenho e no código do PR 1)

1. **Papel de banco próprio para a autenticação.** A biblioteca usa um pool com papel `app_auth`, o único com acesso a `identidade.sessao`, `conta` e `verificacao`. O `app_user` das rotas de negócio não tem nenhum GRANT nesse schema (no máximo, leitura de `usuario.id`/nome se uma tela precisar, via view). Compensa o token da sessão em claro no banco. Teste: `app_user` recebe erro de permissão ao ler `identidade.sessao`.
2. **Segredo da biblioteca.** `BETTER_AUTH_SECRET` (assina o cookie e cifra o TOTP do PR 2) vem do Secrets Manager, tem ≥ 32 bytes aleatórios, não tem valor padrão, e a API não sobe sem ele fora de dev/test. Nunca no git nem em `.env` versionado; plano de rotação escrito (troca derruba as sessões, aceitável). Também: `baseURL` fixo por configuração, nunca derivado do `Host` da requisição.
3. **Absoluto de 12 h em todo caminho.** Não basta o nosso provedor recusar: a sessão vencida pelo absoluto é **apagada**, e a montagem recusa qualquer rota da biblioteca (inclusive `get-session`) com sessão de mais de 12 h. Teste nos dois caminhos.
4. **Allowlist de endpoints** da biblioteca na montagem, com teste de que um caminho fora da lista (ex.: `/api/auth/sign-up/email`, `/change-email`, `/delete-user`, `/update-user`) dá 404. A lista é fechada e declarada junto do `HANDLERS_FORA_DE_CONTROLLER`.
5. **Campos nossos protegidos:** `clinica_ativa` e `mfa_em` com `input: false`; não saem em resposta da biblioteca. Teste: tentar gravar os dois pelo corpo de qualquer endpoint permitido não muda nada.
6. **Vínculo vale a cada requisição** (regra 3 do memo): o provedor confere o vínculo ativo em `clinic_members` em toda resolução. Vínculo inativo ou sem perfil ativo → `null` (401) e `clinica_ativa` zerada. Isso é do PR 1, porque o provedor nasce nele.
7. **Função `app_clinicas_do_usuario`** conforme a resposta 4, com teste RLS.
8. **Cookies e sessão:** teste de todos os `Set-Cookie`; fábrica de dev falha fechada; `useSecureCookies: true` explícito fora de dev/test; `freshAge` ≤ 15 min; `trustedOrigins` sem curinga.
9. **Hash de senha:** o §2 promete Argon2id e o desenho usa scrypt. Decidir **antes** de existir a primeira senha (trocar depois exige rehash no login): ou configurar `password.hash/verify` com Argon2id (parâmetros OWASP: m=19 MiB, t=2, p=1 no mínimo), ou manter scrypt registrando os parâmetros reais da biblioteca e comparando com o mínimo da OWASP, com o §2 corrigido.
10. **IP e origem:** HMAC com chave secreta (do Secrets Manager), gravado por gancho de banco antes da inserção, com teste de que a coluna nunca recebe IP em claro. `advanced.ipAddress` com os proxies confiáveis (faixa do ALB), para o `X-Forwarded-For` não ser forjável: é ele que alimenta o bloqueio por origem. Rate limit da biblioteca desligado ou ligado no Redis, nunca em memória com mais de uma instância.
11. **Retenção e expurgo** definidos no desenho: sessão vencida e `verificacao` usada/vencida apagadas por rotina diária (a rotina pode vir no PR 3, o prazo fica escrito agora); log de segurança com prazo (≥ 6 meses, Marco Civil art. 15, e teto definido). Entram no ROPA.
12. **Auditoria do PR 1:** teste da R6(b) do #117 (único handler fora de controller é a lista conhecida); login com clínica automática grava `session_tenant_selected`; o logger interno da biblioteca passa pelo nosso log de segurança sanitizado (R1 do #129) ou fica em `error` sem corpo de requisição, para o e-mail nunca sair por ele.
13. **Contradição do contrato:** a R2 do #128 exige os 6 ganchos para qualquer provedor que não seja o `dev`, e a tabela da §11 põe `stepUp`, `trocarSenha`, `trocarClinica` e `trocarPerfis` no PR 2/3. Resolver no desenho: ou o PR 1 implementa os 6 ganchos na bancada (gravando nos campos da sessão pelas nossas funções internas), ou `better-auth` só entra em `TIPOS_DE_PROVEDOR` quando os 6 existirem. Nos dois casos, **`AUTH_PROVIDER=better-auth` não sobe em produção antes do PR 3**: escrever isso na §11. (Entre o PR 1 e o PR 2, `mfa_em` nulo dá 403 em todos os perfis: falha fechada, correta.)

### PR 2 / PR 3

14. **(PR 2) R5 do #123 inteira**, incluindo a quantidade de alvos distintos da nota da R9, e `mfa_em` gravado só no gancho depois da verificação do TOTP, com segredo TOTP e códigos de recuperação cifrados.
15. **(PR 2) Bloqueio e enumeração:** resposta e tempo de resposta equivalentes para conta existente e inexistente no login (teste com tolerância), e verificação de senha vazada sem mandar a senha nem o hash completo para fora (k-anonimato ou lista local).
16. **(PR 2/3) Troca de credencial na trilha:** troca de senha e reset pelo admin (com quem fez e justificativa) nas trilhas das clínicas do usuário; `CONTA_BLOQUEADA` de usuário identificado vira aviso nas clínicas do vínculo.
17. **(PR 3) Recuperação pelo admin e desligamento:** o admin gera um link/código de uso único e curto, entregue fora da plataforma, que obriga a troca de senha no primeiro uso; nunca define a senha. Troca de senha e reset apagam as outras sessões (`revokeSessionsOnPasswordReset` e equivalente na troca). Desligado perde todas as sessões na hora (já previsto) e não consegue logar (marca de conta inativa em `identidade.usuario`).
18. **(PR 3) Identificação do autor no prontuário (CFM 1.821/2007, 20 anos):** desligar não apaga `identidade.usuario` enquanto houver registro clínico do profissional, ou a identificação (nome e registro profissional) fica na tabela da clínica. Escrever qual dos dois no desenho e no RIPD; exclusão a pedido do titular respeita essa retenção (LGPD art. 16 I).
19. **(PR 3, front)** Polling e chamadas automáticas não renovam a sessão (rota sem refresh ou `deferSessionRefresh`), para a inatividade de 15 min ser real.
20. **(PR 3)** Logout global e lista de sessões mostram só dado da própria pessoa; o IP aparece só como HMAC truncado ou não aparece.

## Itens conferidos sem achado
- `cookieCache` desligado: correto, fecha o GHSA-xg6x-h9c9-2m83.
- Sem `jwt`/`bearer`: correto; o cookie é a única credencial.
- Sem o CLI, versão exata, telemetria desligada, revisão mensal: atende à regra 6.
- Portal do paciente fora e separado: atende à regra 5 e ao B3 do #47.
- CSRF: `SameSite=Strict` + `protecaoCsrf` + `trustedOrigins` + 403 sem `Origin` (R1 do #132) no PR 1, com teste.

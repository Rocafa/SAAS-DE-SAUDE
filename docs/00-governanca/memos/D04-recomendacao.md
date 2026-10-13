# D4 — Autenticação: recomendação para a conversa dos sócios
> Memo de recomendação · 12/10/2026 · frente Engenharia · base: memo [D04-autenticacao.md](D04-autenticacao.md) e a PoC do branch `poc/d4-autenticacao` (PR #36, medição de 11/10/2026). **Quem decide são os sócios.**
> Legenda: **FATO** = medido na PoC ou escrito no repositório (com fonte). **ESTIMATIVA** = opinião da Engenharia, sem medição.

## 1. A pergunta
**Que sistema usamos para o login das clínicas (senha, segundo fator, troca de clínica): o Zitadel, um servidor de login separado, ou o Better Auth, uma biblioteca que roda dentro da nossa API?**

Hoje ela trava todo o M0 (FATO, memo D04 e CONTEXTO §6). Sem login não existem perfis e permissões (RBAC), MFA, rotas de negócio na API, ligação das telas com a API, a rota de exportação com MFA recente (garantia G2), a auditoria de "quem leu o prontuário", os testes de ponta a ponta e o Portão B do piloto.

## 2. As opções medidas
- **Zitadel v4.19.4:** servidor de identidade pronto, auto-hospedado. Já traz telas de login, console de administração e padrões de mercado (OIDC/SAML).
- **Better Auth 1.7.7:** biblioteca TypeScript que roda dentro da nossa API NestJS e grava no nosso Postgres.
- **Fora da disputa** (FATO, memo D04): **login 100% próprio**, porque as duas pesquisas descartaram escrever sessão, MFA e recuperação do zero num produto com dado de saúde; **Auth0/Clerk** (e, pelo mesmo motivo, Cognito), porque os dados de identidade sairiam do Brasil (transferência internacional); **Keycloak**, porque o servidor Java exige uma operação pesada demais para dois sócios, e o Zitadel cobre o mesmo papel.

## 3. Comparação
| Critério | Zitadel v4 | Better Auth |
|---|---|---|
| **MFA (código no celular e passkey)** | FATO: TOTP e WebAuthn ativos. "MFA obrigatório" vale por organização, não por perfil, e vem desligado por padrão | FATO: TOTP e passkey ativos. Não há política de MFA; obrigar por perfil fica no **nosso código** |
| **Sessão e token** | FATO: token de acesso de **12 h** no padrão (o requisito é ≤ 15 min, então precisa configurar). Refresh rotativo com detecção de reuso existe segundo a documentação, mas **não foi medido** | FATO: sessão em cookie HttpOnly guardada no banco, revogável (depois do logout, o cookie antigo recebe 401); token de **15 min**; CSRF bloqueado (403). **Não tem refresh rotativo** porque o desenho é outro: a sessão fica no servidor |
| **Recuperação de conta** | FATO: a API de gestão diz se o usuário existe (404). Exige token, então não vaza para o público, mas é um cuidado a mais | FATO: a resposta é **idêntica** para e-mail existente e inexistente (atende a HU-NUC-012) |
| **Bloqueio por tentativas** | FATO: vem vazio no padrão | FATO: não configurado. Nos dois casos entra o nosso rate limit no Redis |
| **Multi-clínica: como a clínica chega ao `withTenant`** | FATO: a troca usual é por **cabeçalho enviado pelo navegador**, só validado por vínculo. Para ser seguro, a API precisa ler o claim do token assinado. **O caminho fácil é o errado** | FATO: a clínica ativa fica **na sessão do servidor**. Testamos mandar outra clínica no cabeçalho e o pedido foi ignorado |
| **LGPD (dados no Brasil, logs)** | FATO: auto-hospedado, fica na AWS São Paulo. Traz auditoria de login própria, que vira mais um lugar a reter e proteger | FATO: tudo no nosso Postgres, nada sai da nossa infra. A auditoria de login e MFA é **nossa** (já temos a auditoria encadeada) |
| **Operação** | FATO: 1 binário de 169 MB + 1 banco (144 tabelas), um **serviço a mais** para atualizar e monitorar. Teve 6 CVEs em 2026, todos corrigidos na versão medida. Rodar em container não foi medido | FATO: nada novo para operar (10 tabelas). Teve CVEs altos em 2026, corrigidos na versão medida. **Atenção:** o CLI oficial puxa uma versão antiga e vulnerável (`pnpm audit`: 1 crítico e 16 altos), e o nosso CI bloqueia altos e críticos |
| **Custo AWS** | **Sem dado.** ESTIMATIVA: mais 1 serviço no ECS e mais 1 banco ou schema; precisa entrar na conta da D13 (hoje US$ 750–1.050/mês sem o login) | ESTIMATIVA: perto de zero, porque roda na API e no banco que já vamos pagar |
| **Quem mantém** | ESTIMATIVA: nós, com as telas e o console prontos do fornecedor | ESTIMATIVA: nós, incluindo as telas de login, MFA e convite (já desenhadas no front) |
| **Portal do paciente** | **Não medido.** ESTIMATIVA: dá para usar um projeto ou organização separado | **Não medido.** ESTIMATIVA: sessão e cookie separados dos da clínica. O login sem senha por celular (HU-POR-001) ainda precisa de PoC |
| **Velocidade para o MVP** | ESTIMATIVA: mais lento (infra, domínio, TLS, tela de login hospedada e configuração do token e do claim) | ESTIMATIVA: mais rápido (é código na API que já existe) |
| **Lock-in (ficar preso)** | ESTIMATIVA: baixo, porque usa padrão OIDC e é código aberto. Migrar usuários e MFA dá trabalho | ESTIMATIVA: baixo, porque as tabelas são nossas. O risco é a biblioteca, que é nova e muda rápido (o CLI já está atrasado) |

Limites honestos (FATO): a PoC não mediu nada que exija navegador (passkey real, reuso de refresh, cookie do Zitadel), nem carga, nem container, nem custo.

## 4. Recomendação: **Better Auth**
Motivo: atende o requisito mais perigoso deste produto, que é **uma clínica nunca ver os dados de outra**, já no desenho padrão, enquanto no Zitadel o caminho fácil é o inseguro. Além disso, não cria um serviço a mais para dois sócios operarem e é o caminho mais curto para destravar o M0. O que ele não traz pronto (MFA por perfil, bloqueio por tentativas) o Zitadel também não traz.

**Regras que viram requisito (entram na Definição de Pronto e passam pelo Guardião LGPD):**
1. **A clínica vem sempre da sessão guardada no servidor**, nunca de cabeçalho, parâmetro ou corpo enviado pelo cliente. Um teste no CI prova isso.
2. **MFA obrigatório** para perfis clínicos, financeiros e admin, conferido no servidor. **MFA recente** (até 15 min) para abrir prontuário sensível e para exportar (G2). Resetar o MFA exige justificativa e fica na auditoria.
3. **Sessão curta e revogável:** cookie `HttpOnly` + `Secure` + `SameSite=Lax`, expiração por inatividade, logout que mata a sessão no servidor e desativação do usuário valendo na próxima requisição. Token de 15 min só para chamadas entre serviços. Isso **substitui** o "refresh rotativo" de `seguranca-na-arquitetura.md` §2, uma mudança que o Guardião precisa aprovar.
4. Identidade num **schema separado**, migrações feitas pelo nosso próprio pipeline (sem o CLI desatualizado, para o `pnpm audit` continuar verde), bloqueio de 5 tentativas em 15 min no Redis e auditoria de login, falha, MFA e troca de clínica.
5. **Portal do paciente com login separado:** outro cookie e outra sessão, sem `pacienteId` vindo do cliente (veto B3 do Guardião no #47).
6. Versão fixada e revisão mensal dos avisos de segurança da biblioteca.

**Se escolherem o Zitadel:** dá certo, desde que (a) a clínica venha do claim do token assinado e nunca do cabeçalho `x-zitadel-orgid`; (b) o token seja configurado para ≤ 15 min e o bloqueio por tentativas seja ligado; (c) a D13 inclua o custo e a operação do serviço extra; (d) a ESTIMATIVA seja de **mais 1 a 2 semanas** até o primeiro login e de mais um item no plano de atualização e no pentest.

## 5. O que acontece no código depois do "sim" (ESTIMATIVA, uma pessoa ou agente, sem contar o CI parado)
1. **Módulo `auth` de verdade** (3 a 5 dias): Better Auth no NestJS, schema de identidade, organização = clínica, `TenantGuard` lendo a clínica da sessão e passando para o `withTenant`, teste de "cabeçalho forjado é ignorado".
2. **MFA e proteção** (4 a 6 dias): MFA por perfil, MFA recente para prontuário e exportação, bloqueio no Redis, recuperação sem enumeração e eventos de auditoria (HU-NUC-012, 013 e 014).
3. **Convites, RBAC e ligação com as telas** (4 a 6 dias): convite, desativação imediata, lista de sessões e logout remoto, e a rota HTTP da exportação G2. Depende de um provedor de e-mail transacional, que ainda não foi escolhido.

Total: **cerca de 2 a 3 semanas** até o login completo do M0. O portal do paciente fica para depois, com PoC própria. Nada entra na `main` enquanto o GitHub Actions estiver parado.

## 6. O que os sócios precisam responder
1. **Aprovam o Better Auth com as 6 regras acima?** Ou preferem o Zitadel, aceitando mais 1 a 2 semanas e um serviço a mais?
2. **Algum cliente do primeiro ano vai exigir login corporativo (SSO/SAML, de rede ou hospital)?** Se sim, o Zitadel ganha força. Para fisio/TO e psicólogos autônomos, a Engenharia acredita que não.
3. **Login do paciente no portal:** código por SMS ou WhatsApp (custo por mensagem, ainda não levantado) ou por e-mail (sem custo por envio)?

## Fontes
`D04-autenticacao.md` no branch `origin/poc/d4-autenticacao` (tabela da PoC, achados e limites) · `poc/d4/src/auth.ts` · `docs/04-arquitetura/seguranca-na-arquitetura.md` §1, §2 e §10 · `docs/02-produto/garantias-ao-cliente.md` (G2) · `docs/02-produto/backlog-mvp.md` (HU-NUC-012 a 014, HU-POR-001) · `docs/03-seguranca-lgpd/revisoes/2026-10-12-front-r8.md` (B3 e R13) · `D13-orcamento-infra-pentest.md` · `CONTEXTO.md` §6.

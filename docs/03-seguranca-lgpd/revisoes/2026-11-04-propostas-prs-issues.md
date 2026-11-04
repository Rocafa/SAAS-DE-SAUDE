# Triagem de segurança e LGPD: PRs e issues abertos (para aprovação em produção)

> Revisor: agente `revisor-codigo` (N1), a pedido do Maestro · Data: 2026-11-04 · Repo: `Rocafa/SAAS-DE-SAUDE` (main em `12595f5`).
> Como foi feito: só leitura (`gh pr list/view/diff`, `gh issue list/view`, `gh api` da proteção da main, leitura dos workflows e dos pareceres em `docs/03-seguranca-lgpd/revisoes/`). Nada foi comentado, aprovado, fechado ou enviado. Nenhum teste foi rodado por mim: o estado do CI é o que o GitHub mostra em cada PR.
> Não substitui o parecer do `guardiao-lgpd` (veto). É uma triagem para decidir o que pode ir para produção.

## 1. Resumo e veredito

- **Nenhum PR aberto introduz dado real de paciente, segredo, log com dado pessoal ou cache de dado sensível.** A varredura dos 14 diffs só achou `console.log` num script de gerar ícones, uma senha sintética na PoC (#36) e `.env.example` sem valor. CPFs são `000.*` e e-mails são `@exemplo.test`.
- **A produção continua bloqueada por fora dos PRs:** não existe provedor de sessão real (#107) nem MFA de verdade (#106). Hoje o login da clínica é simulado e o front só pode subir em modo demonstração. Nenhum PR aberto resolve isso.
- **A pilha do front precisa entrar inteira e na ordem certa.** O #86 sozinho tem travas que falham abertas. As correções estão empilhadas sobre ele: #118 → #103 → #92 → #86 → main. O #86 está 109 commits atrás da main e em rascunho, esperando a decisão do `fake.ts` pelo @Lopesloro.
- **Processo de PR e CI: bom em ferramentas, fraco em quem aprova.** Há gitleaks, CodeQL, auditoria de dependências, RLS, testes ofensivos, ZAP, k6, Trivy e E2E. Mas a proteção da main exige **0 aprovações**, não exige o dono do código, não vale para admin, e **o E2E e o Trivy não estão entre os checks obrigatórios**. O parecer do Guardião não é uma trava automática: depende de alguém lembrar.

**Veredito do processo: PODE COM CONDIÇÕES.** As ferramentas atendem. Antes de produção, falta transformar em trava o que hoje é combinado (aprovação humana, Guardião, E2E, Trivy, logs). Ver §4.

## 2. PRs abertos

Legenda do CI: "verde" = todos os checks que rodaram passaram; os de infra aparecem como *skipped* quando o PR não mexe em infra, e isso é esperado.

| PR | O que propõe | Toca dado pessoal? | Riscos no diff | CI | Parecer do Guardião | Veredito |
|---|---|---|---|---|---|---|
| **#118** (base: branch do #103) | R1 e R2 do parecer do #103: toda captura de tela passa por `e2e/captura.ts`, que confere o modo demonstração na clínica e no portal antes de gravar PNG; teste que recusa `page.screenshot` direto; `exigirAdmin()` em `salvarClinica`, `devolverAcesso` e `reativarAssinatura` | Só fictício. Protege contra foto de dado real no git | Nenhum. A trava falha fechada: se a conferência falha uma vez, nenhuma captura do worker acontece | Verde 15/15, com Playwright | Ele **é** a correção pedida no [parecer do #103](2026-10-29-pr103-front.md). Ainda não há registro de que o Guardião conferiu o #118 | **Pode com condições:** entrar no #103 e o Guardião confirmar R1/R2 |
| **#103** (base: branch do #92) | Fecha #93 a #102: trava de papel nas 7 rotas do fake, varredura de privacidade em 40 arquivos, trava de captura, SW sem cache velho, `start_url` do portal, `next.config` recusa modo http em produção | Só fictício | R1 e R2 do parecer ficaram abertos até o #118. R4 do parecer segue aberta: no modo http `obterClinica` ainda vem do fake, e o atestado só não sai com o nome errado da clínica por acaso | Verde 15/15 | [2026-10-29-pr103-front.md](2026-10-29-pr103-front.md): **aprovado com ressalvas** (R1, R2 obrigatórias) | **Pode com condições:** só junto com o #118. R4 vira trava antes de ligar o atestado à API |
| **#92** (base: branch do #86) | Corrige travas que falhavam abertas: `SoAdmin` liberava com papel desconhecido; trilha de auditoria (nome de paciente, e-mail da equipe) chegava ao navegador da recepção; trocador de usuário funcionava no modo http; timeout no portal | Sim, corrige exposição de nome de paciente e e-mail da equipe a quem não devia ver | Nenhum novo. Ele fecha três falhas abertas do #86 | Verde 15/15; 1 aprovação | Sem parecer próprio. O parecer do #103 cobre a pilha por cima dele | **Pode com condições:** entrar junto com #103/#118 no #86, e o Guardião registrar parecer da pilha consolidada |
| **#86** (rascunho, base: main) | Integra a pilha do front (#44 → #47 + #75) sobre a main: atendimento, prontuário sigiloso, documentos, financeiro, configurações LGPD, portal do paciente, PWA, adaptador HTTP do portal | Sim (telas de prontuário, CPF, portal), com dado fictício | **Sozinho, tem travas abertas** (#92, #95, #102) e a captura de tela sem trava (#94). 109 commits atrás da main. Decisão do `fake.ts` pendente | Verde em 28/10, mas está atrás da main (CI precisa rodar de novo) | Pilha aprovada em [2026-10-24-front-vetos.md](2026-10-24-front-vetos.md) e [2026-10-25-pr75.md](2026-10-25-pr75.md) | **Não pode** sozinho. **Pode com condições** com #92 + #103 + #118 dentro, atualizado com a main, CI verde de novo (com E2E) e parecer do Guardião sobre a pilha final |
| **#75** (base: #47) | Portal ligado ao backend real (adaptador HTTP, contrato `ApiPortal`) | Sim (portal do paciente), fictício | Modo http travado fora de produção (2 travas, com teste). Ressalvas R1–R4 do parecer | **Vermelho**: os jobs são de 25/10, da falha de cobrança do Actions, e nunca rodaram de novo | [2026-10-25-pr75.md](2026-10-25-pr75.md): aprovado com ressalvas, merge só com CI verde | **Não pode por este PR.** O conteúdo já está no #86 (que tem CI verde). Fechar quando o #86 entrar |
| **#44, #45, #46, #47** (pilha empilhada) | Telas do front da rodada 8 | Sim, fictício | Vetos B1/B2/B3 corrigidos | "Auditoria de dependências" vermelha (runs antigos, de 12/10). #44 tem conflito com a main | [2026-10-12-front-r8.md](2026-10-12-front-r8.md) + [2026-10-24-front-vetos.md](2026-10-24-front-vetos.md): aprovados com ressalvas | **Não pode por estes PRs.** Entram pelo #86 (o GitHub os marca como merged) |
| **#91** (base: main) | Timeout do adaptador HTTP passa a cobrir a leitura do corpo; `comTruncado` deixa de mutar a lista; `CURSOR_INVALIDO` e `PaginaPorCursor` vêm de `packages/shared` | Não | Nenhum. Reduz cópia de tipo (usa `packages/shared`) | Verde, mas 88 commits atrás da main | Sem parecer; não precisa (não toca dado pessoal) | **Pode com condições:** "Update branch" e CI verde de novo |
| **#116** (rascunho, base: main) | Troca o postgres.js 3.4.9 com patch pela 4.0.0 | Não (dependência) | Risco de comportamento: na v4 `Date` em coluna `timestamp`/`date` vira UTC, só ESM. O próprio PR registra isso | Verde 17/17 (com Trivy) | Não precisa | **Ainda não:** só a partir de 12/11/2026, como o PR manda. Depois, pode com RLS, resiliência e E2E verdes de novo |
| **#104** (base: main) | Só documentação: estado verificado dos itens de produção e `integracoes.md` | Não | Nenhum | Verde | Não precisa | **Pode ir** (é doc; precisa de "Update branch") |
| **#55** (base: main) | Só documentação: relatório final da Engenharia na rodada 8 | Não | Nenhum. Desatualizado (fala do CI parado por cobrança, já resolvido) | Verde | Não precisa | **Pode ir**, mas sugiro fechar por estar velho |
| **#36** (rascunho, base: main) | PoC da D4: Zitadel × Better Auth, medidos. Material de decisão, não pede merge | Não (sintético) | PoC fora do workspace; `.env` ignorado; recusa subir sem `POC_AUTH_SECRET`; senha sintética no script de medição | Verde | Não precisa para o merge (é decisão dos sócios) | **Não vai para produção** (não é código de produto). Falta a confirmação do @Lopesloro da D4, que destrava #107 e #106 |

## 3. Issues abertas

| Issue | Assunto | Severidade para produção | Já tem PR? |
|---|---|---|---|
| **#107** | Provedor de sessão real (S2): cookie HttpOnly, token de 15 min, refresh com detecção de reuso, logout global | **Bloqueia produção** | Não. O contrato de provedor entrou na main (#128). Depende da D4 (#36) |
| **#106** | MFA (S3), exigido pela garantia G2 | **Bloqueia produção** | Em parte: a política de MFA independente de provedor entrou (#123–#125). Falta o fator real (TOTP/WebAuthn), que depende do #107 |
| **#100** | `next.config` não barrava `NEXT_PUBLIC_API_MODO=http` em produção (com login simulado, qualquer um entraria) | **Bloqueia produção** | Sim: #103 (`conferirConfigClinica`) |
| **#94** | Captura das 96 telas pode fotografar dado real para o git (e o repositório é **público**) | **Bloqueia produção** | Sim: #103 + #118 (R1) |
| **#102** | Exportação total aprovada por quem pediu; varredura de privacidade sem as telas da clínica | **Bloqueia produção** da G2 | No front: #103. No servidor, a rota da exportação total ainda não existe (está na fila). Quando existir, a regra de duas pessoas tem de ser do servidor, com teste |
| **#95** | Sete rotas do adaptador falso sem trava de papel | Antes do piloto (a API real decide de novo, mas a tela ensinava o modelo errado) | Sim: #103 + #118 (R2) |
| **#98** | `useConsulta` mostra o dado antigo quando o filtro muda (pode mostrar dado de outro paciente por um instante) | Antes do piloto | Sim: #103 |
| **#93** | Documento imprimível com registro profissional e clínica fixos da demonstração | Antes do piloto (antes de ligar o atestado à API, vira bloqueio) | Em parte: #103. A R4 do parecer do #103 segue aberta |
| **#97** | `start_url` do manifesto leva o paciente para a área da equipe | Antes do piloto | Sim: #103 |
| **#101** | Remarcar perde a escolha, fila de espera sem erro na tela, vínculo do atestado | Antes do piloto | Sim: #103 |
| **#96** | Service worker preso no cache v1 | Melhoria (sem dado pessoal no cache, confirmado no parecer do #103) | Sim: #103 |
| **#99** | Classe de campo repetida, `useConsulta` duplicado | Melhoria | Sim: #103 |

Observação: o #103 aponta para outra branch, não para a main. O GitHub **não vai fechar** essas issues sozinho (`closingIssuesReferences` vazio). Fechar à mão quando a pilha chegar à main.

## 4. Travas do processo exigidas para produção

### O que existe e funciona

- **Template de PR** (`.github/pull_request_template.md`) com o gate de LGPD: dado real, segredo, tenant, auditoria, base legal, Guardião e aprovação dos dois sócios.
- **Checklist de PR** ([checklist-pr.md](../checklist-pr.md)) com 22 itens, 🔴 = veto.
- **Workflows em todo PR:** gitleaks (secret scan, histórico inteiro), CodeQL (falha em achado grave, 0 alertas abertos), `pnpm audit` (alto/crítico bloqueia), lint/typecheck/testes, RLS com papel `app_user`, testes ofensivos, ZAP baseline, k6, resiliência e backup/restauração, trava de TLS. Com filtro de caminho: Playwright (E2E do web), Trivy + SBOM + fumaça da imagem, Terraform (fmt/validate/tflint/checkov).
- **Actions fixadas por SHA**, permissões `contents: read`. Dependabot semanal (npm, actions, docker).
- **No GitHub:** secret scanning e push protection ligados. 0 alertas abertos de code scanning, Dependabot e secret scanning.
- **Logs na API:** `no-console: error` no ESLint da API. Uma leitura dos ~40 `Logger.warn/error` mostrou só códigos de evento, ids de clínica e nomes de erro, nunca nome, CPF ou conteúdo clínico (`describe()` do processo registra só `name` e `code`). No web, testes de varredura proíbem `console`, storage, analytics e HTML cru no portal, no Ajudante e, com o #103, nas telas da clínica.
- **Proteção da main** (lida com `gh api .../branches/main/protection`): PR obrigatório, `strict` (branch atualizada), force push e deleção bloqueados, 10 checks obrigatórios.

### Lacunas e correção sugerida

| # | Lacuna | Risco | Correção sugerida | Prioridade |
|---|---|---|---|---|
| L1 | **0 aprovações exigidas**, `require_code_owner_reviews: false`, `dismiss_stale_reviews: false`. O CODEOWNERS pede os dois sócios, mas o GitHub não obriga | Um PR com CI verde entra sem nenhum humano olhar, contrariando o template ("Aprovação dos sócios") | `required_approving_review_count: 1`, `require_code_owner_reviews: true`, `dismiss_stale_reviews: true`, `require_last_push_approval: true` | Bloqueia produção |
| L2 | **`enforce_admins: false`** | Admin passa por cima dos checks e da revisão | Ligar `enforce_admins` (exceção só por escrito, como manda o checklist) | Bloqueia produção |
| L3 | **Parecer do Guardião não é trava automática.** É uma caixa no template e um arquivo em `revisoes/`. Exemplo: #92 e #118 não têm parecer próprio registrado | Um PR que toca dado pessoal pode entrar sem o veto ter sido exercido | Check obrigatório (job leve) que, quando o diff toca `apps/`, `packages/` ou `infra/`, exige um rótulo `lgpd-aprovado` ou o arquivo `revisoes/*-prNNN*.md` com "APROVADO". Mais simples: tornar o Guardião um code owner de `apps/**` e `packages/**` e ligar L1 | Bloqueia produção |
| L4 | **E2E (Playwright) e Trivy não são obrigatórios.** Têm filtro de caminho, por isso não podem entrar direto na lista | Um PR do web com E2E vermelho, ou da API com imagem com CVE alta, pode entrar. É no E2E que estão as provas de que recepção não vê prontuário | Fazer como o `infra.yml`: um job que sempre roda, detecta a mudança e chama o E2E/Trivy (ou sai verde quando não há mudança). Tornar esse job obrigatório | Bloqueia produção |
| L5 | **Não há checagem automática de dado pessoal em `Logger` na API.** O `common/README.md` promete `logging/` com redaction de PII, e **essa pasta não existe**. O `no-console` só barra `console` | Um `this.logger.warn(\`... ${paciente.nome}\`)` passaria no CI. Hoje está limpo por disciplina, não por trava | (a) Teste estático em CI que recusa interpolar campos sensíveis (`nome`, `cpf`, `email`, `telefone`, `campos`, `conteudo`, `texto`, `body`) em `logger.*`; (b) criar o logger com redaction prometido no README ou corrigir o README | Antes do piloto |
| L6 | No web, `console` é global liberado no ESLint (`apps/web/eslint.config.mjs`). Só as varreduras por pasta protegem | Pasta nova fora da varredura fica sem rede | `no-console: error` no web também (com exceção só para `scripts/`) | Antes do piloto |
| L7 | `required_conversation_resolution: false` | Ressalva do Guardião comentada no PR pode ficar sem resposta no merge | Ligar | Antes do piloto |
| L8 | DAST (ZAP) varre só `/health` | O ZAP verde diz pouco sobre as rotas reais | Varredura com sessão de teste nas rotas principais (depois do #107), ou ZAP API scan com o OpenAPI | Antes do piloto |
| L9 | Template de PR **não traz** o checklist de 22 itens, só 6 caixas. Não pede evidência de teste | Os itens 🔴 de IA, suboperador, criptografia de campo e logs passam sem pergunta | Colar o link e os itens 🔴 do `checklist-pr.md` no template, mais um campo "Evidência de teste (comando e saída)" | Melhoria |
| L10 | Repositório **público** (desde a rodada 29, para o Actions voltar) | Os RIPD, o plano de incidentes, as travas e as capturas de tela ficam visíveis para todos. Não é dado pessoal, mas mostra a defesa. E qualquer foto com dado real (#94) ficaria pública na hora | Decisão dos sócios: voltar a privado com o Actions pago antes do piloto, ou registrar o aceite do risco | Antes do piloto |
| L11 | `dependabot_security_updates: disabled`, `secret_scanning_non_provider_patterns: disabled`, `required_signatures: false` | Correção de CVE espera a rodada semanal. Segredos genéricos (senha em URL) dependem só do gitleaks | Ligar os alertas e as atualizações de segurança do Dependabot e os padrões genéricos de secret scanning. Commits assinados: opcional | Melhoria |
| L12 | PRs empilhados (base que não é a main) e PRs velhos (#75, #44–#47, #55) com CI vermelho ou desatualizado | Confusão sobre o que foi testado. Issues não fecham sozinhas | Depois do #86, fechar #44–#47 e #75 com referência. Fechar o #55. Preferir PRs contra a main | Melhoria |

## 5. Ordem sugerida para liberar

1. @Lopesloro: merge de #118 → #103 → #92 dentro do #86, decidir o `fake.ts`, atualizar o #86 com a main e deixar o CI rodar de novo.
2. Guardião: um parecer da pilha consolidada do #86 (confirmar R1/R2 do #103, e #92).
3. Merge de #91 e #104 depois de "Update branch".
4. Sócios: ligar L1 a L4 na proteção da main.
5. Produção de verdade só depois de #107 e #106 (depende da confirmação da D4 no #36). Até lá, o front sobe só em modo demonstração, e a trava do #100 garante isso no build.

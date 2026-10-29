# Rodada 29: merges com o CI de volta (2026-10-27)

**Gatilho:** o repositório ficou **público** em 27/10/2026. O GitHub Actions voltou a rodar (minutos grátis em
repositório público) e destravou a fila de merges que o [ensaio 2](2026-10-27-ensaio-de-merge-2.md) tinha validado.

**Método:** cada PR foi atualizado sobre a main (`update-branch`, ou merge local quando havia conflito), rodou o CI
completo (CI, Segurança com Redis real, Testes de produção, CodeQL e, quando aplicável, imagem e infra) e só entrou
com tudo verde, por merge commit. Nenhum push em branch do @Lopesloro.

## 1. O que entrou na main

| PR | O quê | Observação |
|---|---|---|
| #77 | next 16.4.3 + overrides multer/body-parser | **novo:** o audit acusava 2 críticos (RCE no Next.js) e 3 altos que surgiram depois do ensaio |
| #52, #51 | setup-node 7.1.0, upload-artifact 7.0.2 | Dependabot |
| #43 | Agenda e Pacientes (front, PR 2, @Lopesloro) | CI disparado de novo fechando e reabrindo o PR, sem push na branch |
| #57, #61, #62, #63, #65 | API: pacientes/agenda, ressalvas, guias e pacotes, prontuário, financeiro | pilha retargetada para a main a cada merge |
| #78 | 13 atualizações menores (substitui o #72) | Dependabot |
| #79 | codeql-action init + analyze juntos na v4.39.1 | substitui #70 e #71, que subiam cada metade separada |
| #56 | golden sets de IA | |
| #59 | imagem Docker da API + E2E no CI | 2 correções (§2) |
| #73 | integração r19+ (cursor v2, KMS por clínica, importador, responsáveis, portal, WhatsApp, jobs) | conflito do `package.json` resolvido como no ensaio; 1 correção (§2). Inclui #66–#69, fechados como "entraram pelo #73" |
| #60 | adaptador HTTP do front (pacientes e agenda) | seção do front em `api-dominio.md` virou §15 |
| #58 | Terraform do staging | 3 correções (§2); `terraform validate`, tflint e checkov rodaram de verdade pela 1ª vez |
| #76 | adaptador HTTP alinhado ao backend r19+ | |
| #83 | trava API × Terraform passa a falhar (em vez de pular) se o `app.tf` sumir | item Livre da fila |
| #84 | Dependabot não sobe versão maior da imagem `node` | o #80 queria build em Node 26 com runtime distroless nodejs22 (fechado) |
| #81, #82 | setup-node e upload-artifact nos workflows novos do #59 | Dependabot |
| #49 | ioredis 6 | Redis real no CI (88/88) |
| #85 | client-kms 3.1156.0, bullmq 6.4.2 (versões exatas mantidas) | Dependabot, 28/10 |

**Fechados sem merge:** #74 (substituído pelo #77), #72 (o Dependabot fechou e abriu o #78), #70/#71 (pelo #79), #80 (§1),
#66–#69 (já contidos no #73).

## 2. Defeitos que só o CI real mostrou (todos corrigidos)

1. **Imagem (#59), `pnpm deploy --offline`:** o `deploy` do pnpm 9 resolve de novo e precisa dos metadados do registro,
   que o `pnpm fetch` não guarda (`ERR_PNPM_NO_OFFLINE_META`). Reproduzido localmente sem Docker. Passou a
   `--prefer-offline`. O `/out` continua só com dependências de produção, o patch do postgres aplicado, os overrides
   respeitados e as versões do lockfile (627de6a).
2. **Imagem (#59), Trivy:** `libssl3` 3.0.18 na distroless `nodejs22-debian12` (1 CRITICAL, 6 HIGH). A variante debian12
   não é republicada desde fev/2026. Runtime passou para `nodejs22-debian13:nonroot` e build para `node:22-trixie-slim`.
   Digests conferidos na API dos registros (2a7ca24).
3. **Carga (#73):** o `/health/ready` ganhou o rótulo `jobs` e o check do k6 só conhecia `{status, rateLimit}`. O regex
   aceita o rótulo novo e continua recusando campo extra (3d975e1).
4. **Infra (#58):** a pasta do `TF_PLUGIN_CACHE_DIR` não existia antes do `terraform fmt`; `fmt` desalinhado em 2 linhas
   do `app.tf`; o shellcheck acusava SC2016 (o `$` é JavaScript do `node -e`) e SC2119, ambos anotados com o motivo
   (383bcc6, 2b97d8a).

Nenhuma dessas mudanças altera regra de negócio, dado pessoal ou política de chave.

## 3. O que falta

- **Pilha do front do @Lopesloro (#44 → #45 → #46 → #47) e #75 em cima dela:** cada branch precisa receber a main. O #44
  pede decisão dele no `fake.ts`. Passo a passo comentado no #44.
  **28/10:** proposta montada no **#86** (rascunho, branch minha). As resoluções do ensaio foram reaproveitadas depois de conferir que as entradas de cada conflito eram idênticas. Resultado: web 349/349, api 995/995 e CI todo verde, incluindo Playwright e RLS. Falta o aval dele no `fake.ts`.
- **#49 (ioredis 6): entrou.** No CI de Segurança, com Redis real (`JOBS_REDIS_TESTE=1`), `agendador-redis` e `rate-limit-redis` rodaram e passaram (88/88, nenhum pulado).
- **#54:** fora da fila. O motivo (billing) sumiu e ele reduziria a cobertura.
- **#55 e #36 (@Lopesloro):** antigos, sem relação com a fila. Ficam com ele.
- **Proteção da `main`: ligada em 28/10/2026** com o OK do sócio. Configuração: PR obrigatório, branch atualizada, 10 checks
  obrigatórios, sem force push nem exclusão. Aprovação obrigatória e `CODEOWNERS` ficaram para depois. Detalhes em
  [ambientes-e-devops](../04-arquitetura/ambientes-e-devops.md).
- **Staging e piloto:** continuam dependendo da D4 (login real) e de rodar as provas K-c3/K-c5 na AWS
  ([runbook](../04-arquitetura/runbook-primeiro-dia-staging.md)).

## 4. 28/10: proteção da main e índice cego

- **#87, proteção da `main`:** ligada com o OK do sócio. PR obrigatório, branch atualizada, 10 checks obrigatórios, sem force push nem exclusão. O próprio #87 serviu de teste.
- **#54 fechado.** Pular o CI em PRs só de documentação travaria esses PRs, porque os checks obrigatórios nunca chegariam.
- **#88, job `cpf-indice-reindexacao` (diário, 05:30):** fecha a observação "antes do GA" do parecer do importador. Os pacientes anteriores à 0046 só ganhavam índice cego por um passo de runbook que não tinha script. O job faz até 20 lotes de 500 por clínica e por dia. Sem pendente, não decifra nada nem cria chave. Quando zera, destrói as versões aposentadas.
  - **Guardião: APROVADO COM RESSALVAS, depois APROVADO.** A C1 apontava que uma clínica eliminada (G3) faria o job falhar todo dia, e esse alarme eterno esconderia as falhas reais. Agora o job devolve `chaveDestruida = 1` sem falhar. A C2 pediu que o teste prove que nenhuma chave é criada.
  - CI todo verde, com RLS.
- **Fila:** o item "#66 R3/R9" estava velho, porque os dois já tinham entrado pelo #73. Foi trocado pelas pendências reais de antes do GA:
  - índice cego dos responsáveis;
  - conferir `pending = 0` em produção.

## 5. 29/10: índice cego nos responsáveis (#89)

- **O que entrou:**
  - migração 0054, que leva o índice cego do CPF aos responsáveis com a mesma chave da clínica e o domínio `guardians.cpf:v1:`;
  - a deduplicação do importador passa a usar o índice;
  - o job `cpf-indice-reindexacao` cobre as duas tabelas;
  - uma versão de chave só é destruída sem paciente nem responsável indexado nela.
- **Execução:** feito por um agente de engenharia num worktree próprio e conferido pelo Maestro. O Maestro corrigiu:
  - os testes do agente: um comparava `updated_at` e outro mudava um telefone que a pessoa não tinha;
  - um defeito: reenviar o mesmo CPF zerava o índice a cada edição;
  - o teste do adaptador web, que agendava "hoje às 23:00" e falhava quando o CI rodava depois das 23h.
- **Guardião: APROVADO COM RESSALVAS, depois APROVADO.**
  - **C1:** decidir "mesmo CPF" pelo índice, que pode ser trocado sem usuário, deixaria um índice forjado descartar em silêncio uma alteração legítima. Agora a decisão é tomada decifrando o CPF atual, como nos pacientes.
  - **Defeito revelado pelo teste da C1:** com o índice forjado igual ao novo, o gatilho de índice ausente zerava o índice gravado. Corrigido.
- **Situação:** CI todo verde com RLS. Fica no checklist do GA conferir `pending = 0` também com `table: guardians`.

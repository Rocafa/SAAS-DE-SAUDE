# Parecer do Guardião: código da recuperação do fator do admin único pelo suporte (B12)

> 17/11/2026 · Guardião LGPD & Segurança · revisão de **código** do PR #199 (`eng/recuperacao-admin-unico`, commit `3ecd9a9`, diff contra `origin/eng/provisionamento-clinica`).
> Base: [parecer do desenho de 16/11](2026-11-16-desenho-recuperacao-do-admin-unico.md) (R1 a R10; recuperação completa vetada).

## Veredito: **APROVADO COM RESSALVAS**. Merge só depois de C1 e C2.

O código cumpre o que o desenho pediu no essencial: o suporte só emite token de **fator**, com 24 h, ator sistema e chamado, travado no banco por CHECK (0077); o uso troca a conferência do emissor por "a pessoa segue admin ativo"; a trilha da clínica não tem o operador; a saída do comando só tem códigos fixos; e, sem o SSM real, o comando **falha fechado** (`ssm_nao_configurado`). Nenhum caminho do PR restaura senha e fator juntos. Faltam dois ajustes pequenos antes do merge (C1, C2). O resto são recomendações.

## Condições para o merge

- **C1 — `--derrubar-sessoes` não cobre o aparelho roubado nem a conta bloqueada** (`recuperacao-pelo-suporte.ts:37` e `:93`). A R5 pedia `--derrubar-sessoes` obrigatório com `suspeita_de_invasao` **ou aparelho roubado**. A lista fechada não tem "roubado": o operador escolhe `perdeu_o_aparelho` e o celular furtado segue com a sessão de admin aberta até o titular usar o token (até 24 h). Também ficou `conta_bloqueada`: um `MFA_BLOQUEADO` (5 códigos errados com a senha certa) é exatamente o sinal de ataque da R3, e o comando aceita esse motivo sem derrubar nada. **Correção:** `--derrubar-sessoes` obrigatório para **todo** motivo, exceto `troca_de_aparelho` (o único em que o titular ainda tem o aparelho antigo). O custo é baixo: quem perdeu o fator não entra sem ele, e as sessões já caem no uso. Teste: `perdeu_o_aparelho` e `conta_bloqueada` sem a flag → `derrubar_sessoes_obrigatorio`. No runbook, `conta_bloqueada` exige a consulta da R3 com resultado "sem sinal de ataque" registrada no chamado antes da emissão.
- **C2 — Testes contra o banco ainda não rodaram no CI.** Na hora desta revisão, "Isolamento entre tenants (RLS)" e "Lint, typecheck e testes" estavam pendentes no #199. Localmente rodei só a parte unitária (`src/ops/recuperar-admin-unico.test.ts`: 7/7). O merge só entra com esses dois checks verdes.

## Conferência das ressalvas do desenho

| Ressalva | Situação | Onde |
|---|---|---|
| R1 (desenho corrigido) | Fatos do #159 refletidos no código e no runbook (15 min do admin, conferência do emissor, teto por emissor, `credential_recovery_issued`). | `0077:8-9`, runbook |
| R2 (origem, uso adaptado, testes a–e) | **OK.** `origem`/`chamado` com CHECK (chamado obrigatório só no suporte; suporte só `fator` e `criado_por` = sistema; 24 h × 15 min). Uso: `provedor.ts:539` (suporte só `fator`), `:544` e `:644` (sem emissor, a pessoa precisa ser **admin** ativo). Testes (a) a (e) presentes e sem verde falso: (b) rebaixa pela API real; (c) usa token de admin com emissor sem vínculo, válido no resto; (d) cobre os sete casos de CHECK; (e) junto com a asserção de exatamente 24 h na emissão. | `contrato-provedor-better-auth.rls.test.ts` (bloco B12), `recuperacao-admin-unico.rls.test.ts` |
| R3 (engenharia social) | Runbook com titular conferido, ligação de retorno ao telefone anterior ao chamado, suspensão por troca de contato, consulta de 7 dias, roteiro de recusa, sem break-glass. Ver C1 sobre `conta_bloqueada`. | runbook |
| R4 (comando no padrão do B10) | **OK, com uma diferença** (A1). Ordem: entrada → chamado → motivo → clínica existe → admin ativo → conta ativa (`ativo` e `inativa_por`) → nenhum outro admin com fator → teto. Tetos (1 por clínica em 30 dias, 2 por pessoa em 12 meses) contados sob trava consultiva por clínica e por pessoa, em ordem fixa. Pendentes da pessoa invalidados na emissão. Só `app_auth` e `app_user`, sem `BETTER_AUTH_SECRET`. Saída: códigos fixos, código ≠ 0 na falha, nunca a mensagem do driver (testado). | `recuperacao-pelo-suporte.ts:93-170`, `recuperar-admin-unico.ts` |
| R5 (sessões e vínculo) | Vínculo intacto; sessões caem no uso; `--derrubar-sessoes` na emissão. **Incompleto: C1.** | `recuperacao-pelo-suporte.ts:93`, `:162` |
| R6 (prova) | **OK.** Trilha com ator sistema e metadata fechada `{op, user_id, kind, reason, via, ticket}`, testada com `toEqual` e varredura do operador em toda a trilha da clínica. `RECUPERACAO_PELO_SUPORTE` com alarme **imediato** em toda emissão; `RECUPERACAO_USADA` com `motivo: recuperacao_pelo_suporte` e chamado; `RECUPERACAO_TETO` com `teto_do_suporte`. | `recuperacao-pelo-suporte.ts:124-128`, `log-de-seguranca.ts` |
| R7 (retenção) | **OK.** SSM apagado na falha depois de gravar; vencimento e KMS ficam para o cliente real (TODO). 13 meses para as linhas do suporte: ver "Decisões". | `provedor.ts:305`, `matriz-retencao.md` |
| R8, R10, `--revisao`, Terraform, SSM real | Fora do PR. Ver "O que ficou fora". | — |
| R9 (fora do escopo) | No runbook ("quando NÃO usar"). | runbook |

## Decisões do implementador

- **`--motivo` com lista fechada (subconjunto do #159, sem `esqueceu_a_senha`): aprovada.** Sem texto livre na trilha nem no CloudTrail, e `esqueceu_a_senha` fora impede o uso para o caso vetado. O problema não é a lista fechada, é a regra das sessões sobre ela (C1).
- **13 meses para as linhas `origem = 'suporte'`: aprovada e justificada.** O teto por pessoa (2 em 12 meses) atravessa clínicas. A trilha da clínica está sob RLS por tenant e o log de segurança guarda só 180 dias, então a única fonte que conta isso sem consulta entre tenants é a própria `identidade.recuperacao`. 395 dias contados do **vencimento** cobrem a janela de 12 meses contada da **criação**, com folga. A linha não tem dado pessoal além de ids pseudônimos, o chamado e o hash de um token vencido (art. 6º III atendido). Pendente: refletir no `RIPD-identidade.md` §3 junto com a R10.
- **Apagar o parâmetro SSM só se a rodada o gravou: aprovada.** Uma recusa (teto, outro admin, trava) não pode destruir a entrega legítima pendente de outra rodada. Está testada (`recuperar-admin-unico.test.ts`, "recusa da função vira o código fixo").

## Achados não bloqueantes (recomendações)

- **A1 — Trava fora das conferências da clínica** (`recuperacao-pelo-suporte.ts:101-119` × `:132-133`). A R4 pedia todas as conferências sob a trava por clínica. Aqui a trava (no banco `identidade`) só cobre o teto. "Admin ativo" e "nenhum outro admin com fator" são lidos antes, numa transação sem trava. A corrida é estreita e o dano é pequeno: o uso confere de novo "admin ativo" (`provedor.ts:644`), e outro admin que cadastra o fator no meio só deixaria passar uma emissão que ele mesmo poderia fazer. Aceito como risco residual. Registrar no comentário do cabeçalho, porque ele diz que as conferências seguem a ordem da R4 sob trava.
- **A2 — A compensação engole o erro** (`recuperacao-pelo-suporte.ts:174`, `.catch(() => undefined)`). Se a trilha não confirma e a invalidação também falha, fica um token **válido por 24 h** sem linha na trilha da clínica. O token só existiu no SSM, que o comando apaga, então ninguém o tem. Mesmo assim, registrar `registrarEventoDeSeguranca` (alto, imediato) nesse `catch` para alguém invalidar à mão.
- **A3 — `--operador` é declarado por quem roda** (`recuperar-admin-unico.ts:126`). O id vai para o log de segurança sem amarra ao principal. Até o Terraform com `SourceIdentity`, o runbook deve mandar conferir o CloudTrail do `RunTask` contra o `operador` no fechamento do chamado.
- **A4 — Testes que faltam** (não tornam os atuais falsos): (i) duas emissões concorrentes na mesma clínica → uma `teto`; (ii) a trilha falha **depois** do commit do banco `identidade` → a linha fica com `usado_em` e o token não vale; (iii) os casos novos de C1.
- **A5 — Saída de sucesso com o uuid do usuário** (`recuperar-admin-unico.ts:108`). Aceitável: é id pseudônimo e já vai no override (CloudTrail). Nunca acrescentar nome, e-mail ou chamado a essa linha.

## O que ficou fora: algo fica inseguro sem isso?

- **SSM real:** não. `parametrosDoSsm()` devolve `null` e o comando sai com `ssm_nao_configurado` antes de abrir o banco (`recuperar-admin-unico.ts:126-134`). Quando entrar: `SecureString` com KMS própria, política de vencimento de 24 h, papel restrito a `/recuperacao-suporte/*`, e `DeleteParameter` que ignore `ParameterNotFound`. Isso volta ao Guardião.
- **Terraform `ops-recuperacao`:** não, enquanto não existir tarefa; ninguém roda em produção. A função só é importada pelo comando (nenhum controller ou rota a importa).
- **`--revisao`:** não. Sem ele, acima do teto o comando recusa sempre (falha fechado). O runbook diz isso.
- **R8 (aviso ao signatário):** passo manual no runbook. Aceitável até a automação.
- **R10 (RIPD e checklist):** documental, mas é **condição para a primeira recuperação real**, não para o merge. Também precisa entrar a retenção de 13 meses no RIPD §3.
- **Fumaça do staging:** só depois do SSM e do Terraform.

## Conferência dos requisitos

| Requisito | Situação |
|---|---|
| Base legal (art. 7º e 11) | Art. 7º V (contrato) e art. 7º II/IX e art. 46 (segurança), como no desenho. Nada do art. 11 é tocado. Falta registrar no RIPD (R10). |
| Minimização | Chamado só `SUP-<n>` (CHECK e regex); trilha sem operador; saída sem nome, e-mail, token ou mensagem do driver; tarefa sem `BETTER_AUTH_SECRET`. |
| Consentimento | Não é a base. |
| Criptografia | Só o SHA-256 do token no banco; token só no SSM (SecureString com KMS no PR do cliente real); TLS no uso. |
| Isolamento por tenant | Conferências e trilha via `withTenant` com o usuário de sistema; token preso à `clinica_id`; uso confere admin na clínica do token. |
| Controle de acesso | Uso exige a senha atual e admin ativo; emissão só para admin único; IAM nominal com MFA depende do Terraform. |
| Auditoria | Trilha com ator sistema e chamado; operador e chamado no log de segurança com alarme imediato; CloudTrail no `RunTask`. |
| Retenção | 24 h do token; SSM apagado na falha; linhas do suporte 13 meses (justificado); log 180 dias. Prontuário (20 anos) não é tocado. |
| Segredos fora do código | Nenhum segredo no diff; token fictício nos testes. |
| Dados reais fora do git/prompts | Testes com `@exemplo.test` e uuids fictícios. |
| CFM/ANS/ICP-Brasil | Nada específico. Garantir que só o titular volta a acessar sustenta o sigilo do prontuário (CFM 1.821/2007, 2.299/2021). |

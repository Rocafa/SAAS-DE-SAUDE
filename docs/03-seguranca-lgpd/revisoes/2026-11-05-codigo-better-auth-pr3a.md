# Parecer do Guardião LGPD: código do PR 3a da autenticação real (D4, Better Auth, PR #155)

> Data: 05/11/2026. Branch: `eng/better-auth-equipe`, base `eng/better-auth-mfa`. Base: §14.1 e §14.4 do desenho e o parecer do desenho do PR 3 (`2026-11-05-desenho-better-auth-pr3.md`, R3 a R7). Revisão estática do diff `origin/eng/better-auth-mfa...origin/eng/better-auth-equipe`. A bancada RLS não rodou aqui.

## Veredito: **APROVADO COM RESSALVAS.** Nada bloqueia. A R1 e a R2 entram antes do 3c.

O 3a faz o que o desenho prometeu:
- **`SessaoDePessoaGuard`:** só funciona com o provedor real (com o dev, 404), aplica as mesmas travas do `resolver` (o prazo absoluto de 12 h apaga a sessão, conta inativa cai) e entrega só `{ sessaoId, userId }`.
- **`mfa_sem_clinica_em`:** é `input: false` e `returned: false`, o `resolver` nunca o lê, e ele é zerado em toda escolha, valendo ou não. Só a **primeira** escolha (`clinicaAtiva === null`) dentro de 5 min o converte, com os perfis da clínica escolhida e a trilha nela.
- **Lista de sessões:** sem IP, user-agent nem clínica.
- **Encerrar sessão:** o dono é conferido no banco pelo id completo.
- **`Set-Cookie`:** filtrado pelo nome do cookie de sessão. Nas rotas `@SemRenovarSessao()` sai com `disableRefresh` e sem cookie.
- **`LOGIN_SENHA_OK`:** sai na sessão provisória.
- **Expurgo:** é um job da plataforma e guarda só as contagens.

Há testes de contrato para cada um desses pontos.

## Ressalvas

### Antes do 3c (antes de abrir produção)

1. **A conversão do MFA sem clínica não é atômica.** `definirClinica` lê `mfaSemClinicaEm` e `clinicaAtiva` num `SELECT` e só depois faz o `UPDATE`. Dois `POST /sessao/clinica` simultâneos leem o mesmo "antes" (sem clínica, TOTP recente), e **os dois** convertem: o MFA é marcado em A e depois em B, com `mfa_verified` nas duas trilhas. O estrago é pequeno, porque a sessão termina numa clínica só, mas a regra "só a primeira escolha" deixa de valer.
   - **Correção:** fazer o `UPDATE … SET clinica_ativa = $c, mfa_em = NULL, perfis_no_mfa = NULL, mfa_sem_clinica_em = NULL WHERE id = $s AND usuario_id = $u RETURNING` com o valor **anterior** (CTE `WITH antes AS (SELECT … FOR UPDATE)`) e decidir o "aproveita" pelo que voltou.
   - **Teste:** duas escolhas em paralelo; no máximo uma linha `mfa_verified` sai.
2. **O logout precisa apagar o cookie.** `encerrar-todas` e `DELETE /sessao/sessoes/:id` (quando o id é o da sessão atual) passam antes pelo guard, que pode ter **renovado** o cookie na mesma resposta. O navegador fica com um cookie de sessão que não existe mais. Isso falha fechado, mas o certo é a resposta levar o `Set-Cookie` que expira o cookie de sessão (`Max-Age=0`, com os mesmos atributos), e não o renovado.

### Fila

3. **Clínica cancelada.** `clinicasDaPessoa` e `escolherClinica` usam o espelho de vínculos, que não olha `tenants.subscription_status`. Uma clínica cancelada aparece na lista e pode ser escolhida. Alinhar com a regra que o `SessaoGuard` e a tenancy aplicam a clínicas canceladas (a exportação da portabilidade pode precisar de acesso). Se a regra for bloquear, filtrar nos dois lugares, com teste.
4. **Teste pela HTTP.** O teste do `Set-Cookie` renovado roda no provedor (`aoRenovarCookie`), não no guard com `res.append`. Falta um teste pela rota que confira que a resposta HTTP leva **só** o `Set-Cookie` da sessão, com os atributos de produção do PR 1, e que nenhum outro cabeçalho da biblioteca passa. O mesmo teste deve cobrir a rota `@SemRenovarSessao()` pela HTTP.
5. **`LOGIN_OK` no fim do cadastro do fator.** A troca de sessão que a biblioteca faz no `verify-totp` do cadastro gera `LOGIN_OK`, que não é um login. Mandar `motivo: 'cadastro_do_fator'` ou suprimir o evento quando o caminho for o do cadastro com sessão aberta.
6. **`dois_fatores.criado_em`.** Quando a biblioteca reaproveita a linha de um cadastro não concluído (novo `enable`), ela não atualiza `criado_em`. Um cadastro refeito perto das 24 h pode ser apagado pelo expurgo no meio do processo. Isso falha fechado (a pessoa recomeça), mas vale um gancho que atualize `criado_em` no `enable` ou um comentário no §14.
7. **Sessão `cadastro_do_fator_pendente` (R3 do desenho, parte da 3b).** O guard novo ainda não conhece esse estado, porque ele nasce no 3b. Quando nascer, conferir que `SessaoDePessoaGuard` recusa a sessão pendente em todas as rotas da pessoa (lista fechada por estado, como no parecer do desenho).

## Conferido sem achado

| Item | Situação |
|---|---|
| Base legal | Sessão e vínculo da equipe: execução do contrato e segurança (art. 7º V e IX, art. 46). ✅ |
| Minimização | Clínicas: só id e nome (nome de clínica não é dado pessoal). Sessões: id, criação e última atividade. Expurgo e logout global: só contagens. ✅ |
| Isolamento | O nome da clínica é lido com `withTenant` na própria clínica. A escolha passa pelo espelho e devolve 404 sem vínculo. A trilha vai só para as clínicas do vínculo, com `op` fixo. ✅ |
| R4 (MFA sem clínica) | Zerado em toda escolha, nunca lido como `mfa_em`, só na primeira escolha em até 5 min; testes dos três casos. ✅ (atomicidade na R1) |
| R5 (`Set-Cookie`) | Filtro `^(__Host-)?sessao=`. Nas rotas de polling, nem renovação nem cookie (teste com 20 leituras). ✅ (teste HTTP na R4 desta lista) |
| R6 (sessões) | `DELETE` por uuid com `user_id` da sessão no `WHERE`; de outra pessoa, 404 e nada apagado (teste). ✅ |
| R7 (expurgo) | Sessões vencidas, `verificacao` vencida há mais de 24 h e TOTP não concluído há mais de 24 h; job diário da plataforma com tentativas e só contagens no log. ✅ |
| Auditoria | As rotas novas estão em `AUDITADAS` e `LEITURA_SEM_DADO_DE_PACIENTE` com motivo, e a análise resolve interface → implementação. ✅ |
| Dados reais e segredos | Só contas fictícias na bancada. ✅ |
| CFM, ANS e ICP-Brasil | Não toca prontuário, TISS nem assinatura. ✅ |

## Nota do Maestro (05/11/2026)

- **R1 corrigida.** A escolha de clínica lê o valor anterior e faz a troca numa única instrução, com a linha travada (`with antes as (select … for update) update … returning antes.*`). Teste novo na bancada: duas escolhas ao mesmo tempo geram uma única linha `mfa_verified` somando as duas trilhas.
- **R2 corrigida.** O logout global, e o encerramento da própria sessão atual, devolvem o `Set-Cookie` que expira o cookie de sessão. O nome e os atributos são os do ambiente, montados no boot, e o cookie sai depois de qualquer renovação feita pelo guard.
- **R6 corrigida.** Um trigger na `identidade.dois_fatores` renova `criado_em` quando o segredo muda (cadastro refeito), então o expurgo não apaga um cadastro em andamento.
- **R3, R4, R5 e R7** vão para a fila do 3b e do 3c.

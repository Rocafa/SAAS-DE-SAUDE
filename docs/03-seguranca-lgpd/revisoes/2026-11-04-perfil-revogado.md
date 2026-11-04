# Parecer: PR #130, perfil revogado corta a sessão aberta (E2)

- **Data:** 04/11/2026
- **Revisor:** agente `guardiao-lgpd` (N1, veto)
- **Escopo:** `git diff main...eng/perfil-revogado-corta-sessao` (`a13b60c`). Arquivos: `auth/sessao.guard.ts` (`perfisVigentes`, `perfisDoBanco`), `auth/perfis-vigentes.test.ts`, `test/perfil-revogado.rls.test.ts`, `security/log-de-seguranca.ts` (motivo `perfil_revogado`) e docs.
- **Origem:** E2 de `revisoes/2026-11-04-revisao-interna-profissionais.md`.
- **Como revisei:** li o diff, a migração 0020 (RLS e índices de `clinic_members`), `withTenant`/`app_set_tenant`/`app_set_user`, `auth-provider.factory.ts`, `membros.ts` e o apoio dos testes. **Não rodei** os testes RLS (não há Postgres local).
- Não é parecer jurídico.

## Veredito: APROVADO COM RESSALVAS

O E2 está resolvido do jeito certo: a cada requisição o guard lê as linhas do usuário em `clinic_members`, na clínica da sessão e sob RLS, e o perfil revogado sai da sessão. Desligar alguém (todas as linhas revogadas) tira todo o acesso. A leitura pega só `role` e `revoked_at` (minimização). O log usa só ids e um motivo de lista fechada. As ressalvas 1 a 3 devem ser corrigidas **neste PR**. As demais podem ir para a fila.

## Respostas às perguntas

- **Regra de transição (sem linha, vale o provedor):** é aceitável até a D4. A produção não sobe sem provedor real (`auth-provider.factory.ts:20-27`), então hoje a regra só vale em dev/test. O histórico é append-only: `DELETE`/`TRUNCATE` foram revogados de `app_user` e há gatilho. Por isso um desligado nunca volta a "sem linha" e não cai na transição. Resíduos: ressalvas 1 e 2.
- **Corrida:** a leitura do guard roda numa transação própria, antes da transação do handler (READ COMMITTED). Uma revogação gravada entre as duas não pega a requisição que já está em andamento. A janela é de uma requisição, e isso é aceitável. Ressalva 5 para operações longas.
- **Falha do banco:** fecha. A exceção de `db.run` sobe e a requisição recebe 500 sem executar o handler. Um `userId` que não é UUID, ou que é o sentinela de sistema, também barra (`withTenant` lança exceção). Exceção a essa regra: sem `TenantDatabase` injetado, o guard **abre** (ressalva 3).
- **RLS e usuário travado:** a policy `tenant_isolation` filtra por `app_current_tenant()`, e a consulta ainda filtra `tenant_id` e `user_id` de forma explícita. `app_set_user` exige o contexto de tenant antes, e `withTenant` o define antes. Não há efeito colateral de escrita.
- **Criar clínica e fundador:** a clínica nasce com o fundador como admin ativo (0022/0047), e `app_set_tenant` não exige que o tenant exista. Uma sessão de clínica nova, sem linha, cai na transição. Na correção de fundador (0042/0047), o fundador antigo perde o admin na próxima requisição, e esse é o comportamento desejado.
- **O teste RLS prova o que diz?** Em grande parte, sim: mostra 200→403→200 na mesma sessão e o desligado com perfis "fantasmas" levando 403. O caso da "outra clínica" passa pelo caminho de transição, não pela leitura com linha (ressalva 6).

## Ressalvas

1. **(corrigir neste PR, ou registrar como risco aceito pelo N1)** Um perfil que a sessão afirma ter, mas que **nunca foi para o banco**, sobrevive quando o usuário tem outra linha ativa. Exemplo: o banco diz `recepcao` ativo, a sessão diz `admin`+`recepcao`, e o `admin` fica. Isso é escalada por afirmação do provedor e fica coberto hoje só porque a produção exige provedor real. Recomendação: quando o usuário tiver **qualquer** linha, a sessão passa a ser a interseção com os perfis ativos. A transição fica só para quem não tem linha nenhuma. O teste `perfil sem linha própria, com outro perfil ativo: fica` precisa ser invertido. Se a interseção quebrar testes existentes, ajuste os testes em vez da regra. No mínimo, a D4 precisa ter como condição explícita que "os perfis vêm só do banco" (`prontidao-producao.md`, linha E2).
2. **(corrigir neste PR)** A checagem de "desligado" (`linhas.some(l => l.revokedAt === null)`) conta a qualificação `psicologo` como linha ativa. Um usuário com todos os perfis revogados e só `psicologo` ativo não é tratado como desligado: os perfis da sessão sem linha própria continuam valendo (por exemplo, `admin`). Correção: considerar só linhas com `role` ∈ `PERFIS`, tanto para "tem linha" quanto para "tem ativa". Incluir um teste unitário desse caso.
3. **(corrigir neste PR)** `if (!this.db) return auth.perfis;` abre o acesso quando o banco não foi injetado. Hoje o `TenancyModule` é global, mas uma regressão de módulo desligaria o E2 sem nenhum aviso. Correção: abrir assim só com `NODE_ENV` ∈ {development, test} (a mesma lista fechada da fábrica). Fora disso, negar com 503, ou lançar exceção no construtor.
4. **(fila)** Uma falha na leitura vira 500 genérico e não gera evento de segurança. Recomendo devolver 503 e registrar um evento (`SESSAO_INVALIDA` ou um evento próprio, com motivo de lista fechada) para distinguir uma queda do banco de um ataque.
5. **(fila)** Operações longas que já passaram pelo guard (exportação da clínica, importação, streaming) continuam até o fim com os perfis antigos. Para essas rotas, conferir de novo o perfil ativo dentro da transação do handler, ou em cada lote.
6. **(fila)** No teste `o perfil revogado de uma clínica não afeta o mesmo usuário em outra`, o usuário não tem linha na outra clínica, então o 200 vem da transição. Dar a ele uma linha ativa na outra clínica, para que o teste prove o isolamento da leitura. Faltam também: um teste unitário do guard com `db.run` lançando exceção (prova que fecha), a confirmação de `motivo: 'perfil_revogado'` no evento de log e, se possível, o fundador antigo perdendo o acesso após a correção de fundador.
7. **(fila, desempenho)** O único índice de `clinic_members` é parcial (`WHERE revoked_at IS NULL`), e a consulta nova lê também as linhas revogadas, então tende a varrer a tabela em toda requisição autenticada. Criar um índice não parcial em `(tenant_id, user_id)`. Sob carga, a pressão no pool vira 500, e o acesso continua fechado, mas fica indisponível.
8. **(condição de merge)** Os testes RLS não foram rodados nesta revisão. O merge depende do CI verde em `test/perfil-revogado.rls.test.ts` e nos demais `*.rls.test.ts`.

## Conformidade

- LGPD art. 46 (medidas de segurança) e art. 6º, VII e VIII (segurança e prevenção): a revogação de acesso passa a valer na hora, e não mais só no fim da sessão.
- Minimização (art. 6º, III): a leitura pega só o perfil e a data da revogação. O log leva só ids e um motivo fechado, sem dado pessoal.
- Isolamento por tenant: mantido (a clínica vem da sessão, e a RLS é FORCE).
- Trilha: a concessão e a revogação já são auditadas em `membros.ts`. O guard só lê.

## Nota do Maestro (04/11/2026)

- **R1 (feita):** com qualquer linha no banco, ficam só os perfis da sessão que estão ativos no banco. Teste RLS: uma sessão com `admin` e `recepcao`, mas só `recepcao` registrada, lista pacientes e recebe 403 na listagem de membros.
- **R2 (feita):** a qualificação `psicologo` não é perfil de sessão e não segura ninguém. Com a R1, isso sai de graça. Teste RLS: revogar `profissional` de quem também é psicólogo corta o acesso.
- **R3 (feita):** sem banco injetado fora de dev/test, o guard lança em vez de liberar.
- **R6 (feita):** no teste "outra clínica", o usuário também está registrado na outra clínica, então a decisão passa pela leitura do banco.
- **Fixtures:** 7 sessões de teste que diziam `profissional` e só tinham `psicologo` (ou só `admin`) no banco ganharam o perfil registrado. É o efeito esperado da R1.
- **R4, R5, R7 e R8 (fila):** 503 com evento quando o banco falha, nova checagem em operação longa, testes mais fortes e índice em `(tenant_id, user_id)`.

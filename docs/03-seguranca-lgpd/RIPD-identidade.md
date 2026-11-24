# RIPD: identidade e login da equipe (D4, Better Auth)

> Rascunho do Maestro, 06/11/2026, para o Guardião. Faz parte do PR 3c (R14 e R17 do parecer do desenho do PR 3; R5 do parecer do código do #152). Segue o `RIPD-modelo.md`. As bases legais ainda precisam de confirmação do advogado ⚖️.

## 0. Identificação

| Papel | Quem |
|---|---|
| **Controladora do schema `identidade`** | A plataforma (a conta é da pessoa e serve a várias clínicas). |
| **Controladora do vínculo e da trilha da clínica** | Cada clínica (`clinic_members`, `team_invites`, `audit_log`). |
| **Operadores** | AWS (RDS, ElastiCache, Secrets Manager e KMS, em sa-east-1). |
| **Encarregado (DPO)** | A definir pelos sócios ⚖️ (exigido antes da assinatura da §8). |

## 1. Tratamento

| Item | Descrição |
|---|---|
| **Titulares** | Equipe das clínicas (profissionais, recepção, financeiro, admin). **Não** inclui pacientes; o portal do paciente tem RIPD próprio. |
| **Dados** | E-mail (declarado pelo admin, **não verificado** enquanto não houver provedor de e-mail); nome; hash scrypt da senha; segredo do TOTP, cifrado pela biblioteca com o `BETTER_AUTH_SECRET`; sessões, com IP e user-agent **só em HMAC**; vínculos (ids de pessoa, clínica e papel); tokens de convite e de recuperação (**só SHA-256**); contadores de bloqueio no Redis (chave em HMAC, prazo de até 15 min). |
| **Finalidade** | Autenticar quem acessa o prontuário e os dados das clínicas, com segundo fator obrigatório (CFM 1.821/2007, NGS2; LGPD art. 46). |
| **Base legal (proposta ⚖️, ressalva 2 do parecer do 3c)** | **Plataforma:** legítimo interesse (art. 7º IX), com o teste de balanceamento abaixo; a pessoa da equipe não é parte do contrato entre a plataforma e a clínica, por isso o art. 7º V não cabe. **Clínica:** cumprimento de obrigação legal ou regulatória ao identificar quem acessa o prontuário (art. 7º II; CFM 1.821/2007). O art. 46 é dever de segurança, não base legal. Nada do art. 11 (dado sensível) entra neste schema. |
| **Teste de balanceamento (LI)** | *Finalidade legítima:* garantir que só pessoas autorizadas acessem o prontuário. *Necessidade:* só o mínimo para autenticar (e-mail, nome, credenciais; IP e user-agent só em HMAC). *Expectativa:* a pessoa sabe que o acesso a dado de saúde exige login com segundo fator. *Salvaguardas:* §5. |
| **Onde fica** | Schema `identidade` no RDS (sa-east-1), acessível **só** pelo papel `app_auth`. A clínica (papel `app_user`) não lê nada dele. |

## 2. Compartilhamento e transferência

- **Base de senhas vazadas (Have I Been Pwned):** sai só o **prefixo de 5 hex do SHA-1** da senha nova (k-anonimato, com enchimento). Um prefixo é compartilhado por centenas de senhas e não identifica ninguém. **Não é dado pessoal**, então não há transferência internacional. **Hoje a API não tem saída para a internet** (B2 do parecer do 3c): a conferência falha aberta com o alarme `CONFERENCIA_DE_SENHA_INDISPONIVEL` até os sócios decidirem entre um filtro de saída por domínio (Network Firewall por SNI ou proxy) e abrir a produção sem a conferência, por escrito.
- Nenhum outro terceiro recebe dado de identidade. A telemetria da biblioteca fica desligada.

## 3. Retenção (entra na `matriz-retencao.md`)

| Dado | Prazo | Como |
|---|---|---|
| Sessão | até 15 min sem uso e no máximo 12 h | apagada no logout, no prazo absoluto, no desligamento e no expurgo diário (`identidade-expurgo`) |
| Token de uso único da biblioteca (`verificacao`) | 24 h depois de vencer | expurgo diário |
| Cadastro de TOTP não concluído | 24 h | expurgo diário |
| Token de recuperação | 30 dias depois de vencer | expurgo diário |
| Token de recuperação emitido pelo suporte (`origem = suporte`, B12) | 13 meses (o teto de 2 por pessoa em 12 meses cruza clínicas e só esta tabela o conta) | expurgo diário |
| Ativação do fundador (`ativacao_do_fundador`: hash do token e HMAC do e-mail, B11) | 30 dias depois de vencer ou ser usada; o HMAC do e-mail é zerado na ativação, no bloqueio ou no vencimento | expurgo diário (0079) |
| Ativação **não usada** de clínica nunca ativada (sem `founder_activated` na trilha; A2 do parecer de 17/11, R1 do #205) | **sem prazo**, até a ativação ou o encerramento do contrato: é a pendência que mantém a clínica fora do alcance do fundador. Fica só `usuario_id`, `clinica_id`, `contrato` e o hash do token, com o HMAC do e-mail zerado | o expurgo diário retém e conta (`ativacoesRetidas`); falha ao ler a trilha retém e gera `TRILHA_NAO_LIDA` |
| Convite da equipe (`team_invites`, na clínica) | 30 dias depois do estado final (aceito, revogado ou vencido) | job `convites-descarte` zera o HMAC do e-mail e grava `invite_pseudonym_dropped` na trilha da clínica, na mesma transação do UPDATE (art. 37) |
| Espelho dos convites aceitos (`identidade.convite_aceito`, só ids, 0073) | enquanto houver convite aceito com HMAC vivo naquela clínica (no máximo 30 dias depois do aceite) ou até a anonimização | o trigger apaga a linha quando o `convites-descarte` ou a anonimização zera o HMAC; a anonimização apaga o que restar da pessoa |
| Contadores de bloqueio (Redis) | até 15 min | TTL da janela |
| Senha e TOTP de conta **inativa** (ressalva 4 do parecer do 3c) | **90 dias** depois de a conta ficar inativa | `identidade-expurgo`: apaga senha, TOTP, sessões e tokens pendentes, libera o e-mail e **tira o nome** (art. 16; a autoria está em `professionals` da clínica); marca a conta como `expurgada`. O id fica (histórico clínico), não recebe perfil novo (migração 0072) e a recontratação cria conta nova. Grava `account_credentials_purged` na trilha da clínica de ORIGEM da conta (0067), com ator sistema; a falha da trilha não segura o expurgo (reter seria pior) e gera `TRILHA_NAO_GRAVADA`, contada em `expurgosSemTrilha` |
| Conta (`identidade.usuario`) | **nunca apagada** (R18): o id identifica o autor do prontuário por 20 anos | a pedido do titular, **anonimizada**: e-mail e nome saem; senha, TOTP, sessões e tokens são apagados; o convite aceito pela conta perde o HMAC do e-mail na hora, em toda clínica onde ele ainda existir (pelo espelho `identidade.convite_aceito`); evento `CONTA_ANONIMIZADA` e trilha `account_anonymized` como prova (art. 18 IV e art. 37) |
| Log de segurança | 180 dias | já definido (Marco Civil) |
| Troca do admin único (`identidade.troca_do_admin`, B13, 0082): ids, códigos (`SUP-<n>`, `CTR-<n>`), motivo, estado e operador do `pedir` | **13 meses** a partir do pedido, e só depois do estado final (`concluida`, `contestada`, `cancelada` ou `vencida`), porque o teto de 2 trocas ou recuperações por pessoa em 12 meses só se conta por esta tabela | `identidade-expurgo` (`expurgarTrocasAntigas`); o trigger da 0082 recusa qualquer outro DELETE (FATO) |
| HMAC do e-mail novo na troca | até a emissão do token ou o encerramento | o trigger da 0082 o zera na passagem a `emitida` e a qualquer estado final; a suspensão o mantém, porque a troca pode voltar (FATO) |
| Ativação `origem = 'troca'` | 24 h de validade (CHECK da 0082); depois, a regra da 0079 (30 dias). A exceção A2 da clínica nunca ativada não se aplica | expurgo diário |
| Parâmetros SSM da troca (`/troca-admin/<pedido>` e `.../entrega`) | apagados no uso; `Expiration` de 72 h (pedido) e 24 h (entrega) | tarefa avulsa e SSM |
| Conta antiga **`substituida`** (B13, R5) | **90 dias** depois de ficar `substituida`, como a conta inativa | `identidade-expurgo` passa a aceitar `sem_vinculo` **e** `substituida` (FATO: `provedor.ts` do #239): apaga senha, TOTP, sessões e tokens, libera o e-mail e tira o nome. O id fica pela autoria do prontuário (20 anos) |

### 3.1 Dados e finalidades da troca do admin único (B13)

Desenho: `docs/04-arquitetura/troca-do-admin-unico.md` (v2). Código: PR #239 (migração 0082, `troca-do-admin.ts`, `troca-do-admin-na-api.ts`, `ops/trocar-admin-unico.ts`). Base legal: a mesma do §1 (legítimo interesse da plataforma; obrigação de identificar quem acessa o prontuário, para a clínica). Nada do art. 11.

| Dado | Onde fica | Finalidade | Minimização |
|---|---|---|---|
| **E-mail novo** da pessoa que vira admin | só **HMAC** (uso `ativacao-email`) em `troca_do_admin.email_hmac`; em claro só no SecureString do SSM, apagado no uso | conferir, na ativação, que quem usa o token declara o e-mail pedido | zerado na emissão e no encerramento (FATO: trigger da 0082). Nunca em argumento, ambiente, chamado ou log |
| **Operador do `pedir`** (uuid) | **só** `identidade.troca_do_admin.operador_pedido` e o log de segurança (`TROCA_DO_ADMIN_PEDIDA`) | impedir que a mesma pessoa rode `pedir` e `emitir` (`mesmo_operador`, R4) | **nunca** na trilha da clínica, onde o ator é sempre o sistema (FATO: metadata fechada de `admin_replacement_requested`). A prova continua sendo o CloudTrail |
| **Horários das ligações de viva voz** (`--viva-voz <hora UTC>`) | no chamado `SUP-<n>`; a tarefa só confere o formato e a janela, sem gravar no banco nem no log (FATO) | provar a confirmação pelo telefone do contrato no `pedir` (até 24 h antes) e depois de `libera_em`, no `emitir` (R2) | só a hora; nunca o número do telefone nem o nome de quem atendeu |
| **Conta antiga** marcada `substituida` (ou `suspensa_na_troca`, só com `suspeita_de_invasao` e `--suspender-conta-antiga`) | `identidade.usuario.inativa_por` | impedir que a conta substituída volte a valer ou receba perfil (R5), e alarmar se alguém entrar com ela | `substituida` é definitiva e segue o expurgo de 90 dias (tabela acima). `suspensa_na_troca` volta a valer no cancelamento |

A troca **não** coleta documento: ele é só exibido em vídeo (§5 item 1). O chamado guarda o tipo do documento, sem o número.

A identificação do autor do prontuário (nome e registro profissional) fica na tabela da **clínica** (`professionals`), com a retenção do prontuário, e não depende da conta.

**Decisão (10/11/2026, ressalva 8 da reconferência do #173):** o nome não fica no id expurgado. Ele não é necessário à autoria, que está em `professionals`, e por isso sai junto com o e-mail no expurgo de 90 dias (art. 16). Contas já processadas pelo expurgo antes da decisão perdem o nome na migração 0072.

**Risco residual aceito (ressalva 5 da mesma reconferência):** o token novo de recuperação invalida só os pendentes emitidos pela **mesma** clínica. Assim, o admin de uma clínica não anula o token que outra clínica emitiu para a mesma pessoa. Uma pessoa com vínculo em duas clínicas pode ter, no máximo, um token pendente por clínica, cada um de 15 minutos e de uso único. Quando a pessoa usa um deles, todos os outros pendentes caem.

## 4. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Senha vazada ou fraca | scrypt OWASP; mínimo de 12 caracteres; conferência de vazadas; bloqueio de 5 falhas em 15 min, por e-mail e por origem, com resposta e tempo iguais |
| Roubo do segundo fator | TOTP obrigatório para todo perfil; código não vale de novo; bloqueio do fator; aviso aos admins quando o fator tranca |
| Admin malicioso usa o token | Nenhum token restaura os dois fatores (R1); o convite só cria vínculo na clínica dele (R2); o aceite de conta existente pede login completo |
| **E-mail declarado pelo admin (não verificado, R17)** | A conta guarda a clínica e o convite de origem. A pessoa vê a lista das próprias clínicas. Há procedimento de disputa (§5). Quando houver provedor de e-mail, a verificação passa a ser obrigatória, inclusive para as contas antigas. **O contrato com a clínica diz que o admin responde pelo e-mail que declara e pela entrega dos tokens fora da plataforma.** |
| Quem usa o token percebe se a conta já existe (R18) | Aceito: o aceite muda de modo (conta nova ou login completo). Só quem tem o token percebe, e o token é entregue a uma pessoa determinada. |
| Rotação do `BETTER_AUTH_SECRET` invalida o TOTP de todos (R9 do #152) | Segredos versionados antes de abrir produção (3c) |
| Proxy mal configurado faz todos parecerem uma origem só | `HTTP_TRUST_PROXY_HOPS` conferido no staging (3c) |
| **Troca do admin único sem e-mail (B13, R2 do parecer de 24/11):** sem provedor de e-mail, o titular legítimo não recebe o "não fui eu" no e-mail antigo e só pode contestar pelo contrato ou pelo app | confirmação de viva voz obrigatória, pela ligação de retorno ao telefone do contrato, no `pedir` e de novo antes do `emitir`; aviso escrito ao signatário; aviso no app da conta antiga; janela de 48 h; o login da conta antiga suspende a troca (`docs/04-arquitetura/troca-do-admin-unico.md`). **Risco aceito até a D3** (§8) |
| **Golpe de engenharia social na troca do admin (B13):** alguém se passa pelo admin ou pelo signatário para tomar a clínica | só pelo canal do contrato; escrito do signatário; documento exibido em vídeo; viva voz duas vezes; janela de 48 h; três pessoas nossas (DPO fora da conta); teto somado com o B12 (1 por clínica em 30 dias, 2 por pessoa em 12 meses); contestação no app; o login da conta antiga suspende. Residual: **alto impacto e baixa probabilidade (ESTIMATIVA, sem medição)**; o DPO assina no §8 |
| **Conta antiga com vínculo em outras clínicas (B13, P4)** | a troca revoga só o vínculo **desta** clínica; as outras **não** são avisadas (cada clínica é controladora do próprio vínculo, §0). A conta só vira `substituida` quando cai o último vínculo; até lá, segue ativa lá e, se entrar, o login dispara `CONTA_SUBSTITUIDA_ENTROU` (crítico) e `replaced_account_login` na trilha da clínica da troca. Lá, o caminho da pessoa é o §5 item 1 (convite novo para o e-mail novo) |
| **`suspeita_de_invasao` usada por golpista (B13, P2)** | tira o titular legítimo por até a janela inteira. Hoje só com `--suspender-conta-antiga` e o motivo certo (CHECK da 0082), e o runbook exige a decisão do DPO no chamado. Decisão final com os sócios (§8) |

## 5. Procedimentos de suporte (fora da API, com trilha)

1. **Perdeu senha e fator ao mesmo tempo:** nenhum admin resolve sozinho (R1). O suporte confere a identidade (documento **apenas exibido**, nunca copiado nem guardado, e confirmação pelo admin da clínica de origem) e a pessoa recebe um convite **novo**, com **outro e-mail**. O histórico clínico continua no id antigo. O e-mail antigo só é liberado pela disputa (item 3).
2. **Anonimização a pedido do titular (B10):** o pedido chega ao DPO, que confere a identidade e responde ao titular. O suporte roda o comando operacional como tarefa avulsa do ECS (grupo IAM nominal `ops-lgpd` com MFA, duas pessoas, chamado `LGPD-<n>`), sem rota pública, conforme o [runbook](../04-arquitetura/runbook-anonimizacao-pelo-suporte.md). Prazo interno de **15 dias corridos** do recebimento, enquanto a ANPD não regulamentar o art. 18 §5. A resposta diz o que fica e por quê (id da conta para a autoria do prontuário por 20 anos; nome e registro em cada clínica, que é a controladora; eventos do log até 180 dias), e as clínicas com vínculo são avisadas (art. 18 §6).
3. **Disputa de e-mail (R17):** quando alguém diz que o e-mail da conta é dele, a conta fica **suspensa durante a investigação**. O suporte confere com as clínicas de origem, desativa a conta indevida (sem apagar o histórico), libera o e-mail e registra o resultado na trilha das clínicas envolvidas.
4. **Sem vínculo em nenhuma clínica e sem senha (R13 do código do 3b-2):** a recuperação pelo admin exige vínculo ativo na clínica dele (R16), então quem foi desligado de todas e perdeu a senha não tem admin que o atenda. Se a pessoa volta a trabalhar numa clínica **antes dos 90 dias**, a conta antiga ainda guarda o e-mail, e o convite para ele pede a senha e o TOTP que ela perdeu: o convite vai para **outro e-mail** e o histórico continua no id antigo (como no item 1). **Depois dos 90 dias**, o expurgo libera o e-mail e o convite para ele cria conta nova. Se a pessoa só precisa exercer um direito do art. 18 sobre a conta antiga, o pedido vai ao DPO pelo procedimento 2.
5. **Ordem judicial (Marco Civil, art. 22):** o IP fica só em HMAC. O suporte entrega o que há (sessões e eventos do período, com a origem em HMAC). Se a ordem trouxer IPs, o suporte calcula o HMAC de cada um e compara. O IP em claro nunca é guardado.
6. **Fundador da clínica (B11):** depois do contrato `CTR-<n>` assinado, a nossa equipe provisiona a clínica pelo comando operacional (o e-mail entra por parâmetro cifrado do SSM e fica só em HMAC). O token de ativação é entregue fora de banda por **outra pessoa**. A ativação abre a sessão de cadastro pendente de 15 min. O importador só roda depois de confirmar que foi o fundador quem ativou. Desenho e parecer: `docs/04-arquitetura/provisionamento-da-clinica.md`.
7. **Admin único que perdeu o fator (B12):** só quando não há outro admin com fator. O suporte confere a identidade pelo contrato (o próprio dono da conta, ligação de retorno ao telefone cadastrado antes do pedido, log de segurança da conta olhado antes) e emite, pelo comando operacional, um token só de **fator**, de 24 h, entregue por outra pessoa. Teto: 1 por clínica em 30 dias e 2 por pessoa em 12 meses. As sessões caem em todo motivo, menos a troca planejada de aparelho. Runbook: `docs/04-arquitetura/runbook-recuperacao-admin-unico.md`.
8. **Admin único que perdeu senha e fator (B13):** nenhum token restaura os dois. Conta **nova**, com **outro** e-mail (o antigo nunca é reaproveitado), ativada pelo token de uso único do provisionamento (item 6, `origem = 'troca'`, 24 h). Desenho: `docs/04-arquitetura/troca-do-admin-unico.md`; runbook: `docs/04-arquitetura/runbook-troca-do-admin-unico.md`. Medidas (FATO no #239, salvo onde dito):
   - **Viva voz duas vezes [R2]:** ligação de retorno ao telefone do contrato cadastrado antes do chamado, no `pedir` (hora de até 24 h antes) e de novo **depois** de `libera_em`, antes do `emitir`. Sem ela, `viva_voz_ausente`.
   - **Dois operadores mais o entregador [R4, P3]:** quem roda o `emitir` não pode ser quem rodou o `pedir` (`mesmo_operador`); o entregador é uma terceira pessoa e o DPO não conta como nenhuma delas.
   - **Janela de 48 h:** CHECK `libera_em >= pedido_em + 48 h`; o banco só aceita `emitida` depois dela. Corridas ou com um dia útil é P1 (§8).
   - **Suspensão pelo login:** um login completo da conta antiga durante a troca a passa a `suspensa` (`TROCA_DO_ADMIN_SUSPENSA`, crítico); o DPO decide.
   - **Alarme da conta substituída [R5]:** depois da conclusão, a senha certa ou o login completo da conta antiga gera `CONTA_SUBSTITUIDA_ENTROU` (crítico, ao DPO) e `replaced_account_login` na trilha da clínica. É incidente.
   - **Trigger de transições [R3]:** só o grafo do desenho; `emitida` só pelo provisionamento e depois da janela; `ativada` e `concluida` só pela API; `concluida` só com o TOTP da conta nova confirmado **[R1]**. A conta nova só nasce na transação que consome a ativação dela (trigger `usuario_novo_da_troca`).
   - **Conclusão [R1]:** o vínculo antigo só é revogado quando a conta nova confirma o TOTP; a conta nova recebe **só** admin **[P8]**; as sessões e os tokens pendentes da conta antiga caem.

## 5a. Controles e evidências (art. 38; ressalva 3 do parecer do 3c)

| Controle | Evidência |
|---|---|
| Acesso só pelo papel `app_auth` | migração 0064 e teste RLS "app_user não lê o schema identidade" |
| Senha forte e conferida | `senha.ts` (scrypt N=2^16), `senha-vazada.ts` e testes |
| Segundo fator obrigatório e bloqueio | `protecao.ts` e testes de bloqueio, rajada e reuso |
| Nenhum token restaura os dois fatores | testes da recuperação (3b-2) |
| Clínica nova nasce com o fundador; sem fundador, só pelo papel de migração (G3 do parecer do #207) | migração 0081 (`tenants_founder_guard`) e teste RLS "G3 do #207 (0081)": `app_user` (sessão de sistema e de usuário), `app_auth` e `app_provisionamento` recebem 42501 |
| Retenção | job `identidade-expurgo`, com alarme (`jobs.tf`) |
| Segredos fora do git, com rotação | Terraform (`dados.tf`, `api-ambiente.tf`) e runbook `docs/04-arquitetura/runbook-rotacao-better-auth.md` |
| Prova do atendimento ao titular | evento `CONTA_ANONIMIZADA` (com o chamado e o operador) e trilha `account_anonymized` em cada clínica (ator sistema, com o chamado; nunca o operador) |
| Troca do admin único só pelo grafo de estados, conclusão só com o TOTP da conta nova, conta nova só pela ativação (B13, R1 e R3) | migração 0082 (`troca_do_admin_transicao`, `usuario_novo_da_troca`) e `test/troca-do-admin-unico.rls.test.ts` (transição inválida, INSERT do uuid reservado e conclusão sem TOTP recusados com 42501) |
| Viva voz e dois operadores (B13, R2 e R4) | `troca-do-admin.ts` e `troca-do-admin.test.ts` (`viva_voz_ausente`, `mesmo_operador`), `ops/trocar-admin-unico.test.ts`; CloudTrail do `ecs:RunTask` com o `SourceIdentity` de cada pessoa |
| Operador fora da trilha da clínica (B13, R4) | metadata fechada de `admin_replacement_requested` e teste RLS que a compara por igualdade; lista em `test/cobertura-auditoria/lista.ts` |
| Retenção da troca e da conta substituída (B13) | `identidade-expurgo`: `expurgarTrocasAntigas` (13 meses, só troca encerrada) e expurgo de 90 dias com `substituida`; HMAC do e-mail zerado pelo trigger; guarda dos privilégios em `test/guarda-papeis.rls.test.ts` |
| Atendimento ao titular executável (B10) | `apps/api/src/ops/anonimizar-conta.ts`, testes do comando e da bancada RLS (idempotência, conta inexistente, falha parcial), CloudTrail do `ecs:RunTask` |

## 6. Conclusão (proposta)

O risco residual é aceitável **depois** do checklist do 3c: segredos versionados, egresso, proxy, TLS verificado e contrato. Revisar quando houver provedor de e-mail.

## 8. Risco residual e assinaturas (ressalva 3)

| Risco residual | Aceito por | Data |
|---|---|---|
| E-mail declarado pelo admin, sem verificação (R17) | encarregado e sócios | _pendente_ |
| Conferência de senha vazada desligada até a decisão do egresso (B2) | sócios | _pendente_ |
| Quem entrega o token de ativação conhece o token e o e-mail e poderia ativar no lugar do fundador (B11, R3) | encarregado | _pendente_ |
| O `--operador` do comando do suporte é declarado; a prova é o CloudTrail (B12) | encarregado | _pendente_ |
| Clínica criada à mão pelo `app_migrator` (único caminho sem fundador, 0081) não grava `tenant_create` na trilha (R2 do parecer do #208). **Antes da primeira clínica real:** toda criação manual por esse papel registra o chamado e o operador nominal (CloudTrail da tarefa de migração) | encarregado | _pendente_ |
| Troca do admin único (B13) sem provedor de e-mail: o "não fui eu" não chega ao e-mail antigo, e a contestação depende do contrato (com viva voz obrigatória no `pedir` e antes do `emitir`) e do app (R2 do parecer de 24/11). Vale **até a D3**: com o provedor, o aviso ao e-mail antigo entra como canal | encarregado e sócios | _pendente_ |
| Golpe de engenharia social contra o suporte na troca do admin (B13): alto impacto, baixa probabilidade (ESTIMATIVA), com as medidas do §5 item 8 | encarregado | _pendente_ |
| Conta antiga com vínculo em outras clínicas segue ativa lá depois da troca, sem aviso entre clínicas (B13, P4, decisão do Guardião) | encarregado | _pendente_ |
| **Decisões dos sócios pendentes (B13)**, com o padrão do código até lá: **P1** janela de 48 h corridas (recomendação: com pelo menos um dia útil inteiro); **P2** suspender a conta antiga no `pedir` com `suspeita_de_invasao` (padrão: só com `--suspender-conta-antiga` e a decisão do DPO no chamado); **P5** quem indica o admin novo quando o signatário saiu ou faleceu (recomendação: só o representante legal com poderes comprovados; depende do advogado, D8); **P6** quem decide a reversão depois da conclusão (recomendação: DPO e os dois sócios, com as sessões da conta nova suspensas até a decisão) | sócios | _pendente_ |
| O papel `app_provisionamento` pode abrir o contexto de qualquer clínica e ler `tenants`, `clinic_members` e `audit_log` dela (O1 do parecer do #207); não chega a paciente, prontuário nem financeiro. Portão: IAM da tarefa com duas pessoas e MFA | encarregado | _pendente_ |

Assinatura do encarregado: _pendente_ (exigida antes da abertura de produção, B5).

## 9. Revisões

| Data | Mudança |
|---|---|
| 2026-11-06 | Rascunho (Maestro). |
| 2026-11-08 | Ressalvas 2 a 6 do parecer do 3c parcial: base legal, §0, controles, prazo da credencial de conta inativa, egresso, suporte e ordem judicial. |
| 2026-11-17 | G3 do parecer do #207 fechada pela 0081: sai do §8 o risco aceito "clínica sem fundador criada na sessão de sistema sem trilha"; o controle entra no §5a. |
| 2026-11-24 | R2 do parecer do desenho do B13: o risco da troca do admin único sem provedor de e-mail entra no §4 e no §8, aceito até a D3. |
| 2026-11-24 | Troca do admin único (B13), conforme o desenho v2, o parecer de 24/11 e o código do #239 (0082): retenção e dados da troca (§3 e §3.1: e-mail novo só em HMAC, operador do `pedir` só no schema identidade, horas de viva voz só no chamado, conta `substituida` com expurgo em 90 dias); riscos de engenharia social, de vínculo em outras clínicas e de `suspeita_de_invasao` (§4); medidas do §5 item 8; controles e evidências (§5a); riscos aceitos e P1, P2, P5 e P6 pendentes dos sócios (§8). Os itens "dados" e "retenção" do pedido ficam no §3 e no §3.1, e os controles no §5a, pela numeração deste RIPD. |

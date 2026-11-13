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
| Convite da equipe (`team_invites`, na clínica) | 30 dias depois do estado final (aceito, revogado ou vencido) | job `convites-descarte` zera o HMAC do e-mail |
| Espelho dos convites aceitos (`identidade.convite_aceito`, só ids, 0073) | enquanto houver convite aceito com HMAC vivo naquela clínica (no máximo 30 dias depois do aceite) ou até a anonimização | o trigger apaga a linha quando o `convites-descarte` ou a anonimização zera o HMAC; a anonimização apaga o que restar da pessoa |
| Contadores de bloqueio (Redis) | até 15 min | TTL da janela |
| Senha e TOTP de conta **inativa** (ressalva 4 do parecer do 3c) | **90 dias** depois de a conta ficar inativa | `identidade-expurgo`: apaga senha, TOTP, sessões e tokens pendentes, libera o e-mail e **tira o nome** (art. 16; a autoria está em `professionals` da clínica); marca a conta como `expurgada`. O id fica (histórico clínico), não recebe perfil novo (migração 0072) e a recontratação cria conta nova |
| Conta (`identidade.usuario`) | **nunca apagada** (R18): o id identifica o autor do prontuário por 20 anos | a pedido do titular, **anonimizada**: e-mail e nome saem; senha, TOTP, sessões e tokens são apagados; o convite aceito pela conta perde o HMAC do e-mail na hora, em toda clínica onde ele ainda existir (pelo espelho `identidade.convite_aceito`); evento `CONTA_ANONIMIZADA` e trilha `account_anonymized` como prova (art. 18 IV e art. 37) |
| Log de segurança | 180 dias | já definido (Marco Civil) |

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

## 5. Procedimentos de suporte (fora da API, com trilha)

1. **Perdeu senha e fator ao mesmo tempo:** nenhum admin resolve sozinho (R1). O suporte confere a identidade (documento **apenas exibido**, nunca copiado nem guardado, e confirmação pelo admin da clínica de origem) e a pessoa recebe um convite **novo**, com **outro e-mail**. O histórico clínico continua no id antigo. O e-mail antigo só é liberado pela disputa (item 3).
2. **Anonimização a pedido do titular (B10):** o pedido chega ao DPO, que confere a identidade e responde ao titular. O suporte roda o comando operacional como tarefa avulsa do ECS (grupo IAM nominal `ops-lgpd` com MFA, duas pessoas, chamado `LGPD-<n>`), sem rota pública, conforme o [runbook](../04-arquitetura/runbook-anonimizacao-pelo-suporte.md). Prazo interno de **15 dias corridos** do recebimento, enquanto a ANPD não regulamentar o art. 18 §5. A resposta diz o que fica e por quê (id da conta para a autoria do prontuário por 20 anos; nome e registro em cada clínica, que é a controladora; eventos do log até 180 dias), e as clínicas com vínculo são avisadas (art. 18 §6).
3. **Disputa de e-mail (R17):** quando alguém diz que o e-mail da conta é dele, a conta fica **suspensa durante a investigação**. O suporte confere com as clínicas de origem, desativa a conta indevida (sem apagar o histórico), libera o e-mail e registra o resultado na trilha das clínicas envolvidas.
4. **Sem vínculo em nenhuma clínica e sem senha (R13 do código do 3b-2):** a recuperação pelo admin exige vínculo ativo na clínica dele (R16), então quem foi desligado de todas e perdeu a senha não tem admin que o atenda. Se a pessoa volta a trabalhar numa clínica **antes dos 90 dias**, a conta antiga ainda guarda o e-mail, e o convite para ele pede a senha e o TOTP que ela perdeu: o convite vai para **outro e-mail** e o histórico continua no id antigo (como no item 1). **Depois dos 90 dias**, o expurgo libera o e-mail e o convite para ele cria conta nova. Se a pessoa só precisa exercer um direito do art. 18 sobre a conta antiga, o pedido vai ao DPO pelo procedimento 2.
5. **Ordem judicial (Marco Civil, art. 22):** o IP fica só em HMAC. O suporte entrega o que há (sessões e eventos do período, com a origem em HMAC). Se a ordem trouxer IPs, o suporte calcula o HMAC de cada um e compara. O IP em claro nunca é guardado.

## 5a. Controles e evidências (art. 38; ressalva 3 do parecer do 3c)

| Controle | Evidência |
|---|---|
| Acesso só pelo papel `app_auth` | migração 0064 e teste RLS "app_user não lê o schema identidade" |
| Senha forte e conferida | `senha.ts` (scrypt N=2^16), `senha-vazada.ts` e testes |
| Segundo fator obrigatório e bloqueio | `protecao.ts` e testes de bloqueio, rajada e reuso |
| Nenhum token restaura os dois fatores | testes da recuperação (3b-2) |
| Retenção | job `identidade-expurgo`, com alarme (`jobs.tf`) |
| Segredos fora do git, com rotação | Terraform (`dados.tf`, `api-ambiente.tf`) e runbook `docs/04-arquitetura/runbook-rotacao-better-auth.md` |
| Prova do atendimento ao titular | evento `CONTA_ANONIMIZADA` (com o chamado e o operador) e trilha `account_anonymized` em cada clínica (ator sistema, com o chamado; nunca o operador) |
| Atendimento ao titular executável (B10) | `apps/api/src/ops/anonimizar-conta.ts`, testes do comando e da bancada RLS (idempotência, conta inexistente, falha parcial), CloudTrail do `ecs:RunTask` |

## 6. Conclusão (proposta)

O risco residual é aceitável **depois** do checklist do 3c: segredos versionados, egresso, proxy, TLS verificado e contrato. Revisar quando houver provedor de e-mail.

## 8. Risco residual e assinaturas (ressalva 3)

| Risco residual | Aceito por | Data |
|---|---|---|
| E-mail declarado pelo admin, sem verificação (R17) | encarregado e sócios | _pendente_ |
| Conferência de senha vazada desligada até a decisão do egresso (B2) | sócios | _pendente_ |

Assinatura do encarregado: _pendente_ (exigida antes da abertura de produção, B5).

## 9. Revisões

| Data | Mudança |
|---|---|
| 2026-11-06 | Rascunho (Maestro). |
| 2026-11-08 | Ressalvas 2 a 6 do parecer do 3c parcial: base legal, §0, controles, prazo da credencial de conta inativa, egresso, suporte e ordem judicial. |

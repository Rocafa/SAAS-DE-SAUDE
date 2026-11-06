# RIPD: identidade e login da equipe (D4, Better Auth)

> Rascunho do Maestro, 06/11/2026, para o Guardião. Faz parte do PR 3c (R14 e R17 do parecer do desenho do PR 3; R5 do parecer do código do #152). Segue o `RIPD-modelo.md`. As bases legais ainda precisam de confirmação do advogado ⚖️.

## 1. Tratamento

| Item | Descrição |
|---|---|
| **Titulares** | Equipe das clínicas (profissionais, recepção, financeiro, admin). **Não** inclui pacientes; o portal do paciente tem RIPD próprio. |
| **Dados** | E-mail (declarado pelo admin, **não verificado** enquanto não houver provedor de e-mail); nome; hash scrypt da senha; segredo do TOTP, cifrado pela biblioteca com o `BETTER_AUTH_SECRET`; sessões, com IP e user-agent **só em HMAC**; vínculos (ids de pessoa, clínica e papel); tokens de convite e de recuperação (**só SHA-256**); contadores de bloqueio no Redis (chave em HMAC, prazo de até 15 min). |
| **Finalidade** | Autenticar quem acessa o prontuário e os dados das clínicas, com segundo fator obrigatório (CFM 1.821/2007, NGS2; LGPD art. 46). |
| **Base legal (proposta ⚖️)** | Execução de contrato com a clínica (art. 7º V) e segurança do tratamento (art. 46). Nada do art. 11 (dado sensível) entra neste schema. |
| **Onde fica** | Schema `identidade` no RDS (sa-east-1), acessível **só** pelo papel `app_auth`. A clínica (papel `app_user`) não lê nada dele. |

## 2. Compartilhamento e transferência

- **Base de senhas vazadas (Have I Been Pwned):** sai só o **prefixo de 5 hex do SHA-1** da senha nova (k-anonimato, com enchimento). Um prefixo é compartilhado por centenas de senhas e não identifica ninguém. **Não é dado pessoal**, então não há transferência internacional. O egresso fica liberado só para `api.pwnedpasswords.com:443`.
- Nenhum outro terceiro recebe dado de identidade. A telemetria da biblioteca fica desligada.

## 3. Retenção (entra na `matriz-retencao.md`)

| Dado | Prazo | Como |
|---|---|---|
| Sessão | até 15 min sem uso e no máximo 12 h | apagada no logout, no prazo absoluto, no desligamento e no expurgo diário (`identidade-expurgo`) |
| Token de uso único da biblioteca (`verificacao`) | 24 h depois de vencer | expurgo diário |
| Cadastro de TOTP não concluído | 24 h | expurgo diário |
| Token de recuperação | 30 dias depois de vencer | expurgo diário |
| Convite da equipe (`team_invites`, na clínica) | **a definir (R3 do 3b-1):** proposta de 30 dias depois do estado final | job por clínica (fila) |
| Contadores de bloqueio (Redis) | até 15 min | TTL da janela |
| Conta (`identidade.usuario`) | **nunca apagada** (R18): o id identifica o autor do prontuário por 20 anos | a pedido do titular, **anonimizada**: e-mail e nome saem; senha, TOTP, sessões e tokens são apagados; evento `CONTA_ANONIMIZADA` e trilha `account_anonymized` como prova (art. 18 IV e art. 37) |
| Log de segurança | 180 dias | já definido (Marco Civil) |

A identificação do autor do prontuário (nome e registro profissional) fica na tabela da **clínica** (`professionals`), com a retenção do prontuário, e não depende da conta.

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

1. **Perdeu senha e fator ao mesmo tempo:** nenhum admin resolve sozinho (R1). O suporte confere a identidade (documento e confirmação pelo admin da clínica de origem) e a pessoa recebe um convite **novo**, com **outro e-mail**. O histórico clínico continua no id antigo. O e-mail antigo só é liberado pela disputa (item 3).
2. **Anonimização a pedido do titular:** o pedido chega ao DPO. O suporte roda `anonimizarConta` (sem rota pública), registra o pedido e guarda a prova (evento e trilha). O prazo é o do art. 19.
3. **Disputa de e-mail (R17):** quando alguém diz que o e-mail da conta é dele, o suporte confere com as clínicas de origem, desativa a conta indevida (sem apagar o histórico) e libera o e-mail.
4. **Sem vínculo em nenhuma clínica (R13 do 3b-2):** a recuperação pelo admin não alcança. Vale o item 1.

## 6. Conclusão (proposta)

O risco residual é aceitável **depois** do checklist do 3c: segredos versionados, egresso, proxy, TLS verificado e contrato. Revisar quando houver provedor de e-mail.

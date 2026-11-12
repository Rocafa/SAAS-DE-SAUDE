# Prontidão para produção (segurança e LGPD)

> Quadro único de aprovação. Atualizado em 04/11/2026 pelo Maestro, a partir de três revisões internas feitas no mesmo dia. Cada linha aponta para o relatório com arquivo e linha.

## Veredito de 04/11/2026: **NÃO PRONTO para dado real**

O desenho de segurança está bom e foi elogiado nas três revisões. Os pontos fortes:
- isolamento por clínica no banco (RLS);
- trilha encadeada em toda rota;
- criptografia de campo;
- sigilo da psicologia e do adolescente;
- MFA na política;
- nenhum log com dado pessoal.

O que falta são peças que **ainda não existem**: o login real, a ligação do site com a API e a infraestrutura. Até lá, o site sobe só em modo demonstração, e as travas do build e da fábrica de autenticação garantem isso.

| Superfície | Relatório | Veredito |
|---|---|---|
| Paciente (portal no site e no app/PWA, rotas `/portal`) | [revisao-interna-pacientes](revisoes/2026-11-04-revisao-interna-pacientes.md) | NÃO PRONTO |
| Profissional (telas da clínica no site e no app, rotas da equipe) | [revisao-interna-profissionais](revisoes/2026-11-04-revisao-interna-profissionais.md) | NÃO PRONTO |
| Propostas (PRs, issues e processo de CI) | [propostas-prs-issues](revisoes/2026-11-04-propostas-prs-issues.md) | PRONTO COM CONDIÇÕES |
| Logs de segurança | [logs-de-seguranca](logs-de-seguranca.md) | Feito em 04/11 (log estruturado e trava de PR) |

## Bloqueios para produção

| Id | O quê | Público | Depende de | Situação |
|---|---|---|---|---|
| P1 / E1 | Login real com sessão no servidor, cookie `__Host-`, CSRF e MFA de verdade (#107, #106) | ambos | **D4** (@Lopesloro no #36) | parado |
| P2 | Envio real do código por SMS/WhatsApp, com texto neutro (sem o nome da clínica) | paciente | provedor de SMS e contrato | parado |
| P3 | "Sair" no portal (rota e botão) | paciente | D4 (sessão real) | parado |
| P4 / E11 | Eventos de login, falha, bloqueio, logout e troca de credencial no log e na trilha | ambos | D4 (o formato já está pronto: `log-de-seguranca.ts`) | parcial |
| P5 | Testes RLS do portal verdes no CI do commit do deploy | paciente | CI | conferir no deploy |
| E2 | Revogar perfil não corta a sessão aberta: o guard confia nos perfis do provedor | profissional | — | **feito** (#130; conferência total com a D4) |
| E3 | Desligar funcionário (tirar todos os perfis e encerrar todas as sessões) | profissional | D4 para o logout global | parcial: com o E2, revogar todos os perfis já tira todo o acesso |
| E4 | Site ligado à API em todas as telas (hoje só pacientes e agenda) | profissional | front (@Lopesloro, #86) | parado |
| E5 | Expiração por inatividade (15 min) no servidor e no cliente | ambos | D4 (servidor) e front | parado |
| L1 / L2 | Proteção da main: exigir aprovação, revisão do CODEOWNERS e `enforce_admins` | processo | — | **feito em 05/11** (OK de @Rocafa): 1 aprovação de dono do código, aprovação cai com push novo, vale para admin, conversas resolvidas |
| L4 | E2E e scan de imagem (Trivy) obrigatórios para o merge | processo | devops-ci | **não aplicado:** os dois workflows têm filtro de caminho e não rodam em todo PR; exigidos assim, travariam os PRs que não tocam web/imagem. Precisam de um job "sempre roda" que passe quando o filtro pula |
| E6 | CSRF: a API aceitava formulário e não conferia a origem | ambos | — | **feito** (#132: 415 para corpo não-JSON, 403 para origem fora da allowlist; cookie `__Host-`/`SameSite=Strict` vem com a D4) |
| E8 | MFA recente nas rotas de poder | profissional | — | **feito** (#131, 33 rotas; #133, aviso ao desmarcar área sensível) |
| E12 | Alerta de vínculo cruzado (conluio entre profissionais, R6 do #61) | profissional | — | **feito** (#134) |
| E10 | A clínica consulta a própria trilha | profissional | — | **feito** (#135, `GET /clinica/auditoria`; alerta de anomalia como aviso aos admins no #137) |
| L5 | Checagem automática de dado pessoal nos logs da API | processo | — | **feito em 04/11** |
| — | Revisão EXTERNA (pentest e auditoria independentes) | ambos | staging (AWS) e D4 | [pacote pronto](revisao-externa.md) |
| — | Parecer jurídico D8 (adolescentes, guarda do prontuário, Marco Civil art. 15) | ambos | advogado | parado |

Os itens "Antes do piloto" (P6 a P11, E6 a E14, L6 a L12) estão nos relatórios. Nenhum deles impede a demonstração, mas todos precisam estar resolvidos antes do primeiro dado real.

## Regra de aprovação

Só vai para produção com dado real quando:
1. todo bloqueio acima estiver resolvido, com o PR e o parecer do Guardião citados nesta tabela;
2. a revisão externa estiver sem achado crítico ou alto em aberto;
3. os dois sócios assinarem esta página, com data e o commit do deploy.

| Sócio | Data | Commit | Assinatura |
|---|---|---|---|
| @Rocafa | | | |
| @Lopesloro | | | |

## Checklist da abertura do login real (D4, 3c; B6 do parecer do 3c parcial)

Cada linha precisa de evidência e do PR. A produção só abre com todas as linhas "antes" fechadas e com o parecer final do Guardião.

| # | Item | Quando | Situação | PR / evidência |
|---|---|---|---|---|
| B1 | Segredos versionados, runbook e Terraform | antes | **feito no código**; falta provar no staging | #162 (`segredos.ts`, `segredos.test.ts`, `runbook-rotacao-better-auth.md`) |
| B2 | Saída para a base de senhas vazadas filtrada por domínio, ou decisão escrita dos sócios | antes | **decisão dos sócios** | — |
| B3 | `HTTP_TRUST_PROXY_HOPS` provado atrás do ALB real (duas origens contam separado) | antes | depende da AWS | — |
| B4 | TLS `verify-full` para `app_user` e `app_auth`, e Redis `rediss://` com AUTH | antes | caminho da CA corrigido; falta provar no staging | #162 |
| B5 | RIPD e contrato: base legal confirmada pelo advogado, cláusula no DPA, §8 assinada pelo encarregado | antes | RIPD e DPA escritos; faltam o advogado e a assinatura | #162 |
| B6 | Este checklist | antes | em andamento | #162 |
| B7 | Pilha na `main` (#149 a #161) e #153 | antes | **aguarda a aprovação do @Lopesloro** | — |
| B9 | Chave dos HMACs separada por uso (HKDF, cinco rótulos), antes do B8 (`docs/04-arquitetura/derivacao-da-chave-de-hmac.md`) | antes | desenho aprovado com ressalvas, falta o código | — |
| B8 | Teste de fumaça no staging com contas fictícias (convite, aceite, TOTP, clínica, rota sensível, logout global, bloqueio, recuperação, desligamento) | antes | depende da AWS | — |
| C1 | CSRF com a sessão real (#132) | antes | coberto pela montagem (403 sem Origin) e pelo `protecaoCsrf`; conferir no B8 | #149 |
| C2 | Eventos do fator (#123 R5) | antes | feito | #152, #156, #159 |
| C3 | Auditoria dos ganchos fora de controller (#117 R6) | antes | feito | #149 |
| D1 | Apagar a credencial de conta inativa em 90 dias | depois, até o primeiro desligamento real | fila | — |
| D2 | Retenção de `team_invites` (30 dias) | depois, em 30 dias | fila | — |
| D3 | Verificação de e-mail obrigatória | quando houver provedor de e-mail | fila | — |

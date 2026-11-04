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
| E2 | Revogar perfil não corta a sessão aberta: o guard confia nos perfis do provedor | profissional | — | **em PR** (perfil revogado no banco sai da sessão; conferência total com a D4) |
| E3 | Desligar funcionário (tirar todos os perfis e encerrar todas as sessões) | profissional | D4 para o logout global | parcial: com o E2, revogar todos os perfis já tira todo o acesso |
| E4 | Site ligado à API em todas as telas (hoje só pacientes e agenda) | profissional | front (@Lopesloro, #86) | parado |
| E5 | Expiração por inatividade (15 min) no servidor e no cliente | ambos | D4 (servidor) e front | parado |
| L1 / L2 | Proteção da main: exigir aprovação, revisão do CODEOWNERS e `enforce_admins` | processo | **OK dos sócios** (configuração do GitHub) | aguardando OK |
| L4 | E2E e scan de imagem (Trivy) obrigatórios para o merge | processo | OK dos sócios | aguardando OK |
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

# D4 — Autenticação
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Engenharia · **Este memo não decide nada.**

**Pergunta:** como os usuários das clínicas fazem login (com MFA e permissões por perfil)?
**Prazo sugerido:** já: é a primeira entrega do M0 · **Urgência:** Alta

## Contexto
Sem login não existe RBAC, MFA, a rota HTTP de exportação (garantia G2) nem qualquer tela de negócio. Os dados de identidade devem ficar no Brasil: Auth0 e Clerk foram descartados por transferência internacional. A rodada 7 trouxe duas opções novas (Zitadel e Better Auth), e as duas pesquisas da rodada recomendaram caminhos diferentes.

## Opções
| Opção | Custo | Esforço e operação | Prós | Contras/riscos |
|---|---|---|---|---|
| A. Login próprio no módulo `auth` | Custo não levantado (tempo de engenharia) | Escrever sessão, MFA, recuperação de conta | Controle total | Erro de segurança em código nosso, em produto com dado de saúde |
| B. Keycloak self-hosted em sa-east-1 | Mais 1 serviço na AWS (custo não levantado) | Servidor Java, banco próprio, atualizações | TOTP, WebAuthn e multi-tenancy maduros | Operação pesada para 2 sócios |
| C. Zitadel self-hosted em sa-east-1 | Mais 1 serviço (custo não levantado) | Menos pesado que o Keycloak | Feito para SaaS B2B (organizações) | Comunidade menor |
| D. Better Auth (biblioteca dentro da API) | Sem serviço extra | Mesma operação da API | Dados no nosso Postgres; plugins de 2FA e organização | Biblioteca nova (v1.7.7, set/2026); integração com NestJS a validar |

## Recomendação dos agentes
Recomendação, não decisão: as duas pesquisas da rodada 7 divergem. Uma recomenda **B ou C** (não escrever login do zero, usar servidor de identidade maduro). A outra recomenda **D** (menos operação), sob quatro condições:
- identidade em schema separado;
- MFA obrigatório para perfis clínicos e para exportação;
- revisão do Guardião;
- sessão e rate limit no Redis.

Ponto comum: **descartar A**. Sugestão: uma prova de conceito de 2 dias com C e D, medindo MFA, vínculo usuário–clínica e recuperação de conta.

## O que trava se adiar
- Todo o M0: RBAC, MFA, rota de exportação com MFA recente (G2), auditoria de leitura.
- Testes E2E de login e o Portão B do piloto.

## Para decidir, falta
Prova de conceito curta; revisão do Guardião LGPD sobre onde ficam os dados de identidade.

## Fontes
- `docs/04-arquitetura/README.md` (linha "Autenticação")
- `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.12 (branch `pesquisa/necessidades-producao`)
- Pesquisa complementar de 10/10/2026 (Context7: `/better-auth/better-auth`, `/keycloak/keycloak`)

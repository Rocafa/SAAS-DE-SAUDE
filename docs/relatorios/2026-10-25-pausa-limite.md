# Pausa por limite de uso — 25/10/2026

> Maestro (sessão @Rocafa). Registro feito perto do limite de uso, conforme a regra do projeto.

## Feito desde o relatório da rodada 26
- **Cursor de paginação assinado** no backend (#73, ce116fe): preso a clínica + usuário + filtro, 10 min; 409 `cursor_invalido` sem dados. Maestro: `test:rls` 609/609, `test:security` 81 ok. Guardião: aprovado com condições (C1 segredos no Terraform; C2 front).
- **#76** passou a paginar por `proximoCursor` (40ba2fe, 223 testes). **#76 entra junto com o #73.**
- **#58** (af8a969): `PAGINATION_CURSOR_KEY` e `RATE_LIMIT_HASH_KEY` como segredos, lista única de variáveis, padrões seguros (importador e WhatsApp desligados), `HTTP_TRUST_PROXY_HOPS=1`, tabela de rotação em `infra-staging.md` §4.5. Não validado com terraform.

## Achado importante
Mesmo com todas as variáveis, a API **não sobe em `NODE_ENV=production`** sem: provedor real de login e de código do portal (**D4**), provedor de chaves KMS (Portão A) e cliente KMS do pseudônimo de suporte. Detalhes no §4.5 do `infra-staging.md` (branch do #58).

## Pendente na retomada
1. Guardião conferir af8a969 (#58) e 40ba2fe (#76).
2. Ressalvas R7–R9 do cursor (ids no log do ALB, segredo aleatório, teste da âncora sumida).
3. Seguem dependendo dos sócios: GitHub Actions (cobrança), D4, D8, D7; @Lopesloro: #75 e conflito #44 × #60.

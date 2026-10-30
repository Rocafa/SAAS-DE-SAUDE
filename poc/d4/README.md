# PoC D4 — Better Auth em NestJS mínimo

PoC para **medir**, não para usar. Fica fora do workspace do pnpm de propósito: tem
lockfile próprio, nada aqui entra em `apps/`, e nenhum segredo é commitado.

Resultado da medição: `docs/00-governanca/memos/D04-autenticacao.md`.

## Rodar

```sh
cp .env.example .env     # POC_DATABASE_URL aponta para um Postgres LOCAL e sintético
# POC_AUTH_SECRET não tem valor padrão: gere com `openssl rand -base64 32`
pnpm --ignore-workspace install
pnpm migrate             # cria as tabelas do Better Auth
pnpm start               # porta 8085
pnpm medir               # uma linha por critério da D4, com o valor observado
```

## O que tem aqui

- `src/auth.ts` — Better Auth com os plugins que os critérios da D4 exigem: `twoFactor`
  (TOTP), `passkey` (WebAuthn), `organization` (clínica), `jwt` (access token de 15 min).
- `src/main.ts` — NestJS mínimo. Monta o Better Auth em `/api/auth/*` e expõe `/whoami`,
  que resolve a clínica **pela sessão** e ignora de propósito o cabeçalho `x-tenant-id`:
  é o equivalente ao `withTenant` da API de verdade.
- `medir.mjs` — roda os critérios por HTTP e imprime o que observou.

## Avisos

- `@better-auth/cli` (dependência de desenvolvimento, usada só para migrar) está em 1.4.21
  enquanto a biblioteca está em 1.7.7, e arrasta uma cópia antiga do `better-auth`. Isso é
  o que deixa o `pnpm audit` vermelho aqui — está medido e registrado no memo.
- Dados sintéticos sempre. Nunca aponte `POC_DATABASE_URL` para banco de produção.

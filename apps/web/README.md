# apps/web

Front-end web em **Next.js (App Router) + Tailwind CSS + shadcn/ui**.

Status: **bootstrap** — Next.js (App Router) + Tailwind v4, página inicial e teste de renderização.

## Escopo

- Painel da clínica (agenda, prontuário, financeiro, faturamento)
- Agendamento online público por clínica/profissional (SSR, SEO)
- Portal do paciente (PWA instalável)

## Regras

- Nenhum segredo em variáveis `NEXT_PUBLIC_*`.
- Dados clínicos nunca em `localStorage`/`sessionStorage`; nada sensível em URLs/query strings.
- Chamadas à API via BFF (route handlers do Next) com cookie `HttpOnly`.
- Tipos e contratos importados de `@plataforma/shared`.
- Ver `docs/04-arquitetura/`.

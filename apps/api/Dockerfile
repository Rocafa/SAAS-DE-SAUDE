# Imagem da API (NestJS). Build a partir da RAIZ do repositório:
#   docker build -f apps/api/Dockerfile -t plataforma-api .
# Rodar a API:        docker run --read-only -e DATABASE_URL=... plataforma-api
# Rodar as migrações: docker run --read-only -e DATABASE_MIGRATOR_URL=... plataforma-api scripts/migrate.mjs
#
# Regras (docs/04-arquitetura/ambientes-e-devops.md, seção "Imagem da API"):
# - bases fixadas por DIGEST (o Dependabot de docker atualiza);
# - nenhum segredo nem ARG sensível: tudo chega por variável de ambiente no runtime (Secrets Manager);
# - usuário 1000:1000, código de propriedade do root (somente leitura), compatível com --read-only;
# - certificado do RDS (sa-east-1) baixado no build com checksum SHA-256 conferido.

# ---------------------------------------------------------------------------------------------
# Estágio 1: build (Node 22 LTS, Debian trixie slim) — compila shared + API e isola só a API.
# ---------------------------------------------------------------------------------------------
FROM node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true
# pnpm 9.12.0 fixado (igual ao "packageManager" do package.json raiz), via corepack.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /repo

# Só o que define as dependências: muda pouco, então o cache desta camada vale entre builds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# Código: só o pacote compartilhado e a API (o .dockerignore barra o resto).
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# O `deploy` do pnpm 9 resolve a API de novo, sem o lockfile, e precisa dos metadados do registro, que o
# `fetch` não guarda: com --offline falha (ERR_PNPM_NO_OFFLINE_META). --prefer-offline usa o store e só busca
# o que faltar. O `install --frozen-lockfile --offline` continua preso ao lockfile.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@plataforma/api..." && \
    pnpm --filter "@plataforma/api..." build && \
    pnpm --filter @plataforma/api deploy --prod --prefer-offline /out && \
    mkdir -p /app && \
    cp -R /out/node_modules /out/package.json /out/dist /out/db /out/scripts /app/

# ---------------------------------------------------------------------------------------------
# Estágio 2: runtime distroless (sem shell, sem gerenciador de pacotes). Entrypoint: node.
# Debian 13: a variante debian12 parou de ser republicada (fev/2026) e ficou com OpenSSL vulnerável.
# ---------------------------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:10747a1323be68f206aed893599d43e6697ad67257e7c42703553f99fbce3d33 AS runtime

# Cadeia de certificados do RDS para sa-east-1 (verify-full no Postgres). Se a AWS trocar o bundle,
# o build falha de propósito: baixe o novo, confira e atualize o checksum aqui.
ADD --checksum=sha256:c2f9255eadfa939dd6f965ede75d8e0d4168c9cbb7ca1e7baa9bff6d5e2c96e1 \
    --chmod=0444 \
    https://truststore.pki.rds.amazonaws.com/sa-east-1/sa-east-1-bundle.pem \
    /etc/ssl/certs/rds-sa-east-1-bundle.pem

ENV NODE_ENV=production \
    API_PORT=3333 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-sa-east-1-bundle.pem

WORKDIR /app
# Arquivos do root e só leitura para o processo: o usuário 1000 não altera o próprio código.
COPY --from=build --chown=0:0 --chmod=0555 /app /app

USER 1000:1000
EXPOSE 3333

# Liveness (não toca o banco). O ECS usa o health check do ALB; este serve ao docker/compose.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["dist/main.js"]

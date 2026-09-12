# syntax=docker/dockerfile:1
#
# Builds and runs apps/server (@katnor/server).
#
# IMPORTANT - build context: same as apps/web/Dockerfile (see the comment
# there) - this is a pnpm workspace monorepo, so pnpm needs the repo root
# (lockfile, pnpm-workspace.yaml, every workspace package) to install and
# build @katnor/server. This Dockerfile must therefore be built with the
# REPO ROOT as its context, e.g.:
#
#   docker build -f apps/server/Dockerfile .
#
# docker-compose.yml sets this service's build context/dockerfile to:
#
#   server:
#     build:
#       context: .
#       dockerfile: apps/server/Dockerfile
#
# TODO(integrate): once `turbo prune @katnor/server --docker` is wired up,
# replace the whole-repo COPY in both stages below with the pruned
# out/json + out/full directories it produces, same TODO as apps/web/Dockerfile.
#
# TODO(integrate): apps/server imports @katnor/db and @katnor/core directly
# from their TypeScript source (both packages' package.json point `main`/
# `types` at `./src/index.ts`, not a built `dist/`) - `tsc`'s own build of
# @katnor/server (this Dockerfile's build step) type-checks fine against
# that, but the COMPILED OUTPUT in dist/ still does `import ... from
# "@katnor/db"`, which Node resolves at runtime the same way: straight to
# the *.ts* source file. Plain `node dist/index.js` cannot execute a raw
# .ts file. Until @katnor/db/@katnor/core gain their own build step (or
# this image runs via `tsx` instead of compiled `dist/`), the CMD below
# will need adjusting - flagged here rather than silently papered over.

# ---- builder ----------------------------------------------------------
FROM node:22-slim AS builder

RUN corepack enable
WORKDIR /repo

# Whole monorepo: pnpm workspaces need the root lockfile/config and every
# workspace package's package.json to resolve and hoist dependencies.
COPY . .

RUN pnpm install --frozen-lockfile=false

# Build @katnor/server and every workspace package it depends on (e.g.
# @katnor/core, @katnor/db). The `...` suffix is turbo/pnpm filter syntax
# for "this package and its dependencies" - see the TODO above about turbo
# prune eventually replacing this with a pruned subset.
RUN pnpm --filter @katnor/server... build

# ---- runtime ------------------------------------------------------------
FROM node:22-slim AS runner

ENV NODE_ENV=production
WORKDIR /repo

# pnpm hoists workspace packages (e.g. @katnor/core, @katnor/db) into
# node_modules as symlinks back into packages/*, so - until turbo prune
# trims this down - the runtime image needs the same repo layout as the
# builder for those symlinks to resolve, not just apps/server/dist on its
# own. See the TODO above about @katnor/db/@katnor/core shipping only
# TypeScript source right now.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/server/dist ./apps/server/dist
COPY --from=builder /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /repo/apps/server/package.json ./apps/server/package.json
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml

WORKDIR /repo/apps/server

# SERVER_PORT is read via src/env.ts (zod-validated) and defaults to 3001
# if unset; docker-compose.yml passes it explicitly today.
ENV SERVER_PORT=3001
EXPOSE 3001

CMD ["node", "dist/index.js"]

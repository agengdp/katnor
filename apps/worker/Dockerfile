# syntax=docker/dockerfile:1
#
# Builds and runs apps/worker (@katnor/worker).
#
# IMPORTANT - build context: this is a pnpm workspace monorepo, so pnpm
# needs the repo root (lockfile, pnpm-workspace.yaml, every workspace
# package) to install and build @katnor/worker. This Dockerfile must
# therefore be built with the REPO ROOT as its context, e.g.:
#
#   docker build -f apps/worker/Dockerfile .
#
# docker-compose.yml sets this service's build context/dockerfile to:
#
#   worker:
#     build:
#       context: .
#       dockerfile: apps/worker/Dockerfile
#
# TODO(integrate): once `turbo prune @katnor/worker --docker` is wired up,
# replace the whole-repo COPY in both stages below with the pruned
# out/json + out/full directories it produces - that keeps only the
# packages @katnor/worker actually depends on and lets the runtime stage
# copy a much smaller tree instead of mirroring pnpm's full symlinked
# node_modules layout.

# ---- builder ----------------------------------------------------------
FROM node:22-slim AS builder

RUN corepack enable
WORKDIR /repo

# Whole monorepo: pnpm workspaces need the root lockfile/config and every
# workspace package's package.json to resolve and hoist dependencies.
COPY . .

RUN pnpm install --frozen-lockfile=false

# Build @katnor/worker and every workspace package it depends on (e.g.
# @katnor/core, @katnor/db). The `...` suffix is turbo/pnpm filter syntax
# for "this package and its dependencies" - see the TODO above about turbo
# prune eventually replacing this with a pruned subset.
RUN pnpm --filter @katnor/worker... build

# ---- runtime ------------------------------------------------------------
FROM node:22-slim AS runner

ENV NODE_ENV=production
WORKDIR /repo

# pnpm hoists workspace packages (e.g. @katnor/core, @katnor/db) into
# node_modules as symlinks back into packages/*, so - until turbo prune
# trims this down - the runtime image needs the same repo layout as the
# builder for those symlinks to resolve, not just apps/worker/dist on its
# own.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/worker/dist ./apps/worker/dist
COPY --from=builder /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=builder /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml

WORKDIR /repo/apps/worker

# No HTTP server here - the worker only holds a pg-boss connection to
# Postgres (DATABASE_URL) and runs the heartbeat/job loop in src/index.ts,
# so there is no port to EXPOSE.
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1
#
# Builds and runs apps/web (@katnor/web).
#
# IMPORTANT - build context: this is a pnpm workspace monorepo, so pnpm
# needs the repo root (lockfile, pnpm-workspace.yaml, every workspace
# package) to install and build @katnor/web. This Dockerfile must therefore
# be built with the REPO ROOT as its context, e.g.:
#
#   docker build -f apps/web/Dockerfile .
#
# docker-compose.yml sets this service's build context/dockerfile to:
#
#   web:
#     build:
#       context: .
#       dockerfile: apps/web/Dockerfile
#
# TODO(integrate): once `turbo prune @katnor/web --docker` is wired up,
# replace the whole-repo COPY in both stages below with the pruned
# out/json + out/full directories it produces - that keeps only the
# packages @katnor/web actually depends on and lets the runtime stage copy
# a much smaller tree instead of mirroring pnpm's full symlinked
# node_modules layout.

# ---- builder ----------------------------------------------------------
FROM node:22-slim AS builder

RUN corepack enable
WORKDIR /repo

# Whole monorepo: pnpm workspaces need the root lockfile/config and every
# workspace package's package.json to resolve and hoist dependencies.
COPY . .

RUN pnpm install --frozen-lockfile=false

# Build @katnor/web and every workspace package it depends on (e.g.
# @katnor/core). The `...` suffix is turbo/pnpm filter syntax for "this
# package and its dependencies" - see the TODO above about turbo prune
# eventually replacing this with a pruned subset.
RUN pnpm --filter @katnor/web... build

# ---- runtime ------------------------------------------------------------
FROM node:22-slim AS runner

ENV NODE_ENV=production
WORKDIR /repo

# pnpm hoists workspace packages (e.g. @katnor/core) into node_modules as
# symlinks back into packages/*, so - until turbo prune trims this down -
# the runtime image needs the same repo layout as the builder for those
# symlinks to resolve, not just apps/web/build on its own.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/web/build ./apps/web/build
COPY --from=builder /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /repo/apps/web/package.json ./apps/web/package.json
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml

WORKDIR /repo/apps/web

# adapter-node reads HOST/PORT from the environment. docker-compose sets
# PORT: ${WEB_PORT:-3000} alongside WEB_PORT for this service so the
# published port mapping (which is keyed off WEB_PORT) matches the port the
# Node process inside the container actually listens on. The ENV PORT below
# is just the image-level default for running this container outside compose.
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

CMD ["node", "build/index.js"]

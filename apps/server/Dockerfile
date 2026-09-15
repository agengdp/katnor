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
# Why this runs via `tsx` instead of `node dist/index.js`: every internal
# workspace package @katnor/server depends on (@katnor/core, @katnor/db,
# @katnor/agents, @katnor/artifacts, @katnor/knowledge, ...) has its
# package.json `main`/`types` pointing straight at `./src/index.ts` - none
# of them has a `build` script of its own (only `tsc --noEmit` for type
# checking). `tsc -p tsconfig.json` below still compiles @katnor/server's
# own src/ to dist/ (a real, useful type-check gate that fails this image
# build on a type error) but the emitted JS's `import ... from
# "@katnor/db"` resolves, at runtime, straight through to that raw .ts
# file - which plain `node` cannot execute at all ("Unknown file
# extension .ts"). Rather than retrofit a build step onto every one of
# those packages (unverifiable in the environment this was written in -
# no registry access to actually run any of those builds), the runtime
# stage instead runs the exact same way `dev` already does and is known
# to work: `tsx` against the TypeScript source directly, dist/ discarded.
# `tsx` itself needs no extra step to end up in the runtime image - it's
# already a devDependency of @katnor/server, and the builder's `pnpm
# install` (no `--prod`) installs it into `apps/server/node_modules`,
# which the runtime stage copies wholesale below.

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

# git is needed at runtime: the dashboard's wiki editor (apps/server's
# knowledge router) writes and commits pages directly via
# @katnor/knowledge's wikiStorage.ts, which shells out to `git` - see
# apps/worker/Dockerfile's identical comment (both processes share the
# same `wiki-data` volume in docker-compose.yml).
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# pnpm hoists workspace packages (e.g. @katnor/core, @katnor/db) into
# node_modules as symlinks back into packages/*, so - until turbo prune
# trims this down - the runtime image needs the same repo layout as the
# builder for those symlinks to resolve. `apps/server/src` (not `dist`) is
# what actually runs - see the module comment above for why - `dist` is
# left out of this image entirely; it only existed as a build-time
# type-check gate in the builder stage.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/server/src ./apps/server/src
COPY --from=builder /repo/apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY --from=builder /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /repo/apps/server/package.json ./apps/server/package.json
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /repo/tsconfig.base.json ./tsconfig.base.json

WORKDIR /repo/apps/server

# SERVER_PORT is read via src/env.ts (zod-validated) and defaults to 3001
# if unset; docker-compose.yml passes it explicitly today.
ENV SERVER_PORT=3001
EXPOSE 3001

# `tsx` (not `node`) - see the module comment above. No `watch`: unlike
# the `dev` script, this should exit on a crash rather than sit idle
# waiting for a file change that will never come, so `restart:
# unless-stopped` (docker-compose.yml) actually gets to restart it.
CMD ["npx", "tsx", "src/index.ts"]

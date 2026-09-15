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
#
# Why this runs via `tsx` instead of `node dist/index.js`: same reason as
# apps/server/Dockerfile's identical comment - @katnor/agents, @katnor/db,
# @katnor/knowledge etc. have no `build` step of their own (`main`/`types`
# point straight at `./src/index.ts`), so the compiled `dist/index.js`'s
# `import ... from "@katnor/db"` would resolve, at runtime, straight
# through to that raw .ts file, which plain `node` cannot execute. `tsc -p
# tsconfig.json` below still runs as a build-time type-check gate; the
# runtime stage discards its `dist/` output and instead runs `tsx` against
# the TypeScript source directly, exactly like the `dev` script already
# does. `tsx` is already a devDependency of @katnor/worker, so it's
# already present in the `node_modules` the builder's `pnpm install` (no
# `--prod`) produces and the runtime stage copies wholesale below.

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

# git is needed at runtime, not build time: @katnor/knowledge's wikiStorage.ts
# shells out to `git init`/`add`/`commit` directly (not through a per-project
# sandbox container - the wiki lives on this process's own filesystem, see
# docker-compose.yml's `wiki-data` volume), which node:22-slim doesn't
# include by default.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# pnpm hoists workspace packages (e.g. @katnor/core, @katnor/db) into
# node_modules as symlinks back into packages/*, so - until turbo prune
# trims this down - the runtime image needs the same repo layout as the
# builder for those symlinks to resolve. `apps/worker/src` (not `dist`) is
# what actually runs - see the module comment above for why.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/worker/src ./apps/worker/src
COPY --from=builder /repo/apps/worker/tsconfig.json ./apps/worker/tsconfig.json
COPY --from=builder /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=builder /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /repo/tsconfig.base.json ./tsconfig.base.json

WORKDIR /repo/apps/worker

# No HTTP server here - the worker only holds a pg-boss connection to
# Postgres (DATABASE_URL) and runs the heartbeat/job loop in src/index.ts,
# so there is no port to EXPOSE.
#
# `tsx` (not `node`) - see the module comment above. No `watch`: unlike
# the `dev` script, this should exit on a crash rather than sit idle
# waiting for a file change that will never come, so `restart:
# unless-stopped` (docker-compose.yml) actually gets to restart it.
CMD ["npx", "tsx", "src/index.ts"]

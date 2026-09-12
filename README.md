# Katnor

A self-hosted AI company: a CEO agent that hires AI employees (each with its own name, persona,
and model), who complete your tasks by collaborating and using real tools (Claude Code, Codex,
GitHub, Figma, ...). Includes a project knowledge graph, an LLM-maintained wiki, artifacts,
kanban boards, a web dashboard, and a 2D interactive office to watch it all happen.

The full build plan is in [PLAN.md](./PLAN.md).

## Development

### Prerequisites

- [Node.js 22](https://nodejs.org/) (use [corepack](https://nodejs.org/api/corepack.html) to get
  the pinned pnpm version: `corepack enable`)
- [pnpm](https://pnpm.io/) (via corepack, see above - no separate install needed)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for Postgres, MinIO, and
  running the full stack in containers)

### Getting started

1. Copy `.env.example` to `.env` and fill in the secrets (see the comments in that file for how
   to generate each one).
2. Start the infrastructure services: `docker compose up -d postgres minio`.
3. Install dependencies: `pnpm install`.
4. Set up the database: `pnpm --filter @katnor/db db:generate`, then `db:migrate`, then
   `db:post-migrate` (enables the `pgvector` extension and installs the event-notify trigger the
   server's WebSocket layer depends on), then `db:seed`.
5. Start everything in dev mode: `pnpm dev`.

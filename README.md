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
6. (Optional - only needed for the `shell`/`claude_code` work tools, PLAN.md 4.3) Build the
   per-project sandbox image: `docker build -t katnor-sandbox:latest -f sandbox/Dockerfile .`. Without
   it (or with `SANDBOX_MODE=host` in `.env`, which skips Docker entirely and runs those tools
   against a plain local directory - dev-only, no isolation), those two tools simply fail until
   either is set up.
7. (Optional, PLAN.md 4.4) Set `EMBEDDINGS_API_KEY` in `.env` for vector search over the
   knowledge graph and wiki (`search_knowledge`/`ask_wiki`/the Knowledge page's Ask tab). Without
   it, those fall back to plain keyword matching rather than failing.

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
   server's WebSocket layer depends on).
5. Start everything in dev mode: `pnpm dev`.
6. Open the dashboard and finish setup in the browser. A brand-new install sends you to `/setup`,
   a short wizard that names the company, creates the first account, and optionally takes a model
   provider API key. That is all `db:seed` used to do from a terminal, so you do not need to run
   it — see "First-run setup" below.
7. (Optional - only needed for the `shell`/`claude_code` work tools, PLAN.md 4.3) Build the
   per-project sandbox image: `docker build -t katnor-sandbox:latest -f sandbox/Dockerfile .`. Without
   it (or with `SANDBOX_MODE=host` in `.env`, which skips Docker entirely and runs those tools
   against a plain local directory - dev-only, no isolation), those two tools simply fail until
   either is set up.
8. (Optional, PLAN.md 4.4) Set `EMBEDDINGS_API_KEY` in `.env` for vector search over the
   knowledge graph and wiki (`search_knowledge`/`ask_wiki`/the Knowledge page's Ask tab). Without
   it, those fall back to plain keyword matching rather than failing.

### First-run setup

The first user account is the one thing that cannot be created from the dashboard, because the
dashboard requires being logged in. There are two ways to create it, and they do exactly the same
thing — both call `ensureCompanyBootstrap` / `createFirstUser` in `packages/db/src/bootstrap.ts`:

- **The browser wizard at `/setup`** — the default. Start the stack, open the dashboard, fill in
  three steps. Nothing is written until the last one, and it logs you straight in afterwards.
- **`pnpm --filter @katnor/db db:seed`** — for scripted or unattended installs, where nobody is
  there to fill in a form. Set `OWNER_EMAIL` and `OWNER_PASSWORD_HASH` in `.env` first (see the
  comments there for how to generate the hash).

**Setup closes permanently once one account exists.** Both paths refuse after that, and every
further account is created by an already logged-in user under Settings > Team members.

One deployment note: `setup.complete` is necessarily a public endpoint — an endpoint that creates
the first login cannot itself require a login — so between starting a brand-new stack and
finishing setup, whoever reaches the server first becomes its owner. This is the same trade every
self-hosted first-run wizard makes, and the same mitigation applies: **finish setup before
exposing a new install to an untrusted network.**

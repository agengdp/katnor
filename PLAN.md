# Katnor — AI Agent Company: Project Plan

Katnor is a self-hosted "AI company". You are the owner. On first run the company has a single
employee, the **CEO**. You give the CEO tasks; the CEO plans, **hires** AI employees (each with a
name, a persona, and its own model), and the team completes the work by talking to each other and
using real tools (Claude Code, Codex, GitHub, Figma, shell, browser, ...).

Everything the company learns is captured in a **project knowledge graph** and an
**LLM-maintained wiki**; everything it produces is stored as **artifacts**; all work is tracked on
**project kanban boards**. You watch and steer it through a **2D interactive office** and a
**web dashboard**.

This document is the build plan. It is organised as:

1. Product vision and the first-run story
2. Architecture and tech stack
3. Domain model
4. Subsystems (agents, comms, tools, knowledge graph, wiki, artifacts, kanban, office, dashboard)
5. Delivery phases with acceptance criteria
6. Risks, decisions taken, open questions

---

## 1. Vision and first-run story

### 1.1 What "done" looks like

```
You  ──task──▶ CEO ──hires──▶ PM, Tech Lead, Backend Dev, Frontend Dev, QA, Designer
                 │
                 └──creates project + board──▶ tasks assigned to employees
                                                  │
                     employees chat, delegate, ask each other, use tools
                                                  │
                     PRs / docs / designs / reports  ──▶ Artifacts
                     facts, decisions, code structure ──▶ Knowledge Graph + Wiki
                                                  │
                     you watch it all happen in the 2D office and the dashboard
```

### 1.2 First run, step by step

1. `docker compose up` → open the dashboard. Onboarding asks for provider API keys
   (Anthropic required, others optional), a company name, and a default model.
2. The office shows one desk: the **CEO** (default model `claude-opus-5`).
3. You post in the `#general` channel: *"Create a software development team and build me a
   todo app with a Next.js frontend and a Postgres backend."*
4. The CEO run starts. It calls `hire_agent` several times, e.g.:
   - "Maya Chen" — Product Manager — `claude-opus-5`
   - "Tomasz Nowak" — Tech Lead — `claude-opus-5`
   - "Ravi Iyer" — Backend Engineer — `claude-sonnet-5`
   - "Lena Fischer" — Frontend Engineer — `claude-sonnet-5`
   - "Sam Okafor" — QA Engineer — `claude-haiku-4-5`
   - "Ines Duarte" — Product Designer — `claude-sonnet-5` with the Figma tool
   New desks appear in the office as they are hired. (If you enable "approve hires", each hire
   waits for your click.)
5. The CEO creates a project, a board, and a handful of epics, and assigns them to the PM and
   the Tech Lead. Those agents wake up, break work down into tasks, assign them, and post in the
   project channel.
6. Engineers pick up tasks. Each task run happens in the project's sandboxed workspace; agents
   use Claude Code / Codex / shell / git. When they need something they `ask_colleague`, or
   `ask_human` (which pauses and shows a question card in the dashboard).
7. Every completed task produces artifacts (PR link, diff, docs, screenshots). The **Librarian**
   background job ingests them into the wiki and the knowledge graph.
8. You can, at any moment: open an agent's live trace, edit its persona or swap its model, drag
   tasks on the board, ask the wiki a question, or type in any channel.

### 1.3 Non-goals for v1

- Multi-tenant SaaS, billing, SSO.
- Mobile apps.
- Training or fine-tuning models.

---

## 2. Architecture and tech stack

### 2.1 High-level architecture

```
┌──────────────────────────────── apps/web (Next.js) ────────────────────────────────┐
│  Office (Phaser 3)  │ Kanban │ Team & Agent config │ Chat │ Knowledge (graph+wiki) │
│  Artifacts │ Runs & Costs │ Settings (providers, tools/MCP, budgets, approvals)    │
└───────────────▲──────────────────────────────▲──────────────────────────────────────┘
                │ tRPC (HTTP)                  │ WebSocket (live events)
┌───────────────┴──────────────────────────────┴──────────────────────────────────────┐
│                                apps/server (Hono + tRPC + ws)                      │
│   auth · API · event bus fan-out · file/artifact serving · approval gates           │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │ Postgres (tables + pg-boss queue + LISTEN/NOTIFY)
┌───────────────┴──────────────────────────────────────────────────────────────────────┐
│                                apps/worker (agent runtime)                          │
│  Scheduler → Run executor (LLM loop) → Tool registry → MCP clients / sandboxes      │
│  Librarian (wiki + knowledge-graph ingestion) · Cost meter · Trace recorder          │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │ dockerode
┌───────────────┴──────────────────────────────────────────────────────────────────────┐
│   Workspace sandboxes: one container per project (git repo, Claude Code, Codex, ...)│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Single deployable via Docker Compose: `web`, `server`, `worker`, `postgres` (with pgvector),
`minio` (artifact object storage; local disk in dev). In dev, `server` and `worker` can run as
one process.

### 2.2 Tech stack (decisions)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (Node 22) | One language for web, server, worker, and the Claude Agent SDK |
| Monorepo | pnpm workspaces + Turborepo | Shared packages, fast CI |
| Web | Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Query, Zustand | Standard, fast to build a dashboard |
| 2D office | Phaser 3 (inside a React page), Tiled maps, pixel-art tilesets | Built-in tilemaps, sprites, animation, pathfinding plugins |
| Kanban | dnd-kit | Accessible drag-and-drop |
| Graph view | Sigma.js + graphology | Renders thousands of nodes in WebGL |
| API | Hono + tRPC + zod | End-to-end types, tiny footprint |
| Realtime | WebSocket (`ws`) fed by Postgres LISTEN/NOTIFY | No extra broker |
| DB | Postgres 16 + pgvector, Drizzle ORM | Relational data, vectors, and graph tables in one DB |
| Queue | pg-boss | Durable jobs without Redis |
| LLM (Claude) | `@anthropic-ai/sdk` (Messages API, Tool Runner) | Full feature access: adaptive thinking, effort, caching, structured outputs, compaction |
| LLM (others) | Provider adapter interface; OpenAI-compatible adapter first, then Google, Ollama | "Each employee can use a different model" |
| Coding agents | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for Claude Code; `codex exec` CLI for Codex | Batteries-included coding harnesses run inside the sandbox |
| Tool integrations | MCP (Model Context Protocol) client; GitHub MCP, Figma MCP, Playwright MCP | One plug-in standard for external tools |
| Sandboxes | Docker via dockerode; per-project container with a mounted workspace volume | Isolation for shell and code execution |
| Artifacts | S3-compatible (MinIO) in prod, local FS in dev | Versioned binary/text storage |
| Wiki | Markdown files in a git repo per project (`wiki/`) | Human-readable, diffable, editable in Obsidian/VS Code |
| Auth | Single owner account (password in env) for v1; better-auth later | Keep v1 small |

### 2.3 Repository layout

```
katnor/
├── apps/
│   ├── web/                # Next.js dashboard + 2D office
│   ├── server/             # Hono + tRPC + WebSocket API
│   └── worker/             # agent runtime, scheduler, librarian
├── packages/
│   ├── core/               # domain types, zod schemas, event definitions
│   ├── db/                 # Drizzle schema, migrations, repositories
│   ├── llm/                # provider adapters (anthropic, openai-compatible, google, ollama)
│   ├── agents/             # run loop, prompt builder, company tools, hiring
│   ├── tools/              # tool registry, MCP client, sandbox tools, coding-agent tools
│   ├── knowledge/          # knowledge graph, wiki librarian, embeddings, search
│   ├── artifacts/          # artifact storage + viewers metadata
│   └── ui/                 # shared React components
├── sandbox/                # Dockerfile for the workspace image (node, python, git, claude, codex)
├── assets/office/          # tilesets, sprites, Tiled maps (with licenses)
├── docs/                   # ADRs, prompts, runbooks
├── docker-compose.yml
├── PLAN.md
└── README.md
```

---

## 3. Domain model

All tables carry `id` (ULID), `created_at`, `updated_at`. Only key fields are listed.

| Entity | Key fields | Notes |
|---|---|---|
| `company` | name, settings (default model, budgets, approval policy) | Exactly one in v1 |
| `agent` | name, title, persona (bio, personality, strengths, communication style), system_prompt, avatar (sprite id), reports_to, team_id, model_config, tool_allowlist, status, budget (daily USD), is_system (CEO) | "Employee" |
| `model_config` | provider, model id, effort, thinking display, max_tokens, temperature (non-Claude) | Embedded JSON on agent, validated per provider |
| `team` | name, lead_agent_id | Optional grouping |
| `project` | name, description, repos[], workspace_id, board settings, wiki path | Owns a board, a channel, a wiki, a subgraph |
| `task` | project_id, title, description, acceptance_criteria, status, priority, assignee_id, created_by, parent_id, depends_on[], due_at | Kanban card; also the unit of agent work |
| `run` | agent_id, task_id?, trigger (task/mention/schedule/human), status, started/finished, tokens in/out, cost_usd, summary | One agent execution |
| `run_step` | run_id, seq, kind (llm_call/tool_call/tool_result/message/thinking_summary), payload, tokens, duration | Trace |
| `channel` | project_id?, team_id?, kind (project/team/dm/task_thread/general) | Slack-like |
| `message` | channel_id, author (agent or human), content, mentions[], reply_to, attachments | Wakes mentioned agents |
| `artifact` | project_id, task_id?, run_id?, kind (file/diff/pr/doc/image/design/link/report), title, storage_key, version, mime, metadata | Versioned by `(artifact_group_id, version)` |
| `kg_node` | project_id?, type, name, summary, properties, embedding | Knowledge graph |
| `kg_edge` | from_id, to_id, type, weight, evidence (run/artifact/message id) | |
| `wiki_page` | project_id, path, title, frontmatter, content_hash, embedding | Mirrors the file on disk |
| `tool_config` | kind (mcp/builtin), name, command/url, env secret refs, enabled | Configured in Settings |
| `provider_config` | provider, api key (encrypted), base_url, enabled, model catalog cache | |
| `approval` | kind (hire/tool_call/spend), payload, status, decided_by | Human gates |
| `event` | type, payload, occurred_at | Append-only bus, also feeds the office |

Task status flow: `backlog → todo → in_progress → review → done`, plus `blocked` (side state).
Columns are configurable per project; the statuses above are the defaults.

---

## 4. Subsystems

### 4.1 Agent runtime

**Trigger → Run.** An agent runs when it has work: a task assigned to it, a message that mentions
it, a colleague's question, a scheduled check-in, or a human message in its DM. The scheduler
(worker) turns each trigger into a `run` job; one run per agent at a time (a per-agent lock),
with a global concurrency cap.

**The loop.** A run is an agentic loop over the agent's provider adapter:

- Build the prompt (see below), call the model with the agent's tools, execute tool calls,
  feed results back, repeat until the model ends the turn or a limit trips.
- Limits: max steps per run, max tokens per run, per-agent daily budget, per-project budget.
  On Claude, a **task budget** is also sent so the model paces itself.
- Claude runs use the official SDK Tool Runner with `thinking: {type: "adaptive"}`, an `effort`
  level from the agent's model config (default `high`; `xhigh` for engineering roles doing
  long agentic work), prompt caching on the stable prefix, server-side compaction for long
  runs, and `fallbacks: "default"` so a refusal on Opus-tier models is retried automatically.
- Every LLM call and tool call is recorded as a `run_step` with token counts and cost.

**Prompt layout (cache-friendly).** Stable first, volatile last:

1. Company system prompt: values, how the company works, tools etiquette, when to ask a human.
2. Agent persona: name, title, personality, strengths, communication style, who they report to.
3. Tool definitions (company tools + the agent's allowlisted work tools).
   ── cache breakpoint ──
4. Working context: the task card, the last N messages of relevant channels, wiki index,
   memory notes, pending questions.
5. The trigger (what just happened) and the ask.

Mid-run operator nudges (budget warnings, "wrap up") are appended as system messages in the
message list on models that support it, so the cached prefix is untouched.

**Memory.** Each agent has a small memory directory (markdown notes: preferences, project facts,
open threads) it can read and write via a `memory` tool. Long-term shared memory is the wiki
and the graph, not per-agent memory.

**Personas.** A persona is generated at hire time (by the CEO's `hire_agent` call) and editable
in the dashboard. It is rendered into the system prompt by a template, so edits take effect on
the next run.

**Hiring (CEO-only tools).** `hire_agent`, `update_agent`, `fire_agent`, `create_team`. The CEO's
prompt includes the current model catalog (from provider configs, with price per token and a
one-line guidance per model) and the tool catalog, so it can pick a sensible model and tools per
role. `hire_agent` uses a strict schema:

```json
{
  "name": "string", "title": "string",
  "persona": { "bio": "string", "personality": "string", "strengths": ["string"], "style": "string" },
  "model": { "provider": "anthropic", "model": "claude-sonnet-5", "effort": "high" },
  "tools": ["claude_code", "shell", "github", "web_search"],
  "reports_to": "agent_id", "team": "string | null"
}
```

The user can set policies: "auto-approve hires", "max headcount", "allowed models",
"default model for new hires".

**Multiple providers.** The `LLMProvider` interface exposes `run(loopInput) → stream of steps`
plus `capabilities` (tools, structured output, thinking, caching, max context). The Anthropic
adapter is first-class. The OpenAI-compatible adapter covers OpenAI, and any local server with
the same wire format (Ollama, vLLM). Google comes third. The dashboard only offers features the
selected provider supports.

### 4.2 Communication

Slack-like model: channels (`#general`, one per project, one per team), DMs, and a thread per
task. Both humans and agents post. Agents get these tools:

- `send_message(channel|agent, text, mentions)` — mentions wake the mentioned agent.
- `read_channel(channel, since)`.
- `ask_colleague(agent, question, context)` — creates a thread, wakes the colleague, and the
  asking run either waits (short timeout) or ends and is re-triggered when the reply arrives.
- `delegate_task(agent, title, description, acceptance_criteria)` — creates and assigns a task.
- `request_review(agent, artifact|task)`.
- `ask_human(question, options?)` — pauses the run; a card appears in the dashboard and the
  office shows a "?" bubble; the answer resumes the run.

Anti-chatter rules (enforced by the harness, not by trust): a message must belong to a task or
thread; per-agent message rate limit; a thread auto-escalates to the manager (then to the
human) after N back-and-forths without a task status change; managers get a daily "stand-up"
run that summarises threads into the wiki and closes stale ones.

### 4.3 Tools

A single **tool registry** with three tool families:

1. **Company tools** (built-in, all agents): messaging, tasks, artifacts, knowledge search,
   wiki read/write proposals, memory, ask_human. CEO-only: hiring/org tools.
2. **Work tools** (allowlisted per agent):
   - `claude_code` — runs the Claude Agent SDK `query()` inside the project sandbox with the
     task as the prompt; streams progress; returns a summary + changed files; PRs become
     artifacts.
   - `codex` — runs `codex exec` in the sandbox with the same contract.
   - `shell` — sandboxed bash in the workspace container (timeouts, output caps).
   - `git` / `github` — via GitHub MCP (create branch, PR, comment, read issues).
   - `figma` — via Figma MCP (read designs, export frames as image artifacts).
   - `browser` — Playwright MCP for testing and screenshots.
   - `web_search` / `web_fetch` — Claude server-side tools when the model is Claude; a
     search-API tool otherwise.
3. **MCP servers** added by the user in Settings (command or URL + env). Their tools appear in
   the catalog and can be allowlisted per agent.

Dangerous actions (git push to protected branches, deployments, spending above a threshold,
deleting artifacts) are gated by an **approval policy**: auto, ask-once-per-project, or
always-ask. Tool outputs are treated as untrusted data in prompts.

**Workspaces.** Each project gets a Docker container built from `sandbox/Dockerfile` (node,
python, git, Claude Code CLI, Codex CLI, ripgrep, playwright). The project's repos are cloned
into a named volume. Agents work on branches named `katnor/<task-id>-<slug>`. Secrets reach the
container only as scoped env vars (e.g. a GitHub token limited to the repo). A "host mode" flag
runs tools in a local directory for development without Docker.

### 4.4 Knowledge graph

Purpose: a queryable map of what the company knows about each project — components, decisions,
people/agents, tasks, artifacts, external systems — with provenance.

- **Storage:** `kg_node` / `kg_edge` tables in Postgres with pgvector embeddings on nodes.
  This is enough to start; the access layer is behind an interface so Neo4j can replace it
  later if traversal depth or scale demands it.
- **Node types:** Project, Task, Agent, Person (human), Repo, Module, File, Function/Class,
  Decision, Requirement, Concept, Tool/Service, Artifact, WikiPage, Bug, Risk.
- **Edge types:** `part_of`, `depends_on`, `implements`, `decided_in`, `produced_by`,
  `assigned_to`, `references`, `blocks`, `supersedes`, `mentions`.
- **Ingestion (Librarian job):** after each run, artifact, or wiki change, an extraction call
  (structured outputs, `claude-sonnet-5` by default) returns entities and relations with
  evidence ids; the ingester upserts nodes (dedupe by embedding similarity + name), links edges,
  and records evidence. A separate **code indexer** parses repos with tree-sitter to add
  Module/File/Function nodes and `imports`/`calls` edges (incremental, per commit).
- **Query:** `search_knowledge(query)` tool = hybrid search (vector + keyword) over nodes and
  wiki pages, then a 1–2 hop expansion, returning a compact context block with citations.
- **UI:** graph explorer (Sigma.js) with type filters, click-to-expand, node detail panel
  linking to tasks/artifacts/wiki, and a per-project subgraph view.

### 4.5 Wiki LLM

A markdown wiki per project, maintained by the **Librarian** (a background role, not a hired
employee) and readable/editable by humans.

- **Layout:** `wiki/index.md` (catalogue of pages with one-line summaries), `wiki/log.md`
  (append-only changelog), `wiki/pages/<slug>.md` (concepts, modules, decisions, people,
  runbooks), `wiki/decisions/ADR-*.md`. Pages use frontmatter (`type`, `tags`, `sources`) and
  `[[wikilinks]]`; wikilinks become graph edges.
- **Ingest:** on new artifacts, completed tasks, and important threads, the Librarian reads the
  source, decides which pages to create/update, writes them, updates `index.md` and `log.md`,
  and commits to the project's wiki git repo. Every page cites its sources (artifact/run/message
  ids).
- **Query:** `ask_wiki(question)` (agents and humans) answers with citations using the index +
  hybrid search; good answers can be saved as new pages ("promote to page").
- **Lint:** a scheduled job finds contradictions, orphan pages, stale facts (source superseded),
  and missing pages for frequently referenced graph nodes; it opens tasks for the Librarian or
  reports to the human.
- **Editing:** humans edit in the dashboard (markdown editor with preview) or directly in the
  git repo; the DB mirror re-indexes on change.

### 4.6 Artifacts

- Any file, diff, PR, document, image, design export, link, or report produced during work.
- Created explicitly by agents via `save_artifact(kind, title, content|path, task)` and
  automatically by tools (PR opened → `pr` artifact; screenshot taken → `image` artifact;
  files written under `workspace/artifacts/` → `file` artifacts).
- Versioned; linked to task, run, and agent; searchable; ingested by the Librarian.
- Viewers: markdown, code/diff (CodeMirror), image, PDF, HTML preview (sandboxed iframe),
  Figma embed, PR card with CI status.
- Human actions: comment, approve/reject (feeds back to the producing agent as a message),
  download, pin to project.

### 4.7 Projects kanban

- One board per project; default columns Backlog / Todo / In progress / Review / Done, plus
  Blocked badge; columns editable.
- Card: title, assignee avatar, priority, labels, artifact count, live status ("Ravi is
  running tests…"). Drawer: description, acceptance criteria, thread, run history, artifacts,
  dependencies, sub-tasks.
- Humans can create, edit, assign, reorder, and move cards; moving a card to Todo with an
  assignee triggers a run. Agents move cards via `update_task`.
- Board events stream live over WebSocket; the office reads the same events.

### 4.8 2D interactive office

A top-down pixel-art office rendered with Phaser 3 inside the dashboard, driven entirely by the
event stream (no game logic on the server beyond events).

- **Map:** Tiled map with zones — desks (one per agent, auto-assigned on hire), a meeting room,
  a whiteboard (opens the kanban), a bookshelf (opens the wiki), a server rack (opens runs and
  costs), a reception desk (the CEO's spot and the human's "inbox" of questions).
- **Agents:** sprite per agent (chosen at hire from a palette, editable). States: `idle` (at
  desk, occasional fidget), `working` (typing animation + bubble showing the current tool,
  e.g. "claude_code: running tests"), `talking` (walks to a colleague's desk or the meeting
  room; speech bubbles show message snippets), `waiting_human` ("?" bubble, walks to reception),
  `blocked`, `offline` (desk dark, when fired or disabled).
- **Interaction:** click an agent → side panel with persona, current run trace, and a chat box;
  right-click → assign task / edit model; hover a bubble → full message; click the whiteboard,
  bookshelf, or rack → open the matching dashboard page; day/night tint follows spend vs. daily
  budget (a subtle way to see cost).
- **Tech:** Phaser 3 scene mounted in a React component; grid-based pathfinding (EasyStar.js);
  events → a small state machine per sprite; assets from a permissively licensed pack (e.g.
  LimeZu "Modern Office" or Kenney) with licenses stored in `assets/office/LICENSES.md`.

### 4.9 Web dashboard

Pages: **Office**, **Projects** (list + board), **Team** (org chart; agent editor: persona,
model/effort, tools allowlist, budget, memory notes; hire manually), **Chat**, **Knowledge**
(graph explorer, wiki browser/editor, ask box), **Artifacts**, **Runs** (trace viewer with
per-step tokens/cost, filters by agent/project), **Inbox** (pending approvals and questions),
**Settings** (providers and keys, model catalog, MCP servers and tools, sandbox settings,
budgets, approval policies, backups).

Cross-cutting: global command palette, notifications for questions/approvals, live presence
indicators, and a cost meter in the header.

---

## 5. Delivery phases

Each phase ends with a demo that runs from `docker compose up`. Estimates assume one developer
working with an AI coding agent; treat them as ordering, not commitments.

### Phase 0 — Foundations (≈1 week)

- Monorepo scaffold, lint/format/typecheck/test in CI, Docker Compose (postgres+pgvector,
  minio, web, server, worker).
- Drizzle schema and migrations for the domain model in §3; event table + LISTEN/NOTIFY fan-out
  to WebSocket; pg-boss queue.
- Owner login; Settings page for provider keys (encrypted at rest); model catalog loaded from
  the Anthropic Models API and cached.
- Dashboard shell with navigation and empty pages.

**Done when:** the app boots, the CEO record is seeded, and an event inserted in the DB shows
up live in the browser.

### Phase 1 — CEO, hiring, chat, kanban (≈2 weeks)

- Anthropic provider adapter (Tool Runner, adaptive thinking, effort, caching, structured
  outputs, cost accounting), the run executor, run/step tracing, and the Runs page.
- Company tools: messaging, tasks, `ask_human`; CEO tools: hire/update/fire/create_team.
- Chat page (channels, threads, mentions), Team page (org chart + agent editor), Projects +
  kanban (dnd-kit) with live updates.
- Hire approval policy and Inbox.

**Done when:** posting "build a software development team for a todo app" makes the CEO hire a
team, create a project and board, and assign tasks; the assignees post plans in the project
channel; you can edit a persona and swap a model and see the next run use them.

### Phase 2 — Real work: sandboxes and coding tools (≈2 weeks)

- Sandbox image and per-project workspace containers (host mode for dev).
- Work tools: `shell`, `claude_code` (Claude Agent SDK), GitHub MCP, `web_search`/`web_fetch`;
  tool allowlists per agent; MCP server management in Settings; approval gates for pushes.
- Agent-to-agent: `ask_colleague`, `delegate_task`, `request_review`, anti-chatter limits,
  manager stand-up run.
- Artifacts v1: storage, auto-capture of PRs/files/screenshots, viewers, task drawer linkage.

**Done when:** the team turns a todo-app task into a real PR on a GitHub repo you configured,
with a QA agent reviewing it, and every step is visible in the trace and as artifacts.

### Phase 3 — Knowledge: wiki and graph (≈2 weeks)

- Librarian job: wiki ingest, `index.md`/`log.md` maintenance, git commits, lint job.
- Knowledge graph: schema, extraction with structured outputs, embeddings, dedupe, code
  indexer (tree-sitter) for repos, `search_knowledge` and `ask_wiki` tools.
- Knowledge page: graph explorer, wiki browser and editor, ask box with citations.

**Done when:** after Phase 2's demo, asking "how does auth work in the todo app and who decided
it?" returns a cited answer, the graph shows the module/decision/agent nodes, and a new hire
uses `search_knowledge` in its first run.

### Phase 4 — 2D office (≈2 weeks)

- Phaser scene, Tiled map, desk assignment, sprite palette, sprite state machine bound to
  events, pathfinding, speech/thought bubbles, click-through panels, zone shortcuts.
- Performance pass (event batching, offscreen culling) and accessibility fallback (the Team
  page shows the same live status list).

**Done when:** watching a task run, you can see who is working, who is talking to whom, who is
waiting on you, and click any of them to intervene.

### Phase 5 — More tools, control, polish (ongoing)

- Codex tool, Figma MCP, Playwright MCP; OpenAI-compatible and Google provider adapters.
- Budgets and cost dashboards per agent/project/day; task budgets on Claude; hard stops.
- Scheduled runs (daily stand-up, weekly wiki lint), backups/export, multi-user auth.
- Eval harness: a set of scripted company tasks with graded outcomes, run in CI against prompt
  and tool changes.

---

## 6. Risks, decisions, open questions

### 6.1 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runaway spend (agents chatting or looping) | Per-run step/token caps, per-agent and per-project daily budgets with hard stop, task budgets, anti-chatter rules, cost meter in the header |
| Agents talk instead of work | Every message must belong to a task/thread; escalation after N exchanges; manager stand-ups; "progress or stop" rule in the company prompt |
| Sandbox escape / secret leakage | Docker isolation, no host mounts beyond the workspace volume, scoped tokens, secrets never in prompts, approval gates on outbound actions |
| Prompt injection via tool output (web pages, repo contents, PR comments) | Tool results wrapped as untrusted data, no privileged instructions inside tool results, approvals for irreversible actions |
| Context bloat over long tasks | Cache-friendly prompt layout, server-side compaction, context editing of old tool results, wiki as external memory |
| Provider feature drift | Capabilities declared per adapter; UI hides unsupported options; adapters covered by contract tests |
| Wiki/graph drift from reality | Every page and node carries evidence ids; lint job flags superseded sources; humans can edit |
| Asset licensing for the office | Only permissively licensed packs, license files committed with assets |

### 6.2 Decisions taken (assumptions, change if you disagree)

1. **TypeScript monorepo**, Node 22.
2. **Postgres only** (pgvector, pg-boss, LISTEN/NOTIFY). No Redis, no Neo4j in v1; both are
   swappable later behind interfaces.
3. **Docker sandboxes per project**, host mode for development.
4. **Anthropic is the primary provider**; CEO defaults to `claude-opus-5`; hires may use any
   configured provider/model. Claude Code runs through the Claude Agent SDK.
5. **Phaser 3** for the office, embedded in the Next.js app.
6. **Librarian is a system job**, not a hired employee, so the "only the CEO exists on first
   run" rule holds. The CEO may still hire a "Knowledge Manager" employee whose tools include
   wiki editing.
7. **Single owner account** in v1.
8. **Wiki is git-backed markdown** so it stays useful outside the app.

### 6.3 Open questions for you

- Which non-Anthropic providers matter first: OpenAI, Google, or local models via Ollama?
- Should hires require your approval by default, or run fully autonomously with a headcount cap?
- Do you want the office to be single-office-per-company, or one room per project?
- Any existing repos the first team should work on, or should Phase 2's demo use a fresh repo?

### 6.4 Immediate next steps

1. Confirm or amend the decisions in §6.2.
2. Start Phase 0: scaffold the monorepo, Compose stack, schema, event bus, and dashboard shell.
3. In parallel, write the company system prompt and the CEO persona (`docs/prompts/`), since
   they shape everything in Phase 1.

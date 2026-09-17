# @katnor/db

Drizzle ORM schema, Postgres client, and repositories for the whole Katnor system. This package is
the source of truth for how every entity in the domain model is stored.

## Setup order

```
pnpm db:generate      # drizzle-kit reads src/schema and writes SQL migrations to ./drizzle
pnpm db:migrate       # drizzle-kit applies ./drizzle/*.sql to DATABASE_URL
pnpm db:post-migrate  # tsx src/applyPostMigrate.ts - enables pgvector, installs the event-notify trigger
pnpm db:seed          # tsx src/seed.ts - creates the company row, the system CEO agent, and the first user
```

Run them in that order, every time the schema changes. All four are idempotent - safe to re-run.

`DATABASE_URL` must be set (see the repo root `.env.example`; local dev via `docker-compose.yml`
defaults to `postgresql://katnor:katnor@localhost:5432/katnor`). `COMPANY_NAME` is optional and only
used by `db:seed` (defaults to `"Katnor Inc."`). `OWNER_EMAIL`/`OWNER_PASSWORD_HASH` are also only
read by `db:seed`, and only to create the very first `user` row if no user exists yet - nobody can log
in until one does (Phase 5's multi-user auth has no self-serve signup; every other user is created by
an already-logged-in one through Settings > Team members).

### `db:generate` could not be run in this environment

This package's schema (`src/schema/`) was written by hand, but **`pnpm db:generate` has not been
run** - this sandbox has no outbound network access, so `drizzle-kit` (and every other dependency)
could not be installed. As a result:

- The `./drizzle/` directory (SQL migration files + drizzle-kit's `meta/` snapshot) **does not
  exist yet**.
- Nobody should hand-write it: run `pnpm install` followed by `pnpm db:generate` once this package
  has real network/registry access, review the generated SQL, commit it, and only then run
  `pnpm db:migrate` against a real database.
- Until that first `db:generate` has run, `db:migrate`, `db:post-migrate`, and `db:seed` all have
  nothing to apply against and will fail (or run against an empty database with no tables).

## What's in here

- `src/schema/` - one file per entity (see the domain model in `PLAN.md`), split out rather than one
  giant file. `src/schema/columns.ts` factors out the `id` / `created_at` / `updated_at` columns
  every table has. `src/schema/enums.ts` defines a Postgres `pgEnum` for every fixed-vocabulary
  column, reusing the enum arrays exported by `@katnor/core` as the single source of truth for
  _which values are valid_ (this package remains the source of truth for _how they're stored_).
  `src/schema/vector.ts` implements the `vector(n)` pgvector column type by hand via drizzle's
  `customType` - see the comment in that file for why, instead of importing a `vector()` helper
  directly. `src/schema/relations.ts` holds every `relations()` definition in one file, separate
  from the table files themselves - see the comment at the top of that file for why (it avoids a
  real circular-import hazard between tables that reference each other, e.g. `agent` and `task`).
- `src/client.ts` - the `db` (drizzle) and `client` (raw `postgres.js`) singletons.
- `src/env.ts` - validates `DATABASE_URL` is set, shared by `drizzle.config.ts` and `src/client.ts`.
- `src/ulid.ts` - a small dependency-free ULID generator. IDs are generated application-side (every
  `id` column is `text`, not a DB-generated serial/uuid), so every repository's `create()` calls
  `ulid()` itself before inserting.
- `src/applyPostMigrate.ts` - one-off SQL that isn't a schema migration: `CREATE EXTENSION IF NOT
EXISTS vector;`, and the function + trigger that `pg_notify`s the `katnor_events` channel on every
  insert into `event`.
- `src/listen.ts` - `subscribeToEvents()`, a `LISTEN katnor_events` subscriber for the server's event
  fan-out. Uses the `pg` driver rather than `postgres` - see the comment in that file for why.
- `src/repositories/` - thin CRUD wrappers around drizzle calls (no business logic) for `company`
  (including `getSettings`/`updateSettings`, which merge over `@katnor/core`'s
  `DEFAULT_COMPANY_SETTINGS` for any key a stored row doesn't have), `agent`, `project`, `task`,
  `event`, `run`, `runStep`, `channel` (including `getOrCreateGeneral`/`getOrCreateDm`/
  `getOrCreateTaskThread`), `message`, `team`, and `approval`. `@katnor/knowledge`'s own
  repositories (`kg_node`/`kg_edge`/`wiki_page`) are still a later phase.
- `src/seed.ts` - idempotently creates the single `company` row (with default settings), the system
  CEO agent ("Nadia Reyes"), and the `#general` channel.

## Notes on two design choices called out for review

- **pgvector column type**: `src/schema/vector.ts` defines `vector(name, { dimensions })` via
  drizzle's `customType` (`dataType` / `toDriver` / `fromDriver`), not by importing a `vector()`
  helper from `drizzle-orm/pg-core`. drizzle-orm has, at various points, shipped its own pgvector
  support, but this was written without registry access to confirm the exact export/signature
  against `drizzle-orm@^0.38.0`, so it was safer to implement it directly against the stable,
  long-lived `customType` API. `CREATE EXTENSION IF NOT EXISTS vector;` (run by
  `src/applyPostMigrate.ts`) must have been applied before any `vector(n)` column is used.
- **LISTEN/NOTIFY driver**: `src/listen.ts` uses `pg` (+ `@types/pg`), added as an extra dependency
  of this package specifically for that one file, instead of `postgres` (postgres.js, used
  everywhere else in this package). `pg`'s `client.query('LISTEN ...')` + `client.on('notification',
...)` API has been stable for years; this was written without registry access to double-check the
  exact shape of postgres.js's own `.listen()` sugar against the pinned `postgres@^3.4.5`, so
  correctness was preferred over forcing a single driver.

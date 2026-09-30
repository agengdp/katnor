# @katnor/db

Drizzle ORM schema, Postgres client, and repositories for the whole Katnor system. This package is
the source of truth for how every entity in the domain model is stored.

## Setup order

```
pnpm db:generate      # drizzle-kit reads src/schema and writes SQL migrations to ./drizzle
pnpm db:pre-migrate   # tsx src/applyPreMigrate.ts - installs the pgvector extension
pnpm db:migrate       # drizzle-kit applies ./drizzle/*.sql to DATABASE_URL
pnpm db:post-migrate  # tsx src/applyPostMigrate.ts - installs the event-notify trigger
pnpm db:seed          # tsx src/seed.ts - creates the company row, the system CEO agent, and the first user
```

Run them in that order, every time the schema changes. All of them are idempotent - safe to re-run.

The order is not arbitrary in either direction. `pre-migrate` has to come **before** `migrate`,
because the generated tables declare `vector(1536)` columns and Postgres cannot parse that type
until the extension exists. `post-migrate` has to come **after**, because its trigger is attached
to the `event` table. Both used to live in one after-the-fact script, which made a fresh install
impossible to complete.

`db:seed` is optional: the browser setup wizard at `/setup` does the same thing (both call
`src/bootstrap.ts`), and is the easier path unless you are automating an install.

`DATABASE_URL` must be set (see the repo root `.env.example`; local dev via `docker-compose.yml`
defaults to `postgresql://katnor:katnor@localhost:5432/katnor`). `COMPANY_NAME` is optional and only
used by `db:seed` (defaults to `"Katnor Inc."`). `OWNER_EMAIL`/`OWNER_PASSWORD_HASH` are also only
read by `db:seed`, and only to create the very first `user` row if no user exists yet - nobody can log
in until one does (Phase 5's multi-user auth has no self-serve signup; every other user is created by
an already-logged-in one through Settings > Team members).

### About `./drizzle/`

The SQL migrations and drizzle-kit's `meta/` snapshot are committed. They have to be: a deployed
stack applies the committed SQL through `src/migrate.ts` inside the server image, which carries no
drizzle-kit to generate anything with. CI regenerates from `src/schema` on every run and fails if
the result differs, so committed-but-stale migrations cannot slip through.

Getting here took fixing three bugs that had each gone unnoticed because the one upstream of it
also failed, and they are worth recording so nobody re-introduces them:

1. `drizzle.config.ts` imported `./src/env.js`. drizzle-kit loads the config through a CommonJS
   `require`, which resolves that literally, against a file that does not exist - this package is
   ESM with `moduleResolution: NodeNext`, so its source spells imports with `.js` extensions that
   only TypeScript resolves back to `.ts`. `db:generate` had never run, on any machine.
2. The same thing one level down, on the schema barrel's `export * from './columns.js'`. Worse,
   drizzle-kit printed `MODULE_NOT_FOUND` and **exited 0**, so an empty migration went out looking
   like a success and `db:migrate` reported "migrations applied successfully" over it. The fix is
   running `db:generate` under the tsx loader.
3. `CREATE EXTENSION vector` ran in `db:post-migrate`, i.e. after the migrations - but the tables
   declare `vector(1536)` columns, which Postgres cannot parse without it. The documented order
   could never complete on an empty database. It is now `db:pre-migrate`.

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

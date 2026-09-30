# Deploying Katnor

Katnor deploys as five containers on one host: `postgres`, a one-shot
`migrate`, `server`, `worker` and `web`. `docker-compose.prod.yml` pulls
published images, so the host needs Docker and an `.env` file — no source
checkout, no Node, no pnpm.

## What you need

- A host with Docker and the Compose plugin.
- A domain (or at least a stable address) for `web` and `server`. They must
  share a registrable domain — `app.example.com` and `api.example.com` are
  fine, `example.com` and `example.net` are not. See "Why the two hosts must
  match" below.
- An Anthropic API key, or another provider. You can add it through the
  setup wizard on first run instead of putting it in `.env`.

## 1. Write an `.env` next to the compose file

Nothing here has a development default. Compose refuses to start if a
required value is missing, rather than booting with a password everyone
knows.

```sh
POSTGRES_PASSWORD=$(openssl rand -hex 24)
DATABASE_URL=postgresql://katnor:THAT_SAME_PASSWORD@postgres:5432/katnor
SESSION_SECRET=$(openssl rand -hex 32)
SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PUBLIC_SERVER_URL=https://api.example.com
KATNOR_VERSION=v0.1.0
```

`DATABASE_URL`'s password must match `POSTGRES_PASSWORD`. It is spelled out
rather than assembled from the parts because compose's nested interpolation
is fragile, and a database URL that is silently wrong is a bad way to find
that out.

**`SETTINGS_ENCRYPTION_KEY` cannot be rotated casually.** It derives the AES
key that provider API keys and MCP secrets are encrypted with; change it and
every stored secret becomes undecryptable. Back it up with the database.

## 2. Bring it up

```sh
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The `migrate` service runs before `server` and `worker` start: it installs
the `pgvector` extension, applies the committed SQL migrations, and installs
the event-notify trigger. All three steps are idempotent, so this runs on
every deploy and is a no-op when there is nothing to do.

Watch it with `docker compose -f docker-compose.prod.yml logs -f migrate`.

## 3. Finish setup in a browser

Open the web app. A fresh install sends you to `/setup`, which names the
company, creates the first account and optionally takes a provider API key,
then logs you in.

**Do this before the host is reachable from an untrusted network.**
`setup.complete` has to be a public endpoint — the call that creates the
first login cannot require a login — so between `up -d` and finishing that
form, whoever reaches the server first becomes its owner. Setup closes
permanently once one account exists. Every self-hosted first-run wizard
makes this trade; the mitigation is to not leave the window open.

If you would rather not have that window at all, seed from the CLI instead:
set `OWNER_EMAIL` and `OWNER_PASSWORD_HASH` (see `.env.example` for how to
produce the hash) and run `db:seed` from a checkout before exposing the
host. Both paths call the same code.

## Upgrading

```sh
# edit KATNOR_VERSION in .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

`migrate` re-runs and applies anything new. Take a database backup first if
the release contains schema changes — Katnor has no down-migrations.

## Images

`.github/workflows/release.yml` publishes `-server`, `-worker` and `-web` to
GHCR on every push to `main` (tagged `main` and `<sha>`) and on every `v*`
tag (tagged with the version and `latest`). Point `KATNOR_IMAGE_PREFIX` at
your own registry if you are not using GHCR.

The **sandbox image is not built by that workflow** and must be built by
hand:

```sh
docker build -t ghcr.io/OWNER/katnor-sandbox:latest -f sandbox/Dockerfile .
docker push ghcr.io/OWNER/katnor-sandbox:latest
```

It carries the Claude Code and Codex CLIs plus ~26 native tree-sitter
wheels, takes longer than the other three combined, and changes on its own
schedule. Without it the `shell` and `claude_code` work tools fail; the rest
of Katnor runs. Set `SANDBOX_MODE=host` to skip Docker workspaces entirely
(development only — no isolation).

## Things this compose file does differently from the dev one

Each of these is a deliberate difference from `docker-compose.yml`, which
optimises for convenience on a laptop.

**Postgres publishes no port.** The dev file maps 5432 to the host so you
can reach it with `psql`. On a public box that is a database on the
internet. Use `docker compose exec postgres psql` instead.

**No MinIO.** Artifacts are written to a volume and served through
`/artifacts/raw/:key`, which is behind `requireAuth`. In S3 mode the browser
fetches presigned URLs directly from MinIO, which means publishing MinIO and
handing out time-limited unauthenticated links to agent output — diffs,
screenshots, reports. If you want S3 anyway (another host, a real bucket,
shared storage across replicas), set `ARTIFACT_STORAGE=s3` with the
`MINIO_*` variables and make sure the endpoint you configure is one browsers
can actually reach.

**The worker still mounts the Docker socket.** That is root-equivalent
control of the host daemon, and it is how per-project workspace containers
get created. It is the same trust model as any "give the agent runner a
Docker socket" tool. `SANDBOX_MODE=host` opts out and loses isolation.

## Why the two hosts must match

`web` connects to `server`'s `/ws/events` WebSocket for live updates, and
that socket authenticates with the `katnor_session` cookie. A browser
`WebSocket` cannot set headers, so the cookie has to be in scope on its own.
The cookie is `SameSite=Lax`, which is site-based: ports do not matter
(`localhost:3000` reaching `localhost:3001` is fine), and subdomains of one
registrable domain do not matter. Genuinely different domains do — the
cookie will not be sent, the handshake will 401, and live updates will stop
while the rest of the app keeps working, which is a confusing thing to
debug. Serving the two from unrelated domains needs a `SameSite=None; Secure`
session cookie, which `apps/server/src/auth.ts` does not currently issue.

## What has and has not been verified

CI's `image` job builds the server image and runs the exact `working_dir`
and `command` from this compose file's `migrate` service against a real
pgvector Postgres — twice, to prove it is idempotent — then runs the
first-run bootstrap checks against the result, then validates this file with
`docker compose config`.

What no automated check covers: a full five-container stack actually serving
traffic, the browser reaching `PUBLIC_SERVER_URL`, the WebSocket handshake
over a real domain, and the sandbox image. The first real end-to-end run is
a human's.

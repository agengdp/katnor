import { serve } from '@hono/node-server';
import { getStorage } from '@katnor/artifacts';
import { artifactRepo } from '@katnor/db';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth } from './auth.js';
import { buildBackupExport } from './backup.js';
import { env } from './env.js';
import { createContext } from './trpc/context.js';
import { appRouter } from './trpc/router.js';
import { startEventsWebSocketServer } from './ws.js';

const app = new Hono();

// Permissive, credentialed CORS for the tRPC API: apps/web is a separate
// deployable on its own origin/port (see PUBLIC_SERVER_URL in
// .env.example) and needs the `katnor_session` cookie to flow with its
// requests, which requires an exact `Access-Control-Allow-Origin` (not
// `*`) whenever `credentials: true` is set. There's no `CORS_ORIGIN`-style
// allowlist env var yet in this phase, so this reflects whatever Origin the
// browser sent - fine for a self-hosted, single-owner app in Phase 0, but
// worth tightening to a real allowlist once deployment origins are fixed.
app.use(
  '/trpc/*',
  cors({
    origin: (origin) => origin,
    credentials: true,
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

/**
 * Serves artifact bytes stored by @katnor/artifacts' `LocalFsStorage`
 * (dev/host mode) - this is the exact path `LocalFsStorage.getUrl` hands
 * back (PLAN.md 4.6). In S3/MinIO mode `getArtifactUrl` instead returns a
 * presigned URL the browser hits directly, bypassing this route entirely,
 * but `getStorage().get(key)` works against either backend, so this stays
 * correct regardless of `ARTIFACT_STORAGE`.
 */
app.get('/artifacts/raw/:key', async (c) => {
  const key = c.req.param('key');
  let content: Buffer;
  try {
    content = await getStorage().get(key);
  } catch {
    return c.notFound();
  }
  const row = await artifactRepo.getByStorageKey(key);
  c.header('Content-Type', row?.mime ?? 'application/octet-stream');
  return c.body(content);
});

/**
 * PLAN.md Phase 5's "backups/export" (Settings > Backups: a "Download
 * backup" link, apps/web/src/routes/settings/+page.svelte). A plain
 * `<a href>` GET rather than a tRPC procedure: tRPC's request/response path
 * is built around small JSON payloads and doesn't have a "stream this back
 * as a file download" mode, and a multi-table export is exactly the kind
 * of payload that doesn't belong going through it. Gated by `requireAuth`
 * (unlike /artifacts/raw above, which serves already-public artifact
 * bytes) - a backup bundles every table's data, so it needs the same login
 * check every settings.* tRPC procedure already enforces via
 * `protectedProcedure`.
 */
app.get('/export/backup', requireAuth, async (c) => {
  const backup = await buildBackupExport();
  const filename = `katnor-backup-${backup.exported_at.slice(0, 10)}.json`;
  c.header('Content-Type', 'application/json');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(JSON.stringify(backup, null, 2));
});

/**
 * tRPC-on-Hono wiring: tRPC v10's own `@trpc/server/adapters/fetch` adapter
 * (`fetchRequestHandler`), called directly from a catch-all Hono route,
 * rather than a third-party Hono-specific tRPC adapter package. Hono's
 * request/response objects ARE the standard Fetch API `Request`/`Response`
 * (`c.req.raw` / returning a `Response`), so the official fetch adapter -
 * shipped inside `@trpc/server` itself, no extra dependency - works against
 * it directly. This avoids depending on a community adapter package whose
 * exact name/API for this pinned tRPC version isn't something to guess at
 * without registry access in this sandbox.
 */
app.all('/trpc/*', (c) =>
  fetchRequestHandler({
    endpoint: '/trpc',
    req: c.req.raw,
    router: appRouter,
    createContext,
  }),
);

const httpServer = serve(
  {
    fetch: app.fetch,
    port: env.SERVER_PORT,
  },
  (info) => {
    console.log(
      `[server] katnor server listening on http://localhost:${info.port} (tRPC at /trpc, WS at /ws/events)`,
    );
  },
);

// `serve()`'s declared return type is a union that also covers the http2
// server shapes it can produce when given a `createServer` option we never
// pass here - without that option it always hands back a plain node
// `http.Server` at runtime, which is what `startEventsWebSocketServer`
// (and the `ws` package's `WebSocketServer`) expect. The cast reflects
// that; it is not narrowing away anything that can actually happen here.
startEventsWebSocketServer(httpServer as import('node:http').Server);

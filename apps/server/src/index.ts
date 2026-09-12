import { serve } from '@hono/node-server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
    console.log(`[server] katnor server listening on http://localhost:${info.port} (tRPC at /trpc, WS at /ws/events)`);
  },
);

// `serve()`'s declared return type is a union that also covers the http2
// server shapes it can produce when given a `createServer` option we never
// pass here - without that option it always hands back a plain node
// `http.Server` at runtime, which is what `startEventsWebSocketServer`
// (and the `ws` package's `WebSocketServer`) expect. The cast reflects
// that; it is not narrowing away anything that can actually happen here.
startEventsWebSocketServer(httpServer as import('node:http').Server);

import { createTRPCClient, type TRPCClientInit } from 'trpc-sveltekit';
import { env } from '$env/dynamic/public';

// TODO: replace this with a real import once @katnor/server exports its
// router type, e.g. `import type { AppRouter } from '@katnor/server';`.
// apps/server is being built in parallel in this same phase, so its exact
// tRPC router shape (procedure names/inputs/outputs) isn't available to
// import from here yet. Do NOT add a package dependency from @katnor/web on
// @katnor/server to get it early - a shared router-type export across the
// package boundary is a later-phase concern. Until then, calls below (e.g.
// `trpc().settings.listProviders.query()`) are untyped and rely on matching
// the shape documented in PLAN.md by convention.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppRouter = any;

// apps/server is a separate deployable (see docker-compose.yml), reachable
// at PUBLIC_SERVER_URL - not a tRPC handler mounted inside this SvelteKit
// app - so the client always points at an absolute, external URL rather
// than trpc-sveltekit's usual same-origin "/trpc" default. Read via
// $env/dynamic/public (not $env/static/public) so the URL is resolved at
// request/runtime rather than baked in at build time, since the built
// Docker image may be deployed with a different PUBLIC_SERVER_URL than the
// one present when it was built.
const serverUrl = env.PUBLIC_SERVER_URL ?? 'http://localhost:3001';
const trpcUrl = `${serverUrl.replace(/\/+$/, '')}/trpc`;

let browserClient: ReturnType<typeof createTRPCClient<AppRouter>> | undefined;

/**
 * Returns a tRPC client for talking to apps/server's tRPC router.
 *
 * In the browser, a single client is created and reused. During SSR (in
 * `load` functions) a fresh client is created per call so SvelteKit's
 * per-request `fetch` can be passed through via `init`.
 */
export function trpc(init?: TRPCClientInit) {
  const isBrowser = typeof window !== 'undefined';

  if (isBrowser && browserClient) return browserClient;

  const client = createTRPCClient<AppRouter>({
    init: { url: trpcUrl, ...init }
  });

  if (isBrowser) browserClient = client;

  return client;
}

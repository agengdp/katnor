import { createTRPCClient, type TRPCClientInit } from 'trpc-sveltekit';
// A type-only import: @katnor/server is a devDependency of this package
// (package.json) purely so this line resolves - "import type" is erased at
// build time, so no server code is ever bundled or run here. Phase 0 stood
// this in as `AppRouter = any` until apps/server's router existed; it's
// built out now, so every procedure call below (`trpc().settings...`,
// `.agents...`, `.tasks...`, etc.) is fully typed end-to-end.
import type { AppRouter } from '@katnor/server';
import { env } from '$env/dynamic/public';

export type { AppRouter };

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

/**
 * apps/server's base origin, with no trailing slash - for resolving a
 * relative URL it hands back outside of tRPC's own response shape, e.g.
 * artifacts.getUrl's `/artifacts/raw/:key` in local-storage mode (see
 * apps/web/src/routes/artifacts/+page.svelte). A presigned S3 URL from that
 * same procedure is already absolute and doesn't need this.
 */
export function serverOrigin(): string {
  return serverUrl.replace(/\/+$/, '');
}

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

  // `url` is a top-level option; `init` is the SvelteKit request context
  // (its `url` is a URL object, which is why passing a string in there did
  // not typecheck). Nesting the endpoint inside `init` meant it was never
  // applied: with no init the client saw `{ url: '<string>' }` and read
  // `.origin` off a string, and with an init the spread overwrote it. So
  // the browser client never actually pointed at PUBLIC_SERVER_URL - the
  // exact default the comment above says this avoids.
  const client = createTRPCClient<AppRouter>({
    url: trpcUrl,
    init,
  });

  if (isBrowser) browserClient = client;

  return client;
}

import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
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
// app - so the client always points at an absolute, external URL. That is
// why this uses @trpc/client directly rather than trpc-sveltekit: the
// latter's `url` option is typed `/${string}`, a same-origin path, and it
// builds the final URL from the SvelteKit request's own origin. It cannot
// address another origin at all, which is exactly what this app needs.
//
// Read via $env/dynamic/public (not $env/static/public) so the URL is
// resolved at request/runtime rather than baked in at build time, since the
// built Docker image may be deployed with a different PUBLIC_SERVER_URL than
// the one present when it was built.
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

function createClient() {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: trpcUrl,
        // apps/server sets a credentialed CORS policy (exact origin,
        // `credentials: true`) precisely so the `katnor_session` cookie can
        // travel to its separate origin. Cross-origin fetch omits cookies
        // unless asked, so every protected procedure would 401 without this.
        fetch(input, init) {
          return globalThis.fetch(input, { ...init, credentials: 'include' });
        },
      }),
    ],
  });
}

let browserClient: ReturnType<typeof createClient> | undefined;

/**
 * Returns a tRPC client for talking to apps/server's tRPC router.
 *
 * In the browser, a single client is created and reused. During SSR (in
 * `load` functions) a fresh client is created per call, so no state is
 * shared between concurrent requests.
 */
export function trpc() {
  const isBrowser = typeof window !== 'undefined';

  if (isBrowser && browserClient) return browserClient;

  const client = createClient();

  if (isBrowser) browserClient = client;

  return client;
}

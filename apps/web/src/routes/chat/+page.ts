// Client-only - this page talks straight to apps/server's live tRPC and WebSocket APIs on mount, so there's nothing for SvelteKit's SSR `load` to do (see settings/+page.ts).
export const ssr = false;

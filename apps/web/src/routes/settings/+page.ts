// This page talks directly to a live backend (apps/server, a separate
// deployable) via tRPC as soon as it mounts, and never needs data from
// SvelteKit's own SSR `load` pipeline. Rendering it client-only keeps the
// "server may not be up yet" case (very likely in early Phase 0 dev) a
// normal in-page error state instead of a failed SSR render/500 page.
export const ssr = false;

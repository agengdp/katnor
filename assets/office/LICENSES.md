# Office assets

PLAN.md's original design for the 2D office (section 4.8) calls for a top-down
pixel-art scene built with Phaser 3, a Tiled map, and a permissively-licensed
sprite pack (e.g. LimeZu's "Modern Office" or a Kenney pack).

**This directory is currently empty on purpose.** The Phase 4 implementation
(`apps/web/src/routes/office/+page.svelte`) renders the office with the
Canvas 2D API instead - flat colored circles (a stable per-agent hue,
initials, and a name label), not sprites - for two reasons specific to how
this project has been built:

1. **No way to source real art.** The environment these phases were built in
   has no network access to download a licensed asset pack (and LimeZu's is a
   paid pack that couldn't be legally bundled into this repo even with
   network access). Fabricating "pixel art" by hand isn't a real substitute
   for a licensed pack, so rather than ship something that looks like a
   broken attempt at one, the office uses a clean, flat visual style
   consistent with the rest of the dashboard.
2. **No way to verify a game-engine dependency.** Phaser 3 (plus Tiled JSON
   loading and EasyStar.js pathfinding) is a large runtime surface that
   couldn't be installed or checked against its real API in this sandbox. A
   wrong guess there risks breaking the whole `apps/web` build, unlike a
   backend-only dependency where a wrong guess only fails typecheck. Canvas
   2D's API is small, stable, and already used correctly elsewhere in this
   codebase (the Knowledge page's graph explorer), so it was used again here.

## What still works exactly as PLAN.md describes

Desks per agent, states driven by the live event stream (idle/working/
talking/waiting_human/blocked/offline), click-through zones (whiteboard →
Projects, bookshelf → Knowledge, server rack → Runs, reception → Inbox), a
day/night tint that tracks spend against budget, and the Team page's
accessibility fallback showing the same live status - none of that is a
stub; only the rendering technology and the pathfinding (a direct lerp
instead of grid-based routing, since there's no wall layout to route around
yet) are substituted.

## Dropping in a real asset pack later

To swap in real sprites: add a Tiled map + tileset + sprite sheets under this
directory, add `phaser` (and `easystarjs` for grid pathfinding) to
`apps/web/package.json`, and replace `apps/web/src/routes/office/+page.svelte`'s
canvas renderer with a Phaser `Scene` that reads from the same
`apps/web/src/lib/office/liveStatus.svelte.ts` store and
`apps/web/src/lib/office/layout.ts` zone/desk positions - both were written
independently of the rendering technology for exactly this reason. Record
whatever pack you use here, with its license, before committing its files.

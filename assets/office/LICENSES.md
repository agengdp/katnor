# Office assets

PLAN.md section 4.8 calls for a top-down pixel-art scene built with Phaser 3,
a Tiled map, and a permissively-licensed sprite pack (e.g. LimeZu's "Modern
Office" or a Kenney pack).

**This directory is empty on purpose, and there is nothing here to license.**
The office in `apps/web/src/routes/office/+page.svelte` uses the Canvas 2D
API, and its characters are generated at runtime rather than loaded from
files.

## Why there is no pack here

1. **No way to source real art.** The environment this was built in has no
   network access to download a licensed asset pack, and the pack PLAN.md
   names is paid - it could not legally be bundled into this repo even with
   network access.
2. **No way to verify a game-engine dependency.** Phaser 3 (plus Tiled JSON
   loading and EasyStar.js pathfinding) is a large runtime surface that
   couldn't be installed or checked against its real API here. A wrong guess
   there breaks the whole `apps/web` build, unlike a backend-only dependency
   where a wrong guess only fails typecheck. Canvas 2D's API is small,
   stable, and already used correctly elsewhere in this codebase (the
   Knowledge page's graph explorer).

## What the characters are instead

`apps/web/src/lib/office/sprite.ts` generates a pixelated 2D character per
agent: one shared 16x16 humanoid template, with skin tone, hair colour, hair
style (short / long / bun / cap), glasses and trouser colour all chosen
deterministically from the agent's id, and the shirt taking the hue that
agent already has elsewhere in the dashboard. `spriteCanvas.ts` rasterises
each one once at an integer scale and the office blits it, with
`imageSmoothingEnabled` off so the pixel grid stays square.

Generating them rather than hand-drawing one fixed character is the point: a
single hand-placed sprite would give every agent the same body, which is the
opposite of what a per-agent character is for.

Everything generated here is original output of code in this repo, so it
carries this repo's own license. There is no third-party art to attribute.

## What still works exactly as PLAN.md describes

Desks per agent, states driven by the live event stream (idle/working/
talking/waiting_human/blocked/offline), click-through zones (whiteboard to
Projects, bookshelf to Knowledge, server rack to Runs, reception to Inbox), a
day/night tint that tracks spend against budget, and the Team page's
accessibility fallback showing the same live status - none of that is a
stub. What is substituted is the rendering technology and the pathfinding (a
direct lerp instead of grid-based routing, since there is no wall layout to
route around yet).

## Dropping in a real asset pack later

To swap in real sprites: add a Tiled map + tileset + sprite sheets under this
directory, add `phaser` (and `easystarjs` for grid pathfinding) to
`apps/web/package.json`, and replace the canvas renderer in
`apps/web/src/routes/office/+page.svelte` with a Phaser `Scene` that reads
from the same `apps/web/src/lib/office/liveStatus.svelte.ts` store and
`apps/web/src/lib/office/layout.ts` zone/desk positions - both were written
independently of the rendering technology for exactly this reason.

For characters specifically, the smaller swap is to replace `sprite.ts` with
a loader that reads a sprite sheet: `spriteCanvas.ts` and every caller keep
working, since they only ever see "give me this agent's frame N".

**Record whatever pack you use here, with its license, before committing its
files.**

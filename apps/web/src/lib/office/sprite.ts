/**
 * Generates a pixelated 2D character per agent, procedurally.
 *
 * PLAN.md 4.8 asks for sprite characters from a permissively licensed
 * pixel-art pack. assets/office/LICENSES.md records why there is no pack in
 * this repo: the environment this was built in cannot reach any asset host
 * to download one, and the pack PLAN.md names is paid and could not be
 * bundled here regardless. Hand-placing pixels for one fixed character
 * would also give every agent the same body, which is the opposite of what
 * a per-agent character is for.
 *
 * So the characters are generated instead: one shared 16x16 humanoid
 * template, with skin tone, hair colour, hair style, glasses and trouser
 * colour all chosen deterministically from the agent's id. The shirt takes
 * the agent's existing `hashColor` hue, so the colour identity an agent
 * already has on the Team page carries onto its character rather than
 * competing with it.
 *
 * Deterministic matters for more than tidiness: desks, colours and now
 * characters are all derived from the id, so an agent looks identical
 * across reloads, browsers and machines with nothing persisted anywhere.
 *
 * This module is pure - no canvas, no DOM, no Svelte. ./spriteCanvas.ts
 * rasterises what this returns. That split is what makes the generator
 * testable, and it is also what makes a real asset pack a drop-in later:
 * swap this for a loader that reads sprite sheets and ./spriteCanvas.ts
 * keeps working.
 */

import { hashColor } from './layout.js';

/**
 * One character, as pixel rows. Each character in a row is a palette key
 * (see `SpritePalette`); `.` is transparent.
 *
 * Strings rather than a number grid so the template below is legible as
 * the picture it actually is - a reader can see the character in the
 * source, which is the whole point of pixel art.
 */
export interface Sprite {
  /** Frame 0 is standing, frame 1 is mid-stride. Both are `SPRITE_SIZE` rows of `SPRITE_SIZE` characters. */
  frames: readonly (readonly string[])[];
  palette: SpritePalette;
}

export type SpritePalette = Record<string, string>;

export const SPRITE_SIZE = 16;

/**
 * The shared body. Every agent is this shape; only the palette and a few
 * per-agent overlays (hair style, glasses) differ, which is what keeps a
 * roomful of generated characters looking like one cast rather than a
 * pile of unrelated doodles.
 *
 * Keys: H hair, S skin, T top/shirt, P trousers, K outline/shoes,
 * E eye, W white (glasses lens).
 */
const BODY: readonly string[] = [
  '................',
  '.....HHHHHH.....',
  '....HHHHHHHH....',
  '....HSSSSSSH....',
  '....HSSSSSSH....',
  '....HSSSSSSH....',
  '.....SSSSSS.....',
  '......SSSS......',
  '...TTTTTTTTTT...',
  '..STTTTTTTTTTS..',
  '..STTTTTTTTTTS..',
  '...TTTTTTTTTT...',
  '...TTTTTTTTTT...',
  '...PPPP..PPPP...',
  '...PPPP..PPPP...',
  '...KKK....KKK...',
];

/** Frame 1 replaces only the lower body, so the two frames read as one character taking a step rather than two different characters. */
const STRIDE_ROWS: Readonly<Record<number, string>> = {
  14: '..PPPP....PPPP..',
  15: '..KKK......KKK..',
};

const SKIN_TONES = ['#f4d7bd', '#e8b98c', '#cf9463', '#a26b3f', '#6f4527'] as const;
const HAIR_COLORS = ['#241a12', '#4a2f1c', '#96581f', '#d8b45c', '#9aa0a6', '#3a2f6b'] as const;
const TROUSER_COLORS = ['#39404f', '#2b3038', '#4a3f35', '#26384a', '#4b3550'] as const;
const OUTLINE = '#1b1f27';

type HairStyle = 'short' | 'long' | 'bun' | 'cap';
const HAIR_STYLES: readonly HairStyle[] = ['short', 'long', 'bun', 'cap'];

/**
 * A tiny deterministic generator seeded from the agent id.
 *
 * Successive `next()` calls pick successive features, so adding a feature
 * later shifts every choice after it - which would reshuffle everyone's
 * appearance. New features therefore go at the end of `buildSprite`, not
 * in the middle.
 */
function seededRandom(id: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < id.length; i++) {
    state ^= id.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    // xorshift32 - small, deterministic, and good enough for picking one
    // of five hair colours.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  // items is never empty at any call site below, but the index type does
  // not know that - falling back to the first keeps this total.
  return item ?? (items[0] as T);
}

function toGrid(rows: readonly string[]): string[][] {
  return rows.map((row) => [...row]);
}

function setPixel(grid: string[][], row: number, col: number, key: string): void {
  const line = grid[row];
  if (line && col >= 0 && col < line.length) line[col] = key;
}

/** Hair style is drawn as an overlay on the shared body rather than as four separate templates, so a body change never has to be made four times. */
function applyHair(grid: string[][], style: HairStyle): void {
  switch (style) {
    case 'short':
      break;
    case 'long':
      // Falls past the jaw on both sides. Both columns of each strand are
      // filled on both rows: leaving the inner column bare put a
      // transparent pixel between the hair and the face, which reads as a
      // floating fleck rather than as hair.
      for (const row of [6, 7]) {
        for (const col of [4, 5, 10, 11]) setPixel(grid, row, col, 'H');
      }
      break;
    case 'bun':
      setPixel(grid, 0, 7, 'H');
      setPixel(grid, 0, 8, 'H');
      break;
    case 'cap':
      // A brim across the brow - the one style that changes the silhouette.
      for (let col = 3; col <= 12; col++) setPixel(grid, 3, col, 'H');
      break;
  }
}

function applyFace(grid: string[][], glasses: boolean): void {
  if (!glasses) {
    setPixel(grid, 4, 6, 'E');
    setPixel(grid, 4, 9, 'E');
    return;
  }
  // Two lenses joined by a bridge, replacing the bare eyes rather than
  // sitting on top of them.
  const lens = ['K', 'W', 'K', 'K', 'W', 'K'];
  lens.forEach((key, i) => setPixel(grid, 4, 5 + i, key));
}

/**
 * Builds the two-frame character for an agent id. Same id in, same
 * character out, always.
 */
export function buildSprite(agentId: string): Sprite {
  const random = seededRandom(agentId);
  const skin = pick(SKIN_TONES, random);
  const hair = pick(HAIR_COLORS, random);
  const trousers = pick(TROUSER_COLORS, random);
  const style = pick(HAIR_STYLES, random);
  const glasses = random() < 0.35;

  const standing = toGrid(BODY);
  applyHair(standing, style);
  applyFace(standing, glasses);

  const striding = standing.map((row, index) => {
    const replacement = STRIDE_ROWS[index];
    return replacement ? [...replacement] : [...row];
  });

  return {
    frames: [standing.map((row) => row.join('')), striding.map((row) => row.join(''))],
    palette: {
      H: hair,
      S: skin,
      T: hashColor(agentId),
      P: trousers,
      K: OUTLINE,
      E: OUTLINE,
      W: '#ffffff',
    },
  };
}

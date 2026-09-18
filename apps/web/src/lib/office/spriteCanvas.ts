import { buildSprite, SPRITE_SIZE } from './sprite.js';

/**
 * Rasterises the characters from ./sprite.ts onto offscreen canvases the
 * Office scene can blit.
 *
 * Each character is drawn pixel-by-pixel exactly once and cached, then
 * `drawImage`d every frame. Doing it the other way round - 256 `fillRect`
 * calls per agent per frame, at 60fps, for a roomful of agents - is tens
 * of thousands of draw calls a second for an image that never changes.
 *
 * Rasterising at an integer scale (rather than drawing at 1x and letting
 * `drawImage` stretch it) is what actually keeps the pixels square: a
 * fractional scale lands source pixels on half-destination-pixels and the
 * character comes out visibly uneven, whatever `imageSmoothingEnabled`
 * says.
 */

/**
 * Logical canvas pixels per sprite pixel. 3 gives a 48x48 character on the
 * office's 960x600 logical grid - large enough that the pixel grid is
 * plainly visible at the sizes the scene is actually viewed at.
 */
export const SPRITE_SCALE = 3;

/** Rendered size of one character, in the office's logical canvas units. */
export const SPRITE_PIXELS = SPRITE_SIZE * SPRITE_SCALE;

const cache = new Map<string, HTMLCanvasElement>();

/**
 * Returns the rendered character for `agentId` at `frame` (0 standing, 1
 * mid-stride), building and caching it on first use. Returns null only
 * when there is no 2D context to draw into, which callers treat as "skip
 * the sprite this frame" rather than as an error.
 */
export function spriteImage(agentId: string, frame: 0 | 1): HTMLCanvasElement | null {
  const key = `${agentId}:${frame}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const sprite = buildSprite(agentId);
  const rows = sprite.frames[frame] ?? sprite.frames[0];
  if (!rows) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_PIXELS;
  canvas.height = SPRITE_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = sprite.palette[row[x] as string];
      if (!color) continue; // '.' and anything unmapped stays transparent
      ctx.fillStyle = color;
      ctx.fillRect(x * SPRITE_SCALE, y * SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE);
    }
  });

  cache.set(key, canvas);
  return canvas;
}

/**
 * Blits a character centred on (x, y).
 *
 * `imageSmoothingEnabled` is turned off around the blit and restored
 * after: the office draws smooth vector shapes and text in the same pass,
 * and leaving it off would make all of those jagged too.
 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  agentId: string,
  frame: 0 | 1,
  x: number,
  y: number,
): void {
  const image = spriteImage(agentId, frame);
  if (!image) return;
  const previousSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, Math.round(x - SPRITE_PIXELS / 2), Math.round(y - SPRITE_PIXELS / 2));
  ctx.imageSmoothingEnabled = previousSmoothing;
}

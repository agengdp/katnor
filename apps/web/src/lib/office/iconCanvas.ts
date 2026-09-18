import { FILLED_ICONS, ICON_PATHS, type IconName } from '../icons/paths.js';

/**
 * Draws icons from ../icons/paths.ts onto a 2D canvas, so the Office scene
 * uses the same icon set as the rest of the dashboard instead of a second,
 * canvas-only one.
 *
 * `Path2D` objects are built lazily and cached: constructing one parses
 * the path data, and the office redraws every frame via
 * requestAnimationFrame, so re-parsing per frame would be pure waste. Lazy
 * rather than at module scope because `Path2D` is a browser global that
 * does not exist during SvelteKit's SSR pass, and this module is imported
 * by a page that server-renders.
 */
const cache = new Map<IconName, Path2D[]>();

function pathsFor(name: IconName): Path2D[] {
  let paths = cache.get(name);
  if (!paths) {
    paths = ICON_PATHS[name].map((d) => new Path2D(d));
    cache.set(name, paths);
  }
  return paths;
}

export interface DrawIconOptions {
  /** Center of the drawn icon, in canvas coordinates. */
  x: number;
  y: number;
  /** Rendered edge length. The 24x24 source grid is scaled to this. */
  size: number;
  color: string;
  /**
   * Stroke width in *final* canvas pixels. Scaled back through the icon's
   * own transform so an icon drawn at 18px and one drawn at 40px share a
   * stroke weight, rather than the larger one growing a heavy outline.
   */
  lineWidth?: number;
}

export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  { x, y, size, color, lineWidth = 2 }: DrawIconOptions,
): void {
  const scale = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth / scale;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const filled = FILLED_ICONS.has(name);
  for (const path of pathsFor(name)) {
    if (filled) ctx.fill(path);
    ctx.stroke(path);
  }
  ctx.restore();
}

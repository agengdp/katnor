// Plain, non-reactive geometry helpers for the Office canvas (see
// ../../routes/office/+page.svelte). A logical, fixed-size coordinate
// space (CANVAS_WIDTH x CANVAS_HEIGHT) that the page scales to fit its
// container via CSS, same approach as the Knowledge page's SVG graph.

export interface Point {
  x: number;
  y: number;
}

export interface Zone {
  id: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where clicking this zone navigates to - PLAN.md 4.8's "click the whiteboard/bookshelf/rack -> open the matching dashboard page". */
  href: string;
}

export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 600;

export const RECEPTION: Point = { x: 90, y: 100 };
export const MEETING_ROOM: Point = { x: CANVAS_WIDTH / 2, y: 190 };
export const MEETING_ROOM_SIZE = { width: 200, height: 110 };

/** A stable, distinct-enough color per agent id, so the same agent always reads as the same color across a session without needing a real sprite palette. */
export function hashColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** A simple grid of desks below the zones/meeting-room row - one per non-CEO agent, in a stable id-sorted order so desk assignment doesn't shuffle as agents load. */
export function deskPositions(count: number): Point[] {
  if (count === 0) return [];
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(count * 1.4))));
  const marginX = 90;
  const spacingX = (CANVAS_WIDTH - marginX * 2) / cols;
  const spacingY = 110;
  const startY = 320;
  const positions: Point[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({ x: marginX + spacingX * col + spacingX / 2, y: startY + row * spacingY });
  }
  return positions;
}

export function zones(): Zone[] {
  return [
    { id: 'reception', label: 'Reception (Inbox)', icon: '📥', x: 30, y: 30, width: 110, height: 90, href: '/inbox' },
    { id: 'whiteboard', label: 'Whiteboard (Projects)', icon: '📋', x: CANVAS_WIDTH - 240, y: 30, width: 90, height: 70, href: '/projects' },
    { id: 'bookshelf', label: 'Bookshelf (Knowledge)', icon: '📚', x: CANVAS_WIDTH - 140, y: 30, width: 90, height: 70, href: '/knowledge' },
    { id: 'rack', label: 'Server rack (Runs)', icon: '⚙️', x: CANVAS_WIDTH - 240, y: 120, width: 90, height: 70, href: '/runs' },
  ];
}

export function pointInRect(x: number, y: number, rectX: number, rectY: number, width: number, height: number): boolean {
  return x >= rectX && x <= rectX + width && y >= rectY && y <= rectY + height;
}

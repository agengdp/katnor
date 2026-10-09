/**
 * Office layout shared by the Three.js room (placement slots mapped onto
 * the floor in percentages) and the UI chrome that still uses the 2D
 * character sprites (side panel, decision popup, activity log avatars):
 * desk/meeting/reception/water coordinates, plus deterministic
 * hash-based character casting so every employee keeps a stable look
 * across reloads.
 */

export interface OfficeSpot {
  id: string;
  /** Percent across the room floor (0-100). */
  x: number;
  /** Percent along the room floor (0-100). */
  y: number;
}

export interface ZoneHref {
  id: string;
  href: string;
}

/** Dashboard pages reachable by clicking the room's labeled zones. */
export const ZONE_HREFS: Record<string, string> = {
  reception: '/chat',
  kanban: '/projects',
  bookshelf: '/knowledge',
  dashboard: '/runs',
};

/** Character sprite bases available under /office/sprites/characters/. */
export const CHAR_BASES = [
  'dev-1',
  'dev-2',
  'employee-1',
  'employee-2',
  'employee-3',
  'explore-1',
] as const;
export const CEO_CHAR_BASE = 'Claude-1';
export const OWNER_CHAR_BASE = 'Me-1';

/** Desk spots, in assignment order (index 0 = the owner/CEO area desk). */
export const DESK_SPOTS: OfficeSpot[] = [
  { id: 'spot-1', x: 25.8, y: 71 },
  { id: 'spot-2', x: 37.9, y: 68.2 },
  { id: 'spot-3', x: 26.9, y: 59.2 },
  { id: 'spot-4', x: 38.5, y: 55.2 },
  { id: 'spot-5', x: 48.9, y: 52.9 },
  { id: 'spot-6', x: 38.8, y: 43.6 },
  { id: 'spot-7', x: 52.7, y: 78.8 },
  { id: 'spot-8', x: 65.9, y: 75.8 },
  { id: 'spot-9', x: 55.2, y: 66.8 },
  { id: 'spot-10', x: 68.7, y: 66.2 },
];

/** Meeting-table spots — talking agents gather here (facing each other). */
export const MEETING_SPOTS: OfficeSpot[] = [
  { id: 'meet-1', x: 45.5, y: 61.5 },
  { id: 'meet-2', x: 48.5, y: 63.5 },
  { id: 'meet-3', x: 43, y: 64 },
  { id: 'meet-4', x: 50.5, y: 61 },
];

/** Reception area — the CEO stands here; waiting agents queue behind. */
export const RECEPTION_SPOT: OfficeSpot = { id: 'reception', x: 60, y: 50 };
export const RECEPTION_QUEUE: OfficeSpot[] = [
  { id: 'queue-1', x: 57.5, y: 53 },
  { id: 'queue-2', x: 62.5, y: 54.5 },
  { id: 'queue-3', x: 55, y: 55.5 },
  { id: 'queue-4', x: 65, y: 57 },
];

/** Water cooler — idle agents drift here (front-left of staff room). */
export const WATER_SPOT: OfficeSpot = { id: 'water', x: 40.6, y: 86.5 };

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable character look per employee id (deterministic, survives reloads). */
export function charBaseFor(agentId: string, isCeo: boolean): string {
  if (isCeo) return CEO_CHAR_BASE;
  return CHAR_BASES[hashString(agentId) % CHAR_BASES.length];
}

export function spritePath(
  base: string,
  facing: 'front-left' | 'front-right' | 'rear-left' | 'rear-right',
): string {
  return `/office/sprites/characters/${base}-${facing}.png`;
}

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WATER_SPOT } from './officeLayout';
import type { LiveAgentState } from './liveStatus.svelte';
import type { BatuWeatherKind } from './batuWeather';

/**
 * Pure Three.js office scene (no Svelte reactivity inside): a four-floor
 * building — parking, kitchen & dining, workspace, rooftop — with tall
 * sealed floors (focus mode isolates exactly one floor), a wall clock
 * following Batu time, and the Batu weather persona expressed through
 * sun/lamp lighting mood, the workspace clerestory windows' sky tint,
 * plus the live badge in the UI chrome (no floating sky panels).
 *
 * Placement rules — CEO at the executive desk (west end of the open
 * room), talking staff at the meeting table, waiting staff queued at the meeting door, everyone else split
 * across all four floors (workspace desks, kitchen tables, rooftop
 * jam corner + stargazers, parking lane) so every level stays alive
 * and nobody stacks.
 * One idle agent drifts to the pantry; every 45s another roams to a
 * different floor for a visit. Floor changes always route through the
 * lift: walk to the lift lobby, ride the cabin, walk out to the slot.
 */

export interface RoomAgent {
  id: string;
  name: string;
  is_system: boolean;
  state: LiveAgentState;
  detail: string | null;
  status: 'active' | 'paused' | 'offline';
}

interface Callbacks {
  onSelectAgent: (agentId: string) => void;
  onSelectZone: (zoneId: string) => void;
}

export type FloorId = 'parking' | 'kitchen' | 'workspace' | 'rooftop';

export interface FloorMeta {
  id: FloorId;
  label: string;
  icon: string;
}

export const FLOORS: FloorMeta[] = [
  { id: 'parking', label: 'Parking', icon: '🅿️' },
  { id: 'kitchen', label: 'Kitchen & Dining', icon: '🍽️' },
  { id: 'workspace', label: 'Workspace', icon: '💻' },
  { id: 'rooftop', label: 'Rooftop', icon: '🌇' },
];

export interface OfficeScene {
  setRoster: (agents: RoomAgent[]) => void;
  setNight: (value: number) => void;
  setWeather: (kind: BatuWeatherKind) => void;
  setClock: (hour: number, minute: number) => void;
  setFloor: (floor: FloorId) => void;
  /** Wide pullback showing all four floors stacked (building section). */
  setOverview: (all: boolean) => void;
  /** Freeze walking animation; camera stays user-driven. */
  setPaused: (paused: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  /** Ease the camera back to the active floor (or overview) viewpoint. */
  resetView: () => void;
  /** Dolly the viewpoint in (>1) or out (<1), clamped to orbit limits. */
  dolly: (factor: number) => void;
  setSelected: (agentId: string | null) => void;
  /** Manual order: walk this agent to another floor via the lift. */
  sendToFloor: (agentId: string, floor: FloorId) => void;
  dispose: () => void;
}

const ROOM_W = 26;
const ROOM_D = 17;
// Tall, airy floors: generous headroom so a focused floor never feels
// cramped. Walls span the full inter-floor gap, sealing each level up
// to the plate above it.
const WALL_H = 7.5;
const FLOOR_GAP = WALL_H + 4.2;

type SlotKind =
  | 'desk'
  | 'meeting'
  | 'queue'
  | 'reception'
  | 'water'
  | 'dine'
  | 'lounge'
  | 'deck'
  | 'park'
  | 'lift'
  | 'guitar'
  | 'drums'
  | 'stargaze';

/** Rooftop fun: which instrument/spot a seated roamer is enjoying. */
type RoofActivity = 'guitar' | 'drums' | 'stargaze' | null;

function activityForKind(kind: SlotKind): RoofActivity {
  if (kind === 'guitar') return 'guitar';
  if (kind === 'drums') return 'drums';
  if (kind === 'stargaze') return 'stargaze';
  return null;
}

/** Chair slots want a seated pose (desks, meeting, dining, rooftop fun). */
function isSeatKind(kind: SlotKind): boolean {
  return (
    kind === 'desk' ||
    kind === 'meeting' ||
    kind === 'dine' ||
    kind === 'lounge' ||
    kind === 'guitar' ||
    kind === 'drums' ||
    kind === 'stargaze'
  );
}

interface Slot {
  floor: FloorId;
  x: number;
  z: number;
  yaw: number;
  kind: SlotKind;
}

function toWorld(xPct: number, yPct: number): { x: number; z: number } {
  return { x: (xPct / 100 - 0.5) * ROOM_W, z: (yPct / 100 - 0.5) * ROOM_D };
}

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function agentColor(id: string, isSystem: boolean): THREE.Color {
  if (isSystem) return new THREE.Color('#d4a437');
  return new THREE.Color(`hsl(${hashHue(id)}, 55%, 52%)`);
}

const RING_COLORS: Record<LiveAgentState, string> = {
  idle: '#6b7280',
  working: '#4ade80',
  talking: '#60a5fa',
  waiting_human: '#fbbf24',
  blocked: '#f87171',
  offline: '#4b5563',
};

function bubbleFor(agent: RoomAgent, activity?: RoofActivity | null): string | null {
  if (agent.status !== 'active') return null;
  if (activity === 'guitar') return '🎸 lagi main gitar…';
  if (activity === 'drums') return '🥁 lagi main drum…';
  if (activity === 'stargaze') return '✨ selonjoran lihat langit…';
  if (agent.state === 'talking') return agent.detail ?? 'lagi diskusi…';
  if (agent.state === 'working') return agent.detail ?? 'lagi kerja…';
  if (agent.state === 'waiting_human') return 'Butuh keputusanmu…';
  if (agent.state === 'blocked') return 'Terhambat 😖';
  return null;
}

/** Pill color per state, like the reference's colored activity pills. */
const BUBBLE_BG: Record<string, string> = {
  working: '#065f46',
  talking: '#1d4ed8',
  waiting_human: '#b45309',
  blocked: '#b91c1c',
  idle: '#3f3f46',
  offline: '#1a1a10',
};

function effectFor(
  agent: RoomAgent,
  waterId: string | null,
  activity?: RoofActivity | null,
): string | null {
  if (agent.status !== 'active') return '💤';
  if (activity === 'guitar') return '🎶';
  if (activity === 'drums') return '🥁';
  if (activity === 'stargaze') return '✨';
  switch (agent.state) {
    case 'working':
      return '⚡';
    case 'talking':
      return '💬';
    case 'idle':
      return agent.id === waterId ? '☕' : null;
    default:
      return null;
  }
}

/** Small deterministic PRNG for bookshelf colors etc. (stable across reloads). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(10, 10, 15, 0.78)';
    ctx.fillRect(0, 0, 256, 56);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 18), 128, 30, 240);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.1, 0.46, 1);
  return sprite;
}

function makeTextSprite(text: string, fontSize: number, bg: string, fg: string): THREE.Sprite {
  const short = text.length > 80 ? `${text.slice(0, 77)}…` : text;
  const canvas = document.createElement('canvas');
  const measure = document.createElement('canvas').getContext('2d');
  let width = 200;
  if (measure) {
    measure.font = `${fontSize}px system-ui, sans-serif`;
    width = Math.min(520, Math.max(120, Math.ceil(measure.measureText(short).width) + 36));
  }
  canvas.width = width;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, 64);
    ctx.fillStyle = fg;
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(short, width / 2, 34, width - 24);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  sprite.scale.set(width / 110, 0.58, 1);
  return sprite;
}

function makeEmojiSprite(emoji: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '68px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 48, 52);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  sprite.scale.set(0.62, 0.62, 1);
  return sprite;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

interface AgentNode {
  data: RoomAgent;
  group: THREE.Group;
  rig: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  pantsMat: THREE.MeshStandardMaterial;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  /** Held jam prop (guitar body) for the rooftop guitarist. */
  propGuitar: THREE.Group | null;
  /** Drumsticks held while playing the rooftop kit (attached to arms). */
  propStickL: THREE.Object3D | null;
  propStickR: THREE.Object3D | null;
  /** Head mesh — tilts up for stargazing. */
  head: THREE.Mesh;
  /** Cached slot kind so the frame loop can play jam/stargaze poses. */
  slotKind: SlotKind;
  ringMat: THREE.MeshBasicMaterial;
  selRing: THREE.Mesh;
  label: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleText: string | null;
  effect: THREE.Sprite | null;
  effectText: string | null;
  hit: THREE.Mesh;
  target: THREE.Vector3;
  /** Door waypoints ahead of `target` (meeting-room door routing). */
  waypoints: { x: number; z: number }[];
  desiredYaw: number;
  phase: number;
  /** Chair slot (desk/meeting) wants a seated pose. */
  sitting: boolean;
  /** Eased 0 (stand) → 1 (sit); forced to 0 while walking. */
  sitBlend: number;
  /** Floor group this agent currently parents to. */
  floor: FloorId;
  /** Lift journey phase: at-slot, walking to lift, riding, walking out. */
  leg: 'slot' | 'toLift' | 'inLift' | 'toSlot';
  /** Destination slot once the current lift journey completes. */
  pending: Slot | null;
  /** Elapsed seconds when the agent stepped out of the cabin. */
  alightT: number;
}

export function createOfficeScene(canvas: HTMLCanvasElement, cb: Callbacks): OfficeScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#11161f');

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 260);
  camera.position.set(11.5, 13.5 + FLOOR_GAP * 2, 15.5);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, FLOOR_GAP * 2, -0.5);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 8;
  controls.maxDistance = 70;
  controls.maxPolarAngle = 1.35;
  controls.update();

  // ─── Lights ────────────────────────────────────────────────────────
  const hemi = new THREE.HemisphereLight('#dfeaff', '#3a3226', 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff2df', 1.6);
  sun.position.set(10, 16 + FLOOR_GAP * 2, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 45;
  sun.shadow.camera.bottom = -10;
  sun.shadow.camera.far = 160;
  scene.add(sun);
  const lampA = new THREE.PointLight('#ffd9a0', 0, 30, 1.8);
  lampA.position.set(-6, 3.6 + FLOOR_GAP * 2, 0);
  scene.add(lampA);
  const lampB = new THREE.PointLight('#ffd9a0', 0, 30, 1.8);
  lampB.position.set(6, 3.6 + FLOOR_GAP * 2, 0);
  scene.add(lampB);

  const dayBg = new THREE.Color('#a8c3e2');
  const nightBg = new THREE.Color('#05060c');
  const daySun = new THREE.Color('#fff2df');
  const nightSun = new THREE.Color('#9db8ff');
  // Clerestory window skies (workspace) + pendant bulbs + the office
  // cat's tail: registered by the builders below, driven by
  // applyLight/tick.
  const windowSkyMats: THREE.MeshBasicMaterial[] = [];
  const pendantBulbMats: THREE.MeshBasicMaterial[] = [];
  let catTail: THREE.Object3D | null = null;
  const daySky = new THREE.Color('#bfd9ee');
  const nightSky = new THREE.Color('#0a1424');
  let nightValue = 0;
  /** 1 = clear … 0.45 = storm: overcast Batu afternoons dim the room. */
  let weatherDim = 1;

  function applyLight(): void {
    sun.intensity = THREE.MathUtils.lerp(1.6, 0.25, nightValue) * weatherDim;
    sun.color.lerpColors(daySun, nightSun, nightValue);
    hemi.intensity = THREE.MathUtils.lerp(1.15, 0.35, nightValue) * (0.55 + 0.45 * weatherDim);
    scene.background = new THREE.Color().lerpColors(dayBg, nightBg, nightValue);
    const lamp = nightValue * 22 + (1 - weatherDim) * 10;
    lampA.intensity = lamp;
    lampB.intensity = lamp;
    // Window skies follow Batu day/night + overcast dimming.
    const sky = new THREE.Color().lerpColors(daySky, nightSky, nightValue);
    sky.multiplyScalar(0.35 + 0.65 * weatherDim);
    for (const m of windowSkyMats) m.color.copy(sky);
  }

  function setNight(value: number): void {
    nightValue = Math.min(1, Math.max(0, value));
    applyLight();
  }

  // ─── Weather persona (Batu city) ─────────────────────────────────
  // No floating sky objects and no wall windows: weather shows through
  // sun/lamp mood (see setWeather and applyLight) plus the live badge
  // in the UI chrome.

  const WEATHER_DIM: Record<BatuWeatherKind, number> = {
    clear: 1,
    partly: 0.92,
    cloudy: 0.75,
    fog: 0.7,
    drizzle: 0.62,
    rain: 0.55,
    storm: 0.45,
  };

  function setWeather(kind: BatuWeatherKind): void {
    weatherDim = WEATHER_DIM[kind];
    applyLight();
  }

  // ─── Floor scaffolding ─────────────────────────────────────────────
  // Four stacked plates: index 0 = parking … 3 = rooftop. Every floor
  // is a Group at its own Y so whole levels can hide/show; furniture
  // and agents attach to their floor group.

  const floorY = (index: number): number => index * FLOOR_GAP;
  const floorIndex: Record<FloorId, number> = {
    parking: 0,
    kitchen: 1,
    workspace: 2,
    rooftop: 3,
  };
  const floorGroups: Record<FloorId, THREE.Group> = {
    parking: new THREE.Group(),
    kitchen: new THREE.Group(),
    workspace: new THREE.Group(),
    rooftop: new THREE.Group(),
  };
  for (const meta of FLOORS) {
    floorGroups[meta.id].position.y = floorY(floorIndex[meta.id]);
    scene.add(floorGroups[meta.id]);
  }
  const W = floorGroups.workspace;

  const std = (color: string, roughness = 0.9): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness });

  function addTo(floor: FloorId, obj: THREE.Object3D): void {
    floorGroups[floor].add(obj);
  }

  function floorPlate(floor: FloorId, color: string): void {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, 0.35, ROOM_D), std('#3a3448'));
    plate.position.y = -0.18;
    plate.receiveShadow = true;
    addTo(floor, plate);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), std(color, 0.95));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.005;
    top.receiveShadow = true;
    addTo(floor, top);
  }

  // Walls span the full inter-floor gap so each level reads sealed up
  // to the plate above it (no floating gap between floors).
  const WALL_SPAN = FLOOR_GAP + 0.35;

  function backWall(floor: FloorId, color: string): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W + 0.8, WALL_SPAN, 0.4), std(color));
    wall.position.set(0, WALL_SPAN / 2, -ROOM_D / 2 - 0.2);
    wall.receiveShadow = true;
    addTo(floor, wall);
  }

  function leftWall(floor: FloorId, color: string): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, WALL_SPAN, ROOM_D + 0.8), std(color));
    wall.position.set(-ROOM_W / 2 - 0.2, WALL_SPAN / 2, 0);
    wall.receiveShadow = true;
    addTo(floor, wall);
  }

  function floorTitle(floor: FloorId, text: string): void {
    const sprite = makeTextSprite(text, 30, 'rgba(10,10,15,0.78)', '#ffd9a0');
    sprite.position.set(-ROOM_W / 2 + 3.2, 3.4, ROOM_D / 2 - 1.2);
    sprite.scale.multiplyScalar(0.9);
    addTo(floor, sprite);
  }

  // Extra props outside floor groups: lift spine (stacked view only)
  // and the city ring (overview only). Declared up here so the floor
  // builders below can register into them.
  const spineExtras: THREE.Object3D[] = [];
  const cityExtras: THREE.Object3D[] = [];

  // Shared building spine: open-front elevator shaft (hollow, so the
  // cabin reads inside) + one sliding door pair per floor. Each pair
  // belongs to its own floor so focused floors keep their lift entrance.
  // The lift lobby (inside every floor, in front of its doors) is the
  // single choke point for floor changes: agents walk here, board the
  // one cabin, ride it, and walk out to their slot.
  const LIFT_LOBBY = { x: ROOM_W / 2 - 1.4, z: ROOM_D / 2 - 3.4 };
  const LIFT_SHAFT = { x: ROOM_W / 2 + 1.4, z: ROOM_D / 2 - 3.4 };
  const CABIN_HALF = 0.85;
  const doorLeaves: Record<FloorId, { left: THREE.Mesh; right: THREE.Mesh }> = {} as Record<
    FloorId,
    { left: THREE.Mesh; right: THREE.Mesh }
  >;
  {
    // Hollow open-front shaft (frame, not a solid box) so the glass
    // cabin reads inside from the orbit camera. Two side walls + lintel
    // strips per level; open toward the rooms (west face) and the front.
    const shaftMat = std('#2c2838');
    const shaftParts: THREE.Object3D[] = [];
    const WALL_T = 0.3;
    for (let i = 0; i < 4; i++) {
      const y0 = floorY(i);
      for (const gz of [-1, 1] as const) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(2.2, FLOOR_GAP, WALL_T), shaftMat);
        const gzAbs = LIFT_SHAFT.z + gz * (CABIN_HALF + 0.35);
        side.position.set(LIFT_SHAFT.x, y0 + FLOOR_GAP / 2, gzAbs);
        side.castShadow = true;
        side.receiveShadow = true;
        scene.add(side);
        shaftParts.push(side);
      }
      const backWallMesh = new THREE.Mesh(
        new THREE.BoxGeometry(WALL_T, FLOOR_GAP, ROOM_D * 0.42),
        shaftMat,
      );
      backWallMesh.position.set(LIFT_SHAFT.x + CABIN_HALF + 0.5, y0 + FLOOR_GAP / 2, LIFT_SHAFT.z);
      backWallMesh.castShadow = true;
      backWallMesh.receiveShadow = true;
      scene.add(backWallMesh);
      shaftParts.push(backWallMesh);
    }
    const cap = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, ROOM_D * 0.42 + 0.6), shaftMat);
    cap.position.set(LIFT_SHAFT.x, floorY(3) + FLOOR_GAP / 2 + 1.2, LIFT_SHAFT.z);
    scene.add(cap);
    shaftParts.push(cap);
    for (const p of shaftParts) spineExtras.push(p);
    const leafMat = new THREE.MeshStandardMaterial({
      color: '#9fb4c8',
      emissive: '#22d3ee',
      emissiveIntensity: 0.15,
      roughness: 0.35,
      metalness: 0.55,
    });
    const floorIds: FloorId[] = ['parking', 'kitchen', 'workspace', 'rooftop'];
    for (let i = 0; i < 4; i++) {
      // Two sliding leaves with a glowing center seam; each pair parents
      // to its floor group (local Y) so the entrance survives isolation.
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.1, 0.62), leafMat);
      const right = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.1, 0.62), leafMat);
      left.position.set(ROOM_W / 2 + 0.29, 1.15, ROOM_D / 2 - 3.4 - 0.31);
      right.position.set(ROOM_W / 2 + 0.29, 1.15, ROOM_D / 2 - 3.4 + 0.31);
      addTo(floorIds[i], left);
      addTo(floorIds[i], right);
      doorLeaves[floorIds[i]] = { left, right };
    }
    const label = makeTextSprite('🛗 Lift', 30, 'rgba(10,10,15,0.78)', '#a5f3fc');
    label.position.set(ROOM_W / 2 + 1.4, FLOOR_GAP * 3 + 2.2, ROOM_D / 2 - 3.4);
    scene.add(label);
    spineExtras.push(label);
  }

  // ─── Lift cabin (one car, world space) ───────────────────────────────
  // Glass-sided box riding the shaft; boarding agents reparent into it
  // so the whole stack sees them travel. Doors part while it dwells.
  const cabin = new THREE.Group();
  {
    const frame = std('#334155', 0.6);
    const floorPan = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 1.7), frame);
    floorPan.position.y = 0.06;
    cabin.add(floorPan);
    const roofPan = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 1.7), frame);
    roofPan.position.y = 2.3;
    cabin.add(roofPan);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 1.7), frame);
    back.position.set(CABIN_HALF, 1.2, 0);
    cabin.add(back);
    const glassMat = new THREE.MeshStandardMaterial({
      color: '#a5c4d8',
      transparent: true,
      opacity: 0.3,
      roughness: 0.15,
      side: THREE.DoubleSide,
    });
    for (const gz of [-CABIN_HALF, CABIN_HALF] as const) {
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.2), glassMat);
      pane.position.set(0, 1.2, gz);
      cabin.add(pane);
    }
    const lampMat = new THREE.MeshBasicMaterial({ color: '#fef9c3', fog: false });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.5), lampMat);
    lamp.position.y = 2.22;
    cabin.add(lamp);
    cabin.position.set(LIFT_SHAFT.x, 0, LIFT_SHAFT.z);
    scene.add(cabin);
  }
  // Cabin trip state: exactly one boarding/alighting event owns the car.
  interface LiftTrip {
    node: AgentNode;
    from: FloorId;
    to: FloorId;
    phase: 'toPickup' | 'boarding' | 'riding' | 'alighting';
    timer: number;
  }
  let liftTrip: LiftTrip | null = null;
  const liftQueue: AgentNode[] = [];
  /** 0 shut … 1 fully parted, per floor (eased in tick). */
  const doorOpen: Record<FloorId, number> = { parking: 0, kitchen: 0, workspace: 0, rooftop: 0 };
  const doorTarget: Record<FloorId, number> = { parking: 0, kitchen: 0, workspace: 0, rooftop: 0 };

  // ─── Floor 0 · Parking ─────────────────────────────────────────────
  // Same lively language as the rooms above: painted walls, neon
  // strip lights that glow after dark, dressed cars (mirrors +
  // headlights), a walking lane, lift lobby frame, plants, and a
  // waiting bench.
  floorPlate('parking', '#5d6069');
  backWall('parking', '#8a8474');
  leftWall('parking', '#7f7a6b');
  floorTitle('parking', '🅿️ Parking');
  {
    // Neon strip lights under the ceiling (cool white, glow at night).
    for (const nx of [-6, 0, 6]) {
      const tubeMat = new THREE.MeshBasicMaterial({ color: '#e0f2fe', fog: false });
      const tube = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 0.18), tubeMat);
      tube.position.set(nx, 6.8, 0.5);
      addTo('parking', tube);
      pendantBulbMats.push(tubeMat);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(4.3, 0.08, 0.3), std('#2b2b30', 0.9));
      housing.position.set(nx, 6.88, 0.5);
      addTo('parking', housing);
    }
    // Painted bays + walking lane stripes.
    for (let i = 0; i < 6; i++) {
      const bay = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 4.6),
        new THREE.MeshBasicMaterial({ color: '#facc15', transparent: true, opacity: 0.55 }),
      );
      bay.rotation.x = -Math.PI / 2;
      const edge = new THREE.Mesh(
        new THREE.PlaneGeometry(0.12, 4.6),
        new THREE.MeshBasicMaterial({ color: '#facc15' }),
      );
      edge.rotation.x = -Math.PI / 2;
      const x = -9 + i * 3.4;
      bay.position.set(x, 0.01, 0.5);
      edge.position.set(x - 1.25, 0.012, 0.5);
      addTo('parking', bay);
      addTo('parking', edge);
    }
    // Low-poly cars: body + cabin + mirrors + headlights, deterministic
    // colors.
    const carColors = ['#dc2626', '#2563eb', '#e5e7eb', '#16a34a', '#f59e0b'];
    const rng = mulberry32(31);
    for (let i = 0; i < 5; i++) {
      const car = new THREE.Group();
      const color = carColors[i % carColors.length];
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.2), std(color, 0.4));
      body.position.y = 0.55;
      body.castShadow = true;
      car.add(body);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.0), std('#1f2937', 0.3));
      cabin.position.set(0, 1.05, -0.2);
      car.add(cabin);
      for (const mx of [-1.02, 1.02] as const) {
        const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.2), std('#111827', 0.6));
        mirror.position.set(mx, 0.95, 0.6);
        car.add(mirror);
      }
      for (const hx of [-0.6, 0.6] as const) {
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.14, 0.06),
          new THREE.MeshStandardMaterial({
            color: '#fef9c3',
            emissive: '#fde047',
            emissiveIntensity: 0.5,
            roughness: 0.3,
          }),
        );
        lamp.position.set(hx, 0.55, 2.12);
        car.add(lamp);
      }
      const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14);
      const wheelMat = std('#111827', 0.9);
      for (const [wx, wz] of [
        [-0.95, 1.35],
        [0.95, 1.35],
        [-0.95, -1.35],
        [0.95, -1.35],
      ] as const) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, 0.34, wz);
        car.add(wheel);
      }
      car.position.set(-9 + i * 3.4 + (rng() - 0.5), 0, 0.5);
      addTo('parking', car);
    }
    // Pillar row + a "P" sign.
    for (let i = 0; i < 4; i++) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, WALL_H, 0.5), std('#6b6558'));
      pillar.position.set(-10 + i * 6.4, WALL_H / 2, -5.4);
      pillar.castShadow = true;
      addTo('parking', pillar);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.52, 1.2, 0.52), std('#facc15', 0.7));
      stripe.position.set(-10 + i * 6.4, 1.0, -5.4);
      addTo('parking', stripe);
    }
    const sign = makeTextSprite('🅿️ PARKIR', 34, '#1e3a8a', '#fef08a');
    sign.position.set(0, 3.2, -ROOM_D / 2 + 0.6);
    addTo('parking', sign);
    // Lift lobby frame (where riders queue) + waiting bench.
    {
      const frameMat = std('#3f4a5a', 0.7);
      for (const fz of [4.35, 5.75] as const) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), frameMat);
        post.position.set(ROOM_W / 2 + 0.29, 1.3, fz);
        addTo('parking', post);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.3, 1.6), frameMat);
      lintel.position.set(ROOM_W / 2 + 0.29, 2.7, 5.05);
      addTo('parking', lintel);
    }
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.55), std('#7a5c3e'));
    bench.position.set(-7, 0.5, 6.5);
    bench.castShadow = true;
    addTo('parking', bench);
    for (const bx of [-7.9, -6.1] as const) {
      const legB = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.5), std('#2b2118'));
      legB.position.set(bx, 0.25, 6.5);
      addTo('parking', legB);
    }
    // Snake plants flanking the lobby + west corner.
    const potMatP = std('#b08968', 0.9);
    const leafMatP = std('#2f7a44', 0.9);
    for (const [px, pz] of [
      [9.8, 3.4],
      [13, 3.4],
      [-11.8, 6.6],
    ] as const) {
      const g = new THREE.Group();
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.5, 12), potMatP);
      pot.position.y = 0.25;
      pot.castShadow = true;
      g.add(pot);
      for (let i = 0; i < 6; i++) {
        const h = 0.9 + (i % 3) * 0.3;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.09, h, 6), leafMatP);
        const ang = (i / 6) * Math.PI * 2;
        blade.position.set(Math.cos(ang) * 0.12, 0.5 + h / 2, Math.sin(ang) * 0.12);
        blade.castShadow = true;
        g.add(blade);
      }
      g.position.set(px, 0, pz);
      addTo('parking', g);
    }
  }

  // ─── Floor 1 · Kitchen & Dining ────────────────────────────────────
  // Same lively language as the workspace: warm tile floor + dining
  // rug, clerestory windows (sky follows Batu day/night via the shared
  // windowSkyMats), a wood beam with pendant lamps over the tables,
  // dressed tables, an equipped counter, menu board, and plants.
  floorPlate('kitchen', '#a5714d');
  {
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(15, 7.4), std('#c8b9a3', 1));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.012, 2.6);
    rug.receiveShadow = true;
    addTo('kitchen', rug);
    const rugEdge = new THREE.Mesh(new THREE.PlaneGeometry(15.4, 7.8), std('#9a8a72', 1));
    rugEdge.rotation.x = -Math.PI / 2;
    rugEdge.position.set(0, 0.008, 2.6);
    rugEdge.receiveShadow = true;
    addTo('kitchen', rugEdge);
  }
  backWall('kitchen', '#b0927a');
  leftWall('kitchen', '#a68a70');
  floorTitle('kitchen', '🍽️ Kitchen & Dining');
  // Clerestory windows, same pattern as workspace (sky tint shared).
  {
    const frameMat = std('#6b543a', 0.8);
    const mullionMat = std('#4a3a28', 0.8);
    const backZ = -ROOM_D / 2 + 0.06;
    for (let i = 0; i < 4; i++) {
      const wx = -7.5 + i * 5;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 0.12), frameMat);
      frame.position.set(wx, 5.6, backZ);
      addTo('kitchen', frame);
      const skyMat = new THREE.MeshBasicMaterial({ color: '#bfd9ee', fog: false });
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.1), skyMat);
      sky.position.set(wx, 5.6, backZ + 0.07);
      addTo('kitchen', sky);
      windowSkyMats.push(skyMat);
      const mullV = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.1, 0.05), mullionMat);
      mullV.position.set(wx, 5.6, backZ + 0.09);
      addTo('kitchen', mullV);
      const mullH = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.09, 0.05), mullionMat);
      mullH.position.set(wx, 5.6, backZ + 0.09);
      addTo('kitchen', mullH);
    }
    const leftX = -ROOM_W / 2 + 0.06;
    for (const wz of [-2, 2.5] as const) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 3.2), frameMat);
      frame.position.set(leftX, 5.6, wz);
      addTo('kitchen', frame);
      const skyMat = new THREE.MeshBasicMaterial({ color: '#bfd9ee', fog: false });
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.1), skyMat);
      sky.rotation.y = Math.PI / 2;
      sky.position.set(leftX + 0.07, 5.6, wz);
      addTo('kitchen', sky);
      windowSkyMats.push(skyMat);
    }
  }
  // Wood beam + pendant lamp over every dining table.
  {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(15.5, 0.28, 0.34), std('#4a3826', 0.85));
    beam.position.set(0, 6.9, 2.6);
    beam.castShadow = true;
    addTo('kitchen', beam);
    const cordMat = std('#2b2b30', 0.9);
    const shadeMat = std('#c9a06a', 0.85);
    for (const px of [-4.4, 0, 4.4]) {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8), cordMat);
      cord.position.set(px, 5.95, 2.6);
      addTo('kitchen', cord);
      const shade = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.5, 0.55, 14, 1, true),
        shadeMat,
      );
      shade.position.set(px, 5.0, 2.6);
      addTo('kitchen', shade);
      const bulbMat = new THREE.MeshBasicMaterial({ color: '#fde68a', fog: false });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), bulbMat);
      bulb.position.set(px, 4.78, 2.6);
      addTo('kitchen', bulb);
      pendantBulbMats.push(bulbMat);
    }
  }
  {
    // Kitchen counter run along the back wall.
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(9, 0.12, 1.1), std('#8a7355'));
    counterTop.position.set(-4, 1.0, -ROOM_D / 2 + 1.2);
    counterTop.castShadow = true;
    addTo('kitchen', counterTop);
    const counterBase = new THREE.Mesh(new THREE.BoxGeometry(9, 1.0, 1.0), std('#4a4036'));
    counterBase.position.set(-4, 0.5, -ROOM_D / 2 + 1.2);
    addTo('kitchen', counterBase);
    // Open shelf above the counter with colorful jars.
    const shelfPlank = new THREE.Mesh(new THREE.BoxGeometry(7, 0.08, 0.5), std('#6b543a', 0.85));
    shelfPlank.position.set(-4, 2.5, -ROOM_D / 2 + 0.9);
    shelfPlank.castShadow = true;
    addTo('kitchen', shelfPlank);
    const jarColors = ['#f87171', '#fbbf24', '#4ade80', '#60a5fa', '#f472b6', '#a3e635'];
    for (let i = 0; i < 6; i++) {
      const jar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.42, 10),
        std(jarColors[i % jarColors.length], 0.6),
      );
      jar.position.set(-6.8 + i * 1.15, 2.75, -ROOM_D / 2 + 0.9);
      jar.castShadow = true;
      addTo('kitchen', jar);
    }
    // Fridge + stove blocks.
    const fridge = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.0, 0.9), std('#cbd5e1', 0.4));
    fridge.position.set(1.4, 1.0, -ROOM_D / 2 + 1.2);
    fridge.castShadow = true;
    addTo('kitchen', fridge);
    const fridgeHandle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.06), std('#475569'));
    fridgeHandle.position.set(1.75, 1.2, -ROOM_D / 2 + 1.7);
    addTo('kitchen', fridgeHandle);
    const stove = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 1.0), std('#1f2937', 0.5));
    stove.position.set(-9.2, 0.45, -ROOM_D / 2 + 1.2);
    addTo('kitchen', stove);
    for (let i = 0; i < 4; i++) {
      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 0.08, 14),
        std('#0f172a'),
      );
      plate.position.set(-9.6 + (i % 2) * 0.7, 0.94, -ROOM_D / 2 + 0.95 + Math.floor(i / 2) * 0.5);
      addTo('kitchen', plate);
    }
    // Coffee machine on the counter: dark body + glowing brew light.
    const brewer = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.7), std('#1f2937', 0.5));
    brewer.position.set(-1.2, 1.51, -ROOM_D / 2 + 1.2);
    brewer.castShadow = true;
    addTo('kitchen', brewer);
    const brewGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.3),
      new THREE.MeshStandardMaterial({
        color: '#0b1220',
        emissive: '#f59e0b',
        emissiveIntensity: 0.7,
        roughness: 0.4,
      }),
    );
    brewGlow.position.set(-1.2, 1.55, -ROOM_D / 2 + 1.56);
    addTo('kitchen', brewGlow);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.14, 10), std('#f8fafc'));
    cup.position.set(-1.2, 1.13, -ROOM_D / 2 + 1.35);
    addTo('kitchen', cup);
    // Fruit bowl on the counter: bowl + three apples.
    const bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.22, 0.18, 14, 1, true),
      std('#b45309', 0.7),
    );
    bowl.position.set(-5.5, 1.15, -ROOM_D / 2 + 1.2);
    addTo('kitchen', bowl);
    for (const [fx, fz] of [
      [-5.6, -7.25],
      [-5.35, -7.2],
      [-5.48, -7.05],
    ] as const) {
      const apple = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), std('#dc2626', 0.6));
      apple.position.set(fx, 1.28, fz);
      addTo('kitchen', apple);
    }
    // Dining tables in one even row + stools at four fixed compass
    // points per table (no random scatter). Each table is dressed:
    // plates, mugs, and a tiny vase centerpiece.
    for (let t = 0; t < 3; t++) {
      const tx = -4.4 + t * 4.4;
      const tz = 2.6;
      const table = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.1, 20), std('#7a5c3e'));
      table.position.set(tx, 0.78, tz);
      table.castShadow = true;
      addTo('kitchen', table);
      const cloth = new THREE.Mesh(
        new THREE.CylinderGeometry(1.12, 1.12, 0.04, 20),
        std('#e8e0d0', 0.95),
      );
      cloth.position.set(tx, 0.82, tz);
      addTo('kitchen', cloth);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.74, 10), std('#4a3826'));
      leg.position.set(tx, 0.39, tz);
      addTo('kitchen', leg);
      // Two place settings per table.
      for (const [px, pz] of [
        [tx - 0.45, tz - 0.3],
        [tx + 0.45, tz + 0.3],
      ] as const) {
        const dish = new THREE.Mesh(
          new THREE.CylinderGeometry(0.2, 0.2, 0.04, 14),
          std('#f8fafc', 0.5),
        );
        dish.position.set(px, 0.86, pz);
        addTo('kitchen', dish);
        const mug = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.08, 0.16, 10),
          std(['#f472b6', '#38bdf8', '#a3e635'][t % 3], 0.7),
        );
        mug.position.set(px + 0.28, 0.92, pz + 0.15);
        addTo('kitchen', mug);
      }
      // Tiny vase + flower centerpiece.
      const vase = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.12, 0.26, 10),
        std('#0e7490', 0.6),
      );
      vase.position.set(tx, 0.97, tz);
      addTo('kitchen', vase);
      const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), std('#f472b6', 0.7));
      bloom.position.set(tx, 1.18, tz);
      addTo('kitchen', bloom);
      for (let sIdx = 0; sIdx < 4; sIdx++) {
        const ang = (sIdx / 4) * Math.PI * 2;
        const stool = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.3, 0.08, 12),
          std('#5b4a36'),
        );
        stool.position.set(tx + Math.cos(ang) * 1.7, 0.48, tz + Math.sin(ang) * 1.7);
        stool.castShadow = true;
        addTo('kitchen', stool);
        const stoolLeg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.06, 0.44, 8),
          std('#2b2118'),
        );
        stoolLeg.position.set(tx + Math.cos(ang) * 1.7, 0.22, tz + Math.sin(ang) * 1.7);
        addTo('kitchen', stoolLeg);
      }
    }
    // Menu board on the back wall, right of the fridge.
    const menu = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), std('#1f2937', 0.8));
    menu.position.set(6.5, 2.3, -ROOM_D / 2 + 0.05);
    addTo('kitchen', menu);
    for (let i = 0; i < 4; i++) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8 - (i % 2) * 0.4, 0.12),
        std('#fde68a', 0.7),
      );
      line.position.set(6.5, 2.75 - i * 0.32, -ROOM_D / 2 + 0.07);
      addTo('kitchen', line);
    }
    zoneLabel('📋 Menu hari ini', 6.5, 3.45, -ROOM_D / 2 + 0.4);
    // Snake plants in the dining corners (same style as workspace).
    const potMat = std('#b08968', 0.9);
    const leafMat = std('#2f7a44', 0.9);
    for (const [px, pz, ps] of [
      [-11.5, 6.5, 1.2],
      [11.5, 6.5, 1.1],
      [11.5, -6.5, 0.9],
    ] as const) {
      const g = new THREE.Group();
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3 * ps, 0.24 * ps, 0.5 * ps, 12),
        potMat,
      );
      pot.position.y = 0.25 * ps;
      pot.castShadow = true;
      g.add(pot);
      for (let i = 0; i < 6; i++) {
        const h = (0.9 + (i % 3) * 0.3) * ps;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.09 * ps, h, 6), leafMat);
        const ang = (i / 6) * Math.PI * 2;
        blade.position.set(Math.cos(ang) * 0.12 * ps, 0.5 * ps + h / 2, Math.sin(ang) * 0.12 * ps);
        blade.castShadow = true;
        g.add(blade);
      }
      g.position.set(px, 0, pz);
      addTo('kitchen', g);
    }
    const sign = makeTextSprite('☕ Pantry — kopi dulu, baru deploy', 26, '#3f2d1c', '#fde68a');
    sign.position.set(-4, 3.6, -ROOM_D / 2 + 1.2);
    addTo('kitchen', sign);
  }

  // ─── Floor 2 · Workspace (the live office) ─────────────────────────
  // One open workspace (CEO + staff share the room, different desks)
  // plus a glass meeting room on the east side (x > 5.5).
  floorPlate('workspace', '#c49a6c');
  {
    // Warm wood floor + a big soft rug under the staff desks, like the
    // reference's beige carpet zone.
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W * 0.5, ROOM_D * 0.6),
      std('#a7b0b8', 1),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0.6, 0.012, -0.5);
    rug.receiveShadow = true;
    addTo('workspace', rug);
    const rugEdge = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W * 0.52, ROOM_D * 0.62),
      std('#7c8794', 1),
    );
    rugEdge.rotation.x = -Math.PI / 2;
    rugEdge.position.set(0.6, 0.008, -0.5);
    rugEdge.receiveShadow = true;
    addTo('workspace', rugEdge);
  }
  backWall('workspace', '#b8b0a4');
  leftWall('workspace', '#aaa294');
  floorTitle('workspace', '💻 Workspace');
  // ── Clerestory windows (reference look) ─────────────────────────
  // A row of framed windows high on the back + left walls: wood frames,
  // mullion crosses, and a sky pane whose tint follows Batu day/night
  // + overcast dimming (see applyLight → windowSkyMats).
  {
    const frameMat = std('#6b543a', 0.8);
    const mullionMat = std('#4a3a28', 0.8);
    const backZ = -ROOM_D / 2 + 0.06;
    for (let i = 0; i < 5; i++) {
      const wx = -9 + i * 4.6;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 0.12), frameMat);
      frame.position.set(wx, 5.6, backZ);
      addTo('workspace', frame);
      const skyMat = new THREE.MeshBasicMaterial({ color: '#bfd9ee', fog: false });
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.1), skyMat);
      sky.position.set(wx, 5.6, backZ + 0.07);
      addTo('workspace', sky);
      windowSkyMats.push(skyMat);
      const mullV = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.1, 0.05), mullionMat);
      mullV.position.set(wx, 5.6, backZ + 0.09);
      addTo('workspace', mullV);
      const mullH = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.09, 0.05), mullionMat);
      mullH.position.set(wx, 5.6, backZ + 0.09);
      addTo('workspace', mullH);
    }
    const leftX = -ROOM_W / 2 + 0.06;
    for (let i = 0; i < 3; i++) {
      const wz = -4 + i * 4.2;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 3.2), frameMat);
      frame.position.set(leftX, 5.6, wz);
      addTo('workspace', frame);
      const skyMat = new THREE.MeshBasicMaterial({ color: '#bfd9ee', fog: false });
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.1), skyMat);
      sky.rotation.y = Math.PI / 2;
      sky.position.set(leftX + 0.07, 5.6, wz);
      addTo('workspace', sky);
      windowSkyMats.push(skyMat);
    }
  }
  // ── Pendant lamps over the staff rows ───────────────────────────
  // A wood beam spans the open room (left wall → meeting divider) so
  // the cords visibly hang from something; short drops to rattan
  // shades + warm bulbs that glow after dark.
  {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.28, 0.34), std('#4a3826', 0.85));
    beam.position.set(-3.75, 6.9, -0.5);
    beam.castShadow = true;
    addTo('workspace', beam);
    const cordMat = std('#2b2b30', 0.9);
    const shadeMat = std('#c9a06a', 0.85);
    for (const px of [-2, 0.6, 3.2]) {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8), cordMat);
      cord.position.set(px, 5.95, -0.5);
      addTo('workspace', cord);
      const shade = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.5, 0.55, 14, 1, true),
        shadeMat,
      );
      shade.position.set(px, 5.0, -0.5);
      addTo('workspace', shade);
      const bulbMat = new THREE.MeshBasicMaterial({ color: '#fde68a', fog: false });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), bulbMat);
      bulb.position.set(px, 4.78, -0.5);
      addTo('workspace', bulb);
      pendantBulbMats.push(bulbMat);
    }
  }
  // Only the meeting room keeps a partition (door gap mid-wall); CEO +
  // staff share one open room. Partition fades to glass in focus mode
  // so the meeting room stays visible; solid in overview.
  const partMats: THREE.MeshStandardMaterial[] = [];
  let partTarget = 0.22;
  {
    // Only the meeting room divider (run full wall height) with a door
    // gap on the staff-room side. No CEO divider — one open room.
    const partMat = new THREE.MeshStandardMaterial({
      color: '#c9c2b4',
      roughness: 0.9,
      transparent: true,
      opacity: 1,
    });
    partMats.push(partMat);
    const wallTall = (w: number, d: number, x: number, z: number): void => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_SPAN, d), partMat);
      p.position.set(x, WALL_SPAN / 2, z);
      p.castShadow = false;
      p.receiveShadow = true;
      addTo('workspace', p);
    };
    // Meeting room divider at x = 5.5 (wide door gap mid-wall).
    wallTall(0.3, ROOM_D * 0.34, 5.5, -ROOM_D / 2 + (ROOM_D * 0.34) / 2 + 0.6);
    wallTall(0.3, ROOM_D * 0.3, 5.5, ROOM_D / 2 - (ROOM_D * 0.3) / 2 - 0.4);
    const meetDoor = makeTextSprite('🚪 Ruang Meeting', 26, 'rgba(10,10,15,0.78)', '#a5f3fc');
    meetDoor.position.set(5.5, 2.2, 0.4);
    meetDoor.scale.multiplyScalar(0.8);
    addTo('workspace', meetDoor);
    // Glass front for the meeting room (see-through, like the reference).
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 2.6),
      new THREE.MeshStandardMaterial({
        color: '#a5c4d8',
        transparent: true,
        opacity: 0.28,
        roughness: 0.15,
      }),
    );
    glass.position.set(9.1, 1.7, ROOM_D / 2 - 0.05);
    addTo('workspace', glass);
    const ceoSign = makeTextSprite('👑 Meja CEO', 30, 'rgba(10,10,15,0.78)', '#fde68a');
    ceoSign.position.set(-8.6, 2.6, -2.5);
    addTo('workspace', ceoSign);
    const staffSign = makeTextSprite('🧑‍💻 Ruang Kerja', 30, 'rgba(10,10,15,0.78)', '#bbf7d0');
    staffSign.position.set(-1.5, 3, -2.5);
    addTo('workspace', staffSign);
    const meetSign = makeTextSprite('🤝 Ruang Meeting', 30, 'rgba(10,10,15,0.78)', '#a5f3fc');
    meetSign.position.set(9.4, 3, -2.5);
    addTo('workspace', meetSign);
  }
  // Rooftop jam-corner + stargazing seats (furniture built in the
  // rooftop block below): guitarist and drummer face each other across
  // the rug, beach chairs face the skyline past the front parapet.
  const GUITAR_SEAT = { x: -5.6, z: 1.2, yaw: Math.PI / 2 };
  const DRUM_SEAT = { x: -2.8, z: 1.2, yaw: -Math.PI / 2 };
  const STARGAZE_SPOTS = [
    { x: -0.5, z: 6.2, yaw: 0 },
    { x: 2.5, z: 6.2, yaw: 0 },
  ];

  // ─── Floor 3 · Rooftop ─────────────────────────────────────────────
  // Same lively language as the rooms below: warm deck + lounge rug,
  // pergola with hanging planters and a denser string-light canopy
  // (glow brighter after dark, see tick), dressed loungers with side
  // tables + mugs, an outdoor bar counter with stools, and pine
  // planters along the parapet.
  // String-light materials glow brighter after dark (see tick).
  const rooftopBulbMats: THREE.MeshBasicMaterial[] = [];
  floorPlate('rooftop', '#6b624f');
  floorTitle('rooftop', '🌇 Rooftop');
  {
    // Parapet on three sides; the back stays open to the sky.
    const parapetMat = std('#8a8474');
    const mkParapet = (w: number, d: number, x: number, z: number) => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, d), parapetMat);
      p.position.set(x, 0.55, z);
      p.castShadow = true;
      p.receiveShadow = true;
      addTo('rooftop', p);
    };
    mkParapet(ROOM_W, 0.3, 0, ROOM_D / 2 - 0.15);
    mkParapet(0.3, ROOM_D, -ROOM_W / 2 + 0.15, 0);
    mkParapet(0.3, ROOM_D, ROOM_W / 2 - 0.15, 0);
    // Deck + lounge rug.
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), std('#8a6a45', 0.9));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(-4, 0.02, 1);
    deck.receiveShadow = true;
    addTo('rooftop', deck);
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 4.6), std('#c8b9a3', 1));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-4, 0.03, 1);
    rug.receiveShadow = true;
    addTo('rooftop', rug);
    // Pergola posts + slatted roof so string lights hang from
    // something visible.
    for (const [px, pz] of [
      [-7.4, -1.4],
      [-0.6, -1.4],
      [-7.4, 3.4],
      [-0.6, 3.4],
    ] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.6, 0.22), std('#4a3826'));
      post.position.set(px, 1.3, pz);
      post.castShadow = true;
      addTo('rooftop', post);
    }
    for (let s = 0; s < 7; s++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.08, 0.3), std('#5b4630', 0.9));
      slat.position.set(-4, 2.68, -1.4 + s * 0.8);
      slat.castShadow = true;
      addTo('rooftop', slat);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.14, 5.6), std('#374151'));
    roof.position.set(-4, 2.82, 1);
    roof.castShadow = true;
    addTo('rooftop', roof);
    // Denser string-light canopy under the pergola (warm points,
    // brighter at night) + hanging planters between the strands.
    for (let i = 0; i < 10; i++) {
      const bulbMat = new THREE.MeshBasicMaterial({ color: '#fde68a', fog: false });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), bulbMat);
      bulb.position.set(-7 + (i % 5) * 1.5, 2.45, 0.2 + Math.floor(i / 5) * 1.6);
      addTo('rooftop', bulb);
      rooftopBulbMats.push(bulbMat);
    }
    for (const hx of [-5.5, -2.5] as const) {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 6), std('#2b2b30'));
      cord.position.set(hx, 2.5, 2.6);
      addTo('rooftop', cord);
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.16, 0.28, 10),
        std('#b08968', 0.9),
      );
      pot.position.set(hx, 2.25, 2.6);
      addTo('rooftop', pot);
      const fern = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 8), std('#3d9a55', 0.9));
      fern.position.set(hx, 2.05, 2.6);
      addTo('rooftop', fern);
    }
    // Dressed loungers: cushion + folded throw + side table + mug.
    const rng = mulberry32(202);
    const throwColors = ['#f472b6', '#38bdf8', '#fbbf24'];
    for (let i = 0; i < 3; i++) {
      const lx = 4.5 + (i % 2) * 2.2;
      const lz = -1 + Math.floor(i / 2) * 3;
      const lounger = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.35, 1.9), std('#7c5c3f'));
      lounger.position.set(lx, 0.35, lz);
      lounger.castShadow = true;
      addTo('rooftop', lounger);
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 1.0), std('#e8e0d0', 0.95));
      cushion.position.set(lx, 0.58, lz + 0.3);
      addTo('rooftop', cushion);
      const throwM = new THREE.Mesh(
        new THREE.BoxGeometry(0.68, 0.06, 0.6),
        std(throwColors[i % throwColors.length], 0.9),
      );
      throwM.position.set(lx, 0.6, lz - 0.55);
      throwM.rotation.y = (rng() - 0.5) * 0.2;
      addTo('rooftop', throwM);
      const side = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 12), std('#5b4630'));
      side.position.set(lx + 0.85, 0.25, lz);
      side.castShadow = true;
      addTo('rooftop', side);
      const mug = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.07, 0.14, 10),
        std(['#f8fafc', '#fde68a', '#fca5a5'][i % 3], 0.7),
      );
      mug.position.set(lx + 0.85, 0.57, lz);
      addTo('rooftop', mug);
      const planter = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 0.7), std('#3f3a33'));
      planter.position.set(lx + 1.6, 0.3, lz);
      addTo('rooftop', planter);
      const pine = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 8), std('#166534', 0.8));
      pine.position.set(lx + 1.6, 1.35, lz);
      pine.castShadow = true;
      addTo('rooftop', pine);
    }
    // Outdoor bar counter on the east end + three stools.
    {
      const barTop = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.12, 0.9), std('#8a6a45'));
      barTop.position.set(10, 1.05, -5.5);
      barTop.castShadow = true;
      addTo('rooftop', barTop);
      const barBase = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.7), std('#4a4036'));
      barBase.position.set(10, 0.5, -5.5);
      addTo('rooftop', barBase);
      for (let s = 0; s < 3; s++) {
        const stool = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.28, 0.08, 12),
          std('#5b4a36'),
        );
        stool.position.set(9 + s * 1.0, 0.62, -4.3);
        stool.castShadow = true;
        addTo('rooftop', stool);
        const legS = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.05, 0.58, 8),
          std('#2b2118'),
        );
        legS.position.set(9 + s * 1.0, 0.31, -4.3);
        addTo('rooftop', legS);
      }
      for (const [bx, bc] of [
        [9.4, '#f87171'],
        [10.2, '#fbbf24'],
        [10.8, '#4ade80'],
      ] as const) {
        const bottleR = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.09, 0.4, 8),
          std(bc, 0.6),
        );
        bottleR.position.set(bx, 1.31, -5.5);
        addTo('rooftop', bottleR);
      }
    }
    // Jam corner: guitar stool + spare guitar on a stand, drum kit +
    // stool. Guitarist and drummer face each other across the rug.
    {
      const stoolMat = std('#5b4a36');
      const mkStool = (x: number, z: number) => {
        const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 14), stoolMat);
        seat.position.set(x, 0.55, z);
        seat.castShadow = true;
        addTo('rooftop', seat);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), std('#2b2118'));
        leg.position.set(x, 0.28, z);
        addTo('rooftop', leg);
        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(0.24, 0.26, 0.05, 12),
          std('#2b2118'),
        );
        base.position.set(x, 0.03, z);
        addTo('rooftop', base);
      };
      mkStool(GUITAR_SEAT.x, GUITAR_SEAT.z);
      mkStool(DRUM_SEAT.x, DRUM_SEAT.z);
      // Spare guitar leaning on an A-frame stand beside the stool.
      const standX = GUITAR_SEAT.x - 0.9;
      const standZ = GUITAR_SEAT.z - 0.7;
      for (const tilt of [-0.28, 0.28] as const) {
        const legA = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.06), std('#2b2118'));
        legA.position.set(standX, 0.55, standZ);
        legA.rotation.x = tilt;
        addTo('rooftop', legA);
      }
      const spareBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.38, 0.48, 0.14),
        std('#92400e', 0.6),
      );
      spareBody.position.set(standX, 0.5, standZ + 0.12);
      spareBody.rotation.x = -0.22;
      spareBody.castShadow = true;
      addTo('rooftop', spareBody);
      const spareNeck = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.6, 0.06), std('#5b3a1e', 0.7));
      spareNeck.position.set(standX, 1.0, standZ + 0.02);
      spareNeck.rotation.x = -0.22;
      addTo('rooftop', spareNeck);
      // Drum kit in front of the drummer (faces the guitarist).
      const kitX = DRUM_SEAT.x - 0.9;
      const kitZ = DRUM_SEAT.z;
      const bass = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.4, 16),
        std('#b91c1c', 0.55),
      );
      bass.rotation.z = Math.PI / 2;
      bass.position.set(kitX, 0.44, kitZ);
      bass.castShadow = true;
      addTo('rooftop', bass);
      const bassSkin = new THREE.Mesh(new THREE.CircleGeometry(0.36, 16), std('#f8fafc', 0.8));
      bassSkin.position.set(kitX + 0.21, 0.44, kitZ);
      bassSkin.rotation.y = Math.PI / 2;
      addTo('rooftop', bassSkin);
      for (const dz of [-0.5, 0.5] as const) {
        const tom = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.22, 0.3, 12),
          std('#1d4ed8', 0.55),
        );
        tom.position.set(kitX + 0.15, 0.75, kitZ + dz);
        tom.castShadow = true;
        addTo('rooftop', tom);
        const tomLeg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6),
          std('#2b2118'),
        );
        tomLeg.position.set(kitX + 0.15, 0.3, kitZ + dz);
        addTo('rooftop', tomLeg);
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6), std('#2b2118'));
      pole.position.set(kitX - 0.2, 0.5, kitZ);
      addTo('rooftop', pole);
      const cymbal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.04, 14),
        std('#fbbf24', 0.35),
      );
      cymbal.position.set(kitX - 0.2, 1.02, kitZ);
      cymbal.rotation.z = 0.1;
      cymbal.castShadow = true;
      addTo('rooftop', cymbal);
      const jamLabel = makeTextSprite('🎸 Jam corner', 26, 'rgba(10,10,15,0.78)', '#fde68a');
      jamLabel.position.set(-4.2, 2.2, 0.2);
      addTo('rooftop', jamLabel);
    }
    // Beach chairs: selonjoran menghadap langit lewat parapet depan.
    {
      const fabrics = ['#38bdf8', '#f472b6'];
      STARGAZE_SPOTS.forEach((spot, i) => {
        const g = new THREE.Group();
        g.position.set(spot.x, 0, spot.z);
        g.rotation.y = spot.yaw;
        const fabric = std(fabrics[i % fabrics.length], 0.9);
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.09, 1.15), fabric);
        seat.position.set(0, 0.35, 0.1);
        seat.castShadow = true;
        g.add(seat);
        // Reclined backrest — heads tilt up at the sky. Far edge rises
        // (+x rotation lifts -z), near edge stays low at seat level.
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.09, 0.95), fabric);
        back.position.set(0, 0.62, -0.75);
        back.rotation.x = 0.85;
        back.castShadow = true;
        g.add(back);
        const frameMat = std('#e8e0d0', 0.7);
        for (const [lx, lz] of [
          [-0.32, 0.5],
          [0.32, 0.5],
          [-0.32, -0.3],
          [0.32, -0.3],
        ] as const) {
          const legC = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.35, 6), frameMat);
          legC.position.set(lx, 0.17, lz);
          g.add(legC);
        }
        addTo('rooftop', g);
      });
      // Side table + mugs between the beach chairs.
      const midX = (STARGAZE_SPOTS[0].x + STARGAZE_SPOTS[1].x) / 2;
      const midZ = STARGAZE_SPOTS[0].z + 0.2;
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.45, 12), std('#5b4630'));
      table.position.set(midX, 0.22, midZ);
      table.castShadow = true;
      addTo('rooftop', table);
      for (const dx of [-0.12, 0.12] as const) {
        const mug = new THREE.Mesh(
          new THREE.CylinderGeometry(0.07, 0.06, 0.13, 10),
          std('#f8fafc', 0.7),
        );
        mug.position.set(midX + dx, 0.51, midZ);
        addTo('rooftop', mug);
      }
      const skyLabel = makeTextSprite(
        '✨ Selonjoran lihat langit',
        26,
        'rgba(10,10,15,0.78)',
        '#fde68a',
      );
      skyLabel.position.set(midX, 1.9, STARGAZE_SPOTS[0].z);
      addTo('rooftop', skyLabel);
    }
    zoneLabel('🍹 Bar', 10, 2.3, -5.5);
    // Pine row along the front parapet (frames the skyline view).
    for (const [px, ps] of [
      [-2, 1],
      [1, 1.2],
      [4, 0.9],
      [7, 1.1],
    ] as const) {
      const planter = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.6), std('#3f3a33'));
      planter.position.set(px, 0.28, 7.6);
      addTo('rooftop', planter);
      const pine = new THREE.Mesh(
        new THREE.ConeGeometry(0.45 * ps, 1.5 * ps, 8),
        std('#166534', 0.8),
      );
      pine.position.set(px, 1.2 * ps, 7.6);
      pine.castShadow = true;
      addTo('rooftop', pine);
    }
    const sign = makeTextSprite('🌃 Ngopi santai, lihat lampu kota Batu', 26, '#101828', '#fde68a');
    sign.position.set(4, 2.4, -3.4);
    addTo('rooftop', sign);
  }

  // ─── City silhouette backdrop ─────────────────────────────────────
  // A ring of low-poly neighbor buildings (Batu's skyline): pale boxes
  // with window stripes. Only rendered in the stacked overview — a
  // focused floor is a clean single room.
  {
    const cityGroup = new THREE.Group();
    cityExtras.push(cityGroup);
    scene.add(cityGroup);
    const rng = mulberry32(77);
    const palettes = ['#cfd8de', '#c2ccd4', '#b6c2cc', '#dbe4ea'];
    const stripeMat = new THREE.MeshBasicMaterial({ color: '#9fb4c4', fog: false });
    const radius = 34;
    const count = 16;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + rng() * 0.35;
      const dist = radius + rng() * 18;
      const w = 5 + rng() * 7;
      const d = 5 + rng() * 7;
      const h = 6 + rng() * 22;
      const bldg = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        std(palettes[i % palettes.length], 0.95),
      );
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      bldg.position.set(x, h / 2, z);
      bldg.castShadow = false;
      bldg.receiveShadow = false;
      cityGroup.add(bldg);
      // Horizontal window stripes — the "windows" the reference shows.
      const stripes = 3 + Math.floor(rng() * 4);
      for (let s = 0; s < stripes; s++) {
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.72, 0.35), stripeMat);
        stripe.position.set(x, 1.6 + s * ((h - 2.4) / Math.max(1, stripes - 1)), z + d / 2 + 0.01);
        cityGroup.add(stripe);
      }
      // Occasional rooftop block (water tower / lift house).
      if (rng() < 0.4) {
        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.28, 1.2, d * 0.28),
          std('#aeb9c2', 0.95),
        );
        cap.position.set(x, h + 0.6, z);
        cityGroup.add(cap);
      }
    }
  }

  // ─── Ground ────────────────────────────────────────────────────
  // A city ground plane so the building (and the skyline) sits on
  // earth instead of floating in the void. It travels with the
  // focused floor: each isolated floor rests on the ground; in the
  // stacked overview it sits under parking (see applyFloorVisibility).
  const groundGroup = new THREE.Group();
  scene.add(groundGroup);
  {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), std('#2c3644', 1));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    groundGroup.add(ground);
    // Crossing streets around the block.
    const roadMat = std('#1d2530', 1);
    for (const [w, d, x, z] of [
      [240, 7, 0, 14],
      [240, 7, 0, -14],
      [7, 240, 20, 0],
      [7, 240, -20, 0],
    ] as const) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), roadMat);
      road.rotation.x = -Math.PI / 2;
      road.position.set(x, 0.005, z);
      road.receiveShadow = true;
      groundGroup.add(road);
    }
    // Sidewalk pad directly under the building footprint.
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(ROOM_W + 7, 0.12, ROOM_D + 8),
      std('#46536a', 1),
    );
    pad.position.y = 0;
    pad.receiveShadow = true;
    groundGroup.add(pad);
    // Grass corners to soften the concrete.
    const grassMat = std('#2f4a38', 1);
    for (const [gx, gz] of [
      [-26, 22],
      [26, 22],
      [-26, -22],
      [26, -22],
    ] as const) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(22, 12), grassMat);
      g.rotation.x = -Math.PI / 2;
      g.position.set(gx, 0.002, gz);
      g.receiveShadow = true;
      groundGroup.add(g);
    }
  }

  // ─── Furniture + hotspot zones (workspace floor) ───────────────────
  const zoneMeshes: THREE.Object3D[] = [];
  function tagZone(obj: THREE.Object3D, zoneId: string): void {
    obj.userData.zoneId = zoneId;
    zoneMeshes.push(obj);
  }

  function box(
    w: number,
    h: number,
    d: number,
    color: string,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    addTo('workspace', m);
    return m;
  }

  function zoneLabel(text: string, x: number, y: number, z: number): void {
    const sprite = makeTextSprite(text, 30, 'rgba(10,10,15,0.78)', '#ffd9a0');
    sprite.position.set(x, y, z);
    sprite.scale.multiplyScalar(0.8);
    addTo('workspace', sprite);
  }

  // Staff desks: three tidy rows of three in the middle room (x -3..4.5).
  // Each agent claims one desk on first seating and keeps it (see
  // deskClaim) — furniture never overlaps the partitions or the
  // meeting table.
  const STAFF_DESKS: { x: number; z: number }[] = [
    { x: -2, z: -4.5 },
    { x: 0.6, z: -4.5 },
    { x: 3.2, z: -4.5 },
    { x: -2, z: -0.5 },
    { x: 0.6, z: -0.5 },
    { x: 3.2, z: -0.5 },
    { x: -2, z: 3.5 },
    { x: 0.6, z: 3.5 },
    { x: 3.2, z: 3.5 },
  ];
  for (let di = 0; di < STAFF_DESKS.length; di++) {
    const { x, z } = STAFF_DESKS[di];
    box(1.9, 0.12, 1.0, '#7a5c3e', x, 0.74, z);
    for (const [lx, lz] of [
      [-0.85, -0.4],
      [0.85, -0.4],
      [-0.85, 0.4],
      [0.85, 0.4],
    ] as const) {
      box(0.09, 0.74, 0.09, '#4a3826', x + lx, 0.37, z + lz);
    }
    box(0.95, 0.6, 0.07, '#14161c', x, 1.2, z - 0.32);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.85, 0.5),
      new THREE.MeshStandardMaterial({
        color: '#0b1220',
        emissive: '#2563eb',
        emissiveIntensity: 0.55,
        roughness: 0.4,
      }),
    );
    glow.position.set(x, 1.2, z - 0.28);
    addTo('workspace', glow);
    // Second angled monitor on every third desk (reference look).
    if (di % 3 === 0) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.06), std('#14161c'));
      side.position.set(x + 0.75, 1.12, z - 0.2);
      side.rotation.y = -0.5;
      side.castShadow = true;
      addTo('workspace', side);
    }
    // Keyboard slab + mug on alternating desks.
    box(0.7, 0.04, 0.25, '#d6d3cd', x, 0.82, z + 0.18);
    if (di % 2 === 0) {
      const mug = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.08, 0.16, 10),
        std(['#f472b6', '#38bdf8', '#a3e635'][di % 3], 0.7),
      );
      mug.position.set(x - 0.65, 0.88, z + 0.25);
      addTo('workspace', mug);
    }
    // Office chair: seat cushion + high back + stem + disc base.
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 14), std('#23262e'));
    seat.position.set(x, 0.48, z + 0.8);
    seat.castShadow = true;
    addTo('workspace', seat);
    box(0.55, 0.65, 0.08, '#23262e', x, 1.0, z + 1.06);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8), std('#111318'));
    stem.position.set(x, 0.22, z + 0.8);
    addTo('workspace', stem);
    const chairBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.3, 0.05, 12),
      std('#111318'),
    );
    chairBase.position.set(x, 0.03, z + 0.8);
    addTo('workspace', chairBase);
  }

  // Meeting table + chairs (glass meeting room, right side): one long
  // table, three chairs per side, strictly symmetric. MEETING_SEATS is
  // the single source of truth — furniture and agent slots share it.
  const meetCenter = { x: 9.4, z: -2.2 };
  const MEETING_SEATS: { x: number; z: number }[] = [
    { x: 8, z: -3.6 },
    { x: 9.4, z: -3.6 },
    { x: 10.8, z: -3.6 },
    { x: 8, z: -0.8 },
    { x: 9.4, z: -0.8 },
    { x: 10.8, z: -0.8 },
  ];
  const meetYaw = (p: { x: number; z: number }): number =>
    Math.atan2(meetCenter.x - p.x, meetCenter.z - p.z);
  box(4.6, 0.14, 2.3, '#6e5638', meetCenter.x, 0.72, meetCenter.z);
  box(0.16, 0.72, 0.16, '#4a3826', meetCenter.x - 2, 0.36, meetCenter.z - 0.9);
  box(0.16, 0.72, 0.16, '#4a3826', meetCenter.x + 2, 0.36, meetCenter.z + 0.9);
  for (const p of MEETING_SEATS) {
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.1, 14), std('#374151'));
    seat.position.set(p.x, 0.45, p.z);
    seat.castShadow = true;
    addTo('workspace', seat);
  }

  // Reception counter (Chat) — inside the meeting room's front corner.
  const recep = { x: 9.4, z: 3.4 };
  const counter = box(3.4, 1.05, 0.95, '#6b5a44', recep.x, 0.53, recep.z - 1.35);
  box(3.6, 0.1, 1.1, '#8a7355', recep.x, 1.1, recep.z - 1.35);
  tagZone(counter, 'reception');
  zoneLabel('💬 Chat', recep.x, 2.6, recep.z - 1.35);

  // ── Meeting-room wall screen (reference: big display) ────────────
  // Dark glowing screen on the meeting room's back wall with bar-chart
  // content, matching the staff-room dashboard language.
  {
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.5),
      new THREE.MeshStandardMaterial({
        color: '#0b1220',
        emissive: '#1d4ed8',
        emissiveIntensity: 0.4,
        roughness: 0.4,
      }),
    );
    screen.position.set(9.4, 2.3, -ROOM_D / 2 + 0.04);
    addTo('workspace', screen);
    const rng = mulberry32(64);
    for (let i = 0; i < 6; i++) {
      const h = 0.25 + rng() * 0.75;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.24, h, 0.06), std('#38bdf8', 0.6));
      bar.position.set(8.55 + i * 0.35, 1.85 + h / 2, -ROOM_D / 2 + 0.09);
      addTo('workspace', bar);
    }
  }

  // Kanban board (Projects) — back wall of the open room.
  const kanban = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.9), std('#e8e6df', 0.7));
  kanban.position.set(-1.4, 2.2, -ROOM_D / 2 + 0.03);
  addTo('workspace', kanban);
  tagZone(kanban, 'kanban');
  {
    const rng = mulberry32(7);
    const colors = ['#fca5a5', '#fcd34d', '#86efac', '#93c5fd', '#f0abfc', '#fdba74'];
    for (let i = 0; i < 6; i++) {
      const note = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.5),
        std(colors[Math.floor(rng() * colors.length)], 0.8),
      );
      note.position.set(-2.5 + (i % 3) * 1.1, 2.5 - Math.floor(i / 3) * 0.8, -ROOM_D / 2 + 0.05);
      addTo('workspace', note);
    }
  }
  zoneLabel('🗂 Projects', -1.4, 3.6, -ROOM_D / 2 + 0.4);

  // Bookshelf against the west end of the back wall (Knowledge) —
  // long axis along X, clear of the CEO desk (x -10.3..-6.9,
  // z -3.05..-1.35) and the kanban (x -3.2..0.4).
  const shelf = box(3.6, 2.6, 0.7, '#5d4630', -7, 1.3, -7.9);
  tagZone(shelf, 'bookshelf');
  {
    const rng = mulberry32(21);
    const colors = ['#b91c1c', '#1d4ed8', '#15803d', '#a16207', '#6d28d9', '#0e7490'];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 9; i++) {
        const h = 0.45 + rng() * 0.25;
        const book = new THREE.Mesh(
          new THREE.BoxGeometry(0.24, h, 0.4),
          std(colors[Math.floor(rng() * colors.length)], 0.85),
        );
        book.position.set(-8.35 + i * 0.32, 0.55 + row * 0.75 + h / 2, -7.9);
        book.castShadow = true;
        addTo('workspace', book);
      }
    }
  }
  zoneLabel('📚 Knowledge', -7, 3.4, -7.3);

  // CEO desk: executive centerpiece in the open room — mahogany top
  // with brass trim, dual monitors, desk lamp, and a plush high-back
  // chair. Same room as staff, but the desk reads conventions above.
  {
    const dx = -8.6;
    const dz = -2.2;
    // Mahogany top + brass edge trim + modesty panel.
    box(3.4, 0.16, 1.7, '#6e4526', dx, 0.8, dz);
    box(3.5, 0.05, 1.8, '#c9a227', dx, 0.88, dz);
    box(3.4, 0.06, 1.7, '#6e4526', dx, 0.92, dz);
    box(3.0, 0.68, 0.1, '#4a2f1a', dx, 0.44, dz - 0.7);
    // Pedestal drawers both sides with brass knobs.
    for (const sx of [-1.35, 1.35] as const) {
      box(0.6, 0.78, 1.3, '#5b3a20', dx + sx, 0.41, dz);
      for (let r = 0; r < 2; r++) {
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), std('#e3b341', 0.35));
        knob.position.set(dx + sx, 0.32 + r * 0.28, dz + 0.67);
        addTo('workspace', knob);
      }
    }
    // Dual monitors angled toward the chair, both glowing.
    for (const mx of [-0.6, 0.6] as const) {
      box(1.1, 0.68, 0.08, '#14161c', dx + mx, 1.42, dz - 0.55);
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(1.0, 0.58),
        new THREE.MeshStandardMaterial({
          color: '#0b1220',
          emissive: '#2563eb',
          emissiveIntensity: 0.6,
          roughness: 0.4,
        }),
      );
      glow.position.set(dx + mx, 1.42, dz - 0.5);
      addTo('workspace', glow);
      box(0.08, 0.42, 0.08, '#2b2b30', dx + mx, 1.12, dz - 0.58);
    }
    // Keyboard slab + brass desk lamp + nameplate.
    box(1.2, 0.04, 0.4, '#d6d3cd', dx, 0.97, dz + 0.25);
    const lampArm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.7, 8),
      std('#8a6a1f', 0.4),
    );
    lampArm.position.set(dx + 1.4, 1.25, dz - 0.3);
    lampArm.rotation.z = 0.35;
    addTo('workspace', lampArm);
    const lampHead = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.24, 12), std('#8a6a1f', 0.4));
    lampHead.position.set(dx + 1.25, 1.55, dz - 0.25);
    lampHead.rotation.z = 0.9;
    addTo('workspace', lampHead);
    const plate = makeTextSprite('👑 CEO', 30, 'rgba(20,14,6,0.9)', '#fde68a');
    plate.position.set(dx, 1.15, dz + 0.75);
    plate.scale.multiplyScalar(0.7);
    addTo('workspace', plate);
    // Plush high-back chair: seat + tall back + armrests + stem + base.
    const chairMat = std('#7c2d12', 0.8);
    const ceoSeat = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.14, 16), chairMat);
    ceoSeat.position.set(dx, 0.52, dz + 1.5);
    ceoSeat.castShadow = true;
    addTo('workspace', ceoSeat);
    box(0.85, 1.25, 0.14, '#7c2d12', dx, 1.2, dz + 1.95);
    for (const ax of [-0.5, 0.5] as const) {
      box(0.1, 0.35, 0.5, '#5b2110', dx + ax, 0.85, dz + 1.5);
    }
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.42, 8), std('#111318'));
    stem.position.set(dx, 0.24, dz + 1.5);
    addTo('workspace', stem);
    const chairBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.36, 0.06, 14),
      std('#111318'),
    );
    chairBase.position.set(dx, 0.04, dz + 1.5);
    addTo('workspace', chairBase);
  }

  // Dashboard screen (Runs) — back wall of the open room, right of
  // the clock, clear of the meeting-room divider (x = 5.5).
  const dash = new THREE.Mesh(
    new THREE.PlaneGeometry(2.7, 1.5),
    new THREE.MeshStandardMaterial({
      color: '#0b1220',
      emissive: '#0ea5e9',
      emissiveIntensity: 0.35,
      roughness: 0.4,
    }),
  );
  dash.position.set(3.9, 2.2, -ROOM_D / 2 + 0.03);
  addTo('workspace', dash);
  tagZone(dash, 'dashboard');
  {
    const rng = mulberry32(99);
    for (let i = 0; i < 5; i++) {
      const h = 0.25 + rng() * 0.7;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.28, h, 0.06), std('#22c55e', 0.6));
      bar.position.set(3.1 + i * 0.42, 1.75 + h / 2, -ROOM_D / 2 + 0.08);
      addTo('workspace', bar);
    }
  }
  zoneLabel('📊 Runs', 3.9, 3.4, -ROOM_D / 2 + 0.4);

  // Wall clock — back wall of the staff room, centered between kanban
  // and dashboard with clear gaps on both sides (never on a partition).
  const clockGroup = new THREE.Group();
  clockGroup.position.set(1.5, 3.1, -ROOM_D / 2 + 0.06);
  addTo('workspace', clockGroup);
  let hourHand: THREE.Mesh;
  let minuteHand: THREE.Mesh;
  {
    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.08, 28),
      std('#f8fafc', 0.5),
    );
    face.rotation.x = Math.PI / 2;
    clockGroup.add(face);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 10, 28), std('#1f2937', 0.5));
    clockGroup.add(rim);
    for (let i = 0; i < 12; i++) {
      const tickMark = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.02), std('#1f2937'));
      const ang = (i / 12) * Math.PI * 2;
      tickMark.position.set(Math.sin(ang) * 0.45, Math.cos(ang) * 0.45, 0.05);
      tickMark.rotation.z = -ang;
      clockGroup.add(tickMark);
    }
    const handMat = std('#111827', 0.5);
    hourHand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.3, 0.03), handMat);
    hourHand.geometry.translate(0, 0.12, 0);
    hourHand.position.z = 0.07;
    clockGroup.add(hourHand);
    minuteHand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.03), handMat);
    minuteHand.geometry.translate(0, 0.19, 0);
    minuteHand.position.z = 0.09;
    clockGroup.add(minuteHand);
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), std('#dc2626'));
    pin.position.z = 0.11;
    clockGroup.add(pin);
    const clockLabel = makeTextSprite('🕐 Batu', 28, 'rgba(10,10,15,0.78)', '#fde68a');
    clockLabel.position.set(0, 0.95, 0);
    clockLabel.scale.multiplyScalar(0.75);
    clockGroup.add(clockLabel);
  }

  function setClock(hour: number, minute: number): void {
    const h = ((hour % 12) + minute / 60) / 12;
    const m = (minute % 60) / 60;
    hourHand.rotation.z = -h * Math.PI * 2;
    minuteHand.rotation.z = -m * Math.PI * 2;
  }

  // Pantry corner on the workspace floor (idle agents drift here).
  const water = toWorld(WATER_SPOT.x, WATER_SPOT.y);
  {
    const fridge = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.7), std('#cbd5e1', 0.4));
    fridge.position.set(water.x + 1.3, 0.85, water.z - 0.6);
    fridge.castShadow = true;
    addTo('workspace', fridge);
    zoneLabel('☕ Pantry', water.x + 0.6, 2.5, water.z - 0.6);
  }
  const cooler = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.34, 1.0, 16),
    std('#e5e7eb', 0.5),
  );
  cooler.position.set(water.x + 0.9, 0.5, water.z);
  cooler.castShadow = true;
  addTo('workspace', cooler);
  const bottle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.55, 16),
    new THREE.MeshStandardMaterial({
      color: '#7dd3fc',
      transparent: true,
      opacity: 0.75,
      roughness: 0.2,
    }),
  );
  bottle.position.set(water.x + 0.9, 1.28, water.z);
  addTo('workspace', bottle);

  // ── Lounge corner (reference: sofa + coffee table + laptop) ──────
  // CEO-room lounge, front of the executive desk: two facing sofas, a low table
  // with an open laptop, and a floor lamp.
  {
    const sofaMat = std('#cfc3ae', 0.95);
    const sofaDark = std('#a89a82', 0.95);
    const mkSofa = (x: number, z: number, yaw: number): void => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 0.95), sofaMat);
      base.position.y = 0.35;
      base.castShadow = true;
      g.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.75, 0.22), sofaMat);
      back.position.set(0, 0.8, -0.42);
      back.castShadow = true;
      g.add(back);
      for (const ax of [-1, 1] as const) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.7, 0.95), sofaDark);
        arm.position.set(ax * 1.2, 0.55, 0);
        arm.castShadow = true;
        g.add(arm);
        const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 0.8), sofaDark);
        cushion.position.set(ax * 0.52, 0.66, 0.03);
        g.add(cushion);
      }
      g.position.set(x, 0, z);
      g.rotation.y = yaw;
      addTo('workspace', g);
    };
    mkSofa(-8.6, 4.6, Math.PI);
    mkSofa(-8.6, 6.9, 0);
    // Coffee table + open laptop (screen glows like the desk monitors).
    const coffee = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.32, 0.8), std('#8a7355'));
    coffee.position.set(-8.6, 0.32, 5.75);
    coffee.castShadow = true;
    addTo('workspace', coffee);
    const lapBase = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.34), std('#1f2937', 0.5));
    lapBase.position.set(-8.6, 0.5, 5.75);
    lapBase.rotation.y = 0.5;
    addTo('workspace', lapBase);
    const lapScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.46, 0.3),
      new THREE.MeshStandardMaterial({
        color: '#0b1220',
        emissive: '#2563eb',
        emissiveIntensity: 0.55,
        roughness: 0.4,
      }),
    );
    lapScreen.position.set(-8.48, 0.64, 5.62);
    lapScreen.rotation.set(-0.35, 0.5, 0);
    addTo('workspace', lapScreen);
    // Floor lamp with a warm shade beside the sofas.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.7, 8), std('#3a3a40'));
    pole.position.set(-6.6, 0.85, 6.9);
    addTo('workspace', pole);
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.34, 0.4, 12, 1, true),
      std('#e8dcc2', 0.8),
    );
    shade.position.set(-6.6, 1.8, 6.9);
    addTo('workspace', shade);
    const lampBulbMat = new THREE.MeshBasicMaterial({ color: '#fde68a', fog: false });
    const lampBulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), lampBulbMat);
    lampBulb.position.set(-6.6, 1.68, 6.9);
    addTo('workspace', lampBulb);
    pendantBulbMats.push(lampBulbMat);
    zoneLabel('🛋️ Lounge', -8.6, 2.2, 6.2);
  }

  // ── Plants (reference: tall snake plants in pots) ───────────────
  // Terracotta pot + upright tapered blades; deterministic spots,
  // clear of desks.
  {
    const potMat = std('#b08968', 0.9);
    const leafMat = std('#2f7a44', 0.9);
    const leafMat2 = std('#45a35e', 0.9);
    const mkPlant = (x: number, z: number, s: number): void => {
      const g = new THREE.Group();
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3 * s, 0.24 * s, 0.5 * s, 12),
        potMat,
      );
      pot.position.y = 0.25 * s;
      pot.castShadow = true;
      g.add(pot);
      const rng = mulberry32(Math.floor(x * 13 + z * 71 + 500));
      for (let i = 0; i < 7; i++) {
        const h = (0.9 + rng() * 0.7) * s;
        const blade = new THREE.Mesh(
          new THREE.ConeGeometry(0.09 * s, h, 6),
          i % 2 === 0 ? leafMat : leafMat2,
        );
        const ang = (i / 7) * Math.PI * 2;
        blade.position.set(Math.cos(ang) * 0.12 * s, 0.5 * s + h / 2, Math.sin(ang) * 0.12 * s);
        blade.rotation.set((rng() - 0.5) * 0.22, 0, (rng() - 0.5) * 0.22);
        blade.castShadow = true;
        g.add(blade);
      }
      g.position.set(x, 0, z);
      addTo('workspace', g);
    };
    mkPlant(-11.8, 6.8, 1.3);
    mkPlant(-3, -7.2, 1);
    mkPlant(5.2, 6.6, 1.2);
    mkPlant(12.1, 1.2, 1.1);
    mkPlant(12.1, -6.4, 0.9);
    mkPlant(-4.9, 6.4, 0.9);
    mkPlant(-11.9, -7.1, 1);
  }

  // ── Wall shelf + pinboard (reference: shelves + idea wall) ───────
  {
    // Open wall shelf on the left wall with books + a tiny plant.
    const shelfMat = std('#8a6a45', 0.85);
    for (let row = 0; row < 3; row++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 3.2), shelfMat);
      plank.position.set(-ROOM_W / 2 + 0.55, 2 + row * 0.8, 1.5);
      plank.castShadow = true;
      addTo('workspace', plank);
    }
    const rng = mulberry32(53);
    const colors = ['#b91c1c', '#1d4ed8', '#15803d', '#a16207', '#6d28d9'];
    for (let i = 0; i < 7; i++) {
      const h = 0.4 + rng() * 0.2;
      const bk = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, h, 0.22),
        std(colors[Math.floor(rng() * colors.length)], 0.85),
      );
      bk.position.set(-ROOM_W / 2 + 0.55, 2.24 + h / 2, 0.3 + i * 0.32);
      addTo('workspace', bk);
    }
    zoneLabel('📖 Rak', -ROOM_W / 2 + 1.2, 3.2, 4.6);
    // Pinboard / idea wall on the left wall (back corner): cream board
    // + colorful sticky notes, clear of the wall shelf (z ≈ 1.5).
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.5), std('#f3ead3', 0.8));
    board.rotation.y = Math.PI / 2;
    board.position.set(-ROOM_W / 2 + 0.1, 2.3, -4.5);
    addTo('workspace', board);
    const rng2 = mulberry32(12);
    const notes = ['#fca5a5', '#fcd34d', '#86efac', '#93c5fd', '#f0abfc', '#fdba74'];
    for (let i = 0; i < 8; i++) {
      const note = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.34),
        std(notes[Math.floor(rng2() * notes.length)], 0.85),
      );
      note.rotation.y = Math.PI / 2;
      note.rotation.z = (rng2() - 0.5) * 0.25;
      note.position.set(-ROOM_W / 2 + 0.16, 2.6 - Math.floor(i / 4) * 0.55, -5.2 + (i % 4) * 0.48);
      addTo('workspace', note);
    }
    zoneLabel('💡 Ide', -ROOM_W / 2 + 0.9, 3.45, -4.5);
  }

  // ── Office cat (reference: ginger cat asleep on the rug) ─────────
  // A curled-up loaf beside the staff desks; its tail sways in tick.
  {
    const cat = new THREE.Group();
    const fur = std('#c97b2d', 0.95);
    const bodyC = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 12), fur);
    bodyC.scale.set(1.25, 0.62, 1);
    bodyC.position.y = 0.2;
    bodyC.castShadow = true;
    cat.add(bodyC);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), fur);
    head.position.set(0.36, 0.24, 0.1);
    head.castShadow = true;
    cat.add(head);
    for (const ex of [-0.09, 0.09] as const) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.12, 6), fur);
      ear.position.set(0.36 + ex, 0.42, 0.1);
      cat.add(ear);
    }
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.55, 8), fur);
    tail.position.set(-0.42, 0.3, 0);
    tail.rotation.z = 0.9;
    cat.add(tail);
    catTail = tail;
    cat.position.set(-3.4, 0, 1.6);
    cat.rotation.y = 0.7;
    addTo('workspace', cat);
  }

  // ─── Agents (workspace floor) ────────────────────────────────────
  // One open room: the CEO at the executive desk (west end), talking
  // staff around the meeting table, waiting staff queued at the
  // meeting door, everyone else at a staff-room desk. Slot lists have
  // spares plus computed overflow so a big roster never stacks two
  // characters on the same spot.
  // Explicit owner orders (side-panel "Kirim ke lantai"): beat roam
  // and home seats, but never interrupt talking/waiting work. Sending
  // back to workspace clears the order (normal desk life resumes).
  const manualFloor = new Map<string, FloorId>();
  const agents = new Map<string, AgentNode>();
  const hitMeshes: THREE.Mesh[] = [];
  let roster: RoomAgent[] = [];
  const roamFloor = new Map<string, FloorId>();
  // Sticky desks: agent id -> STAFF_DESKS index. Claimed once, kept
  // while talking/waiting/roaming (desk stays empty), freed only on
  // hire/fire removal. Nobody ever takes another's desk.
  const deskClaim = new Map<string, number>();
  let waterBreakerId: string | null = null;
  let selectedId: string | null = null;
  // Shared sim clock (seconds): the water/cooler + roam timers below and
  // the lift machine both read it, so it lives beside the agent system.
  let elapsed = 0;
  const waterTimer = window.setInterval(() => {
    waterBreakerId = null;
    pickWaterBreaker();
    retarget();
  }, 45_000);
  // Every 45s (offset from the pantry timer) one seated desk worker
  // roams to another floor for a visit. Roam assignments persist in
  // roamFloor until the roster recalls them, so the trip always goes
  // through the lift via retarget → startLiftTrip.
  const roamTimer = window.setInterval(() => {
    const sitters = roster.filter(
      (a) =>
        !a.is_system &&
        a.status === 'active' &&
        a.state !== 'talking' &&
        a.state !== 'waiting_human' &&
        !roamFloor.has(a.id),
    );
    if (sitters.length <= 4) return; // keep the workspace populated
    const pick = sitters[Math.floor(Math.random() * sitters.length)];
    const order: FloorId[] = ['kitchen', 'rooftop', 'parking'];
    roamFloor.set(pick.id, order[Math.floor(Math.random() * order.length)]);
    retarget();
  }, 45_000);

  function pickWaterBreaker(): void {
    const idle = roster.filter((a) => !a.is_system && a.status === 'active' && a.state === 'idle');
    if (idle.length === 0) {
      waterBreakerId = null;
      return;
    }
    if (waterBreakerId && idle.some((a) => a.id === waterBreakerId)) return;
    waterBreakerId = idle[Math.floor(Math.random() * idle.length)].id;
  }

  function slotFor(agent: RoomAgent, ctx: Ctx): Slot {
    // Owner's manual order wins over roam/home/pantry — but busy
    // agents (talking, waiting) finish work first. The CEO rides along
    // too: an ordered CEO takes a visiting chair, an unordered one holds
    // the executive desk.
    const manual = manualFloor.get(agent.id);
    if (
      manual &&
      manual !== 'workspace' &&
      agent.state !== 'talking' &&
      agent.state !== 'waiting_human'
    ) {
      const s = roamSlotFor(agent, manual, claimChair(ctx, manual));
      if (s) return s;
    }
    // CEO holds the executive desk at the west end of the open room,
    // seated on the high-back chair, facing the desk. Kind 'desk' so
    // the sit pose applies like staff (was 'reception' = always stand).
    if (agent.is_system) {
      return { floor: 'workspace', x: -8.6, z: -0.65, yaw: Math.PI, kind: 'desk' };
    }
    if (agent.id === waterBreakerId && agent.state === 'idle') {
      const p = toWorld(WATER_SPOT.x, WATER_SPOT.y);
      return { floor: 'workspace', ...p, yaw: Math.PI / 2, kind: 'water' };
    }
    // Roamers (see roamTimer) live on another floor until recalled.
    const roam = ctx.roamFloor.get(agent.id);
    if (roam && agent.state !== 'talking' && agent.state !== 'waiting_human') {
      const s = roamSlotFor(agent, roam, claimChair(ctx, roam));
      if (s) return s;
    }
    if (ctx.talking.has(agent.id)) {
      // Talking staff gather around the meeting-room table (right wing),
      // matching the six symmetric chairs (3 per side). Overflow wraps
      // with a small offset so nobody stacks on one chair.
      const i = ctx.talkingList.findIndex((a) => a.id === agent.id);
      const p = MEETING_SEATS[i % MEETING_SEATS.length];
      const cycle = Math.floor(i / MEETING_SEATS.length);
      return {
        floor: 'workspace',
        x: p.x + cycle * 0.8,
        z: p.z + cycle * 0.3,
        yaw: meetYaw(p),
        kind: 'meeting',
      };
    }
    if (ctx.waiting.has(agent.id)) {
      // Waiting staff queue at the meeting room door (staff side).
      // Overflow steps back into the staff room instead of stacking.
      const spots = [
        { x: 4.4, z: -0.6 },
        { x: 4.4, z: 0.6 },
        { x: 4.4, z: 1.8 },
        { x: 4.4, z: 3 },
      ];
      const i = ctx.waitingList.findIndex((a) => a.id === agent.id);
      const p = spots[i % spots.length];
      const cycle = Math.floor(i / spots.length);
      return { floor: 'workspace', x: p.x - cycle * 0.9, z: p.z, yaw: Math.PI / 2, kind: 'queue' };
    }
    // Everyone else sits at their claimed desk (buildCtx assigns it) —
    // never another's. Fallback (all desks taken) lives on a visiting
    // floor, keyed by agent so it stays stable across passes.
    const home = ctx.homeSeats.get(agent.id);
    if (home) return home;
    const order: FloorId[] = ['kitchen', 'rooftop', 'parking'];
    let h = 0;
    for (let i = 0; i < agent.id.length; i++) h = (h * 31 + agent.id.charCodeAt(i)) >>> 0;
    const fallbackFloor = order[h % order.length];
    const fallback = roamSlotFor(agent, fallbackFloor, claimChair(ctx, fallbackFloor));
    if (fallback) return fallback;
    const s = STAFF_DESKS[0];
    return { floor: 'workspace', x: s.x, z: s.z + 0.85, yaw: Math.PI, kind: 'desk' };
  }

  // Chairs on the visiting floors, in assignment order. Dining stools
  // circle their table (matching the 4 compass stools built below),
  // loungers line the rooftop deck, parking uses marked lane spots.
  const DINE_TABLES = [
    { x: -4.4, z: 2.6 },
    { x: 0, z: 2.6 },
    { x: 4.4, z: 2.6 },
  ];
  const ROOF_LOUNGERS = [
    { x: 4.5, z: -1 },
    { x: 6.7, z: -1 },
    { x: 4.5, z: 2 },
  ];
  const PARK_LANE = [
    { x: -9, z: 5.2 },
    { x: -5.6, z: 5.2 },
    { x: -2.2, z: 5.2 },
    { x: 1.2, z: 5.2 },
  ];

  /** Next free chair index on a visiting floor (bumps the cursor so
   *  concurrent roamers never share a chair within one pass). */
  function claimChair(ctx: Ctx, floor: FloorId): number {
    const i = ctx.chairCursor.get(floor) ?? 0;
    ctx.chairCursor.set(floor, i + 1);
    return i;
  }

  function roamSlotFor(agent: RoomAgent, floor: FloorId, chairIdx: number): Slot | null {
    if (floor === 'kitchen') {
      const t = DINE_TABLES[chairIdx % DINE_TABLES.length];
      const ang = ((chairIdx % 4) / 4) * Math.PI * 2;
      const x = t.x + Math.cos(ang) * 1.7;
      const z = t.z + Math.sin(ang) * 1.7;
      return { floor, x, z, yaw: Math.atan2(t.x - x, t.z - z), kind: 'dine' };
    }
    if (floor === 'rooftop') {
      // Jam corner + stargaze first, loungers after: index 0 guitar,
      // 1 drums, 2-3 beach chairs (selonjoran lihat langit), rest loungers.
      if (chairIdx === 0) {
        return { floor, x: GUITAR_SEAT.x, z: GUITAR_SEAT.z, yaw: GUITAR_SEAT.yaw, kind: 'guitar' };
      }
      if (chairIdx === 1) {
        return { floor, x: DRUM_SEAT.x, z: DRUM_SEAT.z, yaw: DRUM_SEAT.yaw, kind: 'drums' };
      }
      if (chairIdx === 2 || chairIdx === 3) {
        const spot = STARGAZE_SPOTS[(chairIdx - 2) % STARGAZE_SPOTS.length];
        return { floor, x: spot.x, z: spot.z, yaw: spot.yaw, kind: 'stargaze' };
      }
      const p = ROOF_LOUNGERS[(chairIdx - 4) % ROOF_LOUNGERS.length];
      return { floor, x: p.x, z: p.z + 0.9, yaw: Math.PI, kind: 'lounge' };
    }
    if (floor === 'parking') {
      const p = PARK_LANE[chairIdx % PARK_LANE.length];
      return { floor, x: p.x, z: p.z, yaw: Math.PI, kind: 'park' };
    }
    return null;
  }

  interface Ctx {
    talking: Set<string>;
    waiting: Set<string>;
    talkingList: RoomAgent[];
    waitingList: RoomAgent[];
    /** Home seat per non-busy employee: desks first, then free
     *  meeting chairs, then the visiting floors — every level stays
     *  populated, nobody shares. */
    homeSeats: Map<string, Slot>;
    /** Floor change requests waiting for a cabin slot. */
    pendingFloor: Map<string, FloorId>;
    /** Where roamers currently live (cleared when recalled/desked). */
    roamFloor: Map<string, FloorId>;
    /** Next free chair index per visiting floor. */
    chairCursor: Map<FloorId, number>;
  }

  function buildCtx(list: RoomAgent[]): Ctx {
    const deskAgents = list.filter((a) => !a.is_system);
    const talkingList = deskAgents.filter((a) => a.state === 'talking');
    const waitingList = deskAgents.filter((a) => a.state === 'waiting_human');
    const talking = new Set(talkingList.map((a) => a.id));
    const waiting = new Set(waitingList.map((a) => a.id));
    const staying = deskAgents.filter((a) => a.state !== 'talking' && a.state !== 'waiting_human');
    const homeSeats = new Map<string, Slot>();
    const pendingFloor = new Map<string, FloorId>();
    const chairCursor = new Map<FloorId, number>();
    // An ordered CEO travels like staff (manual chair on the ordered
    // floor); an unordered one never enters the desk queue (see slotFor).
    const orderedCeo = list.find(
      (a) =>
        a.is_system &&
        manualFloor.get(a.id) !== undefined &&
        manualFloor.get(a.id) !== 'workspace' &&
        a.state !== 'talking' &&
        a.state !== 'waiting_human',
    );
    if (orderedCeo) {
      const manual = manualFloor.get(orderedCeo.id)!;
      const node = agents.get(orderedCeo.id);
      if (!node || node.floor !== manual) pendingFloor.set(orderedCeo.id, manual);
      roamFloor.set(orderedCeo.id, manual);
      const s = roamSlotFor(orderedCeo, manual, chairCursor.get(manual) ?? 0);
      chairCursor.set(manual, (chairCursor.get(manual) ?? 0) + 1);
      if (s) homeSeats.set(orderedCeo.id, s);
    }
    // Prune claims of removed agents so a freed desk goes to the next hire.
    for (const id of [...deskClaim.keys()]) {
      if (!deskAgents.some((a) => a.id === id)) deskClaim.delete(id);
    }
    // First pass: sticky personal desks. Each staffer claims one desk
    // once and keeps it while talking/waiting/roaming (the desk stays
    // empty) — nobody ever sits at another's desk. Staff with a manual
    // order or a roam assignment skip the desk queue — they belong to
    // their ordered floor (slotFor resolves the exact chair).
    const overflow: RoomAgent[] = [];
    for (const a of staying) {
      const manual = manualFloor.get(a.id);
      const held = roamFloor.get(a.id);
      if ((manual && manual !== 'workspace') || (held && held !== 'workspace')) {
        overflow.push(a);
        continue;
      }
      let idx = deskClaim.get(a.id);
      if (idx === undefined) {
        const used = new Set(deskClaim.values());
        const free = STAFF_DESKS.findIndex((_, i) => !used.has(i));
        if (free === -1) {
          // All desks taken: live on a visiting floor (second pass),
          // never at someone else's desk.
          overflow.push(a);
          continue;
        }
        idx = free;
        deskClaim.set(a.id, idx);
      }
      const s = STAFF_DESKS[idx];
      homeSeats.set(a.id, {
        floor: 'workspace',
        x: s.x,
        z: s.z + 0.85,
        yaw: Math.PI,
        kind: 'desk',
      });
      roamFloor.delete(a.id);
    }
    // Second pass: manual orders first (exact floor), then overflow
    // roams the visiting floors. A fresh roam queues a lift trip via
    // pendingFloor; a held roam keeps its slot.
    const order: FloorId[] = ['kitchen', 'rooftop', 'parking'];
    let roamJ = 0;
    overflow.forEach((a) => {
      const manual = manualFloor.get(a.id);
      if (manual && manual !== 'workspace') {
        roamFloor.set(a.id, manual);
        const probe: Ctx = {
          talking,
          waiting,
          talkingList,
          waitingList,
          homeSeats,
          pendingFloor,
          roamFloor,
          chairCursor,
        };
        // Manual trip is "fresh" unless the agent already lives there.
        const node = agents.get(a.id);
        if (!node || node.floor !== manual) pendingFloor.set(a.id, manual);
        const s = roamSlotFor(a, manual, claimChair(probe, manual));
        if (s) homeSeats.set(a.id, s);
        return;
      }
      let held = roamFloor.get(a.id);
      if (!held || held === 'workspace') {
        held = order[roamJ % order.length];
        pendingFloor.set(a.id, held);
        roamFloor.set(a.id, held);
      }
      roamJ += 1;
      const probe: Ctx = {
        talking,
        waiting,
        talkingList,
        waitingList,
        homeSeats,
        pendingFloor,
        roamFloor,
        chairCursor,
      };
      const s = roamSlotFor(a, held, claimChair(probe, held));
      if (s) homeSeats.set(a.id, s);
    });
    return {
      talking,
      waiting,
      talkingList,
      waitingList,
      homeSeats,
      pendingFloor,
      roamFloor,
      chairCursor,
    };
  }

  function addAgent(data: RoomAgent, floor: FloorId): AgentNode {
    const group = new THREE.Group();
    const rig = new THREE.Group();
    group.add(rig);

    const color = agentColor(data.id, data.is_system);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({ color: '#f1c9a5', roughness: 0.65 });
    if (data.is_system) headMat.color.set('#e8b98a');

    // Blocky voxel torso + cube head (minecraft-style): crisp boxes,
    // flat face with eyes so facing reads at a glance.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, 0.32), bodyMat);
    body.position.y = 1.3;
    body.castShadow = true;
    rig.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.54, 0.54), headMat);
    head.position.y = 1.95;
    head.castShadow = true;
    rig.add(head);
    for (const side of [-1, 1] as const) {
      // Eyes ride on the head mesh (not the rig) so the stargaze
      // head-tilt carries the face along.
      const white = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.02), std('#f8fafc', 0.6));
      white.position.set(0.12 * side, 0.04, 0.275);
      head.add(white);
      const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.02), std('#1e3a8a', 0.6));
      pupil.position.set(0.12 * side, 0.03, 0.285);
      head.add(pupil);
    }

    // Pelvis + articulated legs in darkened agent color (work pants) so
    // characters stand on shoes instead of hovering. Hips pivot for the
    // walk swing and the chair sit; knees bend to match.
    const pantsMat = new THREE.MeshStandardMaterial({ color: '#2b3245', roughness: 0.8 });
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.24, 0.3), pantsMat);
    pelvis.position.y = 0.86;
    pelvis.castShadow = true;
    rig.add(pelvis);

    function buildLeg(side: number): { hip: THREE.Group; knee: THREE.Group } {
      const hip = new THREE.Group();
      hip.position.set(0.14 * side, 0.82, 0);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 0.24), pantsMat);
      thigh.position.y = -0.19;
      thigh.castShadow = true;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.38;
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.32, 0.22), pantsMat);
      shin.position.y = -0.16;
      shin.castShadow = true;
      knee.add(shin);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.34), std('#1f2937', 0.7));
      shoe.position.set(0, -0.38, 0.05);
      shoe.castShadow = true;
      knee.add(shoe);
      hip.add(knee);
      rig.add(hip);
      return { hip, knee };
    }
    const legL = buildLeg(-1);
    const legR = buildLeg(1);

    // Arms in shirt color pivot at the shoulder; hands share the skin
    // material so name/selection tinting stays in sync for free.
    function buildArm(side: number): THREE.Group {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.38 * side, 1.52, 0);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.22), bodyMat);
      arm.position.y = -0.3;
      arm.castShadow = true;
      shoulder.add(arm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.2), headMat);
      hand.position.y = -0.66;
      hand.castShadow = true;
      shoulder.add(hand);
      rig.add(shoulder);
      return shoulder;
    }
    const armL = buildArm(-1);
    const armR = buildArm(1);

    // Rooftop jam props: guitar held across the lap, drumsticks in both
    // hands. Built once per agent (cheap boxes), hidden unless the agent
    // sits at that jam slot — visibility syncs in refreshChrome/retarget.
    const guitarProp = new THREE.Group();
    {
      const wood = std('#92400e', 0.6);
      const bodyG = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.16), wood);
      bodyG.castShadow = true;
      guitarProp.add(bodyG);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), std('#1f130a', 0.9));
      hole.position.set(0, 0.05, 0.085);
      guitarProp.add(hole);
      const neck = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.62, 0.07), std('#5b3a1e', 0.7));
      neck.position.set(0.12, 0.52, 0);
      neck.rotation.z = -0.35;
      guitarProp.add(neck);
      const headstock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.06), std('#3a2412', 0.7));
      headstock.position.set(0.23, 0.8, 0);
      headstock.rotation.z = -0.35;
      guitarProp.add(headstock);
      guitarProp.position.set(0.05, 1.05, 0.35);
      guitarProp.rotation.set(0.25, 0.15, -0.5);
      guitarProp.visible = false;
      rig.add(guitarProp);
    }
    const mkStick = (): THREE.Mesh => {
      const stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6),
        std('#e8dcc3', 0.7),
      );
      stick.position.set(0, -0.75, 0.12);
      stick.rotation.x = 1.1;
      stick.visible = false;
      return stick;
    };
    const stickL = mkStick();
    armL.add(stickL);
    const stickR = mkStick();
    armR.add(stickR);

    if (data.is_system) {
      const crownMat = new THREE.MeshStandardMaterial({
        color: '#fbbf24',
        roughness: 0.35,
        metalness: 0.6,
      });
      const crown = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.4), crownMat);
      crown.position.y = 2.28;
      crown.castShadow = true;
      rig.add(crown);
      for (const [cx, cz] of [
        [-0.14, -0.14],
        [0.14, -0.14],
        [-0.14, 0.14],
        [0.14, 0.14],
      ] as const) {
        const spike = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.08), crownMat);
        spike.position.set(cx, 2.39, cz);
        rig.add(spike);
      }
    }

    const ringMat = new THREE.MeshBasicMaterial({
      color: RING_COLORS.idle,
      transparent: true,
      opacity: 0.9,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.5, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);

    const selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.56, 0.7, 28),
      new THREE.MeshBasicMaterial({
        color: '#f472b6',
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      }),
    );
    selRing.rotation.x = -Math.PI / 2;
    selRing.position.y = 0.03;
    selRing.visible = false;
    group.add(selRing);

    const label = makeLabelSprite(data.is_system ? `${data.name} · CEO` : data.name);
    label.position.y = 2.56;
    group.add(label);

    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.62, 2.7, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 1.35;
    hit.userData.agentId = data.id;
    group.add(hit);
    hitMeshes.push(hit);

    addTo(floor, group);
    const node: AgentNode = {
      data,
      group,
      rig,
      bodyMat,
      headMat,
      pantsMat,
      hipL: legL.hip,
      hipR: legR.hip,
      kneeL: legL.knee,
      kneeR: legR.knee,
      armL,
      armR,
      propGuitar: guitarProp,
      propStickL: stickL,
      propStickR: stickR,
      head,
      slotKind: 'desk',
      ringMat,
      selRing,
      label,
      bubble: null,
      bubbleText: null,
      effect: null,
      effectText: null,
      hit,
      target: new THREE.Vector3(),
      waypoints: [],
      desiredYaw: 0,
      phase: Math.random() * Math.PI * 2,
      sitting: false,
      sitBlend: 0,
      floor,
      leg: 'slot',
      pending: null,
      alightT: -10,
    };
    agents.set(data.id, node);
    return node;
  }

  function removeAgent(id: string): void {
    deskClaim.delete(id);
    roamFloor.delete(id);
    manualFloor.delete(id);
    const node = agents.get(id);
    if (!node) return;
    node.group.parent?.remove(node.group);
    node.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) disposeObject(obj);
    });
    const hitIdx = hitMeshes.indexOf(node.hit);
    if (hitIdx >= 0) hitMeshes.splice(hitIdx, 1);
    agents.delete(id);
  }

  function disposeMaterial(mat: THREE.Material): void {
    const withMap = mat as THREE.Material & { map?: THREE.Texture | null };
    withMap.map?.dispose();
    mat.dispose();
  }

  /**
   * Sprite shares one module-level geometry in three.js — disposing it
   * breaks every other sprite. Only meshes own their geometry here.
   */
  function disposeObject(obj: THREE.Object3D): void {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    const mat = (obj as THREE.Mesh | THREE.Sprite).material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => disposeMaterial(m));
    else if (mat) disposeMaterial(mat);
  }

  function refreshChrome(node: AgentNode): void {
    const { data } = node;
    const offline = data.status !== 'active' || data.state === 'offline';
    const base = offline ? new THREE.Color('#6b7280') : agentColor(data.id, data.is_system);
    node.bodyMat.color.copy(base);
    node.bodyMat.transparent = offline;
    node.bodyMat.opacity = offline ? 0.55 : 1;
    node.pantsMat.transparent = offline;
    node.pantsMat.opacity = offline ? 0.55 : 1;
    node.headMat.transparent = offline;
    node.headMat.opacity = offline ? 0.55 : 1;
    node.ringMat.color.set(offline ? RING_COLORS.offline : RING_COLORS[data.state]);
    node.selRing.visible = data.id === selectedId;
    // Rooftop jam props follow the cached slot kind.
    const activity = offline ? null : activityForKind(node.slotKind);
    if (node.propGuitar) node.propGuitar.visible = activity === 'guitar';
    if (node.propStickL) node.propStickL.visible = activity === 'drums';
    if (node.propStickR) node.propStickR.visible = activity === 'drums';

    const bubbleText = offline ? null : bubbleFor(data, activity);
    if (bubbleText !== node.bubbleText) {
      node.bubbleText = bubbleText;
      if (node.bubble) {
        node.group.remove(node.bubble);
        disposeObject(node.bubble);
        node.bubble = null;
      }
      if (bubbleText) {
        // Colored activity pill per state, like the reference's pills
        // (green = coding, blue = talking, amber = needs decision).
        const bg = BUBBLE_BG[data.state] ?? '#1a1a10';
        node.bubble = makeTextSprite(`● ${data.name} ${bubbleText}`, 24, bg, '#ffffff');
        node.bubble.position.y = 3.62;
        node.group.add(node.bubble);
      }
    }

    const effectText = effectFor(data, waterBreakerId, activity);
    if (effectText !== node.effectText) {
      node.effectText = effectText;
      if (node.effect) {
        node.group.remove(node.effect);
        disposeObject(node.effect);
        node.effect = null;
      }
      if (effectText) {
        node.effect = makeEmojiSprite(effectText);
        node.effect.position.y = 3.08;
        node.group.add(node.effect);
      }
    }
  }

  // ─── Walk routing: door waypoints + soft obstacle steering ────────
  // Agents used to lerp straight at `target`, cutting through desks and
  // the meeting-room divider. Two guards now: explicit waypoints through
  // the meeting-room door (the only full-height wall with a fixed gap),
  // and a repulsion field that bends any walk around fat furniture. Both
  // only bend the walk — final arrival always eases onto the true target.

  // Fixed wall: meeting-room divider at x = 5.5, door gap at z ≈ 0.4.
  // Walks that cross from the staff room (x < 5.5) into the meeting room
  // (x > 5.5), or the reverse, must pass through this point.
  const MEET_DOOR = { x: 5.5, z: 0.4 };
  // Lanes just outside the gap so walkers queue along the gap axis
  // instead of cutting the divider corners.
  const MEET_DOOR_WEST = { x: 4.5, z: 0.4 };
  const MEET_DOOR_EAST = { x: 6.5, z: 0.4 };

  /**
   * Waypoints between `from` and the final slot, or []. The meeting
   * room is the only enclosed area: entering (staff → x > 5.5) queues
   * west lane → gap → east lane; leaving mirrors it. Walkers already
   * inside pass only their side lane + gap.
   */
  function doorWaypoints(
    from: { x: number; z: number },
    dest: { x: number; z: number },
  ): { x: number; z: number }[] {
    const fromInside = from.x > 5.5;
    const destInside = dest.x > 5.5;
    if (fromInside === destInside) return [];
    if (!destInside) return [MEET_DOOR_EAST, MEET_DOOR, MEET_DOOR_WEST];
    return [MEET_DOOR_WEST, MEET_DOOR, MEET_DOOR_EAST];
  }

  interface Blocker {
    x: number;
    z: number;
    r: number;
  }

  // Fat furniture per floor (circle blockers: center + radius). Wall-
  // hugging pieces (back-wall counters, shelves, fridge, bar) are
  // skipped — walks between room-middle slots never reach them.
  const BLOCKERS: Record<FloorId, Blocker[]> = {
    workspace: [
      // Staff desk rows (top + chairs spill south).
      ...STAFF_DESKS.map((d) => ({ x: d.x, z: d.z + 0.3, r: 1.5 })),
      // CEO desk.
      { x: -8.6, z: -2.2, r: 2.2 },
      // Meeting table.
      { x: 9.4, z: -2.2, r: 2.9 },
      // Reception counter.
      { x: 9.4, z: 2.05, r: 2.1 },
      // Lounge sofas + coffee table.
      { x: -8.6, z: 4.6, r: 1.5 },
      { x: -8.6, z: 6.9, r: 1.5 },
      { x: -8.6, z: 5.75, r: 1.1 },
      // Pantry cooler.
      { x: water.x + 0.9, z: water.z, r: 0.8 },
    ],
    kitchen: [
      // Dining tables (stools ring at r = 1.7).
      ...DINE_TABLES.map((t) => ({ x: t.x, z: t.z, r: 2.1 })),
    ],
    rooftop: [
      // Loungers + jam rug + stargaze chairs + side tables.
      ...ROOF_LOUNGERS.map((p) => ({ x: p.x, z: p.z, r: 1.2 })),
      { x: -4.2, z: 1.2, r: 2.2 },
      { x: -0.5, z: 6.2, r: 0.8 },
      { x: 2.5, z: 6.2, r: 0.8 },
      { x: 1, z: 6.4, r: 0.6 },
      // Pergola posts.
      { x: -7.4, z: -1.4, r: 0.4 },
      { x: -0.6, z: -1.4, r: 0.4 },
      { x: -7.4, z: 3.4, r: 0.4 },
      { x: -0.6, z: 3.4, r: 0.4 },
      // Bar counter + stools.
      { x: 10, z: -5.5, r: 2.1 },
    ],
    parking: [
      // Parked cars (2.3 x 4.6 footprint).
      ...[-9, -5.6, -2.2, 1.2, 4.6].map((x) => ({ x, z: 0.5, r: 2.5 })),
      // Pillars.
      ...[-10, -3.6, 2.8, 9.2].map((x) => ({ x, z: -5.4, r: 0.6 })),
      // Lift lobby frame posts.
      { x: ROOM_W / 2 + 0.29, z: 4.35, r: 0.4 },
      { x: ROOM_W / 2 + 0.29, z: 5.75, r: 0.4 },
      // Waiting bench.
      { x: -7, z: 6.5, r: 1.3 },
    ],
  };
  /**
   * Point an agent at a same-floor destination: `target` holds the
   * final slot while `waypoints` holds door legs the tick loop walks
   * first, so meeting-room trips always pass through the door gap.
   */
  function routeTo(node: AgentNode, dest: { x: number; z: number }): void {
    node.waypoints = doorWaypoints({ x: node.group.position.x, z: node.group.position.z }, dest);
    node.target.set(dest.x, 0, dest.z);
  }

  function lobbySlot(floor: FloorId): Slot {
    return { floor, x: LIFT_LOBBY.x, z: LIFT_LOBBY.z, yaw: Math.PI / 2, kind: 'lift' };
  }

  function startLiftTrip(node: AgentNode, to: FloorId): void {
    // NB: node.pending (destination slot) must survive — maybeBoard
    // reads trip.to from it. Clearing it strands the rider (same-floor
    // loop: board → ride nowhere → alight where it started).
    node.leg = 'toLift';
    const lobby = lobbySlot(node.floor);
    routeTo(node, lobby);
    node.desiredYaw = lobby.yaw;
    node.sitting = false;
    if (!liftQueue.includes(node)) liftQueue.push(node);
  }

  function retarget(): void {
    const ctx = buildCtx(roster);
    for (const data of roster) {
      const node = agents.get(data.id);
      if (!node) continue;
      // Mid-journey agents keep their lift legs; the trip resolves them.
      if (node.leg !== 'slot') continue;
      const slot = slotFor(data, ctx);
      const queuedFloor = ctx.pendingFloor.get(data.id);
      if (queuedFloor && queuedFloor !== node.floor) {
        // Fresh roam assignment: walk to this floor's lobby first.
        node.pending = slot;
        startLiftTrip(node, queuedFloor);
        continue;
      }
      if (slot.floor !== node.floor) {
        // Returning (recalled/busy): ride the lift back, same as roaming.
        node.pending = slot;
        startLiftTrip(node, slot.floor);
        continue;
      }
      // Local target: floor groups already carry the world offset.
      // Chair slots (incl. rooftop jam/stargaze) want a seated pose.
      routeTo(node, slot);
      node.desiredYaw = slot.yaw;
      node.sitting = isSeatKind(slot.kind);
      if (node.slotKind !== slot.kind) {
        node.slotKind = slot.kind;
        refreshChrome(node);
      }
    }
  }

  function sendToFloor(agentId: string, floor: FloorId): void {
    const node = agents.get(agentId);
    if (!node) return;
    if (floor === 'workspace') {
      manualFloor.delete(agentId);
      // Recalled CEO walks back through the lift like everyone else.
      roamFloor.delete(agentId);
    } else manualFloor.set(agentId, floor);
    retarget();
  }

  function setRoster(list: RoomAgent[]): void {
    roster = list;
    const ids = new Set(list.map((a) => a.id));
    for (const id of [...agents.keys()]) {
      if (!ids.has(id)) removeAgent(id);
    }
    for (const data of list) {
      const existing = agents.get(data.id);
      if (existing) {
        const nameChanged = existing.data.name !== data.name;
        existing.data = data;
        if (nameChanged) {
          // Name plates are static canvases; rebuild on rename.
          existing.group.remove(existing.label);
          disposeObject(existing.label);
          existing.label = makeLabelSprite(data.is_system ? `${data.name} · CEO` : data.name);
          existing.label.position.y = 2.56;
          existing.group.add(existing.label);
        }
      } else {
        const ctx = buildCtx(list);
        const slot = slotFor(data, ctx);
        const node = addAgent(data, slot.floor);
        // Spawn at target so the first paint is already placed.
        // Local Y: the floor group owns the world offset.
        node.group.position.set(slot.x, 0, slot.z);
        node.group.rotation.y = slot.yaw;
        node.target.set(slot.x, 0, slot.z);
        node.desiredYaw = slot.yaw;
        node.sitting = isSeatKind(slot.kind);
        node.slotKind = slot.kind;
        node.sitBlend = node.sitting ? 1 : 0;
      }
    }
    if (waterBreakerId && !roster.some((a) => a.id === waterBreakerId)) waterBreakerId = null;
    if (!waterBreakerId) pickWaterBreaker();
    retarget();
    for (const node of agents.values()) refreshChrome(node);
  }

  // ─── Lift machine ────────────────────────────────────────────────────
  // One cabin serves the whole stack. A trip: agent walks to its floor
  // lobby → boards when the car dwells there with doors open → rides
  // (reparented into the cabin) → alights at the destination lobby →
  // walks out to its slot. Door pairs ease open only at the served
  // floor so the ride reads even in a focused single-floor view.
  const LIFT_SPEED = FLOOR_GAP / 2.6; // one floor ≈ 2.6s
  const DOOR_DWELL = 1.1; // seconds doors stay open for board/alight

  function reparentAgent(node: AgentNode, floor: FloorId | 'cabin'): void {
    node.group.parent?.remove(node.group);
    if (floor === 'cabin') {
      // Cabin-local: centered, facing the doors (-x toward the lobby).
      node.group.position.set(0, 0, 0);
      node.group.rotation.y = -Math.PI / 2;
      cabin.add(node.group);
    } else {
      node.floor = floor;
      floorGroups[floor].add(node.group);
    }
  }

  function maybeBoard(node: AgentNode): void {
    if (node.leg !== 'toLift' || liftTrip) return;
    const qi = liftQueue.indexOf(node);
    if (qi > 0) return; // FIFO: wait your turn for the car
    if (qi === 0) liftQueue.shift();
    const to = node.pending?.floor ?? node.floor;
    liftTrip = { node, from: node.floor, to, phase: 'boarding', timer: 0 };
    node.leg = 'inLift';
    // Send the car to the pickup floor if it isn't there yet.
    cabin.position.y = floorY(floorIndex[node.floor]);
    doorTarget[node.floor] = 1;
  }

  function updateLift(dt: number): void {
    // Ease every door pair toward its target.
    const de = 1 - Math.exp(-5 * dt);
    for (const meta of FLOORS) {
      const f = meta.id;
      doorOpen[f] += (doorTarget[f] - doorOpen[f]) * de;
      const pair = doorLeaves[f];
      if (pair) {
        pair.left.position.z = LIFT_SHAFT.z - 0.31 - doorOpen[f] * 0.55;
        pair.right.position.z = LIFT_SHAFT.z + 0.31 + doorOpen[f] * 0.55;
      }
    }
    if (!liftTrip) {
      // Idle car: park at the next queued rider's floor.
      const next = liftQueue[0];
      if (next) {
        const y = floorY(floorIndex[next.floor]);
        cabin.position.y += (y - cabin.position.y) * (1 - Math.exp(-2 * dt));
      }
      return;
    }
    const trip = liftTrip;
    const node = trip.node;
    if (!agents.has(node.data.id)) {
      liftTrip = null; // rider left mid-trip; free the car
      return;
    }
    trip.timer += dt;
    if (trip.phase === 'boarding') {
      // Dwell with doors open, then step into the cabin.
      doorTarget[trip.from] = 1;
      if (trip.timer >= DOOR_DWELL) {
        reparentAgent(node, 'cabin');
        doorTarget[trip.from] = 0;
        trip.phase = trip.from === trip.to ? 'alighting' : 'riding';
        trip.timer = 0;
      }
      return;
    }
    if (trip.phase === 'riding') {
      const destY = floorY(floorIndex[trip.to]);
      const dy = destY - cabin.position.y;
      const step = Math.sign(dy) * Math.min(Math.abs(dy), LIFT_SPEED * dt);
      cabin.position.y += step;
      if (Math.abs(destY - cabin.position.y) < 0.02) {
        cabin.position.y = destY;
        trip.phase = 'alighting';
        trip.timer = 0;
        doorTarget[trip.to] = 1;
      }
      return;
    }
    // alighting: doors open at the destination, step out to the lobby,
    // then walk to the real slot.
    doorTarget[trip.to] = 1;
    if (trip.timer >= DOOR_DWELL) {
      doorTarget[trip.to] = 0;
      const dest = node.pending ?? lobbySlot(trip.to);
      reparentAgent(node, trip.to);
      node.leg = 'toSlot';
      node.group.position.set(LIFT_LOBBY.x, 0, LIFT_LOBBY.z);
      node.group.rotation.y = -Math.PI / 2;
      routeTo(node, dest);
      node.desiredYaw = dest.yaw;
      node.sitting = isSeatKind(dest.kind);
      if (node.slotKind !== dest.kind) {
        node.slotKind = dest.kind;
        refreshChrome(node);
      }
      node.pending = null;
      node.alightT = elapsed;
      liftTrip = null;
    }
  }

  // ─── Floor switching + isolation mode ──────────────────────────────
  // Focus mode shows exactly ONE floor: other floor groups (and the
  // lift spine doors + city ring) hide entirely, so e.g. Kitchen &
  // Dining fills the screen alone. Overview pulls back and shows the
  // whole building stack + city again.
  let activeFloor: FloorId = 'workspace';
  let overview = false;
  let paused = false;
  /** Seconds of camera easing left (floor switch / reset); afterwards
   *  the camera belongs to the user so orbiting never rubber-bands. */
  let camEase = 0;
  const camGoal = {
    pos: new THREE.Vector3(11.5, 13.5 + FLOOR_GAP * 2, 15.5),
    target: new THREE.Vector3(0, FLOOR_GAP * 2, -0.5),
  };

  // Extra per-floor props that don't live inside a floor group.
  // (spineExtras / cityExtras are declared beside floorTitle above.)
  function applyFloorVisibility(): void {
    for (const meta of FLOORS) {
      floorGroups[meta.id].visible = overview || meta.id === activeFloor;
    }
    for (const obj of spineExtras) obj.visible = overview;
    for (const obj of cityExtras) obj.visible = overview;
    // The ground travels with the focused floor so the isolated room
    // rests on earth; in overview it sits under parking.
    groundGroup.position.y = overview ? -0.36 : floorY(floorIndex[activeFloor]) - 0.36;
    // Focused workspace reads as one open room: partitions go glass so
    // CEO / staff / meeting stay visible. Solid again in overview.
    partTarget = overview || activeFloor !== 'workspace' ? 1 : 0.22;
    for (const m of partMats) m.depthWrite = partTarget >= 1;
  }

  function updateCamGoal(): void {
    if (overview) {
      camGoal.pos.set(27, 19, 31);
      camGoal.target.set(0, FLOOR_GAP * 1.5, -0.5);
      lampA.position.set(-6, FLOOR_GAP * 1.5 + 4, 0);
      lampB.position.set(6, FLOOR_GAP * 1.5 + 4, 0);
    } else {
      const y = floorY(floorIndex[activeFloor]);
      camGoal.pos.set(11.5, 13.5 + y, 15.5);
      camGoal.target.set(0, y - 0.5, -0.5);
      // Interior lamps travel with the focused floor so the isolated
      // room is lit the same wherever you are.
      lampA.position.set(-6, y + 4.6, 0);
      lampB.position.set(6, y + 4.6, 0);
    }
    camEase = 1.6;
  }

  function setFloor(floor: FloorId): void {
    activeFloor = floor;
    overview = false;
    applyFloorVisibility();
    updateCamGoal();
  }

  function setOverview(all: boolean): void {
    overview = all;
    applyFloorVisibility();
    updateCamGoal();
  }

  function resetView(): void {
    updateCamGoal();
  }

  function dolly(factor: number): void {
    const off = camGoal.pos.clone().sub(camGoal.target);
    off.setLength(THREE.MathUtils.clamp(off.length() * factor, 8, 70));
    camGoal.pos.copy(camGoal.target).add(off);
    camEase = Math.max(camEase, 0.6);
  }

  function setPaused(value: boolean): void {
    paused = value;
  }

  function setAutoRotate(on: boolean): void {
    controls.autoRotate = on;
    controls.autoRotateSpeed = 0.9;
  }
  applyFloorVisibility();
  updateCamGoal();
  camEase = 0; // start settled; lamps now track the active floor too

  // ─── Picking ─────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt: { x: number; y: number } | null = null;

  function castAt(clientX: number, clientY: number): THREE.Intersection[] {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...hitMeshes, ...zoneMeshes], false);
    // Skip meshes on hidden floors (raycast ignores `visible` groups).
    return hits.filter((hit) => {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        if (obj.visible === false) return false;
        obj = obj.parent;
      }
      return true;
    });
  }

  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent): void {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return; // an orbit drag, not a click
    const hits = castAt(e.clientX, e.clientY);
    for (const hit of hits) {
      const agentId = hit.object.userData.agentId as string | undefined;
      if (agentId) {
        cb.onSelectAgent(agentId);
        return;
      }
      const zoneId = hit.object.userData.zoneId as string | undefined;
      if (zoneId) {
        cb.onSelectZone(zoneId);
        return;
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.buttons !== 0) return;
    const hits = castAt(e.clientX, e.clientY);
    canvas.style.cursor = hits.length > 0 ? 'pointer' : 'grab';
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);

  // ─── Resize ──────────────────────────────────────────────────────
  function resize(): void {
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  window.addEventListener('resize', resize);

  // ─── Frame loop ──────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let raf = 0;
  let disposed = false;

  function tick(): void {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    // Camera keeps easing (floor switches, reset) while paused; the
    // simulation itself — walking, bulb glow — freezes.
    const simActive = !paused;
    if (simActive) elapsed += dt;

    // Ease toward the floor viewpoint briefly after a switch or reset;
    // otherwise the camera belongs to the user (orbit/zoom stay put).
    if (camEase > 0) {
      camEase -= dt;
      const e = 1 - Math.exp(-2.5 * dt);
      camera.position.lerp(camGoal.pos, e);
      controls.target.lerp(camGoal.target, e);
    }

    if (simActive) {
      const k = 1 - Math.exp(-3 * dt);
      updateLift(dt);
      for (const node of agents.values()) {
        // Riders parent to the cabin: skip floor-local walking while aboard.
        if (node.leg === 'inLift') {
          animateAgent(node, dt, false);
          continue;
        }
        const g = node.group;
        // Walk any door legs first: meeting-room trips pass the gap
        // instead of cutting the divider. The final slot still lives in
        // node.target, so arrival logic below is untouched.
        const leg = node.waypoints[0] ?? node.target;
        const legDone =
          node.waypoints.length > 0 &&
          Math.hypot(leg.x - g.position.x, leg.z - g.position.z) < 0.35;
        if (legDone) node.waypoints.shift();
        const goal = node.waypoints[0] ?? node.target;
        const arrivedFinal =
          node.waypoints.length === 0 &&
          Math.hypot(node.target.x - g.position.x, node.target.z - g.position.z) < 0.12;
        // Soft obstacle steering: each blocker pushes perpendicular to
        // the walk direction (never backwards), fading out past its
        // radius + margin. Small enough to miss furniture, weak enough
        // to always reach the goal.
        let steerX = goal.x;
        let steerZ = goal.z;
        const dx = goal.x - g.position.x;
        const dz = goal.z - g.position.z;
        const distGoal = Math.hypot(dx, dz);
        if (distGoal > 0.001 && !arrivedFinal) {
          const ux = dx / distGoal;
          const uz = dz / distGoal;
          // Arrival funnel: steering dies out in the last half meter so
          // agents always settle onto slots that sit inside a blocker
          // (their own desk chair, a dining stool, the pantry cooler).
          const funnel = THREE.MathUtils.clamp((distGoal - 0.5) / 1.0, 0, 1);
          for (const b of BLOCKERS[node.floor]) {
            const bx = g.position.x - b.x;
            const bz = g.position.z - b.z;
            const d = Math.hypot(bx, bz);
            const range = b.r + 0.9;
            if (d >= range || d < 0.001) continue;
            // Ahead of the walker only — furniture behind never pulls.
            const ahead = bx * -ux + bz * -uz;
            if (ahead < -0.3) continue;
            const strength = (1 - d / range) * 1.6 * funnel;
            // Perpendicular side: keep the walker's current dodge side
            // (sign of cross product) so it never zig-zags mid-pass.
            const cross = ux * bz - uz * bx;
            const side = cross >= 0 ? 1 : -1;
            steerX += -uz * side * strength;
            steerZ += ux * side * strength;
          }
        }
        const dist = Math.hypot(node.target.x - g.position.x, node.target.z - g.position.z);
        const moving = dist > 0.08;
        if (moving) {
          g.position.x += (steerX - g.position.x) * k;
          g.position.z += (steerZ - g.position.z) * k;
          const yaw = Math.atan2(steerX - g.position.x, steerZ - g.position.z);
          g.rotation.y = lerpAngle(g.rotation.y, yaw, 1 - Math.exp(-8 * dt));
          g.rotation.y = lerpAngle(g.rotation.y, yaw, 1 - Math.exp(-8 * dt));
        } else {
          g.rotation.y = lerpAngle(g.rotation.y, node.desiredYaw, 1 - Math.exp(-4 * dt));
        }
        // Anyone who reached their lobby and holds a cabin slot boards
        // as soon as the car is free and dwelling at their floor.
        if (node.leg === 'toLift' && !moving) maybeBoard(node);
        animateAgent(node, dt, moving);
      }
      // Riders who stepped out finish their walk before going idle so
      // the slot pose (sit/stand) only applies once truly arrived.
      // Waypoints must drain first: an agent still routing the meeting
      // door isn't "there" even if close to the final slot.
      for (const node of agents.values()) {
        if (node.leg !== 'toSlot') continue;
        const arrived =
          node.waypoints.length === 0 &&
          Math.hypot(node.target.x - node.group.position.x, node.target.z - node.group.position.z) <
            0.12;
        if (arrived && elapsed - node.alightT > 0.6) node.leg = 'slot';
      }

      // ─── Per-agent animation (limbs + sit blend) ─────────────────────────
      // Extracted so lift riders (parented to the cabin) animate too.
      function animateAgent(node: AgentNode, dt: number, moving: boolean): void {
        // Walk while relocating; ease into the chair once seated.
        // Limbs swing on the inner rig so the ground ring never lifts.
        const t = elapsed;
        const p = node.phase;
        const st = node.data.status !== 'active' ? 'offline' : node.data.state;
        const sitTarget = node.sitting && !moving ? 1 : 0;
        node.sitBlend += THREE.MathUtils.clamp(sitTarget - node.sitBlend, -dt * 2.5, dt * 2.5);
        const s = node.sitBlend;

        if (moving) {
          // Opposite-phase leg swing, knees trailing; arms counter-swing.
          const w = t * 10 + p;
          const swL = Math.sin(w);
          const swR = Math.sin(w + Math.PI);
          node.hipL.rotation.x = -0.55 * swL;
          node.hipR.rotation.x = -0.55 * swR;
          node.kneeL.rotation.x = 0.2 + 0.9 * Math.max(0, Math.sin(w + 0.7));
          node.kneeR.rotation.x = 0.2 + 0.9 * Math.max(0, Math.sin(w + Math.PI + 0.7));
          node.armL.rotation.x = 0.4 * swL;
          node.armR.rotation.x = 0.4 * swR;
          node.armL.rotation.z = 0;
          node.armR.rotation.z = 0;
          node.head.rotation.set(0, 0, 0);
          node.rig.rotation.x = 0;
          node.rig.position.y = Math.abs(Math.cos(w)) * 0.06;
          node.rig.rotation.z = Math.sin(w) * 0.02;
        } else if (s > 0.001) {
          // Seated: thighs forward, shins down, pelvis dropped onto the
          // chair pan (~0.48), hands reaching to the desk.
          node.hipL.rotation.x = -1.45 * s;
          node.hipR.rotation.x = -1.45 * s;
          node.kneeL.rotation.x = 1.45 * s;
          node.kneeR.rotation.x = 1.45 * s;
          node.armL.rotation.x = -0.55 * s;
          node.armR.rotation.x = -0.55 * s;
          node.rig.position.y = -0.36 * s;
          node.rig.rotation.z = 0;
          const activity = activityForKind(node.slotKind);
          // Reset the head every seated frame so poses don't leak across slots.
          node.head.rotation.set(0, 0, 0);
          if (activity === 'guitar') {
            // Strum: right arm sways fast across the strings, left hand
            // frets up the neck; gentle torso groove.
            const strum = Math.sin(t * 9 + p);
            node.armR.rotation.x = -0.75 + strum * 0.28;
            node.armR.rotation.z = -0.15;
            node.armL.rotation.x = -0.5 + Math.sin(t * 4.5 + p) * 0.08;
            node.armL.rotation.z = 0.45;
            node.rig.rotation.z = Math.sin(t * 4.5 + p) * 0.03;
            node.rig.position.y = -0.36 * s + Math.abs(Math.sin(t * 4.5 + p)) * 0.02;
          } else if (activity === 'drums') {
            // Alternating stick hits on the kit; sticks ride the hands.
            node.armL.rotation.x = -1.0 + Math.max(0, Math.sin(t * 10 + p)) * 0.45;
            node.armR.rotation.x = -1.0 + Math.max(0, Math.sin(t * 10 + p + Math.PI)) * 0.45;
            node.rig.position.y = -0.36 * s + Math.abs(Math.sin(t * 10 + p)) * 0.02;
            node.rig.rotation.z = Math.sin(t * 5 + p) * 0.02;
          } else if (activity === 'stargaze') {
            // Selonjoran: legs stretched forward, torso leaned back onto
            // the reclined backrest, head tilted up at the sky, arms resting.
            node.hipL.rotation.x = -1.1 * s;
            node.hipR.rotation.x = -1.1 * s;
            node.kneeL.rotation.x = 0.25 * s;
            node.kneeR.rotation.x = 0.25 * s;
            node.armL.rotation.x = -0.15 * s;
            node.armR.rotation.x = -0.15 * s;
            node.armL.rotation.z = 0.35 * s;
            node.armR.rotation.z = -0.35 * s;
            node.rig.position.y = -0.42 * s;
            node.rig.rotation.x = -0.18 * s;
            node.head.rotation.x = -0.55;
            node.rig.position.y += Math.sin(t * 1.2 + p) * 0.008;
          }
        } else {
          // Standing: reset limb pose, keep the old per-state idle life
          // (typing bounce, talk bob, breath sway) on the rig.
          node.hipL.rotation.x = 0;
          node.hipR.rotation.x = 0;
          node.kneeL.rotation.x = 0;
          node.kneeR.rotation.x = 0;
          node.armL.rotation.x = 0;
          node.armR.rotation.x = 0;
          node.armL.rotation.z = 0;
          node.armR.rotation.z = 0;
          node.head.rotation.set(0, 0, 0);
          node.rig.rotation.x = 0;
          switch (st) {
            case 'working':
              node.armL.rotation.x = -0.7;
              node.armR.rotation.x = -0.7 + Math.sin(t * 22 + p) * 0.12;
              node.rig.position.y = Math.abs(Math.sin(t * 22 + p)) * 0.02;
              node.rig.rotation.z = Math.sin(t * 22 + p) * 0.015;
              break;
            case 'talking':
              node.armR.rotation.x = -0.9 + Math.sin(t * 6 + p) * 0.25;
              node.armL.rotation.x = -0.2;
              node.rig.position.y = Math.abs(Math.sin(t * 6 + p)) * 0.05;
              node.rig.rotation.z = 0;
              break;
            case 'idle':
              node.rig.position.y = Math.sin(t * 1.6 + p) * 0.02 + 0.02;
              node.rig.rotation.z = 0;
              break;
            case 'waiting_human':
            case 'blocked':
              node.rig.position.y = Math.abs(Math.sin(t * 3 + p)) * 0.05;
              node.rig.rotation.z = Math.sin(t * 3 + p) * 0.03;
              break;
            default:
              node.rig.position.y = 0;
              node.rig.rotation.z = 0;
              break;
          }
        }
      }

      // Ease partitions toward glass/solid on focus/overview switches.
      for (const m of partMats) {
        if (Math.abs(m.opacity - partTarget) > 0.005) {
          m.opacity += (partTarget - m.opacity) * (1 - Math.exp(-4 * dt));
        } else {
          m.opacity = partTarget;
        }
      }

      // Rooftop string lights glow after dark.
      const bulbGlow = 0.35 + nightValue * 0.65;
      for (const b of rooftopBulbMats)
        b.color.setRGB(1 * bulbGlow + 0.2, 0.9 * bulbGlow + 0.15, 0.55 * bulbGlow + 0.1);
      // Workspace pendants + lounge lamp glow after dark (daylight off).
      const pendantGlow = 1 - nightValue * 0.55;
      for (const b of pendantBulbMats)
        b.color.setRGB(1 * pendantGlow + 0.15, 0.9 * pendantGlow + 0.12, 0.55 * pendantGlow + 0.08);
      // The office cat's tail sways while it naps.
      if (catTail) catTail.rotation.x = Math.sin(elapsed * 1.4) * 0.35;
    }

    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  function dispose(): void {
    disposed = true;
    cancelAnimationFrame(raf);
    window.clearInterval(waterTimer);
    window.clearInterval(roamTimer);
    ro.disconnect();
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointermove', onPointerMove);
    controls.dispose();
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) disposeObject(obj);
    });
    renderer.dispose();
  }

  return {
    setRoster,
    setNight,
    setWeather,
    setClock,
    setFloor,
    setOverview,
    setPaused,
    setAutoRotate,
    resetView,
    dolly,
    setSelected: (agentId: string | null) => {
      selectedId = agentId;
      for (const node of agents.values()) node.selRing.visible = node.data.id === selectedId;
    },
    sendToFloor,
    dispose,
  };
}

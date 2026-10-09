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
 * sun/lamp lighting mood plus the live badge in the UI chrome (no
 * floating sky panels, no wall windows).
 *
 * Placement rules — CEO in the CEO room, talking staff at the meeting
 * table, waiting staff queued at the meeting door, everyone else at a
 * home seat (staff desks first, then free meeting chairs so every room
 * stays populated and nobody stacks), one idle agent drifts to the
 * pantry.
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
  dispose: () => void;
}

const ROOM_W = 26;
const ROOM_D = 17;
// Tall, airy floors: generous headroom so a focused floor never feels
// cramped. Walls span the full inter-floor gap, sealing each level up
// to the plate above it.
const WALL_H = 7.5;
const FLOOR_GAP = WALL_H + 4.2;

type SlotKind = 'desk' | 'meeting' | 'queue' | 'reception' | 'water';

interface Slot {
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

function bubbleFor(agent: RoomAgent): string | null {
  if (agent.status !== 'active') return null;
  if (agent.state === 'talking' && agent.detail) return agent.detail;
  if (agent.state === 'waiting_human') return 'Butuh keputusanmu…';
  if (agent.state === 'blocked') return 'Terhambat 😖';
  return null;
}

function effectFor(agent: RoomAgent, waterId: string | null): string | null {
  if (agent.status !== 'active') return '💤';
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
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
  ringMat: THREE.MeshBasicMaterial;
  selRing: THREE.Mesh;
  label: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleText: string | null;
  effect: THREE.Sprite | null;
  effectText: string | null;
  hit: THREE.Mesh;
  target: THREE.Vector3;
  desiredYaw: number;
  phase: number;
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

  // Shared building spine: elevator shaft + one door per floor. The
  // shaft only makes sense in the stacked view, but each door belongs
  // to its own floor so focused floors keep their lift entrance.
  {
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, FLOOR_GAP * 3 + WALL_H, ROOM_D * 0.42),
      std('#2c2838'),
    );
    shaft.position.set(ROOM_W / 2 + 1.4, (FLOOR_GAP * 3) / 2, ROOM_D / 2 - 3.4);
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    scene.add(shaft);
    spineExtras.push(shaft);
    const doorMat = new THREE.MeshStandardMaterial({
      color: '#0b1220',
      emissive: '#22d3ee',
      emissiveIntensity: 0.4,
      roughness: 0.4,
    });
    const floorIds: FloorId[] = ['parking', 'kitchen', 'workspace', 'rooftop'];
    for (let i = 0; i < 4; i++) {
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 2.1), doorMat);
      door.position.set(ROOM_W / 2 + 0.29, floorY(i) + 1.15, ROOM_D / 2 - 3.4);
      door.rotation.y = -Math.PI / 2;
      addTo(floorIds[i], door);
    }
    const label = makeTextSprite('🛗 Lift', 30, 'rgba(10,10,15,0.78)', '#a5f3fc');
    label.position.set(ROOM_W / 2 + 1.4, FLOOR_GAP * 3 + 2.2, ROOM_D / 2 - 3.4);
    scene.add(label);
    spineExtras.push(label);
  }

  // ─── Floor 0 · Parking ─────────────────────────────────────────────
  floorPlate('parking', '#3f434c');
  backWall('parking', '#443e54');
  leftWall('parking', '#453f55');
  floorTitle('parking', '🅿️ Parking');
  {
    // Painted bays.
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
    // Low-poly cars: body + cabin + wheels, deterministic colors.
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
      const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14);
      const wheelMat = std('#111827', 0.9);
      for (const [wx, wz] of [[-0.95, 1.35], [0.95, 1.35], [-0.95, -1.35], [0.95, -1.35]] as const) {
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
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, WALL_H, 0.5), std('#575064'));
      pillar.position.set(-10 + i * 6.4, WALL_H / 2, -5.4);
      pillar.castShadow = true;
      addTo('parking', pillar);
    }
    const sign = makeTextSprite('🅿️ PARKIR', 34, '#1e3a8a', '#fef08a');
    sign.position.set(0, 3.2, -ROOM_D / 2 + 0.6);
    addTo('parking', sign);
  }

  // ─── Floor 1 · Kitchen & Dining ────────────────────────────────────
  floorPlate('kitchen', '#54483a');
  backWall('kitchen', '#5d5347');
  leftWall('kitchen', '#524939');
  floorTitle('kitchen', '🍽️ Kitchen & Dining');
  {
    // Kitchen counter run along the back wall.
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(9, 0.12, 1.1), std('#8a7355'));
    counterTop.position.set(-4, 1.0, -ROOM_D / 2 + 1.2);
    counterTop.castShadow = true;
    addTo('kitchen', counterTop);
    const counterBase = new THREE.Mesh(new THREE.BoxGeometry(9, 1.0, 1.0), std('#4a4036'));
    counterBase.position.set(-4, 0.5, -ROOM_D / 2 + 1.2);
    addTo('kitchen', counterBase);
    // Fridge + stove blocks.
    const fridge = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.0, 0.9), std('#cbd5e1', 0.4));
    fridge.position.set(1.4, 1.0, -ROOM_D / 2 + 1.2);
    fridge.castShadow = true;
    addTo('kitchen', fridge);
    const stove = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 1.0), std('#1f2937', 0.5));
    stove.position.set(-9.2, 0.45, -ROOM_D / 2 + 1.2);
    addTo('kitchen', stove);
    for (let i = 0; i < 4; i++) {
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 14), std('#0f172a'));
      plate.position.set(-9.6 + (i % 2) * 0.7, 0.94, -ROOM_D / 2 + 0.95 + Math.floor(i / 2) * 0.5);
      addTo('kitchen', plate);
    }
    // Dining tables in one even row + stools at four fixed compass
    // points per table (no random scatter).
    for (let t = 0; t < 3; t++) {
      const tx = -4.4 + t * 4.4;
      const tz = 2.6;
      const table = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.1, 20), std('#7a5c3e'));
      table.position.set(tx, 0.78, tz);
      table.castShadow = true;
      addTo('kitchen', table);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.74, 10), std('#4a3826'));
      leg.position.set(tx, 0.39, tz);
      addTo('kitchen', leg);
      // A mug on every other table.
      if (t % 2 === 0) {
        const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.22, 12), std('#f472b6'));
        mug.position.set(tx + 0.4, 0.94, tz - 0.3);
        addTo('kitchen', mug);
      }
      for (let sIdx = 0; sIdx < 4; sIdx++) {
        const ang = (sIdx / 4) * Math.PI * 2;
        const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.45, 12), std('#374151'));
        stool.position.set(tx + Math.cos(ang) * 1.7, 0.23, tz + Math.sin(ang) * 1.7);
        stool.castShadow = true;
        addTo('kitchen', stool);
      }
    }
    const sign = makeTextSprite('☕ Pantry — kopi dulu, baru deploy', 26, '#3f2d1c', '#fde68a');
    sign.position.set(-4, 2.6, -ROOM_D / 2 + 1.2);
    addTo('kitchen', sign);
  }

  // ─── Floor 2 · Workspace (the live office) ─────────────────────────
  // Three rooms across the floor:
  //   x < -4   · CEO office (private, big desk + bookshelf)
  //   middle   · staff room (desk rows, kanban, dashboard)
  //   x > 5.5  · glass meeting room (table + reception counter)
  floorPlate('workspace', '#4b4237');
  {
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W * 0.72, ROOM_D * 0.62), std('#353b48', 1));
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.y = 0.01;
    carpet.receiveShadow = true;
    addTo('workspace', carpet);
  }
  backWall('workspace', '#565064');
  leftWall('workspace', '#4e485c');
  floorTitle('workspace', '💻 Workspace');
  // Interior partitions fade to glass in focus mode so all three rooms stay
  // visible; solid again in the stacked overview (see applyFloorVisibility).
  const partMats: THREE.MeshStandardMaterial[] = [];
  let partTarget = 0.22;
  {
    // Interior partitions (run full wall height): CEO room + meeting
    // room walls with door gaps on the staff-room side.
    const partMat = new THREE.MeshStandardMaterial({
      color: '#6b6478',
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
    // CEO room divider at x = -4 (door gap near the front).
    wallTall(0.3, ROOM_D * 0.62, -4, -ROOM_D / 2 + (ROOM_D * 0.62) / 2 + 1.6);
    wallTall(0.3, 2.6, -4, ROOM_D / 2 - 2.2);
    const ceoDoor = makeTextSprite('🚪 Ruang CEO', 26, 'rgba(10,10,15,0.78)', '#fde68a');
    ceoDoor.position.set(-4, 2.2, ROOM_D / 2 - 0.6);
    ceoDoor.scale.multiplyScalar(0.8);
    addTo('workspace', ceoDoor);
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
    const ceoSign = makeTextSprite('👑 Ruang CEO', 30, 'rgba(10,10,15,0.78)', '#fde68a');
    ceoSign.position.set(-8.6, 3, -2.5);
    addTo('workspace', ceoSign);
    const staffSign = makeTextSprite('🧑‍💻 Ruang Karyawan', 30, 'rgba(10,10,15,0.78)', '#bbf7d0');
    staffSign.position.set(0.6, 3, -2.5);
    addTo('workspace', staffSign);
    const meetSign = makeTextSprite('🤝 Ruang Meeting', 30, 'rgba(10,10,15,0.78)', '#a5f3fc');
    meetSign.position.set(9.4, 3, -2.5);
    addTo('workspace', meetSign);
  }
  // ─── Floor 3 · Rooftop ─────────────────────────────────────────────
  // String-light materials glow brighter after dark (see tick).
  const rooftopBulbMats: THREE.MeshBasicMaterial[] = [];
  floorPlate('rooftop', '#4a4f57');
  floorTitle('rooftop', '🌇 Rooftop');
  {
    // Parapet on three sides; the back stays open to the sky.
    const parapetMat = std('#5b6470');
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
    // Deck + pergola.
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), std('#6b543a', 0.9));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(-4, 0.02, 1);
    deck.receiveShadow = true;
    addTo('rooftop', deck);
    for (const [px, pz] of [[-7.4, -1.4], [-0.6, -1.4], [-7.4, 3.4], [-0.6, 3.4]] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.6, 0.22), std('#4a3826'));
      post.position.set(px, 1.3, pz);
      post.castShadow = true;
      addTo('rooftop', post);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.14, 5.6), std('#374151'));
    roof.position.set(-4, 2.7, 1);
    roof.castShadow = true;
    addTo('rooftop', roof);
    // String lights under the pergola (warm points, brighter at night).
    for (let i = 0; i < 6; i++) {
      const bulbMat = new THREE.MeshBasicMaterial({ color: '#fde68a', fog: false });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), bulbMat);
      bulb.position.set(-7 + i * 1.2, 2.45, 1 + (i % 2) * 0.8 - 0.4);
      addTo('rooftop', bulb);
      rooftopBulbMats.push(bulbMat);
    }
    // Lounge chairs + planter boxes with Batu pine silhouettes.
    const rng = mulberry32(202);
    for (let i = 0; i < 3; i++) {
      const lx = 4.5 + (i % 2) * 2.2;
      const lz = -1 + Math.floor(i / 2) * 3;
      const lounger = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.35, 1.9), std('#7c5c3f'));
      lounger.position.set(lx, 0.35, lz);
      lounger.castShadow = true;
      addTo('rooftop', lounger);
      const planter = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 0.7), std('#3f3a33'));
      planter.position.set(lx + 1.6, 0.3, lz);
      addTo('rooftop', planter);
      const pine = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 8), std('#166534', 0.8));
      pine.position.set(lx + 1.6, 1.35, lz);
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
    const pad = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W + 7, 0.12, ROOM_D + 8), std('#46536a', 1));
    pad.position.y = 0;
    pad.receiveShadow = true;
    groundGroup.add(pad);
    // Grass corners to soften the concrete.
    const grassMat = std('#2f4a38', 1);
    for (const [gx, gz] of [[-26, 22], [26, 22], [-26, -22], [26, -22]] as const) {
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
  // Agents sit at these in roster order; furniture never overlaps the
  // partitions or the meeting table.
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
  for (const { x, z } of STAFF_DESKS) {
    box(1.9, 0.12, 1.0, '#7a5c3e', x, 0.74, z);
    for (const [lx, lz] of [[-0.85, -0.4], [0.85, -0.4], [-0.85, 0.4], [0.85, 0.4]] as const) {
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
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 14), std('#2f3542'));
    seat.position.set(x, 0.48, z + 0.8);
    seat.castShadow = true;
    addTo('workspace', seat);
    box(0.55, 0.6, 0.08, '#2f3542', x, 0.95, z + 1.05);
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

  // Kanban board (Projects) — back wall of the staff room, left of the
  // clock, clear of the CEO divider (x = -4).
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

  // Bookshelf on the CEO room's back wall (Knowledge).
  const shelfX = -9.5;
  const shelf = box(0.7, 2.6, 3.6, '#5d4630', shelfX, 1.3, -3.2);
  tagZone(shelf, 'bookshelf');
  {
    const rng = mulberry32(21);
    const colors = ['#b91c1c', '#1d4ed8', '#15803d', '#a16207', '#6d28d9', '#0e7490'];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 9; i++) {
        const h = 0.45 + rng() * 0.25;
        const book = new THREE.Mesh(
          new THREE.BoxGeometry(0.4, h, 0.24),
          std(colors[Math.floor(rng() * colors.length)], 0.85),
        );
        book.position.set(shelfX, 0.55 + row * 0.75 + h / 2, -4.55 + i * 0.32);
        book.castShadow = true;
        addTo('workspace', book);
      }
    }
  }
  zoneLabel('📚 Knowledge', shelfX + 0.4, 3.2, -3.2);

  // CEO desk: big executive desk + high-back chair in the CEO room.
  {
    const dx = -8.6;
    const dz = 0.8;
    box(3, 0.16, 1.5, '#5b3f28', dx, 0.78, dz);
    box(0.14, 0.78, 0.14, '#3a2a1a', dx - 1.3, 0.39, dz - 0.6);
    box(0.14, 0.78, 0.14, '#3a2a1a', dx + 1.3, 0.39, dz + 0.6);
    box(1.2, 0.7, 0.09, '#14161c', dx, 1.35, dz - 0.5);
    const ceoSeat = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.12, 14), std('#7c2d12'));
    ceoSeat.position.set(dx, 0.5, dz + 1.2);
    ceoSeat.castShadow = true;
    addTo('workspace', ceoSeat);
    box(0.6, 1.1, 0.12, '#7c2d12', dx, 1.15, dz + 1.55);
  }

  // Dashboard screen (Runs) — back wall of the staff room, right of
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
  const cooler = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 1.0, 16), std('#e5e7eb', 0.5));
  cooler.position.set(water.x + 0.9, 0.5, water.z);
  cooler.castShadow = true;
  addTo('workspace', cooler);
  const bottle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.55, 16),
    new THREE.MeshStandardMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.75, roughness: 0.2 }),
  );
  bottle.position.set(water.x + 0.9, 1.28, water.z);
  addTo('workspace', bottle);

  // ─── Agents (workspace floor) ────────────────────────────────────
  // Every employee lives in their own room: the CEO in the CEO room,
  // talking staff around the meeting table, waiting staff queued at the
  // meeting door, everyone else at a staff-room desk. Slot lists have
  // spares plus computed overflow so a big roster never stacks two
  // characters on the same spot.
  const agents = new Map<string, AgentNode>();
  const hitMeshes: THREE.Mesh[] = [];
  let roster: RoomAgent[] = [];
  let waterBreakerId: string | null = null;
  let selectedId: string | null = null;
  const waterTimer = window.setInterval(() => {
    waterBreakerId = null;
    pickWaterBreaker();
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
    // CEO holds the executive desk in the CEO room (left wing),
    // standing behind the high-back chair, facing the desk.
    if (agent.is_system) {
      return { x: -8.6, z: 2.9, yaw: Math.PI, kind: 'reception' };
    }
    if (agent.id === waterBreakerId && agent.state === 'idle') {
      const p = toWorld(WATER_SPOT.x, WATER_SPOT.y);
      return { ...p, yaw: Math.PI / 2, kind: 'water' };
    }
    if (ctx.talking.has(agent.id)) {
      // Talking staff gather around the meeting-room table (right wing),
      // matching the six symmetric chairs (3 per side). Overflow wraps
      // with a small offset so nobody stacks on one chair.
      const i = ctx.talkingList.findIndex((a) => a.id === agent.id);
      const p = MEETING_SEATS[i % MEETING_SEATS.length];
      const cycle = Math.floor(i / MEETING_SEATS.length);
      return {
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
      return { x: p.x - cycle * 0.9, z: p.z, yaw: Math.PI / 2, kind: 'queue' };
    }
    // Everyone else sits at their home seat: staff desks first, then
    // free meeting chairs, so every room stays populated and nobody
    // shares a chair. Assigned in buildCtx (stable per roster order).
    const home = ctx.homeSeats.get(agent.id);
    if (home) return home;
    const s = STAFF_DESKS[0];
    return { x: s.x, z: s.z + 0.85, yaw: Math.PI, kind: 'desk' };
  }

  interface Ctx {
    talking: Set<string>;
    waiting: Set<string>;
    talkingList: RoomAgent[];
    waitingList: RoomAgent[];
    /** Home seat per non-busy employee: desks first, then free
     *  meeting chairs — every room stays populated, nobody shares. */
    homeSeats: Map<string, Slot>;
  }

  function buildCtx(list: RoomAgent[]): Ctx {
    const deskAgents = list.filter((a) => !a.is_system);
    const talkingList = deskAgents.filter((a) => a.state === 'talking');
    const waitingList = deskAgents.filter((a) => a.state === 'waiting_human');
    const staying = deskAgents.filter((a) => a.state !== 'talking' && a.state !== 'waiting_human');
    const homeSeats = new Map<string, Slot>();
    staying.forEach((a, i) => {
      if (i < STAFF_DESKS.length) {
        const s = STAFF_DESKS[i];
        homeSeats.set(a.id, { x: s.x, z: s.z + 0.85, yaw: Math.PI, kind: 'desk' });
      } else {
        // Desks full: settle into free meeting chairs so the meeting
        // room stays alive instead of stacking staff at one desk.
        const p = MEETING_SEATS[(i - STAFF_DESKS.length) % MEETING_SEATS.length];
        homeSeats.set(a.id, { x: p.x, z: p.z, yaw: meetYaw(p), kind: 'meeting' });
      }
    });
    return {
      talking: new Set(talkingList.map((a) => a.id)),
      waiting: new Set(waitingList.map((a) => a.id)),
      talkingList,
      waitingList,
      homeSeats,
    };
  }

  function addAgent(data: RoomAgent): AgentNode {
    const group = new THREE.Group();
    const rig = new THREE.Group();
    group.add(rig);

    const color = agentColor(data.id, data.is_system);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({ color: '#f1c9a5', roughness: 0.65 });
    if (data.is_system) headMat.color.set('#e8b98a');

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.75, 4, 12), bodyMat);
    body.position.y = 1.02;
    body.castShadow = true;
    rig.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 14), headMat);
    head.position.y = 1.95;
    head.castShadow = true;
    rig.add(head);

    // Nose so facing reads at a glance.
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), std('#d69e73', 0.6));
    nose.position.set(0, 1.93, 0.26);
    rig.add(nose);

    if (data.is_system) {
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.34, 8),
        new THREE.MeshStandardMaterial({ color: '#fbbf24', roughness: 0.35, metalness: 0.6 }),
      );
      crown.position.y = 2.32;
      rig.add(crown);
    }

    const ringMat = new THREE.MeshBasicMaterial({ color: RING_COLORS.idle, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.5, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);

    const selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.56, 0.7, 28),
      new THREE.MeshBasicMaterial({ color: '#f472b6', transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
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

    addTo('workspace', group);
    const node: AgentNode = {
      data,
      group,
      rig,
      bodyMat,
      headMat,
      ringMat,
      selRing,
      label,
      bubble: null,
      bubbleText: null,
      effect: null,
      effectText: null,
      hit,
      target: new THREE.Vector3(),
      desiredYaw: 0,
      phase: Math.random() * Math.PI * 2,
    };
    agents.set(data.id, node);
    return node;
  }

  function removeAgent(id: string): void {
    const node = agents.get(id);
    if (!node) return;
    W.remove(node.group);
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
    node.headMat.transparent = offline;
    node.headMat.opacity = offline ? 0.55 : 1;
    node.ringMat.color.set(offline ? RING_COLORS.offline : RING_COLORS[data.state]);
    node.selRing.visible = data.id === selectedId;

    const bubbleText = offline ? null : bubbleFor(data);
    if (bubbleText !== node.bubbleText) {
      node.bubbleText = bubbleText;
      if (node.bubble) {
        node.group.remove(node.bubble);
        disposeObject(node.bubble);
        node.bubble = null;
      }
      if (bubbleText) {
        node.bubble = makeTextSprite(bubbleText, 26, '#1a1a10', '#e8e6c8');
        node.bubble.position.y = 3.62;
        node.group.add(node.bubble);
      }
    }

    const effectText = effectFor(data, waterBreakerId);
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

  function retarget(): void {
    const ctx = buildCtx(roster);
    for (const data of roster) {
      const node = agents.get(data.id);
      if (!node) continue;
      const slot = slotFor(data, ctx);
      const base = floorY(floorIndex.workspace);
      node.target.set(slot.x, base, slot.z);
      node.desiredYaw = slot.yaw;
    }
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
        const node = addAgent(data);
        // Spawn at target so the first paint is already placed.
        const ctx = buildCtx(list);
        const slot = slotFor(data, ctx);
        node.group.position.set(slot.x, floorY(floorIndex.workspace), slot.z);
        node.group.rotation.y = slot.yaw;
      }
    }
    if (waterBreakerId && !roster.some((a) => a.id === waterBreakerId)) waterBreakerId = null;
    if (!waterBreakerId) pickWaterBreaker();
    retarget();
    for (const node of agents.values()) refreshChrome(node);
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
  let elapsed = 0;
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
    for (const node of agents.values()) {
      const g = node.group;
      const dist = Math.hypot(node.target.x - g.position.x, node.target.z - g.position.z);
      const moving = dist > 0.08;
      if (moving) {
        g.position.x += (node.target.x - g.position.x) * k;
        g.position.z += (node.target.z - g.position.z) * k;
        const yaw = Math.atan2(node.target.x - g.position.x, node.target.z - g.position.z);
        g.rotation.y = lerpAngle(g.rotation.y, yaw, 1 - Math.exp(-8 * dt));
      } else {
        g.rotation.y = lerpAngle(g.rotation.y, node.desiredYaw, 1 - Math.exp(-4 * dt));
      }

      // Per-state motion on the inner rig (ring stays grounded).
      const t = elapsed;
      const p = node.phase;
      const st = node.data.status !== 'active' ? 'offline' : node.data.state;
      switch (st) {
        case 'working':
          node.rig.position.y = Math.abs(Math.sin(t * 22 + p)) * 0.045;
          node.rig.rotation.z = Math.sin(t * 22 + p) * 0.02;
          break;
        case 'talking':
          node.rig.position.y = Math.abs(Math.sin(t * 6 + p)) * 0.09;
          node.rig.rotation.z = 0;
          break;
        case 'idle':
          node.rig.position.y = Math.sin(t * 1.6 + p) * 0.03 + 0.03;
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
      if (moving) {
        node.rig.position.y += Math.abs(Math.sin(t * 10 + p)) * 0.08;
        node.rig.rotation.z = Math.sin(t * 10 + p) * 0.06;
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
    for (const b of rooftopBulbMats) b.color.setRGB(1 * bulbGlow + 0.2, 0.9 * bulbGlow + 0.15, 0.55 * bulbGlow + 0.1);
    }

    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  function dispose(): void {
    disposed = true;
    cancelAnimationFrame(raf);
    window.clearInterval(waterTimer);
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
    dispose,
  };
}

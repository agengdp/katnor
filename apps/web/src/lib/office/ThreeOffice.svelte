<script lang="ts">
  import type { FloorId, OfficeScene, RoomAgent } from './threeOffice';
  import { WEATHER_META, batuHour, fallbackWeather, fetchBatuWeather } from './batuWeather';
  import type { BatuWeatherState } from './batuWeather';

  /**
   * The office floor as a real-time 3D room (Three.js): orbit to look
   * around, click a character for the side panel, click a labeled zone
   * (Chat / Projects / Knowledge / Runs) to jump to its page.
   *
   * Thin Svelte shell around lib/office/threeOffice.ts — the scene builds
   * itself in an `$effect` (browser-only, so the Three.js import never
   * touches SSR) and tears down on unmount. Roster, day/night, weather,
   * and selection flow in as plain props.
   */

  let {
    agents,
    nightRatio = 0,
    selectedAgentId = null,
    floor = 'workspace',
    overview = false,
    onSelectAgent,
    onSelectZone,
    onScene,
  }: {
    agents: RoomAgent[];
    /** 0..1 - extra dimming as today's spend approaches the daily budget. */
    nightRatio?: number;
    selectedAgentId?: string | null;
    floor?: FloorId;
    overview?: boolean;
    onSelectAgent: (agentId: string) => void;
    onSelectZone: (zoneId: string) => void;
    /** Parent grabs the live scene (to issue manual floor orders). */
    onScene?: (scene: OfficeScene | null) => void;
  } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>(undefined);
  let scene = $state<OfficeScene | null>(null);
  let paused = $state(false);
  let rotating = $state(false);
  let resetTick = $state(0);

  const FLOOR_UI: { id: FloorId; label: string; icon: string }[] = [
    { id: 'parking', label: 'Parking', icon: '🅿️' },
    { id: 'kitchen', label: 'Kitchen & Dining', icon: '🍽️' },
    { id: 'workspace', label: 'Workspace', icon: '💻' },
    { id: 'rooftop', label: 'Rooftop', icon: '🌇' },
  ];
  let focusFloor = $state<FloorId>('workspace');
  let overviewMode = $state(false);

  function pickFloor(f: FloorId): void {
    focusFloor = f;
    overviewMode = false;
    scene?.setFloor(f);
  }

  function pickOverview(): void {
    overviewMode = true;
    scene?.setOverview(true);
  }

  // Day/night follows Batu time: full night before 05:00 (Batu sunrise
  // is ~05:30), dawn ramp 05:00→06:00 so 06:00+ is fully bright, bright
  // all day, dusk ramp 17:30→18:30. Spend dims the room a little but can
  // never force night — morning stays bright even near budget.
  function computeNightOpacity(now: Date): number {
    const h = batuHour(now);
    if (h < 5 || h >= 18.5) return 1;
    if (h < 6) return 1 - (h - 5);
    if (h < 17.5) return 0;
    return (h - 17.5);
  }

  function batuTime(now: Date): { h: number; m: number; label: string } {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    const [hh, mm] = parts.split(/[.:]/);
    const h = Number(hh) || 0;
    const m = Number(mm) || 0;
    return { h, m, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
  }

  let clockNight = $state(computeNightOpacity(new Date()));
  let batuClock = $state(batuTime(new Date()));
  $effect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      clockNight = computeNightOpacity(now);
      batuClock = batuTime(now);
    }, 20_000);
    return () => clearInterval(timer);
  });

  // Spend dims the room gently (max ~35%) but can never drag morning
  // into darkness — the clock owns day vs night.
  const night = $derived(Math.min(1, Math.max(clockNight, nightRatio * 0.35)));

  // ─── Batu weather persona ─────────────────────────────────────────
  // Live Batu city conditions from Open-Meteo, refreshed every 10 min.
  // Falls back to a Batu time-of-day heuristic when offline.
  let weather = $state<BatuWeatherState>(fallbackWeather(new Date()));

  async function refreshWeather(): Promise<void> {
    try {
      weather = await fetchBatuWeather();
    } catch {
      weather = fallbackWeather(new Date());
    }
  }

  $effect(() => {
    void refreshWeather();
    const timer = setInterval(() => void refreshWeather(), 10 * 60_000);
    return () => clearInterval(timer);
  });

  const weatherMeta = $derived(WEATHER_META[weather.kind]);
  const weatherIcon = $derived(weather.isDay ? weatherMeta.dayIcon : weatherMeta.nightIcon);
  const weatherLabel = $derived(
    `${weatherMeta.label} · Batu${weather.tempC !== null ? ` · ${weather.tempC}°C` : ''}${weather.live ? '' : ' · perkiraan'} · 🕐 ${batuClock.label}`,
  );

  $effect(() => {
    const el = canvas;
    if (!el) return;
    let live = true;
    let sceneRef: OfficeScene | null = null;
    (async () => {
      const { createOfficeScene } = await import('./threeOffice');
      if (!live) return;
      sceneRef = createOfficeScene(el, { onSelectAgent, onSelectZone });
      scene = sceneRef;
      onScene?.(sceneRef);
    })().catch((err) => console.error('[three-office] failed to start', err));
    return () => {
      live = false;
      onScene?.(null);
      sceneRef?.dispose();
      scene = null;
    };
  });

  // Push prop changes into the live scene (no-ops until it exists).
  $effect(() => {
    scene?.setRoster(agents);
  });
  $effect(() => {
    scene?.setNight(night);
  });
  $effect(() => {
    scene?.setWeather(weather.kind);
  });
  $effect(() => {
    scene?.setSelected(selectedAgentId);
  });
  $effect(() => {
    scene?.setClock(batuClock.h, batuClock.m);
  });
  $effect(() => {
    scene?.setFloor(floor);
  });
  $effect(() => {
    scene?.setOverview(overview);
  });
  $effect(() => {
    scene?.setPaused(paused);
  });
  $effect(() => {
    scene?.setAutoRotate(rotating);
  });
  // Parent bumps resetTick to ease the camera back to the floor view.
  $effect(() => {
    void resetTick;
    if (resetTick > 0) scene?.resetView();
  });
</script>

<div class="three-office">
  <canvas bind:this={canvas} class="three-canvas" aria-label="3D office"></canvas>
  <div class="three-weather" title="{weatherMeta.desc} — {weather.live ? 'live dari Batu' : 'perkiraan waktu Batu'}">
    <span aria-hidden="true">{weatherIcon}</span>
    <span>{weatherLabel}</span>
  </div>
  <div class="three-focus" role="tablist" aria-label="Fokus lantai">
    <button
      type="button"
      role="tab"
      aria-selected={overviewMode}
      class="three-floor"
      class:active={overviewMode}
      onclick={pickOverview}
    >
      <span aria-hidden="true">🏢</span>
      <span>Gedung</span>
    </button>
    {#each FLOOR_UI as f (f.id)}
      <button
        type="button"
        role="tab"
        aria-selected={!overviewMode && focusFloor === f.id}
        class="three-floor"
        class:active={!overviewMode && focusFloor === f.id}
        onclick={() => pickFloor(f.id)}
      >
        <span aria-hidden="true">{f.icon}</span>
        <span>{f.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .three-office {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #11161f;
  }

  .three-canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: grab;
  }

  .three-weather {
    position: absolute;
    right: 12px;
    top: 12px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(10, 10, 15, 0.72);
    color: #f0ead0;
    border: 1px solid rgba(255, 217, 160, 0.25);
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 11px;
    line-height: 1.5;
    pointer-events: auto;
    cursor: default;
    user-select: none;
  }
  .three-focus {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 10;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    max-width: 62%;
  }

  .three-floor {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(10, 10, 15, 0.72);
    color: #d8d8c0;
    border: 1px solid rgba(255, 217, 160, 0.25);
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 11px;
    line-height: 1.5;
    cursor: pointer;
  }

  .three-floor.active {
    color: #101828;
    background: #fde68a;
    border-color: #fde68a;
    font-weight: 700;
  }
</style>

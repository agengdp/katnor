<script lang="ts">
  import { goto } from '$app/navigation';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { liveStatusStore, type LiveAgentState } from '$lib/office/liveStatus.svelte';
  import {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    RECEPTION,
    MEETING_ROOM,
    MEETING_ROOM_SIZE,
    deskPositions,
    hashColor,
    initials,
    pointInRect,
    zones,
    type Point
  } from '$lib/office/layout';

  /**
   * PLAN.md 4.8's 2D office, built as a plain Canvas 2D renderer rather
   * than Phaser 3 + a Tiled map + a licensed pixel-art pack: this sandbox
   * has no way to install/verify a game-engine dependency's exact runtime
   * API, and no network access to legally source and bundle real sprite
   * assets (see assets/office/LICENSES.md). Agents render as flat colored
   * circles (a stable per-id hue, initials, and a name label) instead of
   * sprites, and movement between desk/meeting-room/reception is a direct
   * lerp rather than EasyStar.js grid pathfinding - there's no wall layout
   * for it to route around yet. The *behavior* PLAN.md actually asks for
   * (desks, states driven by live events, click-through zones, a day/night
   * spend tint) is all real; only the rendering technology is substituted.
   */

  interface AgentPersona {
    bio: string;
    personality: string;
    strengths: string[];
    style: string;
  }
  interface AgentRow {
    id: string;
    name: string;
    title: string;
    status: 'active' | 'paused' | 'offline';
    is_system: boolean;
    persona: AgentPersona;
    model_config: { provider: string; model: string };
  }

  let agents = $state<AgentRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let pendingCount = $state(0);
  let spend = $state<{ spentUsd: number; budgetUsd: number }>({ spentUsd: 0, budgetUsd: 0 });

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  async function loadAgents() {
    loading = true;
    loadError = null;
    try {
      agents = (await trpc().agents.list.query()) as unknown as AgentRow[];
      for (const agent of agents) liveStatusStore.seedFromAgentStatus(agent.id, agent.status);
    } catch (err) {
      loadError = describeError(err);
    } finally {
      loading = false;
    }
  }

  async function loadPendingCount() {
    try {
      const rows = await trpc().approvals.list.query({ status: 'pending' });
      pendingCount = rows.length;
    } catch {
      // Non-fatal - the reception badge just stays at its last known count.
    }
  }

  async function loadSpend() {
    try {
      spend = await trpc().runs.todaySpend.query();
    } catch {
      // Non-fatal - the day/night tint just stays neutral.
    }
  }

  $effect(() => {
    loadAgents();
    loadPendingCount();
    loadSpend();
  });

  $effect(() => {
    liveStatusStore.start();
    return () => liveStatusStore.stop();
  });

  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (event.type === 'agent.hired' || event.type === 'agent.updated' || event.type === 'agent.fired') loadAgents();
      if (event.type === 'approval.requested' || event.type === 'approval.decided') loadPendingCount();
      if (event.type === 'run.finished') loadSpend();
    });
    return unsub;
  });

  // ─── Layout ─────────────────────────────────────────────────────────────

  const ceo = $derived(agents.find((a) => a.is_system) ?? null);
  const deskAgents = $derived(agents.filter((a) => !a.is_system).sort((a, b) => a.id.localeCompare(b.id)));
  const deskByAgentId = $derived.by(() => {
    const positions = deskPositions(deskAgents.length);
    const map = new Map<string, Point>();
    deskAgents.forEach((agent, i) => {
      const pos = positions[i];
      if (pos) map.set(agent.id, pos);
    });
    return map;
  });
  const zoneList = zones();

  function targetFor(agent: AgentRow): Point {
    if (ceo && agent.id === ceo.id) return RECEPTION;
    const status = liveStatusStore.get(agent.id);
    if (status.state === 'talking') return MEETING_ROOM;
    if (status.state === 'waiting_human') return RECEPTION;
    return deskByAgentId.get(agent.id) ?? { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  }

  function liveStateFor(agent: AgentRow): LiveAgentState {
    if (agent.status !== 'active') return 'offline';
    return liveStatusStore.get(agent.id).state;
  }

  // ─── Canvas rendering ───────────────────────────────────────────────────

  let canvasEl = $state<HTMLCanvasElement | undefined>(undefined);
  // Animated (lerped) positions, kept outside Svelte's reactivity - the
  // render loop reads/writes these every frame via requestAnimationFrame,
  // not through $state, since nothing here needs a Svelte re-render.
  const currentPos = new Map<string, Point>();
  let hoveredZoneId = $state<string | null>(null);
  let selectedAgentId = $state<string | null>(null);

  function ensurePos(agent: AgentRow): Point {
    let pos = currentPos.get(agent.id);
    if (!pos) {
      pos = { ...targetFor(agent) };
      currentPos.set(agent.id, pos);
    }
    return pos;
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBubble(ctx: CanvasRenderingContext2D, pos: Point, text: string): void {
    const truncated = text.length > 26 ? `${text.slice(0, 26)}…` : text;
    ctx.font = '11px system-ui, sans-serif';
    const width = ctx.measureText(truncated).width + 14;
    const height = 20;
    const bx = pos.x - width / 2;
    const by = pos.y - 46;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, width, height, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.fillText(truncated, pos.x, by + 14);
  }

  const STATE_ICON: Record<LiveAgentState, string> = {
    idle: '',
    working: '🔧',
    talking: '💬',
    waiting_human: '❓',
    blocked: '🚫',
    offline: ''
  };

  function draw(ctx: CanvasRenderingContext2D): void {
    const now = Date.now();
    ctx.textAlign = 'center';
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = '#eef2f7';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Day/night tint (PLAN.md 4.8): a dark overlay whose opacity tracks
    // today's spend against the company's daily budget.
    const ratio = spend.budgetUsd > 0 ? Math.min(1, spend.spentUsd / spend.budgetUsd) : 0;
    if (ratio > 0) {
      ctx.fillStyle = `rgba(8, 12, 32, ${ratio * 0.35})`;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    // Meeting room outline.
    ctx.strokeStyle = '#c7d2e0';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      MEETING_ROOM.x - MEETING_ROOM_SIZE.width / 2,
      MEETING_ROOM.y - MEETING_ROOM_SIZE.height / 2,
      MEETING_ROOM_SIZE.width,
      MEETING_ROOM_SIZE.height
    );
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('Meeting room', MEETING_ROOM.x, MEETING_ROOM.y - MEETING_ROOM_SIZE.height / 2 - 8);

    // Zones.
    for (const zone of zoneList) {
      ctx.fillStyle = hoveredZoneId === zone.id ? '#dbeafe' : '#e2e8f0';
      roundRect(ctx, zone.x, zone.y, zone.width, zone.height, 8);
      ctx.fill();
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(zone.icon, zone.x + zone.width / 2, zone.y + zone.height / 2 + 8);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText(zone.label, zone.x + zone.width / 2, zone.y + zone.height + 13);

      if (zone.id === 'reception' && pendingCount > 0) {
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(zone.x + zone.width - 8, zone.y + 8, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.fillText(String(pendingCount), zone.x + zone.width - 8, zone.y + 11);
      }
    }

    // Desk outlines.
    for (const pos of deskByAgentId.values()) {
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.strokeRect(pos.x - 30, pos.y - 20, 60, 40);
    }

    // Agents.
    for (const agent of agents) {
      const target = targetFor(agent);
      const pos = ensurePos(agent);
      pos.x += (target.x - pos.x) * 0.08;
      pos.y += (target.y - pos.y) * 0.08;

      const state = liveStateFor(agent);
      const status = liveStatusStore.get(agent.id);
      const pulsing = state === 'working' ? Math.sin(now / 220) * 2 : 0;
      const radius = 16 + pulsing;

      ctx.globalAlpha = state === 'offline' ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = selectedAgentId === agent.id ? '#1f2937' : hashColor(agent.id);
      ctx.fill();
      if (state === 'blocked') {
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (agent.is_system) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText(initials(agent.name), pos.x, pos.y + 4);

      ctx.fillStyle = '#334155';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(agent.name, pos.x, pos.y + radius + 15);

      const icon = STATE_ICON[state];
      if (icon) {
        drawBubble(ctx, pos, status.detail ? `${icon} ${status.detail}` : icon);
      }
    }
  }

  let rafId = 0;
  function frame(): void {
    const ctx = canvasEl?.getContext('2d');
    if (ctx) draw(ctx);
    rafId = requestAnimationFrame(frame);
  }

  $effect(() => {
    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  });

  function canvasPoint(event: MouseEvent): Point {
    const rect = canvasEl!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT
    };
  }

  function agentAt(point: Point): AgentRow | null {
    for (const agent of agents) {
      const pos = currentPos.get(agent.id);
      if (!pos) continue;
      if (Math.hypot(point.x - pos.x, point.y - pos.y) <= 20) return agent;
    }
    return null;
  }

  function zoneAt(point: Point) {
    return zoneList.find((zone) => pointInRect(point.x, point.y, zone.x, zone.y, zone.width, zone.height)) ?? null;
  }

  function handleClick(event: MouseEvent): void {
    const point = canvasPoint(event);
    const zone = zoneAt(point);
    if (zone) {
      void goto(zone.href);
      return;
    }
    const agent = agentAt(point);
    selectedAgentId = agent ? agent.id : null;
    if (agent) {
      chatText = '';
      chatError = null;
      chatSent = false;
    }
  }

  function handleMouseMove(event: MouseEvent): void {
    if (!canvasEl) return;
    const point = canvasPoint(event);
    const zone = zoneAt(point);
    hoveredZoneId = zone?.id ?? null;
    canvasEl.style.cursor = zone || agentAt(point) ? 'pointer' : 'default';
  }

  const selectedAgent = $derived(agents.find((a) => a.id === selectedAgentId) ?? null);

  // ─── Side panel: quick chat ─────────────────────────────────────────────

  let chatText = $state('');
  let chatSending = $state(false);
  let chatError = $state<string | null>(null);
  let chatSent = $state(false);

  async function sendQuickChat() {
    if (!selectedAgent || chatText.trim().length === 0) return;
    chatSending = true;
    chatError = null;
    chatSent = false;
    try {
      const dm = await trpc().channels.getOrCreateDm.mutate({ agent_id: selectedAgent.id });
      await trpc().messages.send.mutate({ channel_id: dm.id, text: chatText.trim() });
      chatText = '';
      chatSent = true;
    } catch (err) {
      chatError = describeError(err);
    } finally {
      chatSending = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <div>
    <h1 class="text-2xl font-semibold">Office</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Click a desk to see what someone's doing, or click the reception/whiteboard/bookshelf/server rack to jump to
      Inbox/Projects/Knowledge/Runs.
    </p>
  </div>

  {#if loadError}
    <p class="text-sm text-[var(--color-danger)]">{loadError}</p>
  {:else if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {/if}

  <div class="flex flex-col gap-4 lg:flex-row">
    <div class="min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        class="block w-full"
        onclick={handleClick}
        onmousemove={handleMouseMove}
      ></canvas>
    </div>

    <div class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm lg:w-80 lg:shrink-0">
      {#if !selectedAgent}
        <p class="text-[var(--color-text-muted)]">
          Click someone's desk to see their persona and live status, or send them a quick message.
        </p>
      {:else}
        {@const status = liveStatusStore.get(selectedAgent.id)}
        {@const state = liveStateFor(selectedAgent)}
        <div class="flex flex-col gap-3">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="font-semibold">{selectedAgent.name}</h2>
              {#if selectedAgent.is_system}
                <span class="rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">CEO</span>
              {/if}
            </div>
            <p class="text-[var(--color-text-muted)]">{selectedAgent.title}</p>
          </div>

          <p class="text-xs">
            <span class="font-medium">Status:</span>
            <span class="capitalize">{state.replace('_', ' ')}</span>{status.detail ? ` - ${status.detail}` : ''}
          </p>

          {#if selectedAgent.persona.bio}
            <p class="text-xs text-[var(--color-text-muted)]">{selectedAgent.persona.bio}</p>
          {/if}
          <p class="text-xs text-[var(--color-text-muted)]">
            {selectedAgent.model_config.provider} · {selectedAgent.model_config.model}
          </p>

          <div class="flex flex-wrap gap-2">
            <a
              href={`/runs?agent=${selectedAgent.id}`}
              class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
            >
              View trace
            </a>
            <a href="/team" class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]">
              Edit persona/model
            </a>
          </div>

          <form
            class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3"
            onsubmit={(event) => {
              event.preventDefault();
              sendQuickChat();
            }}
          >
            <label class="flex flex-col gap-1">
              <span class="text-xs text-[var(--color-text-muted)]">Quick message</span>
              <textarea
                rows="2"
                bind:value={chatText}
                class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs"
              ></textarea>
            </label>
            {#if chatError}
              <p class="text-xs text-[var(--color-danger)]">{chatError}</p>
            {:else if chatSent}
              <p class="text-xs text-[var(--color-success)]">Sent.</p>
            {/if}
            <button
              type="submit"
              disabled={chatSending || chatText.trim().length === 0}
              class="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
            >
              {chatSending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </div>
      {/if}
    </div>
  </div>
</div>

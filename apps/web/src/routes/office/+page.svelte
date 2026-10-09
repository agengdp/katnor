<script lang="ts">
  import { goto } from '$app/navigation';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { liveStatusStore, type LiveAgentState } from '$lib/office/liveStatus.svelte';
  import ThreeOffice from '$lib/office/ThreeOffice.svelte';
  import type { FloorId, OfficeScene, RoomAgent } from '$lib/office/threeOffice';
  import { ZONE_HREFS } from '$lib/office/officeLayout';
  import AgentSprite from '$lib/office/AgentSprite.svelte';
  import DecisionPopup from '$lib/office/DecisionPopup.svelte';
  import FloatingActivity from '$lib/office/FloatingActivity.svelte';

  /**
   * PLAN.md 4.8's office, rendered as a real-time 3D room (Three.js) -
   * one modeled floor with a character per agent, driven by the live
   * status feed: talking agents gather at the meeting table, waiting
   * agents queue at reception, everyone else works their desk. Day/night
   * follows the wall clock and dims with spend.
   *
   * Click a character to open the side panel, click a labeled zone
   * (Chat / Projects / Knowledge / Runs) to jump to its page.
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

  async function loadSpend() {
    try {
      spend = await trpc().runs.todaySpend.query();
    } catch {
      // Non-fatal - the day/night tint just stays neutral.
    }
  }

  $effect(() => {
    loadAgents();
    loadSpend();
  });

  $effect(() => {
    liveStatusStore.start();
    return () => liveStatusStore.stop();
  });

  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (
        event.type === 'agent.hired' ||
        event.type === 'agent.updated' ||
        event.type === 'agent.fired'
      )
        loadAgents();
      if (event.type === 'run.finished') loadSpend();
    });
    return unsub;
  });

  // ─── Live feed into the room ────────────────────────────────────────

  let selectedAgentId = $state<string | null>(null);
  let officeScene = $state<OfficeScene | null>(null);
  let orderSent = $state<string | null>(null);
  // Bumped on a 4Hz poll: the store mutates a plain record Svelte cannot
  // track by itself, and live statuses arrive via websocket between
  // renders, so this keeps characters walking and bubbles fresh.
  let statusTick = $state(0);

  $effect(() => {
    const timer = setInterval(() => {
      statusTick += 1;
    }, 250);
    return () => clearInterval(timer);
  });

  function liveStateFor(agent: AgentRow): LiveAgentState {
    if (agent.status !== 'active') return 'offline';
    return liveStatusStore.get(agent.id).state;
  }

  const roomAgents = $derived.by((): RoomAgent[] => {
    void statusTick;
    return agents
      .slice()
      .sort((a, b) => Number(b.is_system) - Number(a.is_system) || a.id.localeCompare(b.id))
      .map((agent) => {
        const status = liveStatusStore.get(agent.id);
        return {
          id: agent.id,
          name: agent.name,
          is_system: agent.is_system,
          state: liveStateFor(agent),
          detail: status.detail,
          status: agent.status,
        };
      });
  });

  const nightRatio = $derived(
    spend.budgetUsd > 0 ? Math.min(1, spend.spentUsd / spend.budgetUsd) : 0,
  );

  function handleSelectZone(zoneId: string): void {
    const href = ZONE_HREFS[zoneId];
    if (href) void goto(href);
  }

  function handleSelectAgent(agentId: string): void {
    selectedAgentId = selectedAgentId === agentId ? null : agentId;
    chatText = '';
    chatError = null;
    chatSent = false;
    orderSent = null;
  }

  const FLOOR_ORDER: { id: FloorId; label: string; icon: string }[] = [
    { id: 'kitchen', label: 'Kitchen & Dining', icon: '🍽️' },
    { id: 'rooftop', label: 'Rooftop', icon: '🌇' },
    { id: 'parking', label: 'Parking', icon: '🅿️' },
    { id: 'workspace', label: 'Workspace', icon: '💻' },
  ];

  function sendToFloor(floor: FloorId): void {
    if (!selectedAgent) return;
    officeScene?.sendToFloor(selectedAgent.id, floor);
    orderSent =
      selectedAgent.id === ceoId
        ? 'CEO berangkat.'
        : floor === 'workspace'
          ? 'Kembali ke meja kerja.'
          : 'Berjalan ke lift…';
  }

  const selectedAgent = $derived(agents.find((a) => a.id === selectedAgentId) ?? null);
  const ceoId = $derived(agents.find((a) => a.is_system)?.id ?? null);

  // ─── Side panel: quick chat ─────────────────────────────────────────

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

<div class="relative min-h-0 flex-1 overflow-hidden">
  <ThreeOffice
    agents={roomAgents}
    {nightRatio}
    {selectedAgentId}
    onSelectAgent={handleSelectAgent}
    onSelectZone={handleSelectZone}
    onScene={(s) => (officeScene = s)}
  />

  <!-- Floor-focus pills (top-left) carry the page label; no separate
       floating title — that pill row IS the header now. -->
  {#if loadError}
    <p class="pointer-events-none absolute left-4 top-14 z-40 max-w-sm rounded-md bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-danger)] shadow-lg">
      {loadError}
    </p>
  {:else if loading}
    <p class="pointer-events-none absolute left-4 top-14 z-40 max-w-sm rounded-md bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] shadow-lg">
      Loading…
    </p>
  {/if}

  <!-- Floating side panel, right over the room. Hidden until an agent is
       selected; close button returns to a pure fullscreen room. -->
  {#if selectedAgent}
    {@const status = liveStatusStore.get(selectedAgent.id)}
    {@const state = liveStateFor(selectedAgent)}
    <div
      class="absolute bottom-4 right-4 top-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm shadow-xl enter-right"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 items-start gap-3">
          <AgentSprite
            agentId={selectedAgent.id}
            isCeo={selectedAgent.is_system}
            label={`${selectedAgent.name}'s character`}
          />
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="font-semibold">{selectedAgent.name}</h2>
              {#if selectedAgent.is_system}
                <span
                  class="rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
                  >CEO</span
                >
              {/if}
            </div>
            <p class="text-[var(--color-text-muted)]">{selectedAgent.title}</p>
          </div>
        </div>
        <button
          type="button"
          onclick={() => (selectedAgentId = null)}
          aria-label="Close panel"
          class="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
        >
          ✕
        </button>
      </div>

          <p class="text-xs">
            <span class="font-medium">Status:</span>
            <span class="capitalize">{state.replace('_', ' ')}</span>{status.detail
              ? ` - ${status.detail}`
              : ''}
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
              class="btn-press rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
            >
              View trace
            </a>
            <a
              href="/team"
              class="btn-press rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
            >
              Edit persona/model
            </a>
          </div>

          <div class="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3">
            <span class="text-xs text-[var(--color-text-muted)]">Kirim ke lantai</span>
            <div class="flex flex-wrap gap-1.5">
              {#each FLOOR_ORDER as f (f.id)}
                <button
                  type="button"
                  onclick={() => sendToFloor(f.id)}
                  class="btn-press rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
                >
                  <span aria-hidden="true">{f.icon}</span> {f.label}
                </button>
              {/each}
            </div>
            {#if orderSent}
              <p class="text-xs text-[var(--color-success)]">{orderSent}</p>
            {/if}
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

  <!-- Live activity feed, bottom-right; shifts left while the agent side
       panel is open so the two never overlap. -->
  <FloatingActivity shifted={selectedAgent !== null} />

  <!-- Pops up whenever an employee needs the owner's decision: the
       asking character, the question, and its recommended decisions. -->
  <DecisionPopup />
</div>

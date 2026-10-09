<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { Icon } from '$lib/icons';

  /**
   * A floating live activity log for the Office page: a running feed of
   * what every employee is doing right now, built from the shared event
   * bus (packages/core/src/events.ts) rather than any polling. Typical
   * lines: "Ravi is talking with the CEO", "Mira is working on research",
   * "Dev finished a run", "Beni is waiting for your approval".
   *
   * Collapsed it is just a round button (with a badge counting activity
   * that arrived while hidden); expanded it lists the newest ~50 events.
   * This is deliberately read-only - the room-wide #general conversation
   * lives on the Chat page, this widget only observes the office.
   *
   * `shifted` slides the widget left so it never covers the agent side
   * panel when a character is selected.
   */

  let { shifted = false }: { shifted?: boolean } = $props();

  interface AgentRow {
    id: string;
    name: string;
    status: 'active' | 'paused' | 'offline';
  }

  interface RunRow {
    id: string;
    agent_id: string;
    status: string;
    trigger: string;
    started_at: string;
  }

  interface ActivityEntry {
    id: string;
    at: number;
    /** Who did it - the employee's name, or 'Kantor'/'Kamu' for non-agent lines. */
    actor: string;
    /** What they did, rendered on its own line under the actor's name. */
    message: string;
    agentId: string | null;
  }

  const MAX_ENTRIES = 50;
  /** run.step_recorded fires once per LLM call inside a run - repeating the
   *  same "X is talking/working" line that often would flood the log, so
   *  consecutive duplicates from the same agent are collapsed. */
  const DEDUPE_WINDOW_MS = 15_000;

  let open = $state(false);
  let agents = $state<AgentRow[]>([]);
  let entries = $state<ActivityEntry[]>([]);
  // Counts activity that arrives while the widget is hidden; shown as a
  // badge on the collapsed button and reset on open.
  let unseenCount = $state(0);
  let feedEl = $state<HTMLDivElement | undefined>(undefined);

  const agentsById = $derived(new Map(agents.map((a) => [a.id, a.name])));

  function agentName(id: string | null | undefined): string {
    if (!id) return 'Someone';
    return agentsById.get(id) ?? 'Someone';
  }

  function push(
    actor: string,
    message: string,
    agentId: string | null,
    opts: { dedupeKey?: string } = {},
  ): void {
    const last = entries[0];
    if (
      opts.dedupeKey !== undefined &&
      last &&
      last.actor === actor &&
      last.message === message &&
      Date.now() - last.at < DEDUPE_WINDOW_MS
    ) {
      // Refresh the timestamp so the line reads as "still happening".
      entries = [{ ...last, at: Date.now() }, ...entries.slice(1)];
    } else {
      entries = [
        { id: crypto.randomUUID(), at: Date.now(), actor, message, agentId },
        ...entries.slice(0, MAX_ENTRIES - 1),
      ];
    }
    if (!open) unseenCount += 1;
  }

  function str(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  }

  function strArray(payload: Record<string, unknown>, key: string): string[] {
    const value = payload[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Renders one live event as one log line (or ignores it, for events
   *  with nothing human-readable worth showing - e.g. agent.updated). */
  function describeEvent(event: { type: string; payload: Record<string, unknown> }): void {
    const p = event.payload ?? {};
    switch (event.type) {
      case 'run.started': {
        const id = str(p, 'agent_id');
        const name = agentName(id);
        const trigger = str(p, 'trigger');
        if (trigger === 'mention' || trigger === 'human') {
          push(name, 'mulai merespons percakapan', id, { dedupeKey: 'run' });
        } else if (trigger === 'chatter') {
          push(name, 'ikut mengobrol di kantor', id, { dedupeKey: 'run' });
        } else {
          push(name, 'mulai bekerja', id, { dedupeKey: 'run' });
        }
        return;
      }
      case 'run.step_recorded': {
        const id = str(p, 'agent_id');
        const name = agentName(id);
        const kind = str(p, 'kind');
        const detail = str(p, 'detail');
        if (kind === 'tool_call') {
          push(name, detail ? `sedang bekerja: ${detail}` : 'sedang bekerja', id, {
            dedupeKey: 'step',
          });
        } else if (kind === 'message') {
          push(name, detail ? `bicara: “${detail}”` : 'sedang bicara', id, {
            dedupeKey: 'step',
          });
        }
        return;
      }
      case 'run.finished': {
        const id = str(p, 'agent_id');
        const name = agentName(id);
        const status = str(p, 'status');
        if (status === 'waiting_human') {
          push(name, 'menunggu persetujuan kamu', id);
        } else if (status === 'failed') {
          push(name, 'run-nya gagal', id);
        } else {
          push(name, 'selesai bekerja', id);
        }
        return;
      }
      case 'message.posted': {
        const authorType = str(p, 'author_type');
        const authorId = str(p, 'author_id');
        const mentions = strArray(p, 'mentions');
        if (authorType === 'agent') {
          const name = agentName(authorId);
          if (mentions.length > 0) {
            push(name, `menyebut ${mentions.map((m) => agentName(m)).join(', ')}`, authorId, {
              dedupeKey: 'msg',
            });
          } else {
            push(name, 'mengirim pesan', authorId, { dedupeKey: 'msg' });
          }
        }
        return;
      }
      case 'approval.requested': {
        push('Kantor', 'Ada permintaan persetujuan baru', null);
        return;
      }
      case 'approval.decided': {
        const status = str(p, 'status');
        push(
          'Kamu',
          status === 'approved' ? 'menyetujui sebuah permintaan' : 'menolak sebuah permintaan',
          null,
        );
        return;
      }
      case 'task.updated': {
        if (str(p, 'status') === 'blocked') {
          const assigneeId = str(p, 'assignee_id');
          if (assigneeId) {
            push(agentName(assigneeId), 'terhambat di sebuah task', assigneeId);
          } else {
            push('Kantor', 'Sebuah task terhambat', null);
          }
        }
        return;
      }
      case 'agent.hired': {
        const name = str(p, 'name');
        push(name ?? 'Kantor', name ? 'bergabung dengan kantor' : 'Karyawan baru bergabung', null);
        return;
      }
      case 'agent.fired': {
        const id = str(p, 'agent_id');
        push(agentName(id), 'meninggalkan kantor', id);
        return;
      }
      case 'chatter.limited': {
        const id = str(p, 'author_id');
        push(agentName(id), 'dihentikan sebentar (terlalu banyak mengobrol)', id);
        return;
      }
      default:
        return;
    }
  }

  // Boot: the agent roster gives ids human names, and the latest runs
  // pre-fill the log so it isn't empty on first open.
  $effect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentList, runs] = await Promise.all([
          trpc().agents.list.query(),
          trpc().runs.list.query({}),
        ]);
        if (cancelled) return;
        agents = agentList as AgentRow[];
        const names = new Map((agentList as AgentRow[]).map((a) => [a.id, a.name]));
        const seed: ActivityEntry[] = (runs as RunRow[]).slice(0, 10).map((run) => {
          const name = names.get(run.agent_id) ?? 'Someone';
          const message =
            run.status === 'running'
              ? 'sedang bekerja'
              : run.status === 'waiting_human'
                ? 'menunggu persetujuan kamu'
                : run.status === 'failed'
                  ? 'run-nya gagal'
                  : 'selesai bekerja';
          return {
            id: `seed-${run.id}`,
            at: new Date(run.started_at).getTime() || Date.now(),
            actor: name,
            message,
            agentId: run.agent_id,
          };
        });
        entries = seed;
      } catch {
        // Non-fatal - the log just starts empty and fills from live events.
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // One subscription for the life of the component: every office event
  // becomes a log line. `open` is read fresh inside the callback so the
  // badge counts what arrives while hidden.
  $effect(() => {
    const unsubscribe = subscribeToEvents((event) => {
      try {
        describeEvent(event);
      } catch (err) {
        console.error('[activity-log] failed to describe event', err);
      }
    });
    return unsubscribe;
  });

  $effect(() => {
    if (open) unseenCount = 0;
  });

  // New entries land at the top of the list, so keep it pinned there.
  $effect(() => {
    const el = feedEl;
    if (!open || !el) return;
    void entries;
    el.scrollTop = 0;
  });

  function formatTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

{#if open}
  <div
    class="absolute bottom-4 top-4 z-20 flex w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl {shifted
      ? 'right-[21rem]'
      : 'right-4'}"
  >
    <div
      class="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="relative flex h-2 w-2 shrink-0">
          <span
            class="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-success)] opacity-60"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-success)]"></span>
        </span>
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold">Aktivitas kantor</h2>
          <p class="text-xs text-[var(--color-text-muted)]">Siapa sedang ngapain, live</p>
        </div>
      </div>
      <button
        type="button"
        onclick={() => (open = false)}
        aria-label="Sembunyikan aktivitas"
        title="Sembunyikan"
        class="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
      >
        –
      </button>
    </div>

    <div bind:this={feedEl} class="min-h-0 flex-1 overflow-y-auto px-3 py-1">
      {#if entries.length === 0}
        <p class="py-6 text-center text-xs text-[var(--color-text-muted)]">
          Belum ada aktivitas. Log akan terisi otomatis saat karyawan mulai bekerja atau bicara.
        </p>
      {:else}
        {#each entries as entry (entry.id)}
          <div class="flex flex-col gap-0.5 border-b border-[var(--color-border)] py-2 last:border-0">
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate text-xs font-semibold">{entry.actor}</span>
              <span class="shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]"
                >{formatTime(entry.at)}</span
              >
            </div>
            <p class="min-w-0 text-xs text-[var(--color-text-muted)]">{entry.message}</p>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{:else}
  <button
    type="button"
    onclick={() => (open = true)}
    aria-label="Tampilkan aktivitas kantor"
    title="Aktivitas kantor"
    class="absolute bottom-4 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-lg shadow-xl hover:bg-[var(--color-surface-muted)] {shifted
      ? 'right-[21rem]'
      : 'right-4'}"
  >
    <Icon name="activity" size="1.4em" label="Aktivitas kantor" />
    {#if unseenCount > 0}
      <span
        class="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-semibold text-white"
      >
        {unseenCount > 9 ? '9+' : unseenCount}
      </span>
    {/if}
  </button>
{/if}

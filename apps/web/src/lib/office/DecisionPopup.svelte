<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import type { ApprovalKind, ApprovalStatus } from '@katnor/core';
  import AgentSprite from '$lib/office/AgentSprite.svelte';
  import ApprovalCard from '$lib/approval/ApprovalCard.svelte';

  /**
   * Pops up over the office whenever an employee needs the owner's
   * decision - a question, a hire request, a spend request. Shows the
   * asking employee's character and name, the question itself, and that
   * kind's recommended decisions (a question's option list, Approve/
   * Reject for the rest) by reusing the shared ApprovalCard.
   *
   * Several pending decisions queue up and are worked through one at a
   * time, oldest first, with a "1/3"-style counter. "Nanti" parks the
   * popup for the current item - it reappears on the next approval event
   * or when another employee asks something - so a decision is never
   * lost, just postponed.
   */

  interface ApprovalRow {
    id: string;
    created_at: string;
    run_id: string;
    kind: ApprovalKind;
    payload: Record<string, unknown>;
    status: ApprovalStatus;
    /** The asking agent (server joins via run) - null when unknown. */
    agent_id: string | null;
  }

  interface AgentRow {
    id: string;
    name: string;
    title: string;
  }

  let agents = $state<AgentRow[]>([]);
  let queue = $state<ApprovalRow[]>([]);
  let deciding = $state(false);
  let decideError = $state<string | null>(null);
  // Ids parked via "Nanti" for the current batch - hidden again only
  // until anything new happens (a reload re-queues everything pending).
  let snoozedIds = $state<string[]>([]);

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  async function loadPending(): Promise<void> {
    try {
      const rows = await trpc().approvals.list.query({ status: 'pending' });
      queue = (rows as ApprovalRow[]).sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      if (queue.length === 0) snoozedIds = [];
    } catch {
      // Non-fatal - the popup just stays hidden until the next event.
    }
  }

  $effect(() => {
    (async () => {
      try {
        agents = (await trpc().agents.list.query()) as AgentRow[];
      } catch {
        // Names fall back to "Employee".
      }
      await loadPending();
    })();
  });

  // Live queue: a new request re-fetches (and un-parks anything snoozed,
  // since the queue changed anyway); a decision made elsewhere (Chat,
  // another tab) drops the item here too.
  $effect(() => {
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === 'approval.requested') {
        snoozedIds = [];
        void loadPending();
      } else if (event.type === 'approval.decided') {
        void loadPending();
      }
    });
    return unsubscribe;
  });

  const visibleQueue = $derived(queue.filter((row) => !snoozedIds.includes(row.id)));
  const current = $derived(visibleQueue[0] ?? null);
  const askerName = $derived(
    current?.agent_id
      ? (agents.find((a) => a.id === current.agent_id)?.name ?? 'Employee')
      : 'Employee',
  );

  async function decide(decision: 'approved' | 'rejected', answer?: string): Promise<void> {
    const row = current;
    if (!row || deciding) return;
    deciding = true;
    decideError = null;
    try {
      const input =
        answer === undefined ? { id: row.id, decision } : { id: row.id, decision, answer };
      await trpc().approvals.decide.mutate(input);
      queue = queue.filter((item) => item.id !== row.id);
    } catch (err) {
      decideError = describeError(err);
    } finally {
      deciding = false;
    }
  }
</script>

{#if current}
  <div
    class="absolute bottom-4 left-1/2 z-30 w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-accent)] bg-[var(--color-surface)] shadow-2xl"
    role="alertdialog"
    aria-label="Keputusan dibutuhkan"
  >
    <div
      class="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2"
    >
      {#if current.agent_id}
        <AgentSprite agentId={current.agent_id} label={`${askerName}'s character`} />
      {/if}
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold">{askerName} butuh keputusanmu</p>
        <p class="text-xs text-[var(--color-text-muted)]">
          {visibleQueue.length > 1 ? `${visibleQueue.length} keputusan menunggu` : '1 keputusan menunggu'}
        </p>
      </div>
      {#if visibleQueue.length > 1}
        <span
          class="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
        >
          1/{visibleQueue.length}
        </span>
      {/if}
      <button
        type="button"
        onclick={() => {
          snoozedIds = [...snoozedIds, current.id];
          decideError = null;
        }}
        disabled={deciding}
        class="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface)] disabled:opacity-50"
      >
        Nanti
      </button>
    </div>

    <div class="max-h-[50vh] overflow-y-auto p-3">
      {#key current.id}
        <ApprovalCard
          row={current}
          {deciding}
          error={decideError ?? ''}
          onDecide={(decision, answer) => decide(decision, answer)}
        />
      {/key}
    </div>
  </div>
{/if}

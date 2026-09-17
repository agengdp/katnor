<script lang="ts">
  import type { ApprovalKind, ApprovalStatus } from '@katnor/core';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';

  /**
   * What `approvals.list`/`approvals.decide` actually send over the wire.
   * Not imported from `@katnor/core`'s `Approval` type: that type's
   * `created_at`/`updated_at`/`decided_at` are `Date` (drizzle's SELECT type
   * for a `timestamp` column - see packages/db/src/schema/approval.ts), but
   * there's no superjson transformer configured (apps/server/src/trpc/router.ts),
   * so every timestamp actually arrives here as a plain ISO string.
   */
  type ApprovalRow = {
    id: string;
    created_at: string;
    updated_at: string;
    run_id: string;
    kind: ApprovalKind;
    payload: Record<string, unknown>;
    status: ApprovalStatus;
    decided_by: string | null;
    decided_at: string | null;
  };

  type View = 'pending' | 'decided';

  let approvals = $state<ApprovalRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let view = $state<View>('pending');

  // Per-approval-id transient UI state, keyed by id rather than stored on
  // the rows themselves so it survives `approvals` being replaced wholesale
  // by a reload.
  let decidingIds = $state<Record<string, boolean>>({});
  let actionErrors = $state<Record<string, string>>({});
  let draftAnswers = $state<Record<string, string>>({});

  // A one-line toast for "your decision went through" - needed because the
  // decided item disappears from the Pending tab the instant `approvals`
  // updates, so without this the confirmation would never actually be seen.
  let confirmation = $state<{ text: string; positive: boolean } | null>(null);

  let pending = $derived(approvals.filter((a) => a.status === 'pending'));
  let decidedList = $derived(approvals.filter((a) => a.status !== 'pending'));
  let currentList = $derived(view === 'pending' ? pending : decidedList);

  function isUnauthorized(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const data = (err as { data?: { code?: string; httpStatus?: number } }).data;
    return data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401;
  }

  function describeError(err: unknown): string {
    if (isUnauthorized(err)) return 'You need to be logged in to do that.';
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  // --- Defensive payload readers -------------------------------------
  // `payload`'s shape depends on `kind` and isn't validated client-side, so
  // every field is read defensively rather than cast to a strict type.
  function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
  }

  function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function kindLabel(kind: ApprovalKind): string {
    switch (kind) {
      case 'hire':
        return 'Hire request';
      case 'question':
        return 'Question';
      case 'tool_call':
        return 'Tool call';
      case 'spend':
        return 'Spend request';
      default:
        return kind;
    }
  }

  function formatTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function hireName(payload: Record<string, unknown>): string {
    return asString(payload.name, 'Unnamed hire');
  }
  function hireTitle(payload: Record<string, unknown>): string {
    return asString(payload.title);
  }
  function hireBio(payload: Record<string, unknown>): string {
    return asString(asRecord(payload.persona).bio);
  }
  function hireStrengths(payload: Record<string, unknown>): string[] {
    return asStringArray(asRecord(payload.persona).strengths).slice(0, 2);
  }
  function hireModelSummary(payload: Record<string, unknown>): string {
    const model = asRecord(payload.model);
    const provider = asString(model.provider);
    const modelId = asString(model.model);
    if (provider && modelId) return `${provider} / ${modelId}`;
    return provider || modelId;
  }

  function questionText(payload: Record<string, unknown>): string {
    return asString(payload.question, '(question text missing)');
  }
  function questionOptions(payload: Record<string, unknown>): string[] {
    return asStringArray(payload.options);
  }
  function questionAnswer(payload: Record<string, unknown>): string {
    return asString(payload.answer, '(no answer recorded)');
  }

  async function loadApprovals() {
    loading = true;
    loadError = null;
    try {
      // The tRPC client infers timestamp fields as `Date` (see the
      // `ApprovalRow` comment above); cast through `any` rather than let
      // that stale static type silently disagree with the real payload.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const remote: any[] = await trpc().approvals.list.query({});
      approvals = remote as ApprovalRow[];
    } catch (err) {
      loadError = describeError(err);
    } finally {
      loading = false;
    }
  }

  // Runs once on mount - the call itself is async, so nothing reactive is
  // read synchronously inside this effect and it won't re-run afterwards
  // (see apps/web/src/routes/settings/+page.svelte's identical pattern).
  $effect(() => {
    loadApprovals();
  });

  // Live updates over the shared event socket. `approval.requested` fires
  // when an agent's hire_agent/ask_human tool call creates a new pending row
  // (packages/agents/src/orgTools.ts, companyTools.ts). Nothing currently
  // emits `approval.decided` - apps/server's approvals.decide never appends
  // one - but listening for it too is a harmless no-op fallback if a later
  // phase adds it. Either way a full reload keeps this simple: it refreshes
  // both the pending and decided lists at once, since they're just two
  // client-side filters over the same `approvals` array.
  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (event.type === 'approval.requested' || event.type === 'approval.decided') {
        loadApprovals();
      }
    });
    return unsub;
  });

  function outcomeMessage(
    row: ApprovalRow,
    decision: 'approved' | 'rejected',
    answer?: string,
  ): { text: string; positive: boolean } {
    if (row.kind === 'hire') {
      const name = hireName(row.payload);
      return decision === 'approved'
        ? { text: `Approved — ${name} is now on the team.`, positive: true }
        : { text: `Declined the hire request for ${name}.`, positive: false };
    }
    if (row.kind === 'question') {
      return decision === 'approved'
        ? { text: `Answer sent: "${answer ?? ''}"`, positive: true }
        : { text: 'Declined to answer.', positive: false };
    }
    return decision === 'approved'
      ? { text: 'Approved.', positive: true }
      : { text: 'Rejected.', positive: false };
  }

  async function decide(row: ApprovalRow, decision: 'approved' | 'rejected', answer?: string) {
    decidingIds[row.id] = true;
    actionErrors[row.id] = '';
    try {
      const input =
        answer === undefined ? { id: row.id, decision } : { id: row.id, decision, answer };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated: any = await trpc().approvals.decide.mutate(input);
      if (updated) {
        const decidedRow = updated as ApprovalRow;
        approvals = approvals.map((a) => (a.id === decidedRow.id ? decidedRow : a));
      } else {
        // Already decided elsewhere (or gone) - fall back to a full reload.
        await loadApprovals();
      }
      confirmation = outcomeMessage(row, decision, answer);
      delete draftAnswers[row.id];
    } catch (err) {
      actionErrors[row.id] = describeError(err);
    } finally {
      decidingIds[row.id] = false;
    }
  }

  function submitAnswer(row: ApprovalRow) {
    if (decidingIds[row.id]) return;
    const text = (draftAnswers[row.id] ?? '').trim();
    if (!text) return;
    decide(row, 'approved', text);
  }
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Inbox</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Pending hire approvals and the questions agents raise with ask_human, waiting for you to
      answer before their run continues. Answered and decided items move to the Decided tab.
    </p>
  </div>

  {#if confirmation}
    <div
      class="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
    >
      <span
        class={confirmation.positive ? 'text-[var(--color-success)]' : 'text-[var(--color-text)]'}
      >
        {confirmation.text}
      </span>
      <button
        type="button"
        onclick={() => (confirmation = null)}
        class="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-1">
      <button
        type="button"
        onclick={() => (view = 'pending')}
        aria-current={view === 'pending' ? 'page' : undefined}
        class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {view === 'pending'
          ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]'}"
      >
        Pending{#if pending.length > 0}
          ({pending.length}){/if}
      </button>
      <button
        type="button"
        onclick={() => (view = 'decided')}
        aria-current={view === 'decided' ? 'page' : undefined}
        class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {view === 'decided'
          ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]'}"
      >
        Decided
      </button>
    </div>

    <button
      type="button"
      class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
      onclick={loadApprovals}
      disabled={loading}
    >
      {loading ? 'Loading…' : 'Reload'}
    </button>
  </div>

  {#if loadError}
    <div
      class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
    >
      <p class="font-medium text-[var(--color-danger)]">Couldn't load the inbox</p>
      <p class="text-[var(--color-text-muted)]">{loadError}</p>
      <p class="text-[var(--color-text-muted)]">
        apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong place.
        Try Reload once it's up.
      </p>
    </div>
  {/if}

  {#if loading && approvals.length === 0}
    <p class="text-[var(--color-text-muted)]">Loading…</p>
  {:else if currentList.length === 0 && !loadError}
    <p class="text-[var(--color-text-muted)]">
      {view === 'pending' ? 'Nothing waiting on you.' : 'Nothing decided yet.'}
    </p>
  {:else if currentList.length > 0}
    <div class="flex flex-col gap-4">
      {#each currentList as row (row.id)}
        <article
          class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span
              class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-text-muted)]"
            >
              {kindLabel(row.kind)}
            </span>
            <span class="text-xs text-[var(--color-text-muted)]">{formatTime(row.created_at)}</span>
          </div>

          {#if row.kind === 'hire'}
            <div class="flex flex-col gap-1">
              <h3 class="font-medium">
                {hireName(row.payload)}{#if hireTitle(row.payload)}
                  — {hireTitle(row.payload)}{/if}
              </h3>
              {#if hireBio(row.payload)}
                <p class="text-sm text-[var(--color-text-muted)]">{hireBio(row.payload)}</p>
              {/if}
              {#if hireStrengths(row.payload).length > 0}
                <p class="text-sm text-[var(--color-text-muted)]">
                  Strengths: {hireStrengths(row.payload).join(', ')}
                </p>
              {/if}
              {#if hireModelSummary(row.payload)}
                <p class="text-xs text-[var(--color-text-muted)]">
                  Model: {hireModelSummary(row.payload)}
                </p>
              {/if}
            </div>
          {:else if row.kind === 'question'}
            <div class="flex flex-col gap-1">
              <h3 class="font-medium">{questionText(row.payload)}</h3>
            </div>
          {:else}
            <pre
              class="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-muted)] p-3 text-xs text-[var(--color-text)]">{JSON.stringify(
                row.payload,
                null,
                2,
              )}</pre>
          {/if}

          {#if view === 'pending'}
            {#if row.kind === 'question'}
              {#if questionOptions(row.payload).length > 0}
                <div class="flex flex-wrap gap-2">
                  {#each questionOptions(row.payload) as option (option)}
                    <button
                      type="button"
                      onclick={() => decide(row, 'approved', option)}
                      disabled={decidingIds[row.id]}
                      class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                    >
                      {option}
                    </button>
                  {/each}
                </div>
              {/if}

              <form
                class="flex flex-wrap items-center gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  submitAnswer(row);
                }}
              >
                <input
                  type="text"
                  aria-label="Your answer"
                  value={draftAnswers[row.id] ?? ''}
                  oninput={(e) => {
                    draftAnswers[row.id] = (e.currentTarget as HTMLInputElement).value;
                  }}
                  placeholder="Type your own answer…"
                  disabled={decidingIds[row.id]}
                  class="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
                />
                <button
                  type="submit"
                  disabled={decidingIds[row.id] || !(draftAnswers[row.id] ?? '').trim()}
                  class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
                >
                  Answer
                </button>
              </form>

              <div>
                <button
                  type="button"
                  onclick={() => decide(row, 'rejected')}
                  disabled={decidingIds[row.id]}
                  class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                >
                  Decline to answer
                </button>
              </div>
            {:else}
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  onclick={() => decide(row, 'approved')}
                  disabled={decidingIds[row.id]}
                  class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onclick={() => decide(row, 'rejected')}
                  disabled={decidingIds[row.id]}
                  class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            {/if}

            {#if actionErrors[row.id]}
              <p class="text-sm text-[var(--color-danger)]">{actionErrors[row.id]}</p>
            {/if}
          {:else}
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span
                class="font-medium {row.status === 'approved'
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-text-muted)]'}"
              >
                {#if row.kind === 'question'}{row.status === 'approved'
                    ? 'Answered'
                    : 'Declined'}{:else}{row.status === 'approved' ? 'Approved' : 'Rejected'}{/if}
              </span>
              {#if row.kind === 'question' && row.status === 'approved'}
                <span class="text-[var(--color-text-muted)]">— {questionAnswer(row.payload)}</span>
              {:else if row.kind === 'hire' && row.status === 'approved'}
                <span class="text-[var(--color-text-muted)]"
                  >— {hireName(row.payload)} is now on the team</span
                >
              {/if}
            </div>
            {#if row.decided_at}
              <p class="text-xs text-[var(--color-text-muted)]">
                Decided {formatTime(row.decided_at)}
              </p>
            {/if}
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

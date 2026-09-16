<script lang="ts">
  import { page } from '$app/stores';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents, type KatnorEvent } from '$lib/eventsSocket';

  // Local wire-shape types for apps/server's runs/agents routers.
  //
  // The AppRouter types trpc() gives us are inferred from drizzle's
  // `$inferSelect` (see @katnor/db's repositories/run.ts etc.), which types
  // timestamp columns as `Date`. apps/server's tRPC setup has no
  // superjson-style transformer configured, though, so every row actually
  // crosses the wire as plain JSON - timestamps included - and lands here as
  // ISO strings, not real `Date` objects. Declaring the shapes we actually
  // receive (rather than fighting the mismatch with casts everywhere) keeps
  // the rest of this file honest; see loadRuns/loadAgents/loadRunDetail
  // below for where the `any[]`/`any` boundary lives, the same pattern
  // apps/web/src/routes/settings/+page.svelte uses for the same reason.
  type RunTrigger = 'task' | 'mention' | 'schedule' | 'human';
  type RunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled';
  type RunStepKind = 'llm_call' | 'tool_call' | 'tool_result' | 'message' | 'thinking_summary';

  interface RunRow {
    id: string;
    created_at: string;
    updated_at: string;
    agent_id: string;
    task_id: string | null;
    channel_id: string | null;
    trigger: RunTrigger;
    status: RunStatus;
    started_at: string;
    finished_at: string | null;
    tokens_in: number;
    tokens_out: number;
    cost_usd: string;
    summary: string | null;
  }

  interface RunStepRow {
    id: string;
    created_at: string;
    updated_at: string;
    run_id: string;
    seq: number;
    kind: RunStepKind;
    payload: Record<string, unknown>;
    tokens: number | null;
    duration_ms: number | null;
  }

  interface RunDetail extends RunRow {
    steps: RunStepRow[];
  }

  interface AgentRow {
    id: string;
    name: string;
    title: string;
  }

  const statusLabels: Record<RunStatus, string> = {
    queued: 'Queued',
    running: 'Running',
    waiting_human: 'Waiting on human',
    succeeded: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled'
  };

  // Success/failure get their own color; every other status (including the
  // actively-running one) reads as a neutral, muted "in progress or done
  // without a strong outcome" state per this page's spec.
  const statusStyles: Record<RunStatus, string> = {
    queued: 'text-[var(--color-text-muted)]',
    running: 'text-[var(--color-text-muted)]',
    waiting_human: 'text-[var(--color-text-muted)]',
    succeeded: 'text-[var(--color-success)]',
    failed: 'text-[var(--color-danger)]',
    cancelled: 'text-[var(--color-text-muted)]'
  };

  const triggerLabels: Record<RunTrigger, string> = {
    task: 'Task',
    mention: 'Mention',
    schedule: 'Schedule',
    human: 'Human'
  };

  const kindMeta: Record<RunStepKind, { label: string; icon: string }> = {
    llm_call: { label: 'LLM call', icon: '🧠' },
    tool_call: { label: 'Tool call', icon: '🔧' },
    tool_result: { label: 'Tool result', icon: '↩️' },
    message: { label: 'Message', icon: '💬' },
    thinking_summary: { label: 'Thinking', icon: '💭' }
  };

  // Steps whose payload is a tool invocation/output get a visually distinct
  // (muted-tinted) card so the trace reads clearly top to bottom as "the
  // model said/thought X, called tool Y, got result W, ...".
  function isToolKind(kind: RunStepKind): boolean {
    return kind === 'tool_call' || kind === 'tool_result';
  }

  const RUN_LIFECYCLE_EVENTS = new Set(['run.started', 'run.step_recorded', 'run.finished']);

  let agents = $state<AgentRow[]>([]);
  // '' = "All agents" - initialized from `?agent=<id>` so the office page's
  // "view full trace" link can deep-link straight to one agent's runs.
  let agentFilter = $state($page.url.searchParams.get('agent') ?? '');

  // SvelteKit reuses this component instance for a same-route navigation
  // (e.g. clicking "view trace" for a different agent while already on
  // /runs, or browser back/forward) - the `$state()` initializer above
  // only ever runs once, so without this the filter would silently stay
  // on whichever agent was selected first. Comparing against the last URL
  // value (rather than just re-reading it) is what keeps this from also
  // stomping on a filter the owner picked by hand from the dropdown.
  //
  // Seeded from the URL directly rather than from `agentFilter` - the two are
  // the same string at init (see that `$state()` initializer above), but
  // reading the `$state` here would only ever capture its initial value,
  // which Svelte flags as `state_referenced_locally`.
  let lastUrlAgentFilter = $page.url.searchParams.get('agent') ?? '';
  $effect(() => {
    const urlAgentFilter = $page.url.searchParams.get('agent') ?? '';
    if (urlAgentFilter !== lastUrlAgentFilter) {
      lastUrlAgentFilter = urlAgentFilter;
      agentFilter = urlAgentFilter;
    }
  });

  let runs = $state<RunRow[]>([]);
  let runsLoading = $state(true);
  let runsError = $state<string | null>(null);
  let runsRequestSeq = 0; // guards against an in-flight request's response arriving out of order

  let selectedRunId = $state<string | null>(null);
  let selectedRun = $state<RunDetail | null>(null);
  let traceLoading = $state(false);
  let traceError = $state<string | null>(null);
  let traceRequestSeq = 0;

  const agentsById = $derived(new Map(agents.map((agent) => [agent.id, agent])));
  // Defensive re-sort on top of the server's already-ascending `seq` order
  // (apps/server/src/trpc/routers/runs.ts / @katnor/db's runStep repo) -
  // cheap, and guards this view against ever showing a trace out of order.
  const orderedSteps = $derived(
    selectedRun ? [...selectedRun.steps].sort((a, b) => a.seq - b.seq) : []
  );

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  function agentName(agentId: string): string {
    return agentsById.get(agentId)?.name ?? agentId;
  }

  function formatDateTime(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** "Xs" / "Xm Ys" / "Xh Ym", or null while the run hasn't finished yet. */
  function formatDuration(startedAt: string, finishedAt: string | null): string | null {
    if (!finishedAt) return null;
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(finishedAt).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function formatCost(cost_usd: string): string {
    return `$${Number(cost_usd).toFixed(4)}`;
  }

  // `payload` is a loosely-typed jsonb blob from the server's point of view
  // (it varies by step `kind`) - these three helpers render it defensively
  // rather than assuming any field beyond what apps/server actually writes.
  function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
  }

  function prettyJson(value: unknown): string {
    try {
      return JSON.stringify(value ?? {}, null, 2);
    } catch {
      return String(value);
    }
  }

  async function loadAgents() {
    try {
      const client = trpc();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = await client.agents.list.query();
      agents = rows as AgentRow[];
    } catch (err) {
      // Non-fatal: runs list/trace still work, just showing a raw agent_id
      // in place of a name, and the filter falls back to "All agents" only.
      // No visible banner for this - the runs list's own error already
      // covers "the server isn't reachable" for this page.
      console.error('[runs] failed to load agents:', err);
    }
  }

  async function loadRuns() {
    const filter = agentFilter; // read synchronously (before the first `await` below) so the
    // effect at the bottom of this file re-runs this function on every
    // `agentFilter` change, not just once on mount - same mechanism as
    // settings/+page.svelte's loadProviders() effect, just with one
    // tracked dependency instead of zero.
    const requestId = ++runsRequestSeq;
    runsLoading = true;
    runsError = null;
    try {
      const client = trpc();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = await client.runs.list.query(filter ? { agent_id: filter } : {});
      if (requestId !== runsRequestSeq) return; // a newer request has since started
      runs = rows as RunRow[];
    } catch (err) {
      if (requestId !== runsRequestSeq) return;
      runsError = describeError(err);
    } finally {
      if (requestId === runsRequestSeq) runsLoading = false;
    }
  }

  async function loadRunDetail(id: string) {
    const requestId = ++traceRequestSeq;
    traceLoading = true;
    traceError = null;
    try {
      const client = trpc();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await client.runs.getById.query({ id });
      if (requestId !== traceRequestSeq) return;
      if (!result) {
        selectedRun = null;
        traceError = "This run couldn't be found - it may have been removed.";
        return;
      }
      selectedRun = result as RunDetail;
    } catch (err) {
      if (requestId !== traceRequestSeq) return;
      traceError = describeError(err);
    } finally {
      if (requestId === traceRequestSeq) traceLoading = false;
    }
  }

  function selectRun(id: string) {
    selectedRunId = id;
    loadRunDetail(id);
  }

  function closeTrace() {
    selectedRunId = null;
    selectedRun = null;
    traceError = null;
    traceRequestSeq += 1; // invalidate any in-flight loadRunDetail call so a late response can't reopen the panel
  }

  function handleEvent(event: KatnorEvent) {
    if (!RUN_LIFECYCLE_EVENTS.has(event.type)) return;
    loadRuns();
    const runId = event.payload?.run_id;
    if (selectedRunId && typeof runId === 'string' && runId === selectedRunId) {
      loadRunDetail(selectedRunId);
    }
  }

  // Runs once on mount - nothing reactive is read synchronously in here.
  $effect(() => {
    loadAgents();
  });

  // ─── Cost breakdown (PLAN.md Phase 5) ──────────────────────────────────

  interface CostRow {
    name: string;
    totalUsd: number;
    budgetUsd?: number;
  }
  interface CostBreakdown {
    budgets: { company_daily_usd: number; project_daily_usd?: number; agent_daily_usd?: number };
    byAgent: CostRow[];
    byProject: CostRow[];
  }

  let costs = $state<CostBreakdown | null>(null);
  let costsOpen = $state(false);
  let costsLoading = $state(false);

  async function loadCosts() {
    costsLoading = true;
    try {
      costs = (await trpc().runs.costBreakdown.query()) as unknown as CostBreakdown;
    } catch (err) {
      console.error('[runs] failed to load cost breakdown:', err);
    } finally {
      costsLoading = false;
    }
  }

  function toggleCosts() {
    costsOpen = !costsOpen;
    if (costsOpen && !costs) loadCosts();
  }

  $effect(() => {
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === 'run.finished' && costsOpen) loadCosts();
    });
    return unsubscribe;
  });

  function costBarWidth(row: CostRow): number {
    if (!row.budgetUsd || row.budgetUsd <= 0) return Math.min(100, (row.totalUsd / Math.max(0.01, costs?.budgets.company_daily_usd ?? 1)) * 100);
    return Math.min(100, (row.totalUsd / row.budgetUsd) * 100);
  }

  function costBarColor(row: CostRow): string {
    if (row.budgetUsd && row.budgetUsd > 0 && row.totalUsd >= row.budgetUsd) return 'var(--color-danger)';
    return 'var(--color-accent)';
  }

  // Runs once on mount, then again every time `agentFilter` changes (see
  // the comment inside loadRuns()).
  $effect(() => {
    loadRuns();
  });

  // One persistent subscription for the life of this page. `handleEvent`
  // reads `selectedRunId` fresh each time it fires rather than closing over
  // a stale value, so this effect doesn't need to (and shouldn't)
  // re-subscribe when the selection changes.
  $effect(() => {
    const unsubscribe = subscribeToEvents(handleEvent);
    return unsubscribe;
  });
</script>

{#snippet stepPayload(step: RunStepRow)}
  {@const payload = asRecord(step.payload)}
  {#if step.kind === 'llm_call'}
    {@const usage = asRecord(payload.usage)}
    <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
      <span>model: <span class="text-[var(--color-text)]">{asString(payload.model, 'unknown')}</span></span>
      {#if payload.served_by}
        {@const servedBy = asRecord(payload.served_by)}
        <span>served by: <span class="text-[var(--color-text)]">{asString(servedBy.provider, '?')}/{asString(servedBy.model, '?')}</span></span>
      {/if}
      <span>stop: <span class="text-[var(--color-text)]">{asString(payload.stop_reason, 'unknown')}</span></span>
      {#if usage.inputTokens != null || usage.outputTokens != null}
        <span>usage: <span class="text-[var(--color-text)]">{Number(usage.inputTokens ?? 0)} in / {Number(usage.outputTokens ?? 0)} out</span></span>
      {/if}
      {#if usage.cacheReadTokens}
        <span>cache read: <span class="text-[var(--color-text)]">{Number(usage.cacheReadTokens)}</span></span>
      {/if}
      {#if usage.cacheCreationTokens}
        <span>cache write: <span class="text-[var(--color-text)]">{Number(usage.cacheCreationTokens)}</span></span>
      {/if}
    </div>
    {#if payload.refusal_category}
      <p class="text-xs font-medium text-[var(--color-danger)]">
        Refused: {asString(payload.refusal_category)}
      </p>
    {/if}
  {:else if step.kind === 'tool_call'}
    <p class="text-sm font-medium">{asString(payload.name, 'unknown tool')}</p>
    <pre
      class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg)] p-2 text-xs">{prettyJson(
        payload.input
      )}</pre>
  {:else if step.kind === 'tool_result'}
    <div class="flex items-center gap-2">
      <p class="text-sm font-medium">{asString(payload.name, 'unknown tool')}</p>
      {#if payload.is_error}
        <span class="text-xs font-medium text-[var(--color-danger)]">error</span>
      {/if}
    </div>
    <pre
      class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg)] p-2 text-xs {payload.is_error
        ? 'text-[var(--color-danger)]'
        : ''}">{asString(payload.content)}</pre>
  {:else if step.kind === 'message' || step.kind === 'thinking_summary'}
    <p class="whitespace-pre-wrap text-sm">{asString(payload.text)}</p>
  {:else}
    <pre
      class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg)] p-2 text-xs">{prettyJson(
        payload
      )}</pre>
  {/if}
{/snippet}

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Runs</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Every agent run - each LLM call and tool call with its tokens and cost.
    </p>
  </div>

  <section class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
    <button type="button" class="flex items-center justify-between gap-3 text-left" onclick={toggleCosts}>
      <span class="text-lg font-semibold">Today's spend</span>
      <span class="text-sm text-[var(--color-text-muted)]">{costsOpen ? 'Hide' : 'Show'}</span>
    </button>

    {#if costsOpen}
      {#if costsLoading && !costs}
        <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
      {:else if costs}
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-[var(--color-text-muted)]">By agent</h3>
            {#if costs.byAgent.length === 0}
              <p class="text-xs text-[var(--color-text-muted)]">No spend yet today.</p>
            {/if}
            {#each costs.byAgent as row (row.name)}
              <div class="flex flex-col gap-0.5">
                <div class="flex justify-between text-xs">
                  <span>{row.name}</span>
                  <span class="text-[var(--color-text-muted)]">
                    ${row.totalUsd.toFixed(2)}{row.budgetUsd ? ` / $${row.budgetUsd.toFixed(2)}` : ''}
                  </span>
                </div>
                <div class="h-1.5 w-full rounded-full bg-[var(--color-surface-muted)]">
                  <div
                    class="h-1.5 rounded-full"
                    style={`width:${costBarWidth(row)}%;background:${costBarColor(row)}`}
                  ></div>
                </div>
              </div>
            {/each}
          </div>

          <div class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-[var(--color-text-muted)]">By project</h3>
            {#if costs.byProject.length === 0}
              <p class="text-xs text-[var(--color-text-muted)]">No project-scoped spend yet today.</p>
            {/if}
            {#each costs.byProject as row (row.name)}
              {@const budgetUsd = costs.budgets.project_daily_usd}
              <div class="flex flex-col gap-0.5">
                <div class="flex justify-between text-xs">
                  <span>{row.name}</span>
                  <span class="text-[var(--color-text-muted)]">
                    ${row.totalUsd.toFixed(2)}{budgetUsd ? ` / $${budgetUsd.toFixed(2)}` : ''}
                  </span>
                </div>
                <div class="h-1.5 w-full rounded-full bg-[var(--color-surface-muted)]">
                  <div
                    class="h-1.5 rounded-full"
                    style={`width:${costBarWidth({ ...row, budgetUsd })}%;background:${costBarColor({ ...row, budgetUsd })}`}
                  ></div>
                </div>
              </div>
            {/each}
          </div>
        </div>
        <p class="text-xs text-[var(--color-text-muted)]">
          Company-wide budget: ${costs.budgets.company_daily_usd.toFixed(2)}/day - configurable in Settings.
        </p>
      {/if}
    {/if}
  </section>

  <div class="flex flex-col gap-4 lg:flex-row lg:items-start">
    <!-- Run list -->
    <section
      class={selectedRunId
        ? 'hidden flex-col gap-3 lg:flex lg:w-[420px] lg:shrink-0'
        : 'flex w-full flex-col gap-3 lg:w-[420px] lg:shrink-0'}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold">All runs</h2>
        <button
          type="button"
          class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
          onclick={loadRuns}
          disabled={runsLoading}
        >
          {runsLoading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Filter by agent</span>
        <select
          bind:value={agentFilter}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        >
          <option value="">All agents</option>
          {#each agents as agent (agent.id)}
            <option value={agent.id}>{agent.name}</option>
          {/each}
        </select>
      </label>

      {#if runsError && runs.length === 0}
        <div
          class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
        >
          <p class="font-medium text-[var(--color-danger)]">Couldn't load runs</p>
          <p class="text-[var(--color-text-muted)]">{runsError}</p>
          <p class="text-[var(--color-text-muted)]">
            apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong
            place. This will try again on Reload.
          </p>
        </div>
      {:else if runsLoading && runs.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">Loading runs…</p>
      {:else if runs.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No runs yet.</p>
      {:else}
        {#if runsError}
          <p class="text-xs text-[var(--color-danger)]">Couldn't refresh the list: {runsError}</p>
        {/if}
        <div class="flex flex-col gap-2">
          {#each runs as r (r.id)}
            {@const duration = formatDuration(r.started_at, r.finished_at)}
            {@const isSelected = r.id === selectedRunId}
            <button
              type="button"
              onclick={() => selectRun(r.id)}
              class="flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors {isSelected
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-muted)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]'}"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate font-medium">{agentName(r.agent_id)}</span>
                <span class="flex shrink-0 items-center gap-1.5 text-xs font-medium {statusStyles[r.status]}">
                  <span aria-hidden="true">●</span>
                  {statusLabels[r.status] ?? r.status}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
                <span>{triggerLabels[r.trigger] ?? r.trigger}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDateTime(r.started_at)}</span>
                {#if duration}
                  <span aria-hidden="true">·</span>
                  <span>{duration}</span>
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
                <span>{r.tokens_in.toLocaleString()} in / {r.tokens_out.toLocaleString()} out tokens</span>
                <span>{formatCost(r.cost_usd)}</span>
              </div>
              {#if r.summary}
                <p class="truncate text-sm text-[var(--color-text-muted)]" title={r.summary}>{r.summary}</p>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Trace panel -->
    <section class="flex min-w-0 flex-1 flex-col gap-3">
      {#if selectedRunId}
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-surface-muted)] lg:hidden"
            onclick={closeTrace}
          >
            ← Back to runs
          </button>
          <h2 class="truncate text-lg font-semibold">
            {selectedRun ? agentName(selectedRun.agent_id) : 'Run'} trace
          </h2>
          {#if selectedRun}
            <span class="text-xs font-medium {statusStyles[selectedRun.status]}">
              {statusLabels[selectedRun.status] ?? selectedRun.status}
            </span>
          {/if}
          <button
            type="button"
            class="ml-auto hidden rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)] lg:inline-flex"
            onclick={closeTrace}
          >
            Close
          </button>
        </div>

        {#if selectedRun}
          {@const duration = formatDuration(selectedRun.started_at, selectedRun.finished_at)}
          <div
            class="grid grid-cols-2 gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)] sm:grid-cols-4"
          >
            <div class="flex flex-col gap-0.5">
              <span class="text-[var(--color-text)]">{formatDateTime(selectedRun.started_at)}</span>
              <span>Started</span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[var(--color-text)]">{duration ?? '—'}</span>
              <span>Duration</span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[var(--color-text)]">{selectedRun.tokens_in.toLocaleString()} / {selectedRun.tokens_out.toLocaleString()}</span>
              <span>Tokens in / out</span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[var(--color-text)]">{formatCost(selectedRun.cost_usd)}</span>
              <span>Cost</span>
            </div>
          </div>

          {#if selectedRun.summary}
            <p class="text-sm text-[var(--color-text-muted)]">{selectedRun.summary}</p>
          {/if}

          {#if traceError}
            <p class="text-xs text-[var(--color-danger)]">Couldn't refresh this trace: {traceError}</p>
          {/if}

          {#if orderedSteps.length === 0}
            <p class="text-sm text-[var(--color-text-muted)]">No steps recorded yet.</p>
          {:else}
            <ol class="flex flex-col gap-2">
              {#each orderedSteps as step (step.id)}
                {@const meta = kindMeta[step.kind] ?? { label: step.kind, icon: '•' }}
                <li
                  class="flex gap-3 rounded-lg border border-[var(--color-border)] p-3 {isToolKind(step.kind)
                    ? 'bg-[var(--color-surface-muted)]'
                    : 'bg-[var(--color-surface)]'}"
                >
                  <span class="w-6 shrink-0 text-right text-xs text-[var(--color-text-muted)]">{step.seq}</span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                      >
                        <span aria-hidden="true">{meta.icon}</span>
                        {meta.label}
                      </span>
                      {#if step.tokens != null}
                        <span class="text-[10px] text-[var(--color-text-muted)]">{step.tokens.toLocaleString()} tok</span>
                      {/if}
                      {#if step.duration_ms != null}
                        <span class="text-[10px] text-[var(--color-text-muted)]">{step.duration_ms.toLocaleString()} ms</span>
                      {/if}
                    </div>
                    {@render stepPayload(step)}
                  </div>
                </li>
              {/each}
            </ol>
          {/if}
        {:else if traceLoading}
          <p class="text-sm text-[var(--color-text-muted)]">Loading trace…</p>
        {:else if traceError}
          <div
            class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
          >
            <p class="font-medium text-[var(--color-danger)]">Couldn't load this run's trace</p>
            <p class="text-[var(--color-text-muted)]">{traceError}</p>
            <div>
              <button
                type="button"
                class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
                onclick={() => selectedRunId && loadRunDetail(selectedRunId)}
              >
                Try again
              </button>
            </div>
          </div>
        {/if}
      {:else}
        <div
          class="hidden min-h-[240px] items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)] lg:flex"
        >
          Select a run to see its trace.
        </div>
      {/if}
    </section>
  </div>
</div>

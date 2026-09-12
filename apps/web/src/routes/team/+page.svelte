<script lang="ts">
  import {
    AGENT_STATUSES,
    MODEL_EFFORTS,
    MODEL_PROVIDERS,
    THINKING_DISPLAY_MODES,
    type AgentPersona,
    type AgentStatus,
    type ModelConfig,
    type ModelEffort,
    type ModelProvider,
    type ThinkingDisplayMode
  } from '@katnor/core';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { liveStatusStore, type LiveAgentState } from '$lib/office/liveStatus.svelte';

  // ---- Wire shapes --------------------------------------------------------
  // @katnor/core types `created_at`/`updated_at` as `Date` (see
  // schemas/base.ts) because that's what they are in-process on
  // apps/server. But the tRPC router has no superjson/data transformer
  // configured, so everything actually crosses the wire as plain JSON -
  // timestamps included - and lands here as ISO strings. These local types
  // describe what actually arrives in the browser; query results are cast
  // to them below rather than trusted as whatever `AppRouter` infers.
  type AgentRow = {
    id: string;
    created_at: string;
    updated_at: string;
    name: string;
    title: string;
    persona: AgentPersona;
    system_prompt: string;
    avatar: string;
    reports_to: string | null;
    team_id: string | null;
    model_config: ModelConfig;
    tool_allowlist: string[];
    status: AgentStatus;
    budget_daily_usd: string; // numeric column - Number(...) it to do math
    is_system: boolean;
  };

  type TeamRow = {
    id: string;
    created_at: string;
    updated_at: string;
    name: string;
    lead_agent_id: string | null;
  };

  // ---- Shared style bits ---------------------------------------------------
  // Plain string constants rather than an `.input`/`.btn` class added to
  // app.css - this page has a lot of form fields, so these just keep every
  // one of them on the exact same utility classes settings/+page.svelte
  // uses without retyping the whole string at each call site.
  const inputClass =
    'rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]';
  const labelClass = 'flex flex-col gap-1 text-sm';
  const primaryButtonClass =
    'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50';
  const secondaryButtonClass =
    'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50';
  const dangerButtonClass =
    'rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50';

  const providerLabels: Record<ModelProvider, string> = {
    anthropic: 'Anthropic',
    openai_compatible: 'OpenAI-compatible',
    google: 'Google',
    ollama: 'Ollama (local)'
  };

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  // Shared by the strengths/tools free-text inputs: comma, newline, or
  // plain-whitespace separated, trimmed, empty entries dropped.
  function splitList(raw: string): string[] {
    return raw
      .split(/[,\n]+/)
      .flatMap((chunk) => chunk.split(/\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function formatBudget(value: string): string {
    return `$${Number(value).toFixed(2)}/day`;
  }

  function statusBadgeClasses(status: AgentStatus): string {
    if (status === 'active') return 'border-[var(--color-success)] text-[var(--color-success)]';
    if (status === 'offline') return 'border-[var(--color-border)] text-[var(--color-text-muted)]';
    return 'border-[var(--color-border)] text-[var(--color-text)]'; // paused
  }

  const cardBaseClass = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';

  function cardClasses(status: AgentStatus): string {
    // Offline agents stay in the list (firing never deletes anyone) but
    // read as visibly de-emphasized rather than looking just like an
    // active teammate.
    return status === 'offline' ? `${cardBaseClass} opacity-60` : cardBaseClass;
  }

  // ---- Data + live updates -------------------------------------------------
  let agents = $state<AgentRow[]>([]);
  let teams = $state<TeamRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let agentById = $derived(new Map(agents.map((a) => [a.id, a])));
  let teamById = $derived(new Map(teams.map((t) => [t.id, t])));
  let ceo = $derived(agents.find((a) => a.is_system));

  function agentName(id: string | null): string {
    if (!id) return 'No one';
    return agentById.get(id)?.name ?? 'Unknown agent';
  }

  function teamName(id: string | null): string {
    if (!id) return 'No team';
    return teamById.get(id)?.name ?? 'Unknown team';
  }

  // Everyone but the CEO, grouped by team (teamless last), each group
  // sorted by name - a flat, grouped list rather than a tree diagram.
  let groupedByTeam = $derived.by(() => {
    const groups = new Map<string | null, AgentRow[]>();
    for (const agent of agents) {
      if (agent.is_system) continue;
      const key = agent.team_id;
      const list = groups.get(key);
      if (list) list.push(agent);
      else groups.set(key, [agent]);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return teamName(a).localeCompare(teamName(b));
    });
    return keys.map((teamId) => ({
      teamId,
      agents: groups.get(teamId)!.slice().sort((a, b) => a.name.localeCompare(b.name))
    }));
  });

  async function refresh(initial = false) {
    if (initial) {
      loading = true;
      loadError = null;
    }
    try {
      const client = trpc();
      const [agentRows, teamRows] = await Promise.all([client.agents.list.query(), client.teams.list.query()]);
      agents = agentRows as unknown as AgentRow[];
      teams = teamRows as unknown as TeamRow[];
      for (const agent of agents) liveStatusStore.seedFromAgentStatus(agent.id, agent.status);
    } catch (err) {
      // A background refresh (triggered by a live event, or right after a
      // mutation) failing quietly isn't worth surfacing - the initial load
      // already proved the server was reachable, and the next successful
      // refresh (or the next live event) catches the page back up.
      if (initial) loadError = describeError(err);
    } finally {
      if (initial) loading = false;
    }
  }

  // Runs once on mount: the call itself is async, so nothing reactive is
  // read synchronously inside this effect and it won't re-run afterwards.
  $effect(() => {
    refresh(true);
  });

  $effect(() => {
    const unsubscribe = subscribeToEvents((event) => {
      if (['agent.hired', 'agent.updated', 'agent.fired', 'team.created'].includes(event.type)) {
        refresh();
      }
    });
    return unsubscribe;
  });

  // PLAN.md 4.8's accessibility fallback: "the Team page shows the same
  // live status list" as the Office - same shared store, so the two never
  // disagree about what an agent is currently doing.
  $effect(() => {
    liveStatusStore.start();
    return () => liveStatusStore.stop();
  });

  const liveStateLabels: Record<LiveAgentState, string> = {
    idle: 'Idle',
    working: 'Working',
    talking: 'Talking',
    waiting_human: 'Waiting on you',
    blocked: 'Blocked',
    offline: 'Offline'
  };

  const liveStateDotClasses: Record<LiveAgentState, string> = {
    idle: 'bg-[var(--color-text-muted)]',
    working: 'bg-[var(--color-accent)]',
    talking: 'bg-[var(--color-accent)]',
    waiting_human: 'bg-[var(--color-danger)]',
    blocked: 'bg-[var(--color-danger)]',
    offline: 'bg-[var(--color-text-muted)]'
  };

  function liveState(agent: AgentRow): LiveAgentState {
    return agent.status !== 'active' ? 'offline' : liveStatusStore.get(agent.id).state;
  }

  // ---- Fire -----------------------------------------------------------------
  type RowUi = { firing: boolean; fireError: string | null };
  let rowUi = $state<Record<string, RowUi>>({});

  function getRowUi(id: string): RowUi {
    return rowUi[id] ?? { firing: false, fireError: null };
  }

  function setRowUi(id: string, patch: RowUi) {
    // Reassign the whole object (rather than `rowUi[id] = patch`) so this is
    // unambiguously reactive even for an id that has never been read yet.
    rowUi = { ...rowUi, [id]: patch };
  }

  async function fireAgent(agent: AgentRow) {
    const ok = confirm(`Fire ${agent.name}? This sets them offline - their history is kept.`);
    if (!ok) return;
    setRowUi(agent.id, { firing: true, fireError: null });
    try {
      await trpc().agents.fire.mutate({ id: agent.id });
      await refresh();
      setRowUi(agent.id, { firing: false, fireError: null });
    } catch (err) {
      setRowUi(agent.id, { firing: false, fireError: describeError(err) });
    }
  }

  // ---- Edit -------------------------------------------------------------
  type EditDraft = {
    agentId: string;
    title: string;
    bio: string;
    personality: string;
    strengths: string;
    style: string;
    system_prompt: string;
    provider: ModelProvider;
    model: string;
    effort: ModelEffort;
    thinking_display: ThinkingDisplayMode;
    max_tokens: number;
    tools: string;
    budget_daily_usd: number;
    status: AgentStatus;
  };

  let editDraft = $state<EditDraft | null>(null);
  let editSaving = $state(false);
  let editError = $state<string | null>(null);
  let editSaved = $state(false);

  function toggleEdit(agent: AgentRow) {
    if (editDraft && editDraft.agentId === agent.id) {
      editDraft = null;
      return;
    }
    editError = null;
    editSaved = false;
    editDraft = {
      agentId: agent.id,
      title: agent.title,
      bio: agent.persona.bio,
      personality: agent.persona.personality,
      strengths: agent.persona.strengths.join(', '),
      style: agent.persona.style,
      system_prompt: agent.system_prompt,
      provider: agent.model_config.provider,
      model: agent.model_config.model,
      effort: agent.model_config.effort,
      thinking_display: agent.model_config.thinking_display,
      max_tokens: agent.model_config.max_tokens,
      tools: agent.tool_allowlist.join(', '),
      budget_daily_usd: Number(agent.budget_daily_usd),
      status: agent.status
    };
  }

  async function saveEdit() {
    if (!editDraft) return;
    const draft = editDraft;
    const original = agentById.get(draft.agentId);
    editSaving = true;
    editError = null;
    editSaved = false;
    try {
      await trpc().agents.update.mutate({
        id: draft.agentId,
        title: draft.title.trim(),
        persona: {
          bio: draft.bio,
          personality: draft.personality,
          strengths: splitList(draft.strengths),
          style: draft.style
        },
        system_prompt: draft.system_prompt,
        model: {
          provider: draft.provider,
          model: draft.model.trim(),
          effort: draft.effort,
          thinking_display: draft.thinking_display,
          max_tokens: draft.max_tokens,
          // Temperature isn't exposed in this form - carry the existing
          // value through so saving doesn't silently clear a custom one.
          temperature: original?.model_config.temperature
        },
        tools: splitList(draft.tools),
        budget_daily_usd: draft.budget_daily_usd,
        // Never offered for the CEO (see the template), so never sent for
        // the CEO either - keeps their status untouched from this form.
        ...(original?.is_system ? {} : { status: draft.status })
      });
      editSaved = true;
      await refresh();
    } catch (err) {
      editError = describeError(err);
    } finally {
      editSaving = false;
    }
  }

  // ---- Hire manually ------------------------------------------------------
  type HireDraft = {
    name: string;
    title: string;
    bio: string;
    personality: string;
    strengths: string;
    style: string;
    system_prompt: string;
    avatar: string;
    provider: ModelProvider;
    model: string;
    effort: ModelEffort;
    max_tokens: number;
    tools: string;
    reports_to: string;
    team_id: string;
  };

  function emptyHireDraft(): HireDraft {
    return {
      name: '',
      title: '',
      bio: '',
      personality: '',
      strengths: '',
      style: '',
      system_prompt: '',
      avatar: '',
      provider: 'anthropic',
      model: '',
      effort: 'medium',
      max_tokens: 4096,
      tools: '',
      reports_to: '',
      team_id: ''
    };
  }

  let hireOpen = $state(false);
  let hireDraft = $state<HireDraft>(emptyHireDraft());
  let hireSaving = $state(false);
  let hireError = $state<string | null>(null);
  let hireSuccess = $state<string | null>(null);

  async function submitHire() {
    hireSaving = true;
    hireError = null;
    hireSuccess = null;
    try {
      const name = hireDraft.name.trim();
      const avatar = hireDraft.avatar.trim();
      await trpc().agents.hire.mutate({
        name,
        title: hireDraft.title.trim(),
        persona: {
          bio: hireDraft.bio,
          personality: hireDraft.personality,
          strengths: splitList(hireDraft.strengths),
          style: hireDraft.style
        },
        system_prompt: hireDraft.system_prompt,
        // Left blank, this is omitted entirely so the server applies its
        // own default rather than getting an explicit empty string.
        ...(avatar === '' ? {} : { avatar }),
        model: {
          provider: hireDraft.provider,
          model: hireDraft.model.trim(),
          effort: hireDraft.effort,
          // Kept off this form to keep it shorter - 'summarized' is a
          // reasonable default thinking-display mode for a fresh hire.
          thinking_display: 'summarized',
          max_tokens: hireDraft.max_tokens
        },
        tools: splitList(hireDraft.tools),
        reports_to: hireDraft.reports_to === '' ? null : hireDraft.reports_to,
        team_id: hireDraft.team_id === '' ? null : hireDraft.team_id
      });
      hireSuccess = `Hired ${name}.`;
      hireDraft = emptyHireDraft();
      await refresh();
    } catch (err) {
      hireError = describeError(err);
    } finally {
      hireSaving = false;
    }
  }

  // ---- Teams ----------------------------------------------------------------
  let teamDraftName = $state('');
  let teamDraftLead = $state('');
  let teamSaving = $state(false);
  let teamError = $state<string | null>(null);
  let teamSaved = $state(false);

  async function submitTeam() {
    teamSaving = true;
    teamError = null;
    teamSaved = false;
    try {
      await trpc().teams.create.mutate({
        name: teamDraftName.trim(),
        lead_agent_id: teamDraftLead === '' ? null : teamDraftLead
      });
      teamDraftName = '';
      teamDraftLead = '';
      teamSaved = true;
      await refresh();
    } catch (err) {
      teamError = describeError(err);
    } finally {
      teamSaving = false;
    }
  }
</script>

{#snippet agentCard(agent: AgentRow)}
  {@const ui = getRowUi(agent.id)}
  <div class={cardClasses(agent.status)}>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-medium">{agent.name}</h3>
          {#if agent.is_system}
            <span
              class="rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
            >
              CEO
            </span>
          {/if}
          <span
            class="rounded-full border px-2 py-0.5 text-xs font-medium capitalize {statusBadgeClasses(agent.status)}"
          >
            {agent.status}
          </span>
          {#if agent.status === 'active'}
            {@const state = liveState(agent)}
            {@const detail = liveStatusStore.get(agent.id).detail}
            <span class="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs">
              <span class="h-1.5 w-1.5 rounded-full {liveStateDotClasses[state]}"></span>
              {liveStateLabels[state]}{detail ? ` - ${detail}` : ''}
            </span>
          {/if}
        </div>
        <p class="text-sm text-[var(--color-text-muted)]">{agent.title}</p>
        {#if !agent.is_system}
          <p class="text-xs text-[var(--color-text-muted)]">Reports to {agentName(agent.reports_to)}</p>
        {/if}
        <p class="text-xs text-[var(--color-text-muted)]">
          {providerLabels[agent.model_config.provider]} · {agent.model_config.model}
        </p>
        <p class="text-xs text-[var(--color-text-muted)]">{formatBudget(agent.budget_daily_usd)}</p>
      </div>

      <div class="flex shrink-0 flex-wrap gap-2">
        <button type="button" class={secondaryButtonClass} onclick={() => toggleEdit(agent)}>
          {editDraft?.agentId === agent.id ? 'Close' : 'Edit'}
        </button>
        {#if !agent.is_system}
          <button type="button" class={dangerButtonClass} onclick={() => fireAgent(agent)} disabled={ui.firing}>
            {ui.firing ? 'Firing…' : 'Fire'}
          </button>
        {/if}
      </div>
    </div>

    {#if !agent.is_system && ui.fireError}
      <p class="text-sm text-[var(--color-danger)]">{ui.fireError}</p>
    {/if}

    {#if editDraft && editDraft.agentId === agent.id}
      {@const draft = editDraft}
      <form
        class="flex flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
        onsubmit={(event) => {
          event.preventDefault();
          saveEdit();
        }}
      >
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Title</span>
            <input type="text" required bind:value={draft.title} class={inputClass} />
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Style</span>
            <input type="text" bind:value={draft.style} class={inputClass} />
          </label>
        </div>

        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Bio</span>
          <textarea rows="2" bind:value={draft.bio} class={inputClass}></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Personality</span>
          <textarea rows="2" bind:value={draft.personality} class={inputClass}></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Strengths (comma or newline separated)</span>
          <textarea rows="2" bind:value={draft.strengths} class={inputClass}></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">System prompt</span>
          <textarea rows="4" bind:value={draft.system_prompt} class="{inputClass} font-mono text-xs"></textarea>
        </label>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Provider</span>
            <select bind:value={draft.provider} class={inputClass}>
              {#each MODEL_PROVIDERS as p (p)}
                <option value={p}>{providerLabels[p]}</option>
              {/each}
            </select>
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Model</span>
            <input type="text" required bind:value={draft.model} class={inputClass} />
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Effort</span>
            <select bind:value={draft.effort} class={inputClass}>
              {#each MODEL_EFFORTS as e (e)}
                <option value={e}>{e}</option>
              {/each}
            </select>
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Thinking display</span>
            <select bind:value={draft.thinking_display} class={inputClass}>
              {#each THINKING_DISPLAY_MODES as t (t)}
                <option value={t}>{t}</option>
              {/each}
            </select>
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Max tokens</span>
            <input type="number" min="1" step="1" bind:value={draft.max_tokens} class={inputClass} />
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Daily budget (USD)</span>
            <input type="number" min="0" step="0.01" bind:value={draft.budget_daily_usd} class={inputClass} />
          </label>
        </div>

        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Tools (comma-separated)</span>
          <input type="text" bind:value={draft.tools} class={inputClass} />
        </label>

        {#if !agent.is_system}
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Status</span>
            <select bind:value={draft.status} class={inputClass}>
              {#each AGENT_STATUSES as s (s)}
                <option value={s}>{s}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if editError}
          <p class="text-sm text-[var(--color-danger)]">{editError}</p>
        {:else if editSaved}
          <p class="text-sm text-[var(--color-success)]">Saved.</p>
        {/if}

        <div class="flex gap-2">
          <button type="submit" class={primaryButtonClass} disabled={editSaving}>
            {editSaving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" class={secondaryButtonClass} onclick={() => (editDraft = null)}>Cancel</button>
        </div>
      </form>
    {/if}
  </div>
{/snippet}

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Team</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Everyone you've hired, who they report to, and which team they're on. Click an agent to edit their persona,
      model, tools, and budget, or fire them. Hire new agents and create teams below.
    </p>
  </div>

  {#if loadError}
    <div class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm">
      <p class="font-medium text-[var(--color-danger)]">Couldn't load the team</p>
      <p class="text-[var(--color-text-muted)]">{loadError}</p>
      <p class="text-[var(--color-text-muted)]">
        apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong place. This will catch
        up automatically once it's reachable, or press Reload below.
      </p>
    </div>
  {/if}

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Org chart</h2>
      <button type="button" class={secondaryButtonClass} onclick={() => refresh(true)} disabled={loading}>
        {loading ? 'Loading…' : 'Reload'}
      </button>
    </div>

    {#if loading}
      <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
    {:else if loadError}
      <p class="text-sm text-[var(--color-text-muted)]">Couldn't load agents - see the error above.</p>
    {:else if agents.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">No agents hired yet.</p>
    {:else}
      <div class="flex flex-col gap-4">
        {#if ceo}
          {@render agentCard(ceo)}
        {/if}

        {#each groupedByTeam as group (group.teamId)}
          <div class="flex flex-col gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              {teamName(group.teamId)}
            </h3>
            <div class="flex flex-col gap-3">
              {#each group.agents as agent (agent.id)}
                {@render agentCard(agent)}
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
    <button type="button" class="flex items-center justify-between gap-3 text-left" onclick={() => (hireOpen = !hireOpen)}>
      <span class="text-lg font-semibold">Hire manually</span>
      <span class="text-sm text-[var(--color-text-muted)]">{hireOpen ? 'Hide' : 'Show'}</span>
    </button>

    {#if hireOpen}
      <form
        class="flex flex-col gap-4"
        onsubmit={(event) => {
          event.preventDefault();
          submitHire();
        }}
      >
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Name</span>
            <input type="text" required bind:value={hireDraft.name} class={inputClass} />
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Title</span>
            <input type="text" required bind:value={hireDraft.title} class={inputClass} />
          </label>
        </div>

        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Bio</span>
          <textarea rows="2" bind:value={hireDraft.bio} class={inputClass}></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Personality</span>
          <textarea rows="2" bind:value={hireDraft.personality} class={inputClass}></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Strengths (comma or newline separated)</span>
          <textarea
            rows="2"
            placeholder="e.g. writing, research, communication"
            bind:value={hireDraft.strengths}
            class={inputClass}
          ></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Style</span>
          <input type="text" bind:value={hireDraft.style} class={inputClass} />
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">System prompt</span>
          <textarea rows="4" bind:value={hireDraft.system_prompt} class="{inputClass} font-mono text-xs"></textarea>
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Avatar (optional)</span>
          <input type="text" bind:value={hireDraft.avatar} class={inputClass} />
        </label>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Provider</span>
            <select bind:value={hireDraft.provider} class={inputClass}>
              {#each MODEL_PROVIDERS as p (p)}
                <option value={p}>{providerLabels[p]}</option>
              {/each}
            </select>
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Model</span>
            <input type="text" required placeholder="e.g. claude-sonnet-4-5" bind:value={hireDraft.model} class={inputClass} />
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Effort</span>
            <select bind:value={hireDraft.effort} class={inputClass}>
              {#each MODEL_EFFORTS as e (e)}
                <option value={e}>{e}</option>
              {/each}
            </select>
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Max tokens</span>
            <input type="number" min="1" step="1" required bind:value={hireDraft.max_tokens} class={inputClass} />
          </label>
        </div>

        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Tools (comma-separated, optional)</span>
          <input type="text" bind:value={hireDraft.tools} class={inputClass} />
        </label>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Reports to</span>
            <select bind:value={hireDraft.reports_to} class={inputClass}>
              <option value="">None</option>
              {#each agents as a (a.id)}
                <option value={a.id}>{a.name} — {a.title}</option>
              {/each}
            </select>
          </label>
          <label class={labelClass}>
            <span class="text-[var(--color-text-muted)]">Team</span>
            <select bind:value={hireDraft.team_id} class={inputClass}>
              <option value="">None</option>
              {#each teams as t (t.id)}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if hireError}
          <p class="text-sm text-[var(--color-danger)]">{hireError}</p>
        {:else if hireSuccess}
          <p class="text-sm text-[var(--color-success)]">{hireSuccess}</p>
        {/if}

        <div>
          <button type="submit" class={primaryButtonClass} disabled={hireSaving}>
            {hireSaving ? 'Hiring…' : 'Hire'}
          </button>
        </div>
      </form>
    {/if}
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-lg font-semibold">Teams</h2>

    <div class="flex flex-col gap-2">
      {#if teams.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No teams yet.</p>
      {/if}
      {#each teams as t (t.id)}
        <div
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <span class="font-medium">{t.name}</span>
          <span class="text-sm text-[var(--color-text-muted)]">Lead: {agentName(t.lead_agent_id)}</span>
        </div>
      {/each}
    </div>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={(event) => {
        event.preventDefault();
        submitTeam();
      }}
    >
      <h3 class="font-medium">Create team</h3>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Name</span>
          <input type="text" required bind:value={teamDraftName} class={inputClass} />
        </label>
        <label class={labelClass}>
          <span class="text-[var(--color-text-muted)]">Lead (optional)</span>
          <select bind:value={teamDraftLead} class={inputClass}>
            <option value="">None</option>
            {#each agents as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
        </label>
      </div>
      {#if teamError}
        <p class="text-sm text-[var(--color-danger)]">{teamError}</p>
      {:else if teamSaved}
        <p class="text-sm text-[var(--color-success)]">Team created.</p>
      {/if}
      <div>
        <button type="submit" class={primaryButtonClass} disabled={teamSaving}>
          {teamSaving ? 'Creating…' : 'Create team'}
        </button>
      </div>
    </form>
  </section>
</div>

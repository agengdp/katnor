<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';

  // Local mirrors of apps/server's tRPC row shapes (packages/db's Drizzle
  // `$inferSelect` types). apps/web doesn't depend on @katnor/db directly
  // (only @katnor/server, type-only, for the fully-typed `trpc()` client),
  // so these are hand-kept in sync with this page's documented contract
  // rather than imported - they just give the state/helpers below
  // something concrete to be typed against.
  interface ChannelRow {
    id: string;
    created_at: string;
    updated_at: string;
    project_id: string | null;
    team_id: string | null;
    kind: 'project' | 'team' | 'dm' | 'task_thread' | 'general';
    name: string | null;
    task_id: string | null;
  }

  interface MessageRow {
    id: string;
    created_at: string;
    updated_at: string;
    channel_id: string;
    author_type: 'agent' | 'human';
    author_id: string;
    content: string;
    mentions: string[];
    reply_to: string | null;
    attachments: unknown[];
  }

  interface AgentRow {
    id: string;
    name: string;
    title: string;
    status: 'active' | 'paused' | 'offline';
    is_system: boolean;
  }

  interface ProjectRow {
    id: string;
    name: string;
  }

  interface ProjectChannel {
    project: ProjectRow;
    channel: ChannelRow;
  }

  // Sidebar data - #general, one channel per project, and the agent list
  // (which doubles as the DM contact list, see dmChannelsByAgent below).
  let sidebarLoading = $state(true);
  let sidebarError = $state<string | null>(null);
  let generalChannel = $state<ChannelRow | null>(null);
  let projectChannels = $state<ProjectChannel[]>([]);
  let agents = $state<AgentRow[]>([]);

  // There is deliberately no "list all DMs" procedure - channels.getOrCreateDm
  // is the only way to learn a DM channel's id, so this remembers what's been
  // resolved this session well enough to highlight the right sidebar row and
  // to avoid re-issuing the mutation every time an already-open DM is
  // clicked again. Not $state: it's always mutated in the same tick as
  // selectedChannel (which is $state), so the UI still updates correctly.
  const dmChannelsByAgent = new Map<string, ChannelRow>();
  let openingDmAgentId = $state<string | null>(null);

  // The selected channel and its thread.
  let selectedChannel = $state<ChannelRow | null>(null);
  let selectedLabel = $state('');
  let messages = $state<MessageRow[]>([]);
  let messagesLoading = $state(false);
  let messagesError = $state<string | null>(null);
  // Guards against an older messages.list response (e.g. from a channel the
  // user has since clicked away from) overwriting a newer one.
  let messagesRequestId = 0;

  // Composer.
  let composerText = $state('');
  let selectedMentionIds = $state<string[]>([]);
  let sending = $state(false);
  // Shown near the composer - covers both a failed send and a failed
  // "open DM" click (clicking an agent in the sidebar), per this page's spec.
  let actionError = $state<string | null>(null);

  function isUnauthorized(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const data = (err as { data?: { code?: string; httpStatus?: number } | null }).data;
    return data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401;
  }

  function describeError(err: unknown, unauthorizedMessage?: string): string {
    if (unauthorizedMessage && isUnauthorized(err)) return unauthorizedMessage;
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  function agentName(id: string): string {
    return agents.find((a) => a.id === id)?.name ?? id;
  }

  function authorLabel(m: MessageRow): string {
    return m.author_type === 'human' ? 'Owner' : agentName(m.author_id);
  }

  function formatMentions(mentions: string[]): string {
    return mentions.map((id) => `@${agentName(id)}`).join(', ');
  }

  function channelKindLabel(kind: ChannelRow['kind']): string {
    switch (kind) {
      case 'general':
        return 'general';
      case 'project':
        return 'project channel';
      case 'dm':
        return 'direct message';
      case 'team':
        return 'team channel';
      case 'task_thread':
        return 'task thread';
      default:
        return kind;
    }
  }

  function isDmSelected(agent: AgentRow): boolean {
    if (!selectedChannel || selectedChannel.kind !== 'dm') return false;
    return dmChannelsByAgent.get(agent.id)?.id === selectedChannel.id;
  }

  function selectChannel(channel: ChannelRow, label: string) {
    if (selectedChannel?.id === channel.id) return;
    selectedChannel = channel;
    selectedLabel = label;
    composerText = '';
    selectedMentionIds = [];
    actionError = null;
    loadMessages(channel.id);
  }

  async function loadSidebar() {
    sidebarLoading = true;
    sidebarError = null;
    try {
      const client = trpc();
      const [general, projectList, agentList] = await Promise.all([
        client.channels.getGeneral.query(),
        client.projects.list.query(),
        client.agents.list.query(),
      ]);

      // Each project's channel list can also include that project's
      // task-thread channels (they carry the same project_id) - pick out
      // the one channel with kind "project" for the sidebar row.
      const channelLists = await Promise.all(
        projectList.map((project) => client.channels.list.query({ project_id: project.id })),
      );
      const entries: ProjectChannel[] = [];
      projectList.forEach((project, index) => {
        const channel = channelLists[index]?.find((c) => c.kind === 'project');
        if (channel) entries.push({ project, channel });
      });

      generalChannel = general;
      projectChannels = entries;
      agents = agentList;

      selectChannel(general, '# general');
    } catch (err) {
      sidebarError = describeError(err);
    } finally {
      sidebarLoading = false;
    }
  }

  async function loadMessages(channelId: string, opts: { silent?: boolean } = {}): Promise<void> {
    const silent = opts.silent === true;
    const requestId = ++messagesRequestId;
    if (!silent) {
      messagesLoading = true;
      messagesError = null;
    }
    try {
      const result = await trpc().messages.list.query({ channel_id: channelId });
      if (requestId !== messagesRequestId) return; // superseded by a newer load
      messages = result;
      if (!silent) messagesError = null;
    } catch (err) {
      if (requestId !== messagesRequestId) return;
      if (silent) {
        // A background refresh (triggered by a live event) failing
        // shouldn't blow away an already-loaded thread with an error.
        console.error('[chat] failed to refresh messages', err);
      } else {
        messagesError = describeError(err);
      }
    } finally {
      if (requestId === messagesRequestId && !silent) {
        messagesLoading = false;
      }
    }
  }

  async function openDm(agent: AgentRow) {
    const cached = dmChannelsByAgent.get(agent.id);
    if (cached) {
      selectChannel(cached, agent.name);
      return;
    }
    openingDmAgentId = agent.id;
    actionError = null;
    try {
      const created = await trpc().channels.getOrCreateDm.mutate({ agent_id: agent.id });
      dmChannelsByAgent.set(agent.id, created);
      selectChannel(created, agent.name);
    } catch (err) {
      actionError = describeError(err, 'You need to log in to message agents.');
    } finally {
      openingDmAgentId = null;
    }
  }

  function toggleMention(agentId: string) {
    selectedMentionIds = selectedMentionIds.includes(agentId)
      ? selectedMentionIds.filter((id) => id !== agentId)
      : [...selectedMentionIds, agentId];
  }

  async function sendMessage(event?: SubmitEvent) {
    event?.preventDefault();
    const channel = selectedChannel;
    if (!channel) return;
    const text = composerText.trim();
    if (!text) return;

    sending = true;
    actionError = null;
    try {
      // A DM always wakes its one agent automatically server-side - no
      // mentions needed, and the picker is hidden for dm channels anyway.
      const mentions = channel.kind === 'dm' ? [] : [...selectedMentionIds];
      await trpc().messages.send.mutate({ channel_id: channel.id, text, mentions });
      composerText = '';
      selectedMentionIds = [];
      // A full re-fetch is simplest for Phase 1 - no need for optimistic UI.
      await loadMessages(channel.id, { silent: true });
    } catch (err) {
      actionError = describeError(err, 'You need to log in to send messages.');
    } finally {
      sending = false;
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  // Runs once on mount: the call itself is async, so nothing reactive is
  // read synchronously inside this effect and it won't re-run afterwards
  // (same pattern as apps/web/src/routes/settings/+page.svelte).
  $effect(() => {
    loadSidebar();
  });

  // Live updates: re-fetch the open channel's thread whenever the event bus
  // reports a new message for it, so messages posted by an agent (or from
  // another tab) show up without a manual reload. selectedChannel is read
  // fresh inside the callback on every event rather than as an effect
  // dependency, so this subscribes exactly once for the life of the page.
  $effect(() => {
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type !== 'message.posted') return;
      if (!selectedChannel) return;
      const rawChannelId = event.payload.channel_id;
      const eventChannelId = typeof rawChannelId === 'string' ? rawChannelId : undefined;
      if (eventChannelId && eventChannelId !== selectedChannel.id) return;
      loadMessages(selectedChannel.id, { silent: true });
    });
    return unsubscribe;
  });
</script>

<div class="mx-auto flex h-[min(70vh,42rem)] min-h-[24rem] w-full max-w-6xl flex-col gap-4">
  <div>
    <h1 class="text-2xl font-semibold">Chat</h1>
    <p class="mt-1 text-sm text-[var(--color-text-muted)]">
      #general, one channel per project, and a DM with every agent - live for you and for them.
    </p>
  </div>

  <div class="flex min-h-0 flex-1 flex-col">
    {#if sidebarLoading}
      <div class="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
        Loading chat…
      </div>
    {:else if sidebarError}
      <div
        class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
      >
        <p class="font-medium text-[var(--color-danger)]">Couldn't load chat</p>
        <p class="text-[var(--color-text-muted)]">{sidebarError}</p>
        <p class="text-[var(--color-text-muted)]">
          apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong place.
        </p>
        <div>
          <button
            type="button"
            onclick={loadSidebar}
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
          >
            Retry
          </button>
        </div>
      </div>
    {:else if selectedChannel}
      {@const channel = selectedChannel}
      <div class="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row sm:gap-4">
        <!-- Desktop sidebar -->
        <aside
          aria-label="Channels and agents"
          class="hidden sm:flex sm:min-h-0 sm:w-64 sm:shrink-0 sm:flex-col sm:gap-4 sm:overflow-y-auto sm:border-r sm:border-[var(--color-border)] sm:pr-4"
        >
          <div class="flex flex-col gap-1">
            <p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Channels</p>
            {#if generalChannel}
              {@const general = generalChannel}
              <button
                type="button"
                onclick={() => selectChannel(general, '# general')}
                title="general"
                class="truncate rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors {channel.id ===
                general.id
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                  : 'hover:bg-[var(--color-surface-muted)]'}"
              >
                # general
              </button>
            {/if}
            {#each projectChannels as entry (entry.channel.id)}
              <button
                type="button"
                onclick={() => selectChannel(entry.channel, `# ${entry.project.name}`)}
                title={entry.project.name}
                class="truncate rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors {channel.id ===
                entry.channel.id
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                  : 'hover:bg-[var(--color-surface-muted)]'}"
              >
                # {entry.project.name}
              </button>
            {/each}
            {#if projectChannels.length === 0}
              <p class="px-3 py-1 text-xs text-[var(--color-text-muted)]">No project channels yet.</p>
            {/if}
          </div>

          <div class="flex flex-col gap-1">
            <p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Agents</p>
            {#each agents as agent (agent.id)}
              <button
                type="button"
                onclick={() => openDm(agent)}
                disabled={openingDmAgentId === agent.id}
                title={agent.name}
                class="flex items-center gap-2 truncate rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors disabled:opacity-50 {isDmSelected(
                  agent
                )
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                  : 'hover:bg-[var(--color-surface-muted)]'}"
              >
                <span
                  aria-hidden="true"
                  class="inline-block h-1.5 w-1.5 shrink-0 rounded-full {agent.status === 'active'
                    ? 'bg-[var(--color-success)]'
                    : 'bg-[var(--color-text-muted)]'}"
                ></span>
                <span class="truncate">{openingDmAgentId === agent.id ? 'Opening…' : agent.name}</span>
              </button>
            {/each}
            {#if agents.length === 0}
              <p class="px-3 py-1 text-xs text-[var(--color-text-muted)]">No agents yet.</p>
            {/if}
          </div>
        </aside>

        <!-- Mobile channel/agent scroller (replaces the sidebar below sm:) -->
        <div aria-label="Channels and agents" class="flex shrink-0 gap-2 overflow-x-auto pb-1 sm:hidden">
          {#if generalChannel}
            {@const general = generalChannel}
            <button
              type="button"
              onclick={() => selectChannel(general, '# general')}
              class="shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors {channel.id ===
              general.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'}"
            >
              # general
            </button>
          {/if}
          {#each projectChannels as entry (entry.channel.id)}
            <button
              type="button"
              onclick={() => selectChannel(entry.channel, `# ${entry.project.name}`)}
              class="shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors {channel.id ===
              entry.channel.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'}"
            >
              # {entry.project.name}
            </button>
          {/each}
          {#each agents as agent (agent.id)}
            <button
              type="button"
              onclick={() => openDm(agent)}
              disabled={openingDmAgentId === agent.id}
              class="shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 {isDmSelected(
                agent
              )
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'}"
            >
              {openingDmAgentId === agent.id ? 'Opening…' : agent.name}
            </button>
          {/each}
        </div>

        <!-- Thread -->
        <section
          class="flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <div class="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
            <h2 class="truncate text-base font-semibold">{selectedLabel}</h2>
            <span
              class="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
            >
              {channelKindLabel(channel.kind)}
            </span>
          </div>

          <div class="flex min-h-0 flex-1 flex-col divide-y divide-[var(--color-border)] overflow-y-auto px-4">
            {#if messagesLoading}
              <p class="py-6 text-center text-sm text-[var(--color-text-muted)]">Loading messages…</p>
            {:else if messagesError}
              <div class="flex flex-col items-center gap-2 py-6 text-center text-sm">
                <p class="text-[var(--color-danger)]">{messagesError}</p>
                <button
                  type="button"
                  onclick={() => loadMessages(channel.id)}
                  class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
                >
                  Retry
                </button>
              </div>
            {:else if messages.length === 0}
              <p class="py-6 text-center text-sm text-[var(--color-text-muted)]">No messages yet - say hello.</p>
            {:else}
              {#each messages as m (m.id)}
                <div class="flex flex-col gap-1 py-3">
                  <div class="flex flex-wrap items-baseline gap-2">
                    <span class="text-sm font-semibold">{authorLabel(m)}</span>
                    <span class="text-xs text-[var(--color-text-muted)]">{formatTime(m.created_at)}</span>
                  </div>
                  <p class="whitespace-pre-wrap break-words text-sm">{m.content}</p>
                  {#if m.mentions.length > 0}
                    <p class="text-xs text-[var(--color-text-muted)]">{formatMentions(m.mentions)}</p>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>

          <div class="flex flex-col gap-2 border-t border-[var(--color-border)] p-3">
            {#if actionError}
              <p class="text-sm text-[var(--color-danger)]">{actionError}</p>
            {/if}

            {#if channel.kind !== 'dm'}
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-xs text-[var(--color-text-muted)]">Mention:</span>
                {#each agents as agent (agent.id)}
                  <button
                    type="button"
                    onclick={() => toggleMention(agent.id)}
                    class="shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium transition-colors {selectedMentionIds.includes(
                      agent.id
                    )
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]'}"
                  >
                    @{agent.name}
                  </button>
                {/each}
                {#if agents.length === 0}
                  <span class="text-xs text-[var(--color-text-muted)]">No agents to mention yet.</span>
                {/if}
              </div>
            {/if}

            <form class="flex flex-col gap-2 sm:flex-row sm:items-end" onsubmit={sendMessage}>
              <textarea
                bind:value={composerText}
                onkeydown={handleComposerKeydown}
                rows="2"
                placeholder={`Message ${selectedLabel}`}
                aria-label={`Message ${selectedLabel}`}
                class="w-full flex-1 resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
              ></textarea>
              <button
                type="submit"
                disabled={sending || composerText.trim() === ''}
                class="w-full shrink-0 rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50 sm:w-auto"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
            <p class="text-xs text-[var(--color-text-muted)]">Enter to send - Shift+Enter for a new line.</p>
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { Icon } from '$lib/icons';

  interface ProjectRow {
    id: string;
    name: string;
  }

  interface WikiPageListItem {
    path: string;
    title: string;
    updatedAt: string | null;
  }

  interface KgNodeRow {
    id: string;
    type: string;
    name: string;
    summary: string | null;
  }

  interface KgEdgeRow {
    id: string;
    from_id: string;
    to_id: string;
    type: string;
  }

  interface SearchCitation {
    kind: 'kg_node' | 'wiki_page';
    id: string;
    title: string;
    snippet?: string;
    score: number;
    path?: string;
  }

  type Tab = 'wiki' | 'graph' | 'ask';

  let projects = $state<ProjectRow[]>([]);
  let projectId = $state<string>('');
  let projectsLoading = $state(true);
  let projectsError = $state<string | null>(null);
  let tab = $state<Tab>('wiki');

  function describeError(err: unknown): string {
    if (err && typeof err === 'object') {
      const data = (err as { data?: { code?: string; httpStatus?: number } }).data;
      if (data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401) {
        return 'You need to be logged in as the owner to do that.';
      }
    }
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  async function loadProjects() {
    projectsLoading = true;
    projectsError = null;
    try {
      projects = (await trpc().projects.list.query()) as unknown as ProjectRow[];
      if (!projectId && projects.length > 0) projectId = projects[0]!.id;
    } catch (err) {
      projectsError = describeError(err);
    } finally {
      projectsLoading = false;
    }
  }

  $effect(() => {
    loadProjects();
  });

  // ─── Wiki tab ───────────────────────────────────────────────────────────

  let pages = $state<WikiPageListItem[]>([]);
  let pagesLoading = $state(false);
  let pagesError = $state<string | null>(null);
  let selectedPath = $state<string | null>(null);
  let editorContent = $state('');
  let editorTitle = $state('');
  let editorLoading = $state(false);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let actionMessage = $state<string | null>(null);

  async function loadPages() {
    if (!projectId) return;
    pagesLoading = true;
    pagesError = null;
    try {
      pages = (await trpc().knowledge.listWikiPages.query({
        projectId,
      })) as unknown as WikiPageListItem[];
    } catch (err) {
      pagesError = describeError(err);
    } finally {
      pagesLoading = false;
    }
  }

  async function openPage(page: WikiPageListItem) {
    selectedPath = page.path;
    editorTitle = page.title;
    editorLoading = true;
    saveError = null;
    try {
      const result = await trpc().knowledge.getWikiPage.query({ projectId, path: page.path });
      editorContent = result.content;
    } catch (err) {
      saveError = describeError(err);
    } finally {
      editorLoading = false;
    }
  }

  async function savePage() {
    if (!selectedPath) return;
    saving = true;
    saveError = null;
    try {
      await trpc().knowledge.saveWikiPage.mutate({
        projectId,
        path: selectedPath,
        title: editorTitle || selectedPath,
        content: editorContent,
      });
      await loadPages();
    } catch (err) {
      saveError = describeError(err);
    } finally {
      saving = false;
    }
  }

  async function reindexCode() {
    actionMessage = null;
    try {
      await trpc().knowledge.reindexCode.mutate({ projectId });
      actionMessage = 'Code reindex queued - check back in a bit for new nodes in the Graph tab.';
    } catch (err) {
      actionMessage = describeError(err);
    }
  }

  async function lintProject() {
    actionMessage = null;
    try {
      await trpc().knowledge.lintProject.mutate({ projectId });
      actionMessage = 'Wiki lint queued - findings (if any) post to the project channel.';
    } catch (err) {
      actionMessage = describeError(err);
    }
  }

  // ─── Graph tab ──────────────────────────────────────────────────────────

  let nodes = $state<KgNodeRow[]>([]);
  let edges = $state<KgEdgeRow[]>([]);
  let graphLoading = $state(false);
  let graphError = $state<string | null>(null);
  let selectedNodeId = $state<string | null>(null);

  async function loadGraph() {
    if (!projectId) return;
    graphLoading = true;
    graphError = null;
    try {
      const result = await trpc().knowledge.listGraph.query({ projectId });
      nodes = result.nodes as unknown as KgNodeRow[];
      edges = result.edges as unknown as KgEdgeRow[];
    } catch (err) {
      graphError = describeError(err);
    } finally {
      graphLoading = false;
    }
  }

  const NODE_TYPE_COLORS: Record<string, string> = {
    repo: '#8b5cf6',
    file: '#64748b',
    module: '#0ea5e9',
    decision: '#f59e0b',
    person: '#22c55e',
    agent: '#22c55e',
    concept: '#ec4899',
    task: '#3b82f6',
    bug: '#ef4444',
    risk: '#ef4444',
  };
  function colorForType(type: string): string {
    return NODE_TYPE_COLORS[type] ?? '#94a3b8';
  }

  interface PositionedNode extends KgNodeRow {
    x: number;
    y: number;
  }

  let positioned = $derived.by(() => {
    const n = nodes.length;
    if (n === 0) return [] as PositionedNode[];
    const radius = Math.max(140, n * 14);
    const center = radius + 60;
    return nodes.map((node, i) => {
      const angle = (2 * Math.PI * i) / n;
      return {
        ...node,
        x: center + radius * Math.cos(angle),
        y: center + radius * Math.sin(angle),
      };
    });
  });
  let viewBoxSize = $derived(nodes.length > 0 ? 2 * (Math.max(140, nodes.length * 14) + 60) : 400);
  let positionById = $derived(new Map(positioned.map((n) => [n.id, n])));
  let selectedNode = $derived(positioned.find((n) => n.id === selectedNodeId) ?? null);
  let selectedNodeEdges = $derived(
    edges.filter((e) => e.from_id === selectedNodeId || e.to_id === selectedNodeId),
  );

  // ─── Ask tab ────────────────────────────────────────────────────────────

  let question = $state('');
  let asking = $state(false);
  let askError = $state<string | null>(null);
  let answer = $state<string | null>(null);
  let citations = $state<SearchCitation[]>([]);

  async function askWiki(event: SubmitEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    asking = true;
    askError = null;
    answer = null;
    try {
      const result = await trpc().knowledge.askWiki.mutate({
        projectId,
        question: question.trim(),
      });
      answer = result.answer;
      citations = result.citations as unknown as SearchCitation[];
    } catch (err) {
      askError = describeError(err);
    } finally {
      asking = false;
    }
  }

  function openCitation(citation: SearchCitation) {
    if (citation.kind === 'wiki_page' && citation.path) {
      tab = 'wiki';
      void loadPages().then(() => {
        const match = pages.find((p) => p.path === citation.path);
        if (match) void openPage(match);
      });
    } else {
      tab = 'graph';
      void loadGraph().then(() => {
        selectedNodeId = citation.id;
      });
    }
  }

  function switchTab(next: Tab) {
    tab = next;
    if (next === 'wiki' && pages.length === 0) void loadPages();
    if (next === 'graph' && nodes.length === 0) void loadGraph();
  }

  $effect(() => {
    if (projectId) {
      pages = [];
      nodes = [];
      edges = [];
      selectedPath = null;
      selectedNodeId = null;
      if (tab === 'wiki') void loadPages();
      if (tab === 'graph') void loadGraph();
    }
  });

  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (
        (event.type === 'wiki_page.updated' || event.type === 'kg_node.upserted') &&
        tab === 'wiki'
      )
        loadPages();
      if (event.type === 'kg_node.upserted' && tab === 'graph') loadGraph();
    });
    return unsub;
  });
</script>

<div class="flex flex-col gap-4">
  <div>
    <h1 class="text-2xl font-semibold">Knowledge</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      The project's wiki and knowledge graph - what the company has learned, with citations.
    </p>
  </div>

  {#if projectsError}
    <p class="text-sm text-[var(--color-danger)]">{projectsError}</p>
  {:else if projectsLoading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading projects…</p>
  {:else if projects.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">
      No projects yet - create one on the Projects page first.
    </p>
  {:else}
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-2 text-sm">
        <span class="text-[var(--color-text-muted)]">Project</span>
        <select
          bind:value={projectId}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
        >
          {#each projects as project (project.id)}
            <option value={project.id}>{project.name}</option>
          {/each}
        </select>
      </label>

      <div class="flex gap-1">
        {#each [['wiki', 'Wiki'], ['graph', 'Graph'], ['ask', 'Ask']] as [value, label] (value)}
          <button
            type="button"
            onclick={() => switchTab(value as Tab)}
            class="rounded-md px-3 py-1.5 text-sm font-medium {tab === value
              ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
              : 'border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'}"
          >
            {label}
          </button>
        {/each}
      </div>
    </div>

    {#if tab === 'wiki'}
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
          onclick={lintProject}
        >
          Lint wiki now
        </button>
        <button
          type="button"
          class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
          onclick={reindexCode}
        >
          Reindex code
        </button>
        {#if actionMessage}
          <span class="text-xs text-[var(--color-text-muted)]">{actionMessage}</span>
        {/if}
      </div>

      {#if pagesError}
        <p class="text-sm text-[var(--color-danger)]">{pagesError}</p>
      {/if}

      <div class="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
        <div class="flex w-full flex-col gap-1 sm:w-64 sm:shrink-0">
          {#if pagesLoading}
            <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
          {:else if pages.length === 0}
            <p class="text-sm text-[var(--color-text-muted)]">
              No pages yet - the Librarian creates these as the team works.
            </p>
          {:else}
            {#each pages as page (page.path)}
              <button
                type="button"
                onclick={() => openPage(page)}
                class="flex flex-col items-start rounded-md px-3 py-2 text-left text-sm {selectedPath ===
                page.path
                  ? 'bg-[var(--color-surface-muted)] font-medium'
                  : 'hover:bg-[var(--color-surface-muted)]'}"
              >
                <span>{page.title}</span>
                <span class="text-xs text-[var(--color-text-muted)]">{page.path}</span>
              </button>
            {/each}
          {/if}
        </div>

        <div
          class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          {#if !selectedPath}
            <p class="text-sm text-[var(--color-text-muted)]">Select a page to view or edit it.</p>
          {:else if editorLoading}
            <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
          {:else}
            <div class="flex flex-col gap-3">
              <input
                type="text"
                bind:value={editorTitle}
                class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm font-medium"
              />
              <textarea
                bind:value={editorContent}
                rows="18"
                class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs"
              ></textarea>
              {#if saveError}
                <p class="text-sm text-[var(--color-danger)]">{saveError}</p>
              {/if}
              <div>
                <button
                  type="button"
                  disabled={saving}
                  onclick={savePage}
                  class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {:else if tab === 'graph'}
      {#if graphError}
        <p class="text-sm text-[var(--color-danger)]">{graphError}</p>
      {:else if graphLoading}
        <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
      {:else if nodes.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">
          No graph nodes yet for this project - they appear as the Librarian ingests finished tasks,
          or after a manual "Reindex code" from the Wiki tab.
        </p>
      {:else}
        <div class="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          <div
            class="min-w-0 flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <svg viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`} class="h-[560px] w-full">
              {#each edges as edge (edge.id)}
                {@const from = positionById.get(edge.from_id)}
                {@const to = positionById.get(edge.to_id)}
                {#if from && to}
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="var(--color-border)"
                    stroke-width="1"
                  />
                {/if}
              {/each}
              {#each positioned as node (node.id)}
                <g
                  role="button"
                  tabindex="0"
                  onclick={() => (selectedNodeId = node.id)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') selectedNodeId = node.id;
                  }}
                  style="cursor:pointer"
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={selectedNodeId === node.id ? 10 : 7}
                    fill={colorForType(node.type)}
                    stroke={selectedNodeId === node.id ? 'var(--color-text)' : 'none'}
                    stroke-width="2"
                  />
                  <text x={node.x + 10} y={node.y + 4} font-size="10" fill="var(--color-text)"
                    >{node.name}</text
                  >
                </g>
              {/each}
            </svg>
          </div>

          <div
            class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm sm:w-72 sm:shrink-0"
          >
            {#if !selectedNode}
              <p class="text-[var(--color-text-muted)]">Click a node to see its details.</p>
            {:else}
              <div class="flex flex-col gap-2">
                <span
                  class="w-fit rounded-full px-2 py-0.5 text-xs font-medium text-white"
                  style={`background:${colorForType(selectedNode.type)}`}
                >
                  {selectedNode.type}
                </span>
                <h3 class="font-medium">{selectedNode.name}</h3>
                {#if selectedNode.summary}
                  <p class="text-[var(--color-text-muted)]">{selectedNode.summary}</p>
                {/if}
                {#if selectedNodeEdges.length > 0}
                  <div class="flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
                    <span class="text-xs font-medium text-[var(--color-text-muted)]"
                      >Connections</span
                    >
                    {#each selectedNodeEdges as edge (edge.id)}
                      {@const otherId =
                        edge.from_id === selectedNode.id ? edge.to_id : edge.from_id}
                      {@const other = positionById.get(otherId)}
                      <button
                        type="button"
                        onclick={() => (selectedNodeId = otherId)}
                        class="flex items-center gap-1 text-left text-xs hover:underline"
                      >
                        <Icon name={edge.from_id === selectedNode.id ? 'arrowRight' : 'arrowLeft'} />
                        {edge.type}
                        {other?.name ?? otherId}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {:else}
      <div class="flex flex-col gap-3">
        <form class="flex gap-2" onsubmit={askWiki}>
          <input
            type="text"
            bind:value={question}
            placeholder="e.g. How does auth work in this project, and who decided it?"
            class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={asking}
            class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
          >
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </form>

        {#if askError}
          <p class="text-sm text-[var(--color-danger)]">{askError}</p>
        {/if}

        {#if answer}
          <div
            class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
          >
            <p class="whitespace-pre-wrap">{answer}</p>
            {#if citations.length > 0}
              <div class="flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
                <span class="text-xs font-medium text-[var(--color-text-muted)]">Sources</span>
                <div class="flex flex-wrap gap-1.5">
                  {#each citations as citation (citation.id)}
                    <button
                      type="button"
                      onclick={() => openCitation(citation)}
                      class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-muted)]"
                    >
                      <Icon name={citation.kind === 'wiki_page' ? 'pencil' : 'link'} />
                      {citation.title}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

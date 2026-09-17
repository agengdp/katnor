<script lang="ts">
  import { page } from '$app/stores';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { dndzone } from 'svelte-dnd-action';
  import { flip } from 'svelte/animate';

  // Local mirrors of apps/server's Row shapes. Timestamps are plain ISO
  // strings on the wire (no superjson transformer), not Date objects, even
  // though @katnor/core's zod schemas type them as `Date` - hence the
  // `as unknown as ...Row[]` casts below rather than trusting tRPC's
  // inferred type directly.
  type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

  interface ProjectRow {
    id: string;
    created_at: string;
    updated_at: string;
    name: string;
    description: string;
    repos: unknown[];
    workspace_id: string | null;
    board_settings: { columns: { id: string; name: string; status: TaskStatus }[] };
    wiki_path: string;
  }

  interface TaskRow {
    id: string;
    created_at: string;
    updated_at: string;
    project_id: string;
    title: string;
    description: string;
    acceptance_criteria: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignee_id: string | null;
    created_by: string;
    parent_id: string | null;
    depends_on: string[];
    due_at: string | null;
  }

  interface AgentRow {
    id: string;
    name: string;
    title: string;
    status: 'active' | 'paused' | 'offline';
  }

  interface ColumnState {
    id: string;
    name: string;
    status: TaskStatus;
    tasks: TaskRow[];
  }

  // svelte-dnd-action dispatches these as plain CustomEvents on the zone
  // element - see https://github.com/isaacHagoel/svelte-dnd-action.
  type DndDetail = { items: TaskRow[]; info: { id: string; trigger: string; source: string } };

  // $page is a store, so this stays in sync if the route param ever changes
  // (navigating from one project straight to another) without a full remount.
  let projectId = $derived($page.params.id);

  let project = $state<ProjectRow | null>(null);
  let tasks = $state<TaskRow[]>([]);
  let agents = $state<AgentRow[]>([]);
  let columns = $state<ColumnState[]>([]);

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);

  // Errors from actions taken on the board itself (a drag move, a
  // reassignment) - shown inline near the board rather than replacing it.
  let actionError = $state<string | null>(null);

  let expandedTaskId = $state<string | null>(null);

  interface TaskArtifactRow {
    id: string;
    title: string;
    kind: string;
    version: number;
  }
  let taskArtifacts = $state<Record<string, TaskArtifactRow[]>>({});

  async function loadTaskArtifacts(taskId: string) {
    if (taskId in taskArtifacts) return; // cached for the life of this page load
    try {
      const rows = await trpc().artifacts.listLatest.query({ taskId });
      taskArtifacts[taskId] = rows as unknown as TaskArtifactRow[];
    } catch {
      // Non-fatal - the task drawer still works without its artifacts list.
    }
  }

  let newTitle = $state('');
  let newDescription = $state('');
  let newAcceptanceCriteria = $state('');
  let newPriority = $state<TaskPriority>('medium');
  let newAssigneeId = $state('');
  let creatingTask = $state(false);
  let createTaskError = $state<string | null>(null);

  const flipDurationMs = 150;
  const dndType = 'kanban-task';

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

  /** Rebuilds each column's local task list from the authoritative `tasks` list. */
  function rebuildColumns() {
    const configured = project?.board_settings.columns ?? [];
    const knownStatuses = new Set(configured.map((c) => c.status));
    const next: ColumnState[] = configured.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      tasks: tasks.filter((t) => t.status === c.status),
    }));
    // "blocked" isn't one of the default columns - anything whose status
    // doesn't match a configured column (in practice, blocked tasks) lands
    // in a small fallback column rather than being dropped silently.
    const leftover = tasks.filter((t) => !knownStatuses.has(t.status));
    if (leftover.length > 0) {
      next.push({ id: '__unmatched__', name: 'Blocked', status: 'blocked', tasks: leftover });
    }
    columns = next;
  }

  async function loadAll(id: string) {
    loading = true;
    loadError = null;
    notFound = false;
    actionError = null;
    expandedTaskId = null;
    try {
      const [proj, taskRows, agentRows] = await Promise.all([
        trpc().projects.getById.query({ id }),
        trpc().tasks.list.query({ project_id: id }),
        trpc().agents.list.query(),
      ]);
      agents = agentRows as unknown as AgentRow[];
      if (!proj) {
        notFound = true;
        project = null;
        tasks = [];
        columns = [];
      } else {
        project = proj as unknown as ProjectRow;
        tasks = taskRows as unknown as TaskRow[];
        rebuildColumns();
      }
    } catch (err) {
      loadError = describeError(err);
    } finally {
      loading = false;
    }
  }

  // Re-runs whenever the route param changes (projectId is read
  // synchronously here, so this effect re-fires on navigation).
  $effect(() => {
    const id = projectId;
    // `$page.params.id` is typed `string | undefined`. The router only
    // matches this route with the param present, so this should not happen -
    // but skipping the load beats calling it with `undefined`.
    if (!id) return;
    loadAll(id);
  });

  async function refreshTasks() {
    try {
      const taskRows = await trpc().tasks.list.query({ project_id: projectId });
      tasks = taskRows as unknown as TaskRow[];
      rebuildColumns();
    } catch (err) {
      actionError = describeError(err);
    }
  }

  // Subscribes once for the component's lifetime; projectId is read fresh
  // inside the callback on every event rather than captured up front, so it
  // always compares against whichever project is currently on screen.
  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (event.type !== 'task.created' && event.type !== 'task.updated') return;
      const payload = event.payload as { project_id?: string } | undefined;
      if (!payload?.project_id || payload.project_id === projectId) {
        refreshTasks();
      }
    });
    return unsub;
  });

  function handleConsider(colIndex: number, e: CustomEvent<DndDetail>) {
    columns[colIndex].tasks = e.detail.items;
  }

  async function handleFinalize(colIndex: number, e: CustomEvent<DndDetail>) {
    const column = columns[colIndex];
    const newItems = e.detail.items;
    columns[colIndex].tasks = newItems;

    // Anything now in this column whose authoritative status doesn't match
    // this column just arrived here via drag - persist that as a move.
    const moved = newItems.filter((item) => {
      const authoritative = tasks.find((t) => t.id === item.id);
      return authoritative && authoritative.status !== column.status;
    });

    for (const item of moved) {
      await moveTask(item.id, column.status);
    }
  }

  async function moveTask(taskId: string, status: TaskStatus) {
    actionError = null;
    try {
      await trpc().tasks.update.mutate({ id: taskId, status });
    } catch (err) {
      actionError = describeError(err);
    } finally {
      // Reconcile from the server either way - on success this settles any
      // columns into their final shape, on failure it snaps the card back.
      await refreshTasks();
    }
  }

  async function reassignTask(taskId: string, assigneeId: string | null) {
    actionError = null;
    try {
      await trpc().tasks.update.mutate({ id: taskId, assignee_id: assigneeId });
      await refreshTasks();
    } catch (err) {
      actionError = describeError(err);
    }
  }

  function toggleExpand(taskId: string) {
    expandedTaskId = expandedTaskId === taskId ? null : taskId;
    if (expandedTaskId) loadTaskArtifacts(expandedTaskId);
  }

  function assigneeName(assigneeId: string | null): string {
    if (!assigneeId) return 'Unassigned';
    return agents.find((a) => a.id === assigneeId)?.name ?? 'Unknown agent';
  }

  function priorityLabel(priority: TaskPriority): string {
    return priority.charAt(0).toUpperCase() + priority.slice(1);
  }

  function priorityClasses(priority: TaskPriority): string {
    switch (priority) {
      case 'urgent':
        return 'bg-[var(--color-danger)] text-[var(--color-accent-contrast)]';
      case 'high':
        return 'border border-[var(--color-danger)] text-[var(--color-danger)]';
      case 'low':
        return 'border border-[var(--color-border)] text-[var(--color-text-muted)]';
      default:
        return 'border border-[var(--color-border)] text-[var(--color-text)]';
    }
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  }

  async function createTask(event: SubmitEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    // Narrows `$page.params.id` from `string | undefined`; tasks.create
    // requires a project_id, so there is nothing sensible to send without it.
    const id = projectId;
    if (!id) return;
    creatingTask = true;
    createTaskError = null;
    try {
      await trpc().tasks.create.mutate({
        project_id: id,
        title,
        description: newDescription.trim(),
        acceptance_criteria: newAcceptanceCriteria.trim(),
        priority: newPriority,
        assignee_id: newAssigneeId || null,
      });
      newTitle = '';
      newDescription = '';
      newAcceptanceCriteria = '';
      newPriority = 'medium';
      newAssigneeId = '';
      await refreshTasks();
    } catch (err) {
      createTaskError = describeError(err);
    } finally {
      creatingTask = false;
    }
  }
</script>

<div class="flex flex-col gap-6">
  <a href="/projects" class="self-start text-sm text-[var(--color-text-muted)] hover:underline">
    ← Back to projects
  </a>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading project…</p>
  {:else if loadError}
    <div
      class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
    >
      <p class="font-medium text-[var(--color-danger)]">Couldn't load this project</p>
      <p class="text-[var(--color-text-muted)]">{loadError}</p>
      <p class="text-[var(--color-text-muted)]">
        apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong place.
      </p>
    </div>
  {:else if notFound || !project}
    <div
      class="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
    >
      <p class="font-medium">Project not found</p>
      <p class="text-[var(--color-text-muted)]">
        There's no project at this address - it may have been deleted, or the link might be wrong.
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-semibold">{project.name}</h1>
      {#if project.description}
        <p class="text-[var(--color-text-muted)]">{project.description}</p>
      {/if}
    </div>

    {#if actionError}
      <p class="text-sm text-[var(--color-danger)]">{actionError}</p>
    {/if}

    <section
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 class="text-sm font-semibold">
        Add task <span class="font-normal text-[var(--color-text-muted)]">(goes to Backlog)</span>
      </h2>
      <form class="flex flex-col gap-3" onsubmit={createTask}>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-[var(--color-text-muted)]">Title</span>
            <input
              type="text"
              required
              bind:value={newTitle}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-[var(--color-text-muted)]">Priority</span>
            <select
              bind:value={newPriority}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Description (optional)</span>
          <textarea
            bind:value={newDescription}
            rows="2"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          ></textarea>
        </label>

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Acceptance criteria (optional)</span>
          <textarea
            bind:value={newAcceptanceCriteria}
            rows="2"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          ></textarea>
        </label>

        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Assignee (optional)</span>
          <select
            bind:value={newAssigneeId}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          >
            <option value="">Unassigned</option>
            {#each agents as agent (agent.id)}
              <option value={agent.id}>{agent.name}</option>
            {/each}
          </select>
        </label>

        {#if createTaskError}
          <p class="text-sm text-[var(--color-danger)]">{createTaskError}</p>
        {/if}

        <div>
          <button
            type="submit"
            disabled={creatingTask}
            class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
          >
            {creatingTask ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </form>
    </section>

    <div class="overflow-x-auto">
      <div class="flex items-start gap-4 pb-2">
        {#each columns as column, colIndex (column.id)}
          <div class="flex w-64 shrink-0 flex-col gap-2 sm:w-72">
            <div class="flex items-center justify-between gap-2 px-0.5">
              <h3 class="text-sm font-semibold">{column.name}</h3>
              <span class="text-xs text-[var(--color-text-muted)]">{column.tasks.length}</span>
            </div>

            <div
              class="flex min-h-[100px] flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2"
              use:dndzone={{ items: column.tasks, flipDurationMs, type: dndType }}
              onconsider={(e) => handleConsider(colIndex, e as CustomEvent<DndDetail>)}
              onfinalize={(e) => handleFinalize(colIndex, e as CustomEvent<DndDetail>)}
            >
              {#each column.tasks as task (task.id)}
                <div animate:flip={{ duration: flipDurationMs }}>
                  <div
                    class="flex cursor-pointer flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm shadow-sm"
                    role="button"
                    tabindex="0"
                    aria-expanded={expandedTaskId === task.id}
                    onclick={() => toggleExpand(task.id)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(task.id);
                      }
                    }}
                  >
                    <div class="flex items-start justify-between gap-2">
                      <p class="font-medium leading-snug">{task.title}</p>
                      {#if task.status === 'blocked'}
                        <span
                          class="shrink-0 rounded-full border border-[var(--color-danger)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)]"
                        >
                          Blocked
                        </span>
                      {/if}
                    </div>

                    <div class="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        class="rounded-full px-2 py-0.5 font-medium {priorityClasses(
                          task.priority,
                        )}"
                      >
                        {priorityLabel(task.priority)}
                      </span>
                      <span class="text-[var(--color-text-muted)]"
                        >{assigneeName(task.assignee_id)}</span
                      >
                    </div>

                    {#if expandedTaskId === task.id}
                      <div
                        class="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-muted)]"
                      >
                        <p>
                          <span class="font-medium text-[var(--color-text)]">Description:</span>
                          {task.description || 'No description.'}
                        </p>
                        <p>
                          <span class="font-medium text-[var(--color-text)]"
                            >Acceptance criteria:</span
                          >
                          {task.acceptance_criteria || 'None.'}
                        </p>
                        {#if task.due_at}
                          <p>
                            <span class="font-medium text-[var(--color-text)]">Due:</span>
                            {formatDate(task.due_at)}
                          </p>
                        {/if}
                        {#if taskArtifacts[task.id]?.length}
                          <div class="flex flex-col gap-1">
                            <span class="font-medium text-[var(--color-text)]">Artifacts:</span>
                            <div class="flex flex-wrap gap-1.5">
                              {#each taskArtifacts[task.id] as artifact (artifact.id)}
                                <a
                                  href={`/artifacts?id=${artifact.id}`}
                                  onclick={(e) => e.stopPropagation()}
                                  class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"
                                >
                                  {artifact.kind} · {artifact.title} (v{artifact.version})
                                </a>
                              {/each}
                            </div>
                          </div>
                        {/if}
                      </div>
                    {/if}

                    <!--
                      These handlers add no interaction of their own - they
                      only stop a click/drag on the assignee control from
                      reaching the card wrapper above, which is a
                      `role="button"` that toggles expand (and a dndzone
                      drag source). The `<select>` inside keeps its own
                      native keyboard handling, and the `<label>` keeps its
                      labelling semantics, so the two a11y rules below are
                      false positives here rather than a missing keyboard
                      affordance.
                    -->
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
                    <label
                      class="flex items-center gap-1.5 text-xs"
                      onclick={(e) => e.stopPropagation()}
                      onmousedown={(e) => e.stopPropagation()}
                    >
                      <span class="shrink-0 text-[var(--color-text-muted)]">Assignee</span>
                      <select
                        value={task.assignee_id ?? ''}
                        onchange={(e) =>
                          reassignTask(
                            task.id,
                            (e.currentTarget as HTMLSelectElement).value || null,
                          )}
                        class="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-xs text-[var(--color-text)]"
                      >
                        <option value="">Unassigned</option>
                        {#each agents as agent (agent.id)}
                          <option value={agent.id}>{agent.name}</option>
                        {/each}
                      </select>
                    </label>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { goto } from '$app/navigation';
  import { Icon } from '$lib/icons';
  import Modal from '$lib/ui/Modal.svelte';

  // Matches ProjectRow from apps/server's projects router. Timestamps are
  // plain ISO strings on the wire (no superjson transformer), not Date
  // objects, even though @katnor/core's zod schemas type them as `Date` -
  // hence the `as unknown as ProjectRow[]` casts below rather than trusting
  // tRPC's inferred type directly.
  interface ProjectRow {
    id: string;
    created_at: string;
    updated_at: string;
    name: string;
    description: string;
    repos: unknown[];
    workspace_id: string | null;
    board_settings: { columns: { id: string; name: string; status: string }[] };
    wiki_path: string;
  }

  let projects = $state<ProjectRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let createOpen = $state(false);
  let name = $state('');
  let description = $state('');
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // Delete is owner-only + confirmed (see the modal below): it drops the
  // board, tasks, channels, and wiki with the project.
  let deleteTarget = $state<ProjectRow | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  function openCreate(): void {
    createError = null;
    createOpen = true;
  }

  function closeCreate(): void {
    if (creating) return;
    createOpen = false;
    createError = null;
  }

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
    loading = true;
    loadError = null;
    try {
      projects = (await trpc().projects.list.query()) as unknown as ProjectRow[];
    } catch (err) {
      loadError = describeError(err);
    } finally {
      loading = false;
    }
  }

  // Runs once on mount: the call itself is async, so nothing reactive is
  // read synchronously inside this effect and it won't re-run afterwards.
  $effect(() => {
    loadProjects();
  });

  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (event.type === 'project.created' || event.type === 'project.deleted') loadProjects();
    });
    return unsub;
  });

  async function createProject(event: SubmitEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    creating = true;
    createError = null;
    try {
      const created = await trpc().projects.create.mutate({
        name: trimmedName,
        description: description.trim(),
      });
      name = '';
      description = '';
      createOpen = false;
      await goto(`/projects/${created.id}`);
    } catch (err) {
      createError = describeError(err);
    } finally {
      creating = false;
    }
  }

  function openDelete(project: ProjectRow): void {
    deleteError = null;
    deleteTarget = project;
    deleteOpen = true;
  }

  function closeDelete(): void {
    if (deleting) return;
    deleteOpen = false;
    deleteTarget = null;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target || deleting) return;
    deleting = true;
    deleteError = null;
    try {
      await trpc().projects.delete.mutate({ id: target.id });
      deleteOpen = false;
      deleteTarget = null;
      await loadProjects();
    } catch (err) {
      deleteError = describeError(err);
    } finally {
      deleting = false;
    }
  }
</script>

<Modal open={createOpen} title="New project" onclose={closeCreate}>
  <form class="flex flex-col gap-3" onsubmit={createProject}>
    <label class="flex flex-col gap-1 text-sm">
      <span class="text-[var(--color-text-muted)]">Name</span>
      <input
        type="text"
        required
        bind:value={name}
        placeholder="e.g. Marketing site redesign"
        class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="text-[var(--color-text-muted)]">Description (optional)</span>
      <textarea
        bind:value={description}
        rows="2"
        placeholder="What is this project for?"
        class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
      ></textarea>
    </label>

    {#if createError}
      <p class="text-sm text-[var(--color-danger)]">{createError}</p>
    {/if}

    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        onclick={closeCreate}
        disabled={creating}
        class="btn-press rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={creating}
        class="btn-press rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
      >
        {creating ? 'Creating…' : 'Create project'}
      </button>
    </div>
  </form>
</Modal>

<Modal open={deleteOpen} title="Delete project?" onclose={closeDelete}>
  {#if deleteTarget}
    <div class="flex flex-col gap-4">
      <p class="text-sm">
        Delete <span class="font-medium">{deleteTarget.name}</span>? Its board, tasks,
        channels, and wiki go with it — this can't be undone.
      </p>
      {#if deleteError}
        <p class="text-sm text-[var(--color-danger)]">{deleteError}</p>
      {/if}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          onclick={closeDelete}
          disabled={deleting}
          class="btn-press rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={confirmDelete}
          disabled={deleting}
          class="btn-press rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  {/if}
</Modal>

<div class="p-4 sm:p-6"><div class="mx-auto flex max-w-3xl flex-col gap-6">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold">Projects</h1>
      <p class="mt-1 text-[var(--color-text-muted)]">
        Every project's kanban board, from backlog through done.
      </p>
    </div>
    <button
      type="button"
      onclick={openCreate}
      class="btn-press flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)]"
    >
      <Icon name="plus" size="1em" />
      New project
    </button>
  </div>

  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">All projects</h2>
      <button
        type="button"
        class="btn-press rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadProjects}
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Reload'}
      </button>
    </div>

    {#if loadError}
      <div
        class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
      >
        <p class="font-medium text-[var(--color-danger)]">Couldn't load projects</p>
        <p class="text-[var(--color-text-muted)]">{loadError}</p>
        <p class="text-[var(--color-text-muted)]">
          apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong
          place. This will try again on Reload.
        </p>
      </div>
    {:else if loading}
      <p class="text-sm text-[var(--color-text-muted)]">Loading projects…</p>
    {:else if projects.length === 0}
      <div
        class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center"
      >
        <p class="text-sm font-medium">No projects yet</p>
        <p class="max-w-sm text-sm text-[var(--color-text-muted)]">
          Create your first project to get a kanban board, a team channel, and a wiki.
        </p>
        <button
          type="button"
          onclick={openCreate}
          class="btn-press flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          <Icon name="plus" size="1em" />
          New project
        </button>
      </div>
    {:else}
      <div class="flex flex-col gap-3">
        {#each projects as project, i (project.id)}
          <div
            class="card-lift enter flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            style="--enter-i: {Math.min(i, 8)}"
          >
            <a
              href={`/projects/${project.id}`}
              class="flex min-w-0 flex-1 items-center gap-3"
              aria-label={`Open ${project.name}`}
            >
              <span
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-muted)] text-base font-semibold text-[var(--color-accent)]"
                aria-hidden="true"
              >
                {project.name.trim().charAt(0).toUpperCase() || '?'}
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="truncate font-medium">{project.name}</span>
                {#if project.description}
                  <span class="truncate text-sm text-[var(--color-text-muted)]"
                    >{project.description}</span
                  >
                {:else}
                  <span class="truncate text-sm italic text-[var(--color-text-muted)]"
                    >No description.</span
                  >
                {/if}
              </span>
              <Icon name="arrowRight" class="shrink-0 text-[var(--color-text-muted)]" />
            </a>
            <button
              type="button"
              onclick={() => openDelete(project)}
              class="btn-press shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)]"
              aria-label={`Delete ${project.name}`}
            >
              Delete
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>
</div>

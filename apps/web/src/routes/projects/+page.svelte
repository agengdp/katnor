<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { goto } from '$app/navigation';

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

  let name = $state('');
  let description = $state('');
  let creating = $state(false);
  let createError = $state<string | null>(null);

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
      if (event.type === 'project.created') loadProjects();
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
      await goto(`/projects/${created.id}`);
    } catch (err) {
      createError = describeError(err);
      creating = false;
    }
  }
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Projects</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Every project's kanban board, from backlog through done.
    </p>
  </div>

  <section
    class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  >
    <h2 class="text-lg font-semibold">Create project</h2>
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

      <div>
        <button
          type="submit"
          disabled={creating}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  </section>

  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">All projects</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
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
      <p class="text-sm text-[var(--color-text-muted)]">
        No projects yet - create one to get started.
      </p>
    {:else}
      <div class="flex flex-col gap-3">
        {#each projects as project (project.id)}
          <a
            href={`/projects/${project.id}`}
            class="flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:bg-[var(--color-surface-muted)]"
          >
            <h3 class="font-medium">{project.name}</h3>
            {#if project.description}
              <p class="text-sm text-[var(--color-text-muted)]">{project.description}</p>
            {:else}
              <p class="text-sm italic text-[var(--color-text-muted)]">No description.</p>
            {/if}
          </a>
        {/each}
      </div>
    {/if}
  </section>
</div>

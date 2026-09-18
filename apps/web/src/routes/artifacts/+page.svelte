<script lang="ts">
  import { ARTIFACT_KINDS, type ArtifactKind } from '@katnor/core';
  import { page } from '$app/stores';
  import { trpc, serverOrigin } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { Icon, type IconName } from '$lib/icons';

  // Local mirror of apps/server's Row shape - see projects/[id]/+page.svelte's
  // comment on why timestamps stay plain strings here (no superjson transformer).
  interface ArtifactRow {
    id: string;
    created_at: string;
    updated_at: string;
    project_id: string | null;
    task_id: string | null;
    run_id: string | null;
    artifact_group_id: string;
    version: number;
    kind: ArtifactKind;
    title: string;
    storage_key: string;
    mime: string | null;
    metadata: Record<string, unknown>;
  }

  const kindIcons: Record<ArtifactKind, IconName> = {
    file: 'fileText',
    diff: 'diff',
    pr: 'pullRequest',
    doc: 'pencil',
    image: 'image',
    design: 'layers',
    link: 'link',
    report: 'barChart',
  };

  let artifacts = $state<ArtifactRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let kindFilter = $state<ArtifactKind | 'all'>('all');

  let selected = $state<ArtifactRow | null>(null);
  let versions = $state<ArtifactRow[]>([]);
  let previewUrl = $state<string | null>(null);
  let previewText = $state<string | null>(null);
  let previewLoading = $state(false);
  let previewError = $state<string | null>(null);

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  function isTextPreviewable(row: ArtifactRow): boolean {
    if (row.kind === 'image') return false;
    if (row.mime && row.mime.startsWith('image/')) return false;
    return true;
  }

  async function loadArtifacts() {
    loading = true;
    loadError = null;
    try {
      artifacts = (await trpc().artifacts.listLatest.query({})) as unknown as ArtifactRow[];
    } catch (err) {
      loadError = describeError(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    loadArtifacts();
  });

  $effect(() => {
    const unsub = subscribeToEvents((event) => {
      if (event.type === 'artifact.created') loadArtifacts();
    });
    return unsub;
  });

  // Deep-linking from the task drawer (projects/[id]/+page.svelte) -
  // `/artifacts?id=<artifact_id>` opens straight to that artifact, even if
  // it isn't the latest version of its group (getById, not listLatest).
  $effect(() => {
    const id = $page.url.searchParams.get('id');
    if (!id) return;
    trpc()
      .artifacts.getById.query({ id })
      .then((row) => {
        if (row) selectArtifact(row as unknown as ArtifactRow);
      })
      .catch(() => {
        // Deep link pointed at something gone/invalid - leave the page in its normal empty state.
      });
  });

  function resolveUrl(rawUrl: string): string {
    return rawUrl.startsWith('http') ? rawUrl : `${serverOrigin()}${rawUrl}`;
  }

  async function selectArtifact(row: ArtifactRow) {
    selected = row;
    versions = [];
    previewUrl = null;
    previewText = null;
    previewError = null;

    try {
      versions = (await trpc().artifacts.listGroup.query({
        artifactGroupId: row.artifact_group_id,
      })) as unknown as ArtifactRow[];
    } catch {
      // Non-fatal - the detail pane still works with just `row` if this fails.
    }

    await loadPreview(row);
  }

  async function loadPreview(row: ArtifactRow) {
    previewLoading = true;
    previewError = null;
    previewText = null;
    try {
      const { url } = await trpc().artifacts.getUrl.query({ id: row.id });
      previewUrl = resolveUrl(url);
      if (isTextPreviewable(row)) {
        const response = await fetch(previewUrl);
        if (!response.ok)
          throw new Error(`Server returned ${response.status} fetching this artifact.`);
        const text = await response.text();
        // A generous but bounded preview - a multi-megabyte diff/report
        // isn't useful to render in full in a side pane.
        previewText = text.length > 50_000 ? `${text.slice(0, 50_000)}\n... (truncated)` : text;
      }
    } catch (err) {
      previewError = describeError(err);
    } finally {
      previewLoading = false;
    }
  }

  let filtered = $derived(
    kindFilter === 'all' ? artifacts : artifacts.filter((a) => a.kind === kindFilter),
  );

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }
</script>

<div class="flex flex-col gap-4">
  <div>
    <h1 class="text-2xl font-semibold">Artifacts</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Every PR, diff, doc, design export, and report the team produces, versioned and linked back to
      the task, run, and agent that made it.
    </p>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="rounded-full border px-3 py-1 text-xs font-medium {kindFilter === 'all'
        ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
        : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'}"
      onclick={() => (kindFilter = 'all')}
    >
      All
    </button>
    {#each ARTIFACT_KINDS as kind (kind)}
      <button
        type="button"
        class="rounded-full border px-3 py-1 text-xs font-medium {kindFilter === kind
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
          : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'}"
        onclick={() => (kindFilter = kind)}
      >
        <Icon name={kindIcons[kind]} />
        {kind}
      </button>
    {/each}
  </div>

  {#if loadError}
    <div
      class="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
    >
      <p class="font-medium text-[var(--color-danger)]">Couldn't load artifacts</p>
      <p class="text-[var(--color-text-muted)]">{loadError}</p>
    </div>
  {:else if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if filtered.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">
      No artifacts yet - the `save_artifact` company tool (or a work tool's auto-capture) will
      populate this as the team produces things.
    </p>
  {:else}
    <div class="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
      <div class="flex w-full flex-col gap-2 sm:w-80 sm:shrink-0">
        {#each filtered as row (row.id)}
          <button
            type="button"
            onclick={() => selectArtifact(row)}
            class="flex flex-col gap-1 rounded-lg border p-3 text-left text-sm transition-colors {selected?.id ===
            row.id
              ? 'border-[var(--color-accent)] bg-[var(--color-surface-muted)]'
              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]'}"
          >
            <div class="flex items-center gap-2">
              <Icon name={kindIcons[row.kind]} />
              <span class="font-medium leading-snug">{row.title}</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <span>v{row.version}</span>
              <span>·</span>
              <span>{formatDate(row.created_at)}</span>
            </div>
          </button>
        {/each}
      </div>

      <div
        class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        {#if !selected}
          <p class="text-sm text-[var(--color-text-muted)]">Select an artifact to preview it.</p>
        {:else}
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="text-lg font-semibold">{selected.title}</h2>
              {#if previewUrl}
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
                >
                  Open raw
                  <Icon name="externalLink" />
                </a>
              {/if}
            </div>

            {#if versions.length > 1}
              <label class="flex items-center gap-2 text-sm">
                <span class="text-[var(--color-text-muted)]">Version</span>
                <select
                  value={selected.id}
                  onchange={(e) => {
                    const row = versions.find(
                      (v) => v.id === (e.currentTarget as HTMLSelectElement).value,
                    );
                    if (row) selectArtifact(row);
                  }}
                  class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                >
                  {#each versions as v (v.id)}
                    <option value={v.id}>v{v.version} - {formatDate(v.created_at)}</option>
                  {/each}
                </select>
              </label>
            {/if}

            {#if previewLoading}
              <p class="text-sm text-[var(--color-text-muted)]">Loading preview…</p>
            {:else if previewError}
              <p class="text-sm text-[var(--color-danger)]">{previewError}</p>
            {:else if selected.kind === 'image' || selected.mime?.startsWith('image/')}
              {#if previewUrl}
                <img
                  src={previewUrl}
                  alt={selected.title}
                  class="max-h-[70vh] w-auto rounded-md border border-[var(--color-border)]"
                />
              {/if}
            {:else if previewText !== null}
              <pre
                class="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg)] p-3 text-xs">{previewText}</pre>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

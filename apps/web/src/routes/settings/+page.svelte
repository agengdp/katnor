<script lang="ts">
  import { MODEL_PROVIDERS, type ModelProvider } from '@katnor/core';
  import { trpc } from '$lib/trpc';

  type ProviderRow = {
    provider: ModelProvider;
    hasKey: boolean;
    baseUrl: string;
    enabled: boolean;
    // Draft-only input; the server never sends a real key back, so this
    // always starts empty and is cleared again after a successful save.
    apiKey: string;
    saving: boolean;
    saveError: string | null;
    justSaved: boolean;
  };

  const providerLabels: Record<ModelProvider, string> = {
    anthropic: 'Anthropic',
    openai_compatible: 'OpenAI-compatible',
    google: 'Google',
    ollama: 'Ollama (local)'
  };

  const baseUrlHints: Record<ModelProvider, string> = {
    anthropic: 'Defaults to https://api.anthropic.com - only set this for a proxy.',
    openai_compatible: 'e.g. https://api.openai.com/v1, or your own OpenAI-compatible endpoint.',
    google: 'Defaults to the Google AI API - only set this for a proxy.',
    ollama: 'e.g. http://localhost:11434'
  };

  function emptyRow(provider: ModelProvider): ProviderRow {
    return {
      provider,
      hasKey: false,
      baseUrl: '',
      // Anthropic is the one provider PLAN.md calls required, so default it
      // to enabled; the rest start off until someone fills them in.
      enabled: provider === 'anthropic',
      apiKey: '',
      saving: false,
      saveError: null,
      justSaved: false
    };
  }

  let rows = $state<ProviderRow[]>(MODEL_PROVIDERS.map(emptyRow));
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  async function loadProviders() {
    loading = true;
    loadError = null;
    try {
      const client = trpc();
      // Expected shape (see PLAN.md / this phase's task):
      // Array<{ provider, hasKey: boolean, baseUrl: string | null, enabled: boolean }>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const remote: any[] = await client.settings.listProviders.query();
      const remoteByProvider = new Map(remote.map((row) => [row.provider, row]));

      rows = MODEL_PROVIDERS.map((provider) => {
        const existing = remoteByProvider.get(provider);
        const base = emptyRow(provider);
        if (!existing) return base;
        return {
          ...base,
          hasKey: Boolean(existing.hasKey),
          baseUrl: existing.baseUrl ?? '',
          enabled: Boolean(existing.enabled)
        };
      });
    } catch (err) {
      // Most likely apps/server isn't running yet, or PUBLIC_SERVER_URL is
      // wrong - keep the form visible (with defaults) and surface a clear,
      // recoverable error instead of a blank/broken page.
      loadError = describeError(err);
    } finally {
      loading = false;
    }
  }

  // Runs once on mount: the call itself is async, so nothing reactive is
  // read synchronously inside this effect and it won't re-run afterwards.
  $effect(() => {
    loadProviders();
  });

  async function saveRow(row: ProviderRow) {
    row.saving = true;
    row.saveError = null;
    row.justSaved = false;
    try {
      const client = trpc();
      const trimmedKey = row.apiKey.trim();
      const trimmedBaseUrl = row.baseUrl.trim();
      await client.settings.upsertProvider.mutate({
        provider: row.provider,
        // Omit apiKey entirely when the field is left blank, so re-saving
        // the base URL or the enabled flag doesn't clobber an existing key.
        apiKey: trimmedKey === '' ? undefined : trimmedKey,
        baseUrl: trimmedBaseUrl === '' ? null : trimmedBaseUrl,
        enabled: row.enabled
      });
      if (trimmedKey !== '') row.hasKey = true;
      row.apiKey = '';
      row.baseUrl = trimmedBaseUrl;
      row.justSaved = true;
    } catch (err) {
      row.saveError = describeError(err);
    } finally {
      row.saving = false;
    }
  }
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Settings</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Provider API keys, live here. Everything else in Settings (model catalog, MCP tools,
      sandbox, budgets, approval policies) lands in a later phase.
    </p>
  </div>

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Model providers</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadProviders}
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Reload'}
      </button>
    </div>

    {#if loadError}
      <div
        class="flex flex-col gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] p-4 text-sm"
      >
        <p class="font-medium text-[var(--color-danger)]">Couldn't load provider settings</p>
        <p class="text-[var(--color-text-muted)]">{loadError}</p>
        <p class="text-[var(--color-text-muted)]">
          apps/server may not be running yet, or PUBLIC_SERVER_URL may be pointing at the wrong
          place. The form below still works locally and will try again on Reload or Save.
        </p>
      </div>
    {/if}

    <div class="flex flex-col gap-4">
      {#each rows as row (row.provider)}
        <div class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-medium">{providerLabels[row.provider]}</h3>
            <span class="text-xs text-[var(--color-text-muted)]">
              {row.hasKey ? 'Key set' : 'No key set'}
            </span>
          </div>

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-[var(--color-text-muted)]">API key</span>
            <input
              type="password"
              autocomplete="off"
              bind:value={row.apiKey}
              placeholder={row.hasKey ? 'Key set — leave blank to keep it' : 'Paste an API key'}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            />
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-[var(--color-text-muted)]">Base URL (optional)</span>
            <input
              type="text"
              bind:value={row.baseUrl}
              placeholder={baseUrlHints[row.provider]}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            />
          </label>

          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={row.enabled} class="h-4 w-4" />
            <span>Enabled</span>
          </label>

          {#if row.saveError}
            <p class="text-sm text-[var(--color-danger)]">{row.saveError}</p>
          {:else if row.justSaved}
            <p class="text-sm text-[var(--color-success)]">Saved.</p>
          {/if}

          <div>
            <button
              type="button"
              class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
              onclick={() => saveRow(row)}
              disabled={row.saving}
            >
              {row.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>

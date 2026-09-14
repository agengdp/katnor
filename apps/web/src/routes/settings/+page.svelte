<script lang="ts">
  import {
    APPROVAL_MODES,
    MODEL_COMBO_ENTRY_PROVIDERS,
    type ApprovalMode,
    type ModelComboEntryProvider,
    type ToolConfigKind
  } from '@katnor/core';
  import { serverOrigin, trpc } from '$lib/trpc';

  type ProviderRow = {
    provider: ModelComboEntryProvider;
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

  const providerLabels: Record<ModelComboEntryProvider, string> = {
    anthropic: 'Anthropic',
    openai_compatible: 'OpenAI-compatible',
    google: 'Google',
    ollama: 'Ollama (local)'
  };

  const baseUrlHints: Record<ModelComboEntryProvider, string> = {
    anthropic: 'Defaults to https://api.anthropic.com - only set this for a proxy.',
    openai_compatible: 'e.g. https://api.openai.com/v1, or your own OpenAI-compatible endpoint.',
    google: 'Defaults to the Google AI API - only set this for a proxy.',
    ollama: 'Defaults to http://localhost:11434/v1 (Ollama\'s own OpenAI-compatible endpoint) - only set this if Ollama runs elsewhere.'
  };

  // Note: "combo" (@katnor/core's MODEL_PROVIDERS) is deliberately absent
  // from both maps above and from the connection rows below - it isn't a
  // real backend with its own base_url/api_key, just a named fallback
  // chain across the providers listed here. It gets its own "Model
  // Combos" section further down this page instead.

  function emptyRow(provider: ModelComboEntryProvider): ProviderRow {
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

  let rows = $state<ProviderRow[]>(MODEL_COMBO_ENTRY_PROVIDERS.map(emptyRow));
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

      rows = MODEL_COMBO_ENTRY_PROVIDERS.map((provider) => {
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

  // ─── MCP servers (tool_config) ─────────────────────────────────────────

  interface ToolConfigRow {
    id: string;
    kind: ToolConfigKind;
    name: string;
    command: string | null;
    url: string | null;
    env_secret_refs: string[];
    enabled: boolean;
  }

  let toolConfigs = $state<ToolConfigRow[]>([]);
  let toolConfigsLoading = $state(true);
  let toolConfigsError = $state<string | null>(null);

  let newServerName = $state('');
  let newServerCommand = $state('');
  let newServerUrl = $state('');
  let newServerSecretRefs = $state('');
  let creatingServer = $state(false);
  let createServerError = $state<string | null>(null);

  async function loadToolConfigs() {
    toolConfigsLoading = true;
    toolConfigsError = null;
    try {
      toolConfigs = (await trpc().toolConfigs.list.query()) as unknown as ToolConfigRow[];
    } catch (err) {
      toolConfigsError = describeError(err);
    } finally {
      toolConfigsLoading = false;
    }
  }

  $effect(() => {
    loadToolConfigs();
  });

  function parseSecretRefs(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async function createServer(event: SubmitEvent) {
    event.preventDefault();
    const name = newServerName.trim();
    const command = newServerCommand.trim();
    const url = newServerUrl.trim();
    if (!name || (!command && !url)) {
      createServerError = 'A name and either a command (stdio) or a URL (HTTP/SSE) are required.';
      return;
    }
    creatingServer = true;
    createServerError = null;
    try {
      await trpc().toolConfigs.create.mutate({
        kind: 'mcp',
        name,
        command: command || null,
        url: url || null,
        envSecretRefs: parseSecretRefs(newServerSecretRefs),
        enabled: true
      });
      newServerName = '';
      newServerCommand = '';
      newServerUrl = '';
      newServerSecretRefs = '';
      await loadToolConfigs();
    } catch (err) {
      createServerError = describeError(err);
    } finally {
      creatingServer = false;
    }
  }

  async function toggleServerEnabled(row: ToolConfigRow) {
    try {
      await trpc().toolConfigs.update.mutate({ id: row.id, enabled: !row.enabled });
      await loadToolConfigs();
    } catch (err) {
      toolConfigsError = describeError(err);
    }
  }

  async function removeServer(row: ToolConfigRow) {
    try {
      await trpc().toolConfigs.remove.mutate({ id: row.id });
      await loadToolConfigs();
    } catch (err) {
      toolConfigsError = describeError(err);
    }
  }

  // ─── Secrets ────────────────────────────────────────────────────────────

  interface SecretRow {
    name: string;
    updatedAt: string;
  }

  let secrets = $state<SecretRow[]>([]);
  let secretsLoading = $state(true);
  let secretsError = $state<string | null>(null);

  let newSecretName = $state('');
  let newSecretValue = $state('');
  let savingSecret = $state(false);
  let saveSecretError = $state<string | null>(null);

  async function loadSecrets() {
    secretsLoading = true;
    secretsError = null;
    try {
      secrets = (await trpc().secrets.list.query()) as unknown as SecretRow[];
    } catch (err) {
      secretsError = describeError(err);
    } finally {
      secretsLoading = false;
    }
  }

  $effect(() => {
    loadSecrets();
  });

  async function saveSecret(event: SubmitEvent) {
    event.preventDefault();
    const name = newSecretName.trim();
    const value = newSecretValue.trim();
    if (!name || !value) {
      saveSecretError = 'A name (e.g. GITHUB_TOKEN) and a value are required.';
      return;
    }
    savingSecret = true;
    saveSecretError = null;
    try {
      await trpc().secrets.upsert.mutate({ name, value });
      newSecretName = '';
      newSecretValue = '';
      await loadSecrets();
    } catch (err) {
      saveSecretError = describeError(err);
    } finally {
      savingSecret = false;
    }
  }

  async function removeSecret(row: SecretRow) {
    try {
      await trpc().secrets.remove.mutate({ name: row.name });
      await loadSecrets();
    } catch (err) {
      secretsError = describeError(err);
    }
  }

  // ─── Budgets & approval policy ──────────────────────────────────────────

  const approvalModeLabels: Record<ApprovalMode, string> = {
    auto: 'Auto (never ask)',
    ask_once_per_project: 'Ask once per project',
    always_ask: 'Always ask'
  };

  let companyDailyUsd = $state(0);
  // Plain text, not `type="number"` + `number | null`, deliberately: an
  // empty numeric input binds to 0 in Svelte, not null, which would make
  // "leave it blank for no cap" silently save a real $0/day cap instead.
  let projectDailyUsdText = $state('');
  let agentDailyUsdText = $state('');
  let hirePolicy = $state<ApprovalMode>('always_ask');
  let toolCallPolicy = $state<ApprovalMode>('auto');
  let spendPolicy = $state<ApprovalMode>('ask_once_per_project');

  let budgetsLoading = $state(true);
  let budgetsError = $state<string | null>(null);
  let savingBudgets = $state(false);
  let budgetsSaved = $state(false);
  let savingPolicy = $state(false);
  let policySaved = $state(false);

  async function loadCompanySettings() {
    budgetsLoading = true;
    budgetsError = null;
    try {
      const settings = await trpc().settings.getCompanySettings.query();
      companyDailyUsd = settings.budgets.company_daily_usd;
      projectDailyUsdText = settings.budgets.project_daily_usd !== undefined ? String(settings.budgets.project_daily_usd) : '';
      agentDailyUsdText = settings.budgets.agent_daily_usd !== undefined ? String(settings.budgets.agent_daily_usd) : '';
      hirePolicy = settings.approval_policy.hire;
      toolCallPolicy = settings.approval_policy.tool_call;
      spendPolicy = settings.approval_policy.spend;
    } catch (err) {
      budgetsError = describeError(err);
    } finally {
      budgetsLoading = false;
    }
  }

  $effect(() => {
    loadCompanySettings();
  });

  async function saveBudgets(event: SubmitEvent) {
    event.preventDefault();
    savingBudgets = true;
    budgetsError = null;
    budgetsSaved = false;
    try {
      const trimmedProject = projectDailyUsdText.trim();
      const trimmedAgent = agentDailyUsdText.trim();
      await trpc().settings.updateBudgets.mutate({
        company_daily_usd: companyDailyUsd,
        project_daily_usd: trimmedProject === '' ? undefined : Number(trimmedProject),
        agent_daily_usd: trimmedAgent === '' ? undefined : Number(trimmedAgent)
      });
      budgetsSaved = true;
    } catch (err) {
      budgetsError = describeError(err);
    } finally {
      savingBudgets = false;
    }
  }

  async function savePolicy(event: SubmitEvent) {
    event.preventDefault();
    savingPolicy = true;
    budgetsError = null;
    policySaved = false;
    try {
      await trpc().settings.updateApprovalPolicy.mutate({ hire: hirePolicy, tool_call: toolCallPolicy, spend: spendPolicy });
      policySaved = true;
    } catch (err) {
      budgetsError = describeError(err);
    } finally {
      savingPolicy = false;
    }
  }

  // ─── Team members (PLAN.md Phase 5's multi-user auth) ───────────────────

  type UserRow = { id: string; name: string; email: string; created_at: string };

  let users = $state<UserRow[]>([]);
  let usersLoading = $state(true);
  let usersError = $state<string | null>(null);

  let newUserName = $state('');
  let newUserEmail = $state('');
  let newUserPassword = $state('');
  let addingUser = $state(false);
  let addUserError = $state<string | null>(null);

  let removingIds = $state<Record<string, boolean>>({});

  async function loadUsers() {
    usersLoading = true;
    usersError = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      users = (await trpc().users.list.query()) as any as UserRow[];
    } catch (err) {
      usersError = describeError(err);
    } finally {
      usersLoading = false;
    }
  }

  $effect(() => {
    loadUsers();
  });

  async function addUser(event: SubmitEvent) {
    event.preventDefault();
    addingUser = true;
    addUserError = null;
    try {
      await trpc().users.create.mutate({ name: newUserName.trim(), email: newUserEmail.trim(), password: newUserPassword });
      newUserName = '';
      newUserEmail = '';
      newUserPassword = '';
      await loadUsers();
    } catch (err) {
      addUserError = describeError(err);
    } finally {
      addingUser = false;
    }
  }

  async function removeUser(id: string) {
    removingIds[id] = true;
    usersError = null;
    try {
      await trpc().users.remove.mutate({ id });
      await loadUsers();
    } catch (err) {
      usersError = describeError(err);
    } finally {
      removingIds[id] = false;
    }
  }

  // ─── Model combos (named fallback chains across providers) ──────────────

  type ComboEntryDraft = { provider: ModelComboEntryProvider; model: string };
  type ComboRow = { id: string; name: string; entries: ComboEntryDraft[] };

  let combos = $state<ComboRow[]>([]);
  let combosLoading = $state(true);
  let combosError = $state<string | null>(null);

  function emptyEntry(): ComboEntryDraft {
    return { provider: 'anthropic', model: '' };
  }

  let newComboName = $state('');
  let newComboEntries = $state<ComboEntryDraft[]>([emptyEntry()]);
  let creatingCombo = $state(false);
  let createComboError = $state<string | null>(null);

  let editingComboId = $state<string | null>(null);
  let editComboName = $state('');
  let editComboEntries = $state<ComboEntryDraft[]>([]);
  let savingComboEdit = $state(false);
  let editComboError = $state<string | null>(null);

  let removingComboIds = $state<Record<string, boolean>>({});

  async function loadCombos() {
    combosLoading = true;
    combosError = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      combos = (await trpc().modelCombos.list.query()) as any as ComboRow[];
    } catch (err) {
      combosError = describeError(err);
    } finally {
      combosLoading = false;
    }
  }

  $effect(() => {
    loadCombos();
  });

  function sanitizeEntries(entries: ComboEntryDraft[]): ComboEntryDraft[] {
    return entries.map((e) => ({ provider: e.provider, model: e.model.trim() })).filter((e) => e.model.length > 0);
  }

  async function createCombo(event: SubmitEvent) {
    event.preventDefault();
    const name = newComboName.trim();
    const entries = sanitizeEntries(newComboEntries);
    if (!name || entries.length === 0) {
      createComboError = 'A name and at least one entry (provider + model) are required.';
      return;
    }
    creatingCombo = true;
    createComboError = null;
    try {
      await trpc().modelCombos.create.mutate({ name, entries });
      newComboName = '';
      newComboEntries = [emptyEntry()];
      await loadCombos();
    } catch (err) {
      createComboError = describeError(err);
    } finally {
      creatingCombo = false;
    }
  }

  function startEditCombo(row: ComboRow) {
    if (editingComboId === row.id) {
      editingComboId = null;
      return;
    }
    editingComboId = row.id;
    editComboName = row.name;
    editComboEntries = row.entries.map((e) => ({ ...e }));
    editComboError = null;
  }

  async function saveComboEdit() {
    if (!editingComboId) return;
    const name = editComboName.trim();
    const entries = sanitizeEntries(editComboEntries);
    if (!name || entries.length === 0) {
      editComboError = 'A name and at least one entry (provider + model) are required.';
      return;
    }
    savingComboEdit = true;
    editComboError = null;
    try {
      await trpc().modelCombos.update.mutate({ id: editingComboId, name, entries });
      editingComboId = null;
      await loadCombos();
    } catch (err) {
      editComboError = describeError(err);
    } finally {
      savingComboEdit = false;
    }
  }

  async function removeCombo(id: string) {
    removingComboIds[id] = true;
    combosError = null;
    try {
      await trpc().modelCombos.remove.mutate({ id });
      await loadCombos();
    } catch (err) {
      combosError = describeError(err);
    } finally {
      removingComboIds[id] = false;
    }
  }
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Settings</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Provider API keys, MCP servers, and secrets live here. Model catalog, sandbox, budgets, and
      approval policy editing land in a later phase.
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

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">MCP servers</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadToolConfigs}
        disabled={toolConfigsLoading}
      >
        {toolConfigsLoading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      Each server here becomes available to an agent by adding <code>mcp__&lt;name&gt;</code> to
      their tool allowlist - see <code>@katnor/agents</code>' <code>mcpTools.ts</code>.
    </p>

    {#if toolConfigsError}
      <p class="text-sm text-[var(--color-danger)]">{toolConfigsError}</p>
    {/if}

    <div class="flex flex-col gap-3">
      {#each toolConfigs as row (row.id)}
        <div class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-medium">{row.name}</h3>
            <span class="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
              {row.kind}
            </span>
          </div>
          {#if row.command}
            <p class="text-xs text-[var(--color-text-muted)]">Command: <code>{row.command}</code></p>
          {/if}
          {#if row.url}
            <p class="text-xs text-[var(--color-text-muted)]">URL: <code>{row.url}</code></p>
          {/if}
          {#if row.env_secret_refs.length > 0}
            <p class="text-xs text-[var(--color-text-muted)]">
              Env secrets: {row.env_secret_refs.join(', ')}
            </p>
          {/if}
          <div class="flex items-center gap-3">
            <label class="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={row.enabled} onchange={() => toggleServerEnabled(row)} class="h-4 w-4" />
              <span>Enabled</span>
            </label>
            <button
              type="button"
              class="rounded-md border border-[var(--color-danger)] px-2 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)]"
              onclick={() => removeServer(row)}
            >
              Remove
            </button>
          </div>
        </div>
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">No MCP servers configured yet.</p>
      {/each}
    </div>

    <form class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" onsubmit={createServer}>
      <h3 class="text-sm font-semibold">Add a server</h3>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Name</span>
        <input
          type="text"
          bind:value={newServerName}
          placeholder="github"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Command (stdio server)</span>
        <input
          type="text"
          bind:value={newServerCommand}
          placeholder="npx -y @modelcontextprotocol/server-github"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">URL (HTTP/SSE server, instead of a command)</span>
        <input
          type="text"
          bind:value={newServerUrl}
          placeholder="https://example.com/mcp"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Env secret names (comma-separated, e.g. GITHUB_TOKEN)</span>
        <input
          type="text"
          bind:value={newServerSecretRefs}
          placeholder="GITHUB_TOKEN"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      {#if createServerError}
        <p class="text-sm text-[var(--color-danger)]">{createServerError}</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={creatingServer}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {creatingServer ? 'Adding…' : 'Add server'}
        </button>
      </div>
    </form>
  </section>

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Secrets</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadSecrets}
        disabled={secretsLoading}
      >
        {secretsLoading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      Encrypted at rest, and never sent back to this page once saved - reference a secret's name
      from an MCP server's env secret names above.
    </p>

    {#if secretsError}
      <p class="text-sm text-[var(--color-danger)]">{secretsError}</p>
    {/if}

    <div class="flex flex-col gap-2">
      {#each secrets as row (row.name)}
        <div class="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
          <span class="font-medium">{row.name}</span>
          <button
            type="button"
            class="rounded-md border border-[var(--color-danger)] px-2 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)]"
            onclick={() => removeSecret(row)}
          >
            Remove
          </button>
        </div>
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">No secrets stored yet.</p>
      {/each}
    </div>

    <form class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" onsubmit={saveSecret}>
      <h3 class="text-sm font-semibold">Add or replace a secret</h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Name</span>
          <input
            type="text"
            bind:value={newSecretName}
            placeholder="GITHUB_TOKEN"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Value</span>
          <input
            type="password"
            autocomplete="off"
            bind:value={newSecretValue}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
      </div>
      {#if saveSecretError}
        <p class="text-sm text-[var(--color-danger)]">{saveSecretError}</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={savingSecret}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {savingSecret ? 'Saving…' : 'Save secret'}
        </button>
      </div>
    </form>
  </section>

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Budgets & approval policy</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadCompanySettings}
        disabled={budgetsLoading}
      >
        {budgetsLoading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      Daily budgets are hard stops (PLAN.md's Phase 5) - a run that would push the company, its own
      agent, or its project over its daily budget doesn't start. What happens next follows the "Spend
      beyond budget" policy below: paused and sent to your Inbox to approve or reject, or - only under
      "Auto" - let through anyway. Leave project/agent blank for no per-project/per-agent cap beyond
      each agent's own budget (set per-agent on the Team page).
    </p>

    {#if budgetsError}
      <p class="text-sm text-[var(--color-danger)]">{budgetsError}</p>
    {/if}

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={saveBudgets}
    >
      <h3 class="text-sm font-semibold">Budgets (USD/day)</h3>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Company-wide</span>
          <input
            type="number"
            min="0"
            step="0.01"
            required
            bind:value={companyDailyUsd}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Per project (optional)</span>
          <input
            type="text"
            inputmode="decimal"
            placeholder="No cap"
            bind:value={projectDailyUsdText}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Default per agent (optional)</span>
          <input
            type="text"
            inputmode="decimal"
            placeholder="No cap"
            bind:value={agentDailyUsdText}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
      </div>
      {#if budgetsSaved}
        <p class="text-sm text-[var(--color-success)]">Saved.</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={savingBudgets}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {savingBudgets ? 'Saving…' : 'Save budgets'}
        </button>
      </div>
    </form>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={savePolicy}
    >
      <h3 class="text-sm font-semibold">Approval policy</h3>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Hiring</span>
          <select bind:value={hirePolicy} class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm">
            {#each APPROVAL_MODES as mode (mode)}
              <option value={mode}>{approvalModeLabels[mode]}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Dangerous tool calls (e.g. git push)</span>
          <select bind:value={toolCallPolicy} class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm">
            {#each APPROVAL_MODES as mode (mode)}
              <option value={mode}>{approvalModeLabels[mode]}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Spend beyond budget</span>
          <select bind:value={spendPolicy} class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm">
            {#each APPROVAL_MODES as mode (mode)}
              <option value={mode}>{approvalModeLabels[mode]}</option>
            {/each}
          </select>
        </label>
      </div>
      {#if policySaved}
        <p class="text-sm text-[var(--color-success)]">Saved.</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={savingPolicy}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {savingPolicy ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </form>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-lg font-semibold">Backups</h2>
    <p class="text-sm text-[var(--color-text-muted)]">
      Downloads a single JSON file with every core table (company, teams, agents, projects, tasks,
      runs, messages, the knowledge graph, wiki pages, ...) plus every project's wiki files.
      Provider/secret values are never included - only whether one is set. Artifact file bytes
      (PRs, diffs, screenshots) aren't included either, just their metadata; the underlying storage
      backend (local disk or MinIO) needs its own backup.
    </p>
    <div>
      <a
        href={`${serverOrigin()}/export/backup`}
        class="inline-block rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
      >
        Download backup
      </a>
    </div>
  </section>

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Team members</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadUsers}
        disabled={usersLoading}
      >
        {usersLoading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      Anyone who can log in has the same access - there's no owner/member distinction (PLAN.md's
      Phase 5 multi-user auth). There's no self-serve signup: add a teammate here with a password
      they can change later; removing the last remaining account is blocked so nobody gets locked
      out.
    </p>

    {#if usersError}
      <p class="text-sm text-[var(--color-danger)]">{usersError}</p>
    {/if}

    <div class="flex flex-col gap-2">
      {#each users as row (row.id)}
        <div class="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="flex flex-col">
            <span class="text-sm font-medium">{row.name}</span>
            <span class="text-xs text-[var(--color-text-muted)]">{row.email}</span>
          </div>
          <button
            type="button"
            onclick={() => removeUser(row.id)}
            disabled={removingIds[row.id] || users.length <= 1}
            title={users.length <= 1 ? "Can't remove the last remaining account" : 'Remove this teammate'}
            class="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
          >
            {removingIds[row.id] ? 'Removing…' : 'Remove'}
          </button>
        </div>
      {/each}
      {#if !usersLoading && users.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No accounts yet.</p>
      {/if}
    </div>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={addUser}
    >
      <h3 class="text-sm font-semibold">Add a teammate</h3>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Name</span>
          <input
            type="text"
            required
            bind:value={newUserName}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Email</span>
          <input
            type="email"
            required
            bind:value={newUserEmail}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Password</span>
          <input
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            bind:value={newUserPassword}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
      </div>
      {#if addUserError}
        <p class="text-sm text-[var(--color-danger)]">{addUserError}</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={addingUser}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {addingUser ? 'Adding…' : 'Add teammate'}
        </button>
      </div>
    </form>
  </section>

  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Model combos</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadCombos}
        disabled={combosLoading}
      >
        {combosLoading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      A combo is a named, ordered fallback chain across providers - hire an agent onto "Combo" (Team
      page) and pick one of these by name instead of a single model. On each call, Katnor tries the
      first entry; if it errors, it automatically tries the next, in order, and uses the first one
      that answers.
    </p>

    {#if combosError}
      <p class="text-sm text-[var(--color-danger)]">{combosError}</p>
    {/if}

    <div class="flex flex-col gap-2">
      {#each combos as row (row.id)}
        <div class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col">
              <span class="text-sm font-medium">{row.name}</span>
              <span class="text-xs text-[var(--color-text-muted)]">
                {row.entries.map((e) => `${providerLabels[e.provider] ?? e.provider}/${e.model}`).join(' → ')}
              </span>
            </div>
            <div class="flex shrink-0 gap-2">
              <button
                type="button"
                onclick={() => startEditCombo(row)}
                class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
              >
                {editingComboId === row.id ? 'Close' : 'Edit'}
              </button>
              <button
                type="button"
                onclick={() => removeCombo(row.id)}
                disabled={removingComboIds[row.id]}
                class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
              >
                {removingComboIds[row.id] ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>

          {#if editingComboId === row.id}
            <form
              class="flex flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
              onsubmit={(event) => {
                event.preventDefault();
                saveComboEdit();
              }}
            >
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-[var(--color-text-muted)]">Name</span>
                <input
                  type="text"
                  required
                  bind:value={editComboName}
                  class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
                />
              </label>
              <div class="flex flex-col gap-2">
                <span class="text-sm text-[var(--color-text-muted)]">Entries, tried in order</span>
                {#each editComboEntries as entry, i (i)}
                  <div class="flex items-center gap-2">
                    <select
                      bind:value={entry.provider}
                      class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                    >
                      {#each MODEL_COMBO_ENTRY_PROVIDERS as p (p)}
                        <option value={p}>{providerLabels[p]}</option>
                      {/each}
                    </select>
                    <input
                      type="text"
                      placeholder="model id"
                      bind:value={entry.model}
                      class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
                    />
                    <button
                      type="button"
                      onclick={() => (editComboEntries = editComboEntries.filter((_, idx) => idx !== i))}
                      disabled={editComboEntries.length <= 1}
                      class="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                {/each}
                <div>
                  <button
                    type="button"
                    onclick={() => (editComboEntries = [...editComboEntries, emptyEntry()])}
                    class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
                  >
                    + Add fallback entry
                  </button>
                </div>
              </div>
              {#if editComboError}
                <p class="text-sm text-[var(--color-danger)]">{editComboError}</p>
              {/if}
              <div>
                <button
                  type="submit"
                  disabled={savingComboEdit}
                  class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
                >
                  {savingComboEdit ? 'Saving…' : 'Save combo'}
                </button>
              </div>
            </form>
          {/if}
        </div>
      {/each}
      {#if !combosLoading && combos.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No model combos yet.</p>
      {/if}
    </div>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={createCombo}
    >
      <h3 class="text-sm font-semibold">New combo</h3>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Name</span>
        <input
          type="text"
          required
          placeholder="e.g. claude-opus-combo"
          bind:value={newComboName}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      <div class="flex flex-col gap-2">
        <span class="text-sm text-[var(--color-text-muted)]">Entries, tried in order</span>
        {#each newComboEntries as entry, i (i)}
          <div class="flex items-center gap-2">
            <select
              bind:value={entry.provider}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            >
              {#each MODEL_COMBO_ENTRY_PROVIDERS as p (p)}
                <option value={p}>{providerLabels[p]}</option>
              {/each}
            </select>
            <input
              type="text"
              placeholder="model id"
              bind:value={entry.model}
              class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            />
            <button
              type="button"
              onclick={() => (newComboEntries = newComboEntries.filter((_, idx) => idx !== i))}
              disabled={newComboEntries.length <= 1}
              class="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        {/each}
        <div>
          <button
            type="button"
            onclick={() => (newComboEntries = [...newComboEntries, emptyEntry()])}
            class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
          >
            + Add fallback entry
          </button>
        </div>
      </div>
      {#if createComboError}
        <p class="text-sm text-[var(--color-danger)]">{createComboError}</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={creatingCombo}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {creatingCombo ? 'Creating…' : 'Create combo'}
        </button>
      </div>
    </form>
  </section>
</div>

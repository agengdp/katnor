<script lang="ts">
  import {
    APPROVAL_MODES,
    MODEL_COMBO_ENTRY_PROVIDERS,
    type ApprovalMode,
    type ModelComboEntryProvider,
    type ModelStrategy,
    type ToolConfigKind,
  } from '@katnor/core';
  import { serverOrigin, trpc } from '$lib/trpc';

  type ProviderConnection = {
    id: string;
    name: string;
    provider: ModelComboEntryProvider;
    hasKey: boolean;
    baseUrl: string | null;
    enabled: boolean;
  };

  type ProviderRow = ProviderConnection & {
    // Draft-only inputs; the server never sends a real key back, so apiKey
    // always starts empty and is cleared again after a successful save.
    apiKey: string;
    baseUrlDraft: string;
    nameDraft: string;
    // Optional $/MTok rates (@katnor/db's schema/providerConfig.ts) - kept
    // as text-input strings, same as apiKey/baseUrl above, rather than
    // numbers, so an in-progress edit isn't fought by number-input
    // coercion. Meaningless for "anthropic" (priced from @katnor/llm's
    // own pricing.ts table) - not rendered for that row.
    inputCostPerMtok: string;
    outputCostPerMtok: string;
    saving: boolean;
    saveError: string | null;
    justSaved: boolean;
    removing: boolean;
    // Fetched model list for this connection (Zed-style). `null` =
    // never fetched; `modelsLoading` guards the Refresh button.
    models: { id: string; display_name: string }[] | null;
    modelsLoading: boolean;
    modelsError: string | null;
    // Card collapsed (shrink) vs expanded. Default collapsed so a long
    // connection list scans fast; expands on demand per card.
    collapsed: boolean;
  };

  const providerLabels: Record<ModelComboEntryProvider, string> = {
    anthropic: 'Anthropic',
    openai_compatible: 'OpenAI-compatible',
    google: 'Google',
    ollama: 'Ollama (local)',
  };

  const baseUrlHints: Record<ModelComboEntryProvider, string> = {
    anthropic: 'Defaults to https://api.anthropic.com - only set this for a proxy.',
    openai_compatible: 'e.g. https://api.openai.com/v1, or your own OpenAI-compatible endpoint.',
    google: 'Defaults to the Google AI API - only set this for a proxy.',
    ollama:
      "Defaults to http://localhost:11434/v1 (Ollama's own OpenAI-compatible endpoint) - only set this if Ollama runs elsewhere.",
  };

  // Note: "combo" (@katnor/core's MODEL_PROVIDERS) is deliberately absent
  // from both maps below - it isn't a real backend with its own
  // base_url/api_key, just a named Model mapping across the connections
  // listed here. It gets its own "Models" section further down this page.

  function toRow(remote: {
    id: string;
    name: string;
    provider: ModelComboEntryProvider;
    hasKey: boolean;
    baseUrl: string | null;
    enabled: boolean;
    inputCostPerMtok: number | null;
    outputCostPerMtok: number | null;
  }): ProviderRow {
    return {
      id: remote.id,
      name: remote.name,
      provider: remote.provider,
      hasKey: Boolean(remote.hasKey),
      baseUrl: remote.baseUrl,
      enabled: Boolean(remote.enabled),
      apiKey: '',
      baseUrlDraft: remote.baseUrl ?? '',
      nameDraft: remote.name,
      inputCostPerMtok:
        remote.inputCostPerMtok != null ? String(remote.inputCostPerMtok) : '',
      outputCostPerMtok:
        remote.outputCostPerMtok != null ? String(remote.outputCostPerMtok) : '',
      saving: false,
      saveError: null,
      justSaved: false,
      removing: false,
      models: null,
      modelsLoading: false,
      modelsError: null,
      collapsed: true,
    };
  }

  let rows = $state<ProviderRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // New-connection form: pick a type first ("tambah provider apa"),
  // then fill the connection detail - one type can back many connections.
  let newProviderType = $state<ModelComboEntryProvider>('openai_compatible');
  let newProviderName = $state('');
  let newProviderKey = $state('');
  let newProviderBaseUrl = $state('');
  let newProviderEnabled = $state(true);
  let creatingProvider = $state(false);
  let createProviderError = $state<string | null>(null);

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  // ─── Tabs ───────────────────────────────────────────────────────────

  type SettingsTabId =
    | 'providers'
    | 'models'
    | 'mcp'
    | 'secrets'
    | 'budgets'
    | 'backups'
    | 'account';

  const TABS: { id: SettingsTabId; label: string }[] = [
    { id: 'providers', label: 'Providers' },
    { id: 'models', label: 'Models' },
    { id: 'mcp', label: 'MCP servers' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'budgets', label: 'Budgets & approvals' },
    { id: 'backups', label: 'Backups' },
    { id: 'account', label: 'Account' },
  ];

  let activeTab = $state<SettingsTabId>('providers');

  async function loadProviders() {
    loading = true;
    loadError = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const remote: any[] = await trpc().settings.listProviders.query();
      // Preserve already-fetched model lists across reloads: toRow()
      // builds rows with models: null, and rebuilding that state on
      // every loadProviders() (tab switch, post-save reload) is what
      // wiped the List-models results.
      const prevById = new Map(rows.map((r) => [r.id, r]));
      rows = remote.map((r) => {
        const row = toRow(r);
        const prev = prevById.get(row.id);
        if (prev?.models) row.models = prev.models;
        if (prev) row.collapsed = prev.collapsed;
        return row;
      });
      // Auto-load the cached catalog per connection (no force-refresh:
      // cached path never throws, offline yields stale/[]) so the
      // Models-tab comboboxes have options without a manual List press
      // per connection first.
      for (const row of rows) {
        if (!row.models) void loadConnectionModels(row, false);
      }
    } catch (err) {
      // Most likely apps/server isn't running yet, or PUBLIC_SERVER_URL is
      // wrong - keep the form visible and surface a clear, recoverable
      // error instead of a blank/broken page.
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

  // Parses a rate input: blank -> null (clears/leaves unset), otherwise a
  // finite non-negative number. Returns 'invalid' rather than throwing so
  // the caller can show a clear per-field error instead of silently
  // sending garbage or a wrong fallback.
  // 999,999 matches the DB column's `numeric(12, 6)` precision - see
  // @katnor/core's schemas/providerConfig.ts for the full rationale. Kept
  // in sync with that same bound (and the server's own copy in
  // apps/server/src/trpc/routers/settings.ts) so a too-large rate fails
  // here with a clear message instead of round-tripping to the server
  // first for a raw numeric-overflow error.
  const MAX_COST_RATE = 999_999;

  function parseRate(raw: string): number | null | 'invalid' {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > MAX_COST_RATE) return 'invalid';
    return n;
  }

  async function saveRow(row: ProviderRow) {
    row.saving = true;
    row.saveError = null;
    row.justSaved = false;

    const inputRate = parseRate(row.inputCostPerMtok);
    const outputRate = parseRate(row.outputCostPerMtok);
    if (inputRate === 'invalid' || outputRate === 'invalid') {
      row.saveError = `Cost rates must be a number from 0 to ${MAX_COST_RATE}, or left blank.`;
      row.saving = false;
      return;
    }
    const name = row.nameDraft.trim();
    if (!name) {
      row.saveError = 'Give this connection a name.';
      row.saving = false;
      return;
    }

    try {
      const trimmedKey = row.apiKey.trim();
      const trimmedBaseUrl = row.baseUrlDraft.trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated: any = await trpc().settings.updateProvider.mutate({
        id: row.id,
        name,
        // Omit apiKey entirely when the field is left blank, so re-saving
        // the base URL or the enabled flag doesn't clobber an existing key.
        apiKey: trimmedKey === '' ? undefined : trimmedKey,
        baseUrl: trimmedBaseUrl === '' ? null : trimmedBaseUrl,
        enabled: row.enabled,
        inputCostPerMtok: inputRate,
        outputCostPerMtok: outputRate,
      });
      Object.assign(row, toRow(updated));
      row.justSaved = true;
    } catch (err) {
      row.saveError = describeError(err);
    } finally {
      row.saving = false;
    }
  }

  async function createProviderConnection(event: SubmitEvent) {
    event.preventDefault();
    creatingProvider = true;
    createProviderError = null;
    try {
      const name = newProviderName.trim();
      if (!name) {
        createProviderError = 'Give this connection a name.';
        return;
      }
      const trimmedKey = newProviderKey.trim();
      const trimmedBaseUrl = newProviderBaseUrl.trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created: any = await trpc().settings.createProvider.mutate({
        name,
        provider: newProviderType,
        apiKey: trimmedKey === '' ? undefined : trimmedKey,
        baseUrl: trimmedBaseUrl === '' ? null : trimmedBaseUrl,
        enabled: newProviderEnabled,
      });
      rows = [...rows, toRow(created)];
      newProviderName = '';
      newProviderKey = '';
      newProviderBaseUrl = '';
    } catch (err) {
      createProviderError = describeError(err);
    } finally {
      creatingProvider = false;
    }
  }

  async function removeProviderConnection(row: ProviderRow) {
    row.removing = true;
    row.saveError = null;
    try {
      await trpc().settings.removeProvider.mutate({ id: row.id });
      rows = rows.filter((r) => r.id !== row.id);
    } catch (err) {
      row.saveError = describeError(err);
    } finally {
      row.removing = false;
    }
  }

  /**
   * Loads the model list for one connection. `refresh: true`
   * force-fetches from the provider (surfacing bad-key/unreachable
   * errors) and doubles as "test connection" - a success proves the
   * key/URL works. Cached path never throws (offline yields stale/[]).
   */
  async function loadConnectionModels(row: ProviderRow, refresh: boolean) {
    row.modelsLoading = true;
    row.modelsError = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models = (await trpc().settings.listConnectionModels.query({
        id: row.id,
        refresh: refresh ? true : undefined,
      })) as any as { id: string; display_name: string }[];
      row.models = models;
      if (refresh && models.length === 0) {
        row.modelsError = 'Connected, but the provider listed no models.';
      }
    } catch (err) {
      row.modelsError = describeError(err);
    } finally {
      row.modelsLoading = false;
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
        enabled: true,
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
    always_ask: 'Always ask',
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
      projectDailyUsdText =
        settings.budgets.project_daily_usd !== undefined
          ? String(settings.budgets.project_daily_usd)
          : '';
      agentDailyUsdText =
        settings.budgets.agent_daily_usd !== undefined
          ? String(settings.budgets.agent_daily_usd)
          : '';
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
        agent_daily_usd: trimmedAgent === '' ? undefined : Number(trimmedAgent),
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
      await trpc().settings.updateApprovalPolicy.mutate({
        hire: hirePolicy,
        tool_call: toolCallPolicy,
        spend: spendPolicy,
      });
      policySaved = true;
    } catch (err) {
      budgetsError = describeError(err);
    } finally {
      savingPolicy = false;
    }
  }

  // ─── Account (single-user passcode) ───────────────────────────────

  type AccountRow = { id: string; name: string; created_at: string };

  let account = $state<AccountRow | null>(null);
  let accountLoading = $state(true);
  let accountError = $state<string | null>(null);

  let accountName = $state('');
  let savingName = $state(false);
  let saveNameError = $state<string | null>(null);

  let currentPasscode = $state('');
  let newPasscode = $state('');
  let newPasscodeConfirm = $state('');
  let savingPasscode = $state(false);
  let savePasscodeError = $state<string | null>(null);
  let passcodeSaved = $state(false);

  async function loadAccount() {
    accountLoading = true;
    accountError = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      account = (await trpc().users.profile.query()) as any as AccountRow;
      accountName = account.name;
    } catch (err) {
      accountError = describeError(err);
    } finally {
      accountLoading = false;
    }
  }

  $effect(() => {
    loadAccount();
  });

  async function saveName(event: SubmitEvent) {
    event.preventDefault();
    savingName = true;
    saveNameError = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      account = (await trpc().users.updateName.mutate({
        name: accountName.trim(),
      })) as any as AccountRow;
      accountName = account.name;
    } catch (err) {
      saveNameError = describeError(err);
    } finally {
      savingName = false;
    }
  }

  async function savePasscode(event: SubmitEvent) {
    event.preventDefault();
    savingPasscode = true;
    savePasscodeError = null;
    passcodeSaved = false;
    try {
      if (newPasscode.length < 4) {
        savePasscodeError = 'New passcode must be at least 4 characters.';
        return;
      }
      if (newPasscode !== newPasscodeConfirm) {
        savePasscodeError = 'The two new passcodes do not match.';
        return;
      }
      await trpc().users.updatePasscode.mutate({ currentPasscode, newPasscode });
      currentPasscode = '';
      newPasscode = '';
      newPasscodeConfirm = '';
      passcodeSaved = true;
    } catch (err) {
      savePasscodeError = describeError(err);
    } finally {
      savingPasscode = false;
    }
  }

  // ─── Models (named mappings across provider connections) ──────────

  type ModelEntryDraft = {
    providerConnectionId: string;
    model: string;
    weight: number;
    modelFilter: string;
    modelsOpen: boolean;
  };
  type ModelRow = {
    id: string;
    name: string;
    entries: { providerConnectionId?: string; provider?: string; model: string; weight?: number }[];
    strategy?: ModelStrategy;
  };

  const STRATEGIES: { value: ModelStrategy; label: string; blurb: string }[] = [
    {
      value: 'round_robin',
      label: 'Round robin',
      blurb: 'Weighted rotation across entries; a dead entry falls through to the next.',
    },
    {
      value: 'fallback',
      label: 'Fallback',
      blurb: 'Strict order - always try the first, next only on error.',
    },
    {
      value: 'router',
      label: 'Router',
      blurb: 'Reserved - behaves as fallback until a cost/latency router exists.',
    },
  ];

  let combos = $state<ModelRow[]>([]);
  let combosLoading = $state(true);
  let combosError = $state<string | null>(null);

  function emptyEntry(): ModelEntryDraft {
    return {
      providerConnectionId: rows[0]?.id ?? '',
      model: '',
      weight: 1,
      // Draft-only: the typed filter for the searchable model combobox.
      // Mirrors `model` until the user types - kept separate so picking
      // an option vs. typing a custom id don't fight over one field.
      modelFilter: '',
      modelsOpen: false,
    };
  }

  function connectionLabel(entry: {
    providerConnectionId?: string;
    provider?: string;
    model: string;
  }): string {
    const conn = entry.providerConnectionId
      ? rows.find((r) => r.id === entry.providerConnectionId)
      : undefined;
    const connName = conn?.name ?? entry.provider ?? entry.providerConnectionId ?? '?';
    return `${connName}/${entry.model}`;
  }

  let newComboName = $state('');
  let newComboEntries = $state<ModelEntryDraft[]>([emptyEntry()]);
  let newComboStrategy = $state<ModelStrategy>('round_robin');
  let creatingCombo = $state(false);
  let createComboError = $state<string | null>(null);

  let editingComboId = $state<string | null>(null);
  let editComboName = $state('');
  let editComboEntries = $state<ModelEntryDraft[]>([]);
  let editComboStrategy = $state<ModelStrategy>('fallback');
  let savingComboEdit = $state(false);
  let editComboError = $state<string | null>(null);

  let removingComboIds = $state<Record<string, boolean>>({});
  let defaultModelName = $state<string | null>(null);
  let settingDefaultName = $state<string | null>(null);
  let setDefaultError = $state<string | null>(null);

  async function loadCombos() {
    combosLoading = true;
    combosError = null;
    try {
      const client = trpc();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [comboRows, defaultRow] = await Promise.all([
        client.modelCombos.list.query() as any as Promise<ModelRow[]>,
        client.settings.getDefaultModel.query(),
      ]);
      combos = comboRows;
      defaultModelName = defaultRow.name;
    } catch (err) {
      combosError = describeError(err);
    } finally {
      combosLoading = false;
    }
  }

  async function setDefaultModel(name: string) {
    settingDefaultName = name;
    setDefaultError = null;
    try {
      const updated = await trpc().settings.setDefaultModel.mutate({ name });
      defaultModelName = updated.name;
    } catch (err) {
      setDefaultError = describeError(err);
    } finally {
      settingDefaultName = null;
    }
  }

  $effect(() => {
    loadCombos();
  });

  /** Wire shape sent to the server - the combobox draft fields stay local. */
  type ModelEntryPayload = { providerConnectionId: string; model: string; weight: number };

  function sanitizeEntries(entries: ModelEntryDraft[]): ModelEntryPayload[] {
    return entries
      .map((e) => ({
        providerConnectionId: e.providerConnectionId,
        model: e.model.trim(),
        weight: Math.max(1, Math.floor(e.weight) || 1),
      }))
      .filter((e) => e.providerConnectionId && e.model.length > 0);
  }

  async function createCombo(event: SubmitEvent) {
    event.preventDefault();
    const name = newComboName.trim();
    const entries = sanitizeEntries(newComboEntries);
    if (!name || entries.length === 0) {
      createComboError = 'A name and at least one entry (connection + model) are required.';
      return;
    }
    creatingCombo = true;
    createComboError = null;
    try {
      await trpc().modelCombos.create.mutate({ name, entries, strategy: newComboStrategy });
      newComboName = '';
      newComboEntries = [emptyEntry()];
      await loadCombos();
    } catch (err) {
      createComboError = describeError(err);
    } finally {
      creatingCombo = false;
    }
  }

  function startEditCombo(row: ModelRow) {
    if (editingComboId === row.id) {
      editingComboId = null;
      return;
    }
    editingComboId = row.id;
    editComboName = row.name;
    editComboStrategy = row.strategy ?? 'fallback';
    // Legacy entries ({provider, model} without a connection) can't be
    // edited in place - they resolve to the default connection at call
    // time. Re-point them here so saving writes the new shape.
    editComboEntries = row.entries.map((e) => ({
      providerConnectionId:
        e.providerConnectionId ??
        rows.find((r) => r.provider === (e.provider as ModelComboEntryProvider))?.id ??
        '',
      model: e.model,
      weight: e.weight ?? 1,
      modelFilter: e.model,
      modelsOpen: false,
    }));
    editComboError = null;
  }

  /**
   * The searchable model combobox options for one entry: the selected
   * connection's fetched catalog (`row.models`), filtered by what the
   * user typed. `null` catalog = not fetched yet - the combobox then
   * offers "fetch first" instead of an empty list. A typed custom id
   * always stays selectable ("Use ..." row), so models missing from
   * the catalog (new releases, proxies hiding the list) still work.
   */
  function entryModelOptions(entry: ModelEntryDraft): { id: string; display_name: string }[] {
    const conn = rows.find((r) => r.id === entry.providerConnectionId);
    if (!conn?.models) return [];
    const q = entry.modelFilter.trim().toLowerCase();
    if (!q) return conn.models;
    return conn.models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q),
    );
  }

  function pickEntryModel(entry: ModelEntryDraft, id: string): void {
    entry.model = id;
    entry.modelFilter = id;
    entry.modelsOpen = false;
  }

  function connectionModelsState(
    connectionId: string,
  ): { models: { id: string; display_name: string }[] | null; loading: boolean } {
    const conn = rows.find((r) => r.id === connectionId);
    return { models: conn?.models ?? null, loading: conn?.modelsLoading ?? false };
  }

  async function saveComboEdit() {
    if (!editingComboId) return;
    const name = editComboName.trim();
    const entries = sanitizeEntries(editComboEntries);
    if (!name || entries.length === 0) {
      editComboError = 'A name and at least one entry (connection + model) are required.';
      return;
    }
    savingComboEdit = true;
    editComboError = null;
    try {
      await trpc().modelCombos.update.mutate({
        id: editingComboId,
        name,
        entries,
        strategy: editComboStrategy,
      });
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

<div class="p-4 sm:p-6"><div class="mx-auto flex max-w-3xl flex-col gap-6">
  <div>
    <h1 class="text-2xl font-semibold">Settings</h1>
    <p class="mt-1 text-[var(--color-text-muted)]">
      Provider API keys, MCP servers, and secrets live here. Model catalog, sandbox, budgets, and
      approval policy editing land in a later phase.
    </p>
  </div>

  <!-- Tabs: one section visible at a time. Buttons render as a segmented
       control; panels below switch on `activeTab`. Data for every tab
       still loads on mount (existing $effect loaders untouched), so
       switching tabs never shows a loading flash. -->
  <div
    role="tablist"
    aria-label="Settings sections"
    class="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
  >
    {#each TABS as tab (tab.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === tab.id}
        onclick={() => (activeTab = tab.id)}
        class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeTab === tab.id
          ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]'}"
      >
        {tab.label}
      </button>
    {/each}
  </div>

  {#if activeTab === 'providers'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="Providers">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Providers</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadProviders}
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      Connected providers - one type can back many connections with different keys (e.g. "OpenAI
      utama" and "OpenAI murah"). Models below map to these connections by name.
    </p>

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
      {#each rows as row (row.id)}
        <div
          class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <button
            type="button"
            onclick={() => (row.collapsed = !row.collapsed)}
            aria-expanded={!row.collapsed}
            class="flex w-full flex-wrap items-center justify-between gap-2 text-left"
          >
            <span class="flex items-center gap-2">
              <span
                class="inline-block text-xs text-[var(--color-text-muted)] transition-transform {row.collapsed
                  ? ''
                  : 'rotate-90'}"
                aria-hidden="true">▶</span
              >
              <span class="font-medium">{row.name}</span>
            </span>
            <span class="text-xs text-[var(--color-text-muted)]">
              {providerLabels[row.provider]} · {row.hasKey ? 'Key set' : 'No key set'}{row.enabled
                ? ''
                : ' · Disabled'}
            </span>
          </button>

          {#if !row.collapsed}

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-[var(--color-text-muted)]">Connection name</span>
            <input
              type="text"
              bind:value={row.nameDraft}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            />
          </label>

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
              bind:value={row.baseUrlDraft}
              placeholder={baseUrlHints[row.provider]}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
            />
          </label>

          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={row.enabled} class="h-4 w-4" />
            <span>Enabled</span>
          </label>

          {#if row.provider !== 'anthropic'}
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-[var(--color-text-muted)]">Input $/MTok (optional)</span>
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="e.g. 0.50"
                  bind:value={row.inputCostPerMtok}
                  class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-[var(--color-text-muted)]">Output $/MTok (optional)</span>
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="e.g. 1.50"
                  bind:value={row.outputCostPerMtok}
                  class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
                />
              </label>
            </div>
            <p class="text-xs text-[var(--color-text-muted)]">
              Left blank, spend on this provider is untracked ($0) rather than guessed at - no
              generic price table exists for a third-party or self-hosted endpoint. Set these to
              feed real spend into budgets and the cost dashboard.
            </p>
          {/if}

          {#if row.saveError}
            <p class="text-sm text-[var(--color-danger)]">{row.saveError}</p>
          {:else if row.justSaved}
            <p class="text-sm text-[var(--color-success)]">Saved.</p>
          {/if}

          <div class="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-sm font-medium"
                >Models{row.models ? ` (${row.models.length})` : ''}</span
              >
              <button
                type="button"
                class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                onclick={() => loadConnectionModels(row, true)}
                disabled={row.modelsLoading}
              >
                {row.modelsLoading ? 'Checking…' : row.models ? 'Refresh' : 'List models'}
              </button>
            </div>
            {#if row.modelsError}
              <p class="text-xs text-[var(--color-danger)]">{row.modelsError}</p>
            {:else if row.models}
              {#if row.models.length === 0}
                <p class="text-xs text-[var(--color-text-muted)]">No models found.</p>
              {:else}
                <ul class="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
                  {#each row.models as m (m.id)}
                    <li
                      class="flex items-baseline justify-between gap-2 rounded px-2 py-1 hover:bg-[var(--color-surface-muted)]"
                    >
                      <code class="truncate font-mono">{m.id}</code>
                      {#if m.display_name && m.display_name !== m.id}
                        <span class="shrink-0 text-[var(--color-text-muted)]">{m.display_name}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else}
              <p class="text-xs text-[var(--color-text-muted)]">
                Paste a key, save, then list the models this connection offers - doubles as a
                connection test.
              </p>
            {/if}
          </div>

          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
              onclick={() => saveRow(row)}
              disabled={row.saving}
            >
              {row.saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
              onclick={() => removeProviderConnection(row)}
              disabled={row.removing}
            >
              {row.removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
          {/if}
        </div>
      {/each}
      {#if !loading && rows.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No providers connected yet.</p>
      {/if}
    </div>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={createProviderConnection}
    >
      <h3 class="text-sm font-semibold">Connect a provider</h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Provider</span>
          <select
            bind:value={newProviderType}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          >
            {#each MODEL_COMBO_ENTRY_PROVIDERS as p (p)}
              <option value={p}>{providerLabels[p]}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Connection name</span>
          <input
            type="text"
            required
            placeholder="e.g. OpenAI utama"
            bind:value={newProviderName}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">API key</span>
          <input
            type="password"
            autocomplete="off"
            bind:value={newProviderKey}
            placeholder="Leave blank for keyless local servers"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Base URL (optional)</span>
          <input
            type="text"
            bind:value={newProviderBaseUrl}
            placeholder={baseUrlHints[newProviderType]}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={newProviderEnabled} class="h-4 w-4" />
        <span>Enabled</span>
      </label>
      {#if createProviderError}
        <p class="text-sm text-[var(--color-danger)]">{createProviderError}</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={creatingProvider}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {creatingProvider ? 'Connecting…' : 'Connect provider'}
        </button>
      </div>
    </form>
  </div>
  {/if}

  {#if activeTab === 'mcp'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="MCP servers">
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
        <div
          class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-medium">{row.name}</h3>
            <span
              class="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
            >
              {row.kind}
            </span>
          </div>
          {#if row.command}
            <p class="text-xs text-[var(--color-text-muted)]">
              Command: <code>{row.command}</code>
            </p>
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
              <input
                type="checkbox"
                checked={row.enabled}
                onchange={() => toggleServerEnabled(row)}
                class="h-4 w-4"
              />
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

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={createServer}
    >
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
        <span class="text-[var(--color-text-muted)]"
          >URL (HTTP/SSE server, instead of a command)</span
        >
        <input
          type="text"
          bind:value={newServerUrl}
          placeholder="https://example.com/mcp"
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]"
          >Env secret names (comma-separated, e.g. GITHUB_TOKEN)</span
        >
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
  </div>
  {/if}

  {#if activeTab === 'secrets'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="Secrets">
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
        <div
          class="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
        >
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

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={saveSecret}
    >
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
  </div>
  {/if}

  {#if activeTab === 'budgets'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="Budgets and approval policy">
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
      agent, or its project over its daily budget doesn't start. What happens next follows the
      "Spend beyond budget" policy below: paused and sent to your Inbox to approve or reject, or -
      only under "Auto" - let through anyway. Leave project/agent blank for no per-project/per-agent
      cap beyond each agent's own budget (set per-agent on the Team page).
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
          <select
            bind:value={hirePolicy}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm"
          >
            {#each APPROVAL_MODES as mode (mode)}
              <option value={mode}>{approvalModeLabels[mode]}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Dangerous tool calls (e.g. git push)</span>
          <select
            bind:value={toolCallPolicy}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm"
          >
            {#each APPROVAL_MODES as mode (mode)}
              <option value={mode}>{approvalModeLabels[mode]}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Spend beyond budget</span>
          <select
            bind:value={spendPolicy}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm"
          >
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
  </div>
  {/if}

  {#if activeTab === 'backups'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="Backups">
    <p class="text-sm text-[var(--color-text-muted)]">
      Downloads a single JSON file with every core table (company, teams, agents, projects, tasks,
      runs, messages, the knowledge graph, wiki pages, ...) plus every project's wiki files.
      Provider/secret values are never included - only whether one is set. Artifact file bytes (PRs,
      diffs, screenshots) aren't included either, just their metadata; the underlying storage
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
  </div>
  {/if}

  {#if activeTab === 'account'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="Account">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Account</h2>
      <button
        type="button"
        class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        onclick={loadAccount}
        disabled={accountLoading}
      >
        {accountLoading ? 'Loading…' : 'Reload'}
      </button>
    </div>
    <p class="text-sm text-[var(--color-text-muted)]">
      Single-user install: one account, one passcode. Rename yourself or rotate the passcode
      here - changing it asks for the current one first.
    </p>

    {#if accountError}
      <p class="text-sm text-[var(--color-danger)]">{accountError}</p>
    {/if}

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={saveName}
    >
      <h3 class="text-sm font-semibold">Display name</h3>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Name</span>
        <input
          type="text"
          required
          bind:value={accountName}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      {#if saveNameError}
        <p class="text-sm text-[var(--color-danger)]">{saveNameError}</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={savingName}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {savingName ? 'Saving…' : 'Save name'}
        </button>
      </div>
    </form>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={savePasscode}
    >
      <h3 class="text-sm font-semibold">Change passcode</h3>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Current passcode</span>
          <input
            type="password"
            autocomplete="current-password"
            required
            bind:value={currentPasscode}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">New passcode</span>
          <input
            type="password"
            autocomplete="new-password"
            required
            minlength="4"
            bind:value={newPasscode}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Confirm new passcode</span>
          <input
            type="password"
            autocomplete="new-password"
            required
            bind:value={newPasscodeConfirm}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
          />
        </label>
      </div>
      {#if savePasscodeError}
        <p class="text-sm text-[var(--color-danger)]">{savePasscodeError}</p>
      {/if}
      {#if passcodeSaved}
        <p class="text-sm text-[var(--color-success)]">Passcode changed.</p>
      {/if}
      <div>
        <button
          type="submit"
          disabled={savingPasscode}
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {savingPasscode ? 'Saving…' : 'Change passcode'}
        </button>
      </div>
    </form>
  </div>
  {/if}

  {#if activeTab === 'models'}
  <div class="flex flex-col gap-4" role="tabpanel" aria-label="Models">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold">Models</h2>
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
      A model is a named mapping across provider connections - hire an agent onto "Combo" (Team
      page) and pick one of these by name instead of a single model. Round robin spreads calls by
      weight; a dead entry falls through to the next, so one down connection degrades rather than
      failing the call.
    </p>

    {#if combosError}
      <p class="text-sm text-[var(--color-danger)]">{combosError}</p>
    {/if}
    {#if setDefaultError}
      <p class="text-sm text-[var(--color-danger)]">{setDefaultError}</p>
    {/if}

    <div class="flex flex-col gap-2">
      {#each combos as row (row.id)}
        <div
          class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col">
              <span class="text-sm font-medium"
                >{row.name} <span class="text-xs font-normal text-[var(--color-text-muted)]"
                  >· {row.strategy ?? 'fallback'}</span
                ></span
              >
              <span class="text-xs text-[var(--color-text-muted)]">
                {row.entries.map((e) => connectionLabel(e)).join(' → ')}
              </span>
            </div>
            <div class="flex shrink-0 gap-2">
              {#if defaultModelName === row.name}
                <span
                  class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-contrast)]"
                  title="New hires (and the CEO) use this model unless picked otherwise"
                  >Default</span
                >
              {:else}
                <button
                  type="button"
                  onclick={() => setDefaultModel(row.name)}
                  disabled={settingDefaultName !== null}
                  title="Make new hires default to this model"
                  class="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                >
                  {settingDefaultName === row.name ? 'Setting…' : 'Set as default'}
                </button>
              {/if}
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
                <div class="flex flex-col gap-2">
                  <span class="text-sm text-[var(--color-text-muted)]"
                    >Entries{editComboStrategy === 'fallback'
                      ? ', tried in order'
                      : ', rotated by weight'}</span
                  >
                  {#each editComboEntries as entry, i (i)}
                    <div class="flex items-center gap-2">
                      <select
                        bind:value={entry.providerConnectionId}
                        class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                      >
                        {#each rows as conn (conn.id)}
                          <option value={conn.id}>{conn.name} · {providerLabels[conn.provider]}</option>
                        {/each}
                      </select>
                      <div class="relative flex-1">
                        <input
                          type="text"
                          placeholder="search or type model id"
                          bind:value={entry.modelFilter}
                          onfocus={() => (entry.modelsOpen = true)}
                          oninput={() => {
                            entry.modelsOpen = true;
                            entry.model = entry.modelFilter;
                          }}
                          class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
                        />
                        {#if entry.modelsOpen}
                          {@const state = connectionModelsState(entry.providerConnectionId)}
                          {@const options = entryModelOptions(entry)}
                          {@const typed = entry.modelFilter.trim()}
                          <div
                            class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
                          >
                            {#if state.loading}
                              <p class="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">
                                Loading…
                              </p>
                            {:else if !state.models}
                              <p class="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">
                                No catalog yet - open the Providers tab and press "List models" on
                                this connection first, or just type the id.
                              </p>
                            {:else if options.length === 0 && !typed}
                              <p class="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">
                                No models found on this connection.
                              </p>
                            {:else}
                              {#each options as m (m.id)}
                                <button
                                  type="button"
                                  onclick={() => pickEntryModel(entry, m.id)}
                                  class="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)] {entry.model ===
                                  m.id
                                    ? 'bg-[var(--color-surface-muted)]'
                                    : ''}"
                                >
                                  <code class="truncate font-mono">{m.id}</code>
                                  {#if m.display_name && m.display_name !== m.id}
                                    <span class="shrink-0 text-[var(--color-text-muted)]"
                                      >{m.display_name}</span
                                    >
                                  {/if}
                                </button>
                              {/each}
                              {#if typed && !options.some((m) => m.id === typed)}
                                <button
                                  type="button"
                                  onclick={() => pickEntryModel(entry, typed)}
                                  class="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
                                >
                                  Use "<code class="font-mono">{typed}</code>"
                                </button>
                              {/if}
                            {/if}
                            <button
                              type="button"
                              onclick={() => (entry.modelsOpen = false)}
                              class="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
                            >
                              Close
                            </button>
                          </div>
                        {/if}
                      </div>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        title="Round-robin weight"
                        bind:value={entry.weight}
                        class="w-16 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                      />
                      <button
                        type="button"
                        onclick={() =>
                          (editComboEntries = editComboEntries.filter((_, idx) => idx !== i))}
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
                      + Add entry
                    </button>
                  </div>
                </div>
                <label class="flex flex-col gap-1 text-sm">
                  <span class="text-[var(--color-text-muted)]">Strategy</span>
                  <select
                    bind:value={editComboStrategy}
                    class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                  >
                    {#each STRATEGIES as s (s.value)}
                      <option value={s.value}>{s.label} - {s.blurb}</option>
                    {/each}
                  </select>
                </label>
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
                  {savingComboEdit ? 'Saving…' : 'Save model'}
                </button>
              </div>
            </form>
          {/if}
        </div>
      {/each}
      {#if !combosLoading && combos.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No models yet.</p>
      {/if}
    </div>

    <form
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={createCombo}
    >
      <h3 class="text-sm font-semibold">New model</h3>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Name</span>
        <input
          type="text"
          required
          placeholder="e.g. coding"
          bind:value={newComboName}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-[var(--color-text-muted)]">Strategy</span>
        <select
          bind:value={newComboStrategy}
          class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
        >
          {#each STRATEGIES as s (s.value)}
            <option value={s.value}>{s.label} - {s.blurb}</option>
          {/each}
        </select>
      </label>
      <div class="flex flex-col gap-2">
        <span class="text-sm text-[var(--color-text-muted)]"
          >Entries{newComboStrategy === 'fallback' ? ', tried in order' : ', rotated by weight'}</span
        >
        {#each newComboEntries as entry, i (i)}
          <div class="flex items-center gap-2">
            <select
              bind:value={entry.providerConnectionId}
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            >
              {#each rows as conn (conn.id)}
                <option value={conn.id}>{conn.name} · {providerLabels[conn.provider]}</option>
              {/each}
            </select>
            <div class="relative flex-1">
              <input
                type="text"
                placeholder="search or type model id"
                bind:value={entry.modelFilter}
                onfocus={() => (entry.modelsOpen = true)}
                oninput={() => {
                  entry.modelsOpen = true;
                  // Typing is itself a valid custom id - keep `model` in
                  // sync so submit works without picking an option first.
                  entry.model = entry.modelFilter;
                }}
                class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)]"
              />
              {#if entry.modelsOpen}
                {@const state = connectionModelsState(entry.providerConnectionId)}
                {@const options = entryModelOptions(entry)}
                {@const typed = entry.modelFilter.trim()}
                <div
                  class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
                >
                  {#if state.loading}
                    <p class="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">Loading…</p>
                  {:else if !state.models}
                    <p class="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">
                      No catalog yet - open the Providers tab and press "List models" on this
                      connection first, or just type the id.
                    </p>
                  {:else if options.length === 0 && !typed}
                    <p class="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">
                      No models found on this connection.
                    </p>
                  {:else}
                    {#each options as m (m.id)}
                      <button
                        type="button"
                        onclick={() => pickEntryModel(entry, m.id)}
                        class="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)] {entry.model ===
                        m.id
                          ? 'bg-[var(--color-surface-muted)]'
                          : ''}"
                      >
                        <code class="truncate font-mono">{m.id}</code>
                        {#if m.display_name && m.display_name !== m.id}
                          <span class="shrink-0 text-[var(--color-text-muted)]"
                            >{m.display_name}</span
                          >
                        {/if}
                      </button>
                    {/each}
                    {#if typed && !options.some((m) => m.id === typed)}
                      <button
                        type="button"
                        onclick={() => pickEntryModel(entry, typed)}
                        class="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
                      >
                        Use "<code class="font-mono">{typed}</code>"
                      </button>
                    {/if}
                  {/if}
                  <button
                    type="button"
                    onclick={() => (entry.modelsOpen = false)}
                    class="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
                  >
                    Close
                  </button>
                </div>
              {/if}
            </div>
            <input
              type="number"
              min="1"
              step="1"
              title="Round-robin weight"
              bind:value={entry.weight}
              class="w-16 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]"
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
            + Add entry
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
          {creatingCombo ? 'Creating…' : 'Create model'}
        </button>
      </div>
    </form>
  </div>
  {/if}
</div>
 </div>

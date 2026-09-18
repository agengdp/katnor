<script lang="ts">
  import { goto } from '$app/navigation';
  import { trpc } from '$lib/trpc';
  import { Icon, type IconName } from '$lib/icons';

  /**
   * First-run setup, in the browser.
   *
   * Before this existed, a fresh `docker compose up` gave you a stack with
   * no account and no way to make one from the UI - the first user could
   * only come from `pnpm db:seed` with a pre-hashed `OWNER_PASSWORD_HASH`,
   * which needs a terminal, a checkout, and knowing how to produce a scrypt
   * hash. This is the other door: start the stack, open the dashboard, fill
   * in three short steps.
   *
   * The server side is apps/server's `setup` router, which is where the
   * actual guarantee lives: `setup.complete` is public (it has to be - the
   * endpoint that creates the first login cannot require a login) and
   * refuses permanently once any account exists.
   *
   * Steps are local state rather than routes. The whole thing is one
   * submission - nothing is written until the last step - so giving each
   * step a URL would let someone bookmark or reload into a half-filled
   * form that cannot be completed from there.
   */

  interface StepDefinition {
    title: string;
    blurb: string;
    icon: IconName;
  }

  const STEPS: StepDefinition[] = [
    {
      title: 'Company',
      blurb: 'What this Katnor install is called. You can rename it later in Settings.',
      icon: 'building',
    },
    {
      title: 'Your account',
      blurb:
        'The first account, and the only one that can be created without logging in. Everyone else is invited from Settings afterwards.',
      icon: 'users',
    },
    {
      title: 'Model provider',
      blurb:
        'Optional. Agents cannot run until at least one provider is configured, but you can skip this and add it in Settings.',
      icon: 'cpu',
    },
  ];

  const PROVIDERS = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai_compatible', label: 'OpenAI-compatible' },
    { value: 'google', label: 'Google (Gemini)' },
    { value: 'ollama', label: 'Ollama (local)' },
  ] as const;

  type ProviderName = (typeof PROVIDERS)[number]['value'];

  let step = $state(0);
  let checking = $state(true);
  let databaseReady = $state(true);
  let alreadySetUp = $state(false);

  let companyName = $state('Katnor Inc.');
  let ownerName = $state('');
  let ownerEmail = $state('');
  let ownerPassword = $state('');
  let ownerPasswordConfirm = $state('');
  let providerName = $state<ProviderName>('anthropic');
  let apiKey = $state('');

  let submitting = $state(false);
  let error = $state<string | null>(null);

  // A `$derived`, not a `{@const}` in the markup: `{@const}` is only legal
  // as an immediate child of a block, and this is read inside a <form>.
  const current = $derived(STEPS[step]);

  $effect(() => {
    void refreshStatus();
  });

  async function refreshStatus() {
    checking = true;
    try {
      const status = await trpc().setup.status.query();
      databaseReady = status.databaseReady;
      alreadySetUp = status.databaseReady && !status.needsSetup;
    } catch (err) {
      databaseReady = false;
      error = err instanceof Error ? err.message : 'Could not reach the server.';
    } finally {
      checking = false;
    }
  }

  /**
   * Per-step validation, returned as a message rather than thrown: the
   * Continue button stays enabled and explains what is wrong on click,
   * instead of being mysteriously dead while someone hunts for the field
   * they missed.
   */
  function validateStep(index: number): string | null {
    if (index === 0) {
      if (companyName.trim().length === 0) return 'Give the company a name.';
      return null;
    }
    if (index === 1) {
      if (ownerName.trim().length === 0) return 'Enter your name.';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail.trim())) {
        return 'Enter a valid email address.';
      }
      // Matches the server's own rule (@katnor/core's createUserInputSchema),
      // so this never rejects something the server would accept or vice versa.
      if (ownerPassword.length < 8) return 'Password must be at least 8 characters.';
      if (ownerPassword !== ownerPasswordConfirm) return 'The two passwords do not match.';
      return null;
    }
    return null;
  }

  function next() {
    const problem = validateStep(step);
    if (problem) {
      error = problem;
      return;
    }
    error = null;
    step += 1;
  }

  function back() {
    error = null;
    step -= 1;
  }

  async function submit() {
    // Re-validate every step, not just the last one: the earlier steps are
    // unmounted by now, so a browser autofill or a stale value that slipped
    // through would otherwise only surface as a server-side rejection.
    for (let i = 0; i < STEPS.length; i++) {
      const problem = validateStep(i);
      if (problem) {
        error = problem;
        step = i;
        return;
      }
    }

    submitting = true;
    error = null;
    try {
      await trpc().setup.complete.mutate({
        companyName: companyName.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        ownerPassword,
        ...(apiKey.trim().length > 0
          ? { provider: { name: providerName, apiKey: apiKey.trim() } }
          : {}),
      });
      // `setup.complete` sets the session cookie itself, so this lands in
      // the app already logged in rather than at the login form.
      await goto('/');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Setup failed.';
      // A CONFLICT means somebody completed setup while this form was open.
      // Re-checking flips the page over to the "already set up" notice
      // instead of leaving a dead form with a cryptic error under it.
      if (/already set up/i.test(error)) await refreshStatus();
    } finally {
      submitting = false;
    }
  }

  const inputClass =
    'rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)]';
</script>

<div class="mx-auto flex w-full max-w-lg flex-col gap-6 py-10">
  <div class="flex items-center gap-2 text-lg font-semibold tracking-tight">
    <Icon name="factory" size="1.2em" />
    <span>Katnor</span>
  </div>

  {#if checking}
    <p class="text-sm text-[var(--color-text-muted)]">Checking this install…</p>
  {:else if !databaseReady}
    <!-- The database is unreachable or has no tables yet. Offering a signup
         form here would fail on submit with a raw SQL error, so the page
         says what to actually do instead. -->
    <div
      class="flex flex-col gap-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-surface)] p-4"
    >
      <h1 class="flex items-center gap-2 text-base font-semibold text-[var(--color-danger)]">
        <Icon name="alertTriangle" />
        The database isn't ready yet
      </h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Katnor reached the server, but not a migrated database. Postgres may still be starting, or
        the migrations may not have run yet.
      </p>
      <p class="text-sm text-[var(--color-text-muted)]">Run these once, then reload this page:</p>
      <pre
        class="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">pnpm --filter @katnor/db db:generate
pnpm --filter @katnor/db db:migrate
pnpm --filter @katnor/db db:post-migrate</pre>
      <p class="text-xs text-[var(--color-text-muted)]">
        You do not need <code>db:seed</code> — that is what this wizard replaces.
      </p>
      <button
        type="button"
        onclick={refreshStatus}
        class="self-start rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
      >
        Check again
      </button>
    </div>
  {:else if alreadySetUp}
    <div class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <h1 class="flex items-center gap-2 text-base font-semibold">
        <Icon name="check" class="text-[var(--color-success)]" />
        Already set up
      </h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        This install already has an account, so setup is closed. Log in instead — or, if you have
        lost access, add an account from another logged-in session under Settings &gt; Team members.
      </p>
      <a
        href="/login"
        class="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)]"
      >
        Go to log in
      </a>
    </div>
  {:else}
    <div>
      <h1 class="text-2xl font-semibold">Set up Katnor</h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Three short steps. Nothing is saved until the last one.
      </p>
    </div>

    <!-- Stepper. `aria-current` rather than colour alone marks where you
         are, so the position is not carried by hue only. -->
    <ol class="flex items-center gap-2">
      {#each STEPS as definition, index (definition.title)}
        <li class="flex flex-1 items-center gap-2" aria-current={index === step ? 'step' : undefined}>
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold {index <
            step
              ? 'border-[var(--color-success)] text-[var(--color-success)]'
              : index === step
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}"
          >
            {#if index < step}
              <Icon name="check" size="0.9em" />
            {:else}
              {index + 1}
            {/if}
          </span>
          <span
            class="hidden text-xs font-medium sm:inline {index === step
              ? 'text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)]'}">{definition.title}</span
          >
          {#if index < STEPS.length - 1}
            <span class="h-px flex-1 bg-[var(--color-border)]"></span>
          {/if}
        </li>
      {/each}
    </ol>

    <form
      class="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onsubmit={(event) => {
        event.preventDefault();
        if (step < STEPS.length - 1) next();
        else submit();
      }}
    >
      {#if current}
        <div class="flex items-start gap-3">
          <Icon name={current.icon} size="1.3em" class="mt-0.5 text-[var(--color-text-muted)]" />
          <div>
            <h2 class="font-semibold">{current.title}</h2>
            <p class="text-xs text-[var(--color-text-muted)]">{current.blurb}</p>
          </div>
        </div>
      {/if}

      {#if step === 0}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Company name</span>
          <input bind:value={companyName} required class={inputClass} />
        </label>
      {:else if step === 1}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Your name</span>
          <input bind:value={ownerName} autocomplete="name" required class={inputClass} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Email</span>
          <input
            type="email"
            bind:value={ownerEmail}
            autocomplete="username"
            required
            class={inputClass}
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Password</span>
          <input
            type="password"
            bind:value={ownerPassword}
            autocomplete="new-password"
            required
            class={inputClass}
          />
          <span class="text-xs text-[var(--color-text-muted)]">At least 8 characters.</span>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Confirm password</span>
          <input
            type="password"
            bind:value={ownerPasswordConfirm}
            autocomplete="new-password"
            required
            class={inputClass}
          />
        </label>
      {:else}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">Provider</span>
          <select bind:value={providerName} class={inputClass}>
            {#each PROVIDERS as provider (provider.value)}
              <option value={provider.value}>{provider.label}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-[var(--color-text-muted)]">API key</span>
          <input
            type="password"
            bind:value={apiKey}
            autocomplete="off"
            placeholder="Leave blank to skip"
            class={inputClass}
          />
          <span class="text-xs text-[var(--color-text-muted)]">
            Stored encrypted, and never sent back to the browser afterwards.
          </span>
        </label>
      {/if}

      {#if error}
        <p class="text-sm text-[var(--color-danger)]">{error}</p>
      {/if}

      <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
        {#if step > 0}
          <button
            type="button"
            onclick={back}
            disabled={submitting}
            class="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
          >
            <Icon name="arrowLeft" />
            Back
          </button>
        {:else}
          <span></span>
        {/if}

        <button
          type="submit"
          disabled={submitting}
          class="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
        >
          {#if step < STEPS.length - 1}
            Continue
            <Icon name="arrowRight" />
          {:else if submitting}
            Setting up…
          {:else}
            {apiKey.trim().length > 0 ? 'Finish setup' : 'Skip and finish'}
            <Icon name="check" />
          {/if}
        </button>
      </div>
    </form>

    <p class="text-xs text-[var(--color-text-muted)]">
      Anyone who can reach this server right now could complete this form and claim the install.
      Finish setup before exposing a new Katnor to an untrusted network.
    </p>
  {/if}
</div>

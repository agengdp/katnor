<script lang="ts">
  import { goto } from '$app/navigation';
  import { trpc } from '$lib/trpc';
  import { Icon } from '$lib/icons';

  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    submitting = true;
    error = null;
    try {
      await trpc().auth.login.mutate({ email, password });
      await goto('/');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Login failed.';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="mx-auto flex max-w-sm flex-col gap-6 pt-12">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold">
      <Icon name="lock" size="0.9em" />
      Log in
    </h1>
    <p class="mt-1 text-sm text-[var(--color-text-muted)]">
      Katnor is private. Everything - the office, projects, chat, runs and settings - is behind this
      form.
    </p>
  </div>

  <form class="flex flex-col gap-3" onsubmit={submit}>
    <label class="flex flex-col gap-1 text-sm">
      <span class="text-[var(--color-text-muted)]">Email</span>
      <input
        type="email"
        autocomplete="email"
        bind:value={email}
        required
        class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)]"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm">
      <span class="text-[var(--color-text-muted)]">Password</span>
      <input
        type="password"
        autocomplete="current-password"
        bind:value={password}
        required
        class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)]"
      />
    </label>

    {#if error}
      <p class="text-sm text-[var(--color-danger)]">{error}</p>
    {/if}

    <button
      type="submit"
      disabled={submitting}
      class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
    >
      {submitting ? 'Logging in…' : 'Log in'}
    </button>
  </form>

  <p class="text-xs text-[var(--color-text-muted)]">
    No account yet? A brand-new install sends you to the setup wizard instead of this page, which
    creates the first account for you. If you are seeing this form, an account already exists -
    anyone already logged in can add teammates under Settings &gt; Team members.
  </p>
</div>

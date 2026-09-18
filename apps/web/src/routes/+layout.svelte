<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { trpc } from '$lib/trpc';
  import { subscribeToEvents } from '$lib/eventsSocket';
  import { Icon, type IconName } from '$lib/icons';

  let { children } = $props();

  const LOGIN_PATH = '/login';

  /**
   * The app is login-only: nothing but the login page renders to a visitor
   * without a session, and the sidebar, header and every page behind them
   * stay unmounted until `auth.me` confirms one.
   *
   * This gate is the user experience, not the security boundary. The real
   * enforcement is server-side - every tRPC procedure except `auth.*` and
   * `health.ping` is a `protectedProcedure`, `/artifacts/raw/:key` and
   * `/export/backup` are behind `requireAuth`, and the `/ws/events`
   * WebSocket rejects an unauthenticated upgrade (apps/server). A visitor
   * who bypasses this component reaches a UI whose every request 401s.
   *
   * `null` means "not checked yet", and is deliberately distinct from
   * `false`: rendering the login page at `null` would flash a login form at
   * someone who is already logged in on every cold load.
   */
  let authenticated = $state<boolean | null>(null);
  let currentUserName = $state<string | null>(null);

  const onLoginPage = $derived($page.url.pathname === LOGIN_PATH);

  async function refreshAuth() {
    try {
      const result = await trpc().auth.me.query();
      authenticated = result.authenticated;
      currentUserName = result.user?.name ?? null;
    } catch {
      // A failed `auth.me` cannot be read as "logged in", so it has to
      // fall to the login page. That does mean an unreachable apps/server
      // presents as logged out - the login page's own error then says what
      // actually went wrong, which is more use than a shell full of
      // failing panels.
      authenticated = false;
      currentUserName = null;
    }
  }

  // Re-checked on every navigation rather than once on mount: this
  // component survives client-side navigation, so a one-shot check would
  // never notice the session that /login just created, nor one that
  // expired while the tab sat open.
  $effect(() => {
    void $page.url.pathname;
    refreshAuth();
  });

  $effect(() => {
    if (authenticated === false && !onLoginPage) void goto(LOGIN_PATH);
  });

  // Cost meter: real spend-vs-budget data (apps/server's runs.todaySpend -
  // added in Phase 4 alongside the office's day/night tint, which reads
  // the same numbers), refreshed on every finished run rather than polled.
  let spend = $state<{ spentUsd: number; budgetUsd: number } | null>(null);

  async function refreshSpend() {
    try {
      spend = await trpc().runs.todaySpend.query();
    } catch {
      // apps/server may not be reachable yet - the chip just stays quiet
      // until the next successful refresh.
    }
  }

  // Gated on `authenticated`: `runs.todaySpend` is a protected procedure,
  // so asking for it before login is a guaranteed 401.
  $effect(() => {
    if (authenticated) refreshSpend();
  });

  $effect(() => {
    if (!authenticated) return;
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === 'run.finished') refreshSpend();
    });
    return unsubscribe;
  });

  const overBudget = $derived(
    spend !== null && spend.budgetUsd > 0 && spend.spentUsd >= spend.budgetUsd,
  );

  async function logout() {
    await trpc().auth.logout.mutate();
    authenticated = false;
    currentUserName = null;
    await goto(LOGIN_PATH);
  }

  const navLinks: { href: string; label: string; icon: IconName }[] = [
    { href: '/office', label: 'Office', icon: 'building' },
    { href: '/projects', label: 'Projects', icon: 'clipboard' },
    { href: '/team', label: 'Team', icon: 'users' },
    { href: '/chat', label: 'Chat', icon: 'messageSquare' },
    { href: '/knowledge', label: 'Knowledge', icon: 'book' },
    { href: '/artifacts', label: 'Artifacts', icon: 'folder' },
    { href: '/runs', label: 'Runs', icon: 'activity' },
    { href: '/inbox', label: 'Inbox', icon: 'inbox' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ];

  function isActive(href: string): boolean {
    const path = $page.url.pathname;
    return path === href || path.startsWith(`${href}/`);
  }
</script>

{#if authenticated === null}
  <div
    class="flex min-h-screen items-center justify-center bg-[var(--color-bg)] text-sm text-[var(--color-text-muted)]"
  >
    Checking your session…
  </div>
{:else if !authenticated}
  <!-- Logged out: the login page renders bare, with none of the app shell
       around it. Any other path has already been redirected here by the
       effect above; this branch just avoids rendering the shell during the
       frame before that navigation lands. -->
  <div class="min-h-screen bg-[var(--color-bg)] p-4 text-[var(--color-text)] sm:p-6">
    {#if onLoginPage}
      {@render children()}
    {/if}
  </div>
{:else}
  <div class="flex min-h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
    <header
      class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
    >
      <a href="/" class="flex items-center gap-2 text-base font-semibold tracking-tight">
        <Icon name="factory" size="1.15em" />
        <span>Katnor</span>
      </a>

      <div
        class="flex shrink-0 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs text-[var(--color-text-muted)]"
        title="Spend so far today across all agents, against the company's daily budget"
      >
        <Icon
          name="dot"
          size="0.75em"
          class={overBudget ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}
        />
        <span>
          {#if spend === null}
            $0.00 today
          {:else}
            ${spend.spentUsd.toFixed(2)}{spend.budgetUsd > 0
              ? ` / $${spend.budgetUsd.toFixed(2)}`
              : ''} today
          {/if}
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        {#if currentUserName}
          <span class="hidden text-xs text-[var(--color-text-muted)] sm:inline">
            {currentUserName}
          </span>
        {/if}
        <button
          type="button"
          onclick={logout}
          class="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
        >
          <Icon name="logOut" />
          Log out
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
      <nav
        aria-label="Main"
        class="order-2 flex shrink-0 gap-1 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] p-2 sm:order-1 sm:w-56 sm:flex-col sm:overflow-x-visible sm:border-t-0 sm:border-r sm:p-3"
      >
        {#each navLinks as link (link.href)}
          <a
            href={link.href}
            aria-current={isActive(link.href) ? 'page' : undefined}
            class="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors {isActive(
              link.href,
            )
              ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
              : 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]'}"
          >
            <Icon name={link.icon} size="1.1em" />
            <span>{link.label}</span>
          </a>
        {/each}
      </nav>

      <main class="order-1 flex-1 overflow-y-auto p-4 sm:order-2 sm:p-6">
        {@render children()}
      </main>
    </div>
  </div>
{/if}

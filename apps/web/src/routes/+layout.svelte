<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { trpc } from '$lib/trpc';

  let { children } = $props();

  let authenticated = $state<boolean | null>(null); // null = not checked yet

  async function refreshAuth() {
    try {
      const result = await trpc().auth.me.query();
      authenticated = result.authenticated;
    } catch {
      // apps/server may not be reachable yet - reads elsewhere already
      // surface their own errors, so this just leaves the auth chip quiet.
      authenticated = null;
    }
  }

  $effect(() => {
    refreshAuth();
  });

  async function logout() {
    await trpc().auth.logout.mutate();
    authenticated = false;
    await goto('/');
  }

  const navLinks = [
    { href: '/office', label: 'Office', icon: '🏢' },
    { href: '/projects', label: 'Projects', icon: '📋' },
    { href: '/team', label: 'Team', icon: '🧑‍🤝‍🧑' },
    { href: '/chat', label: 'Chat', icon: '💬' },
    { href: '/knowledge', label: 'Knowledge', icon: '📚' },
    { href: '/artifacts', label: 'Artifacts', icon: '🗂️' },
    { href: '/runs', label: 'Runs', icon: '⚙️' },
    { href: '/inbox', label: 'Inbox', icon: '📥' },
    { href: '/settings', label: 'Settings', icon: '🔧' }
  ];

  function isActive(href: string): boolean {
    const path = $page.url.pathname;
    return path === href || path.startsWith(`${href}/`);
  }
</script>

<div class="flex min-h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
  <header
    class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
  >
    <a href="/" class="flex items-center gap-2 text-base font-semibold tracking-tight">
      <span aria-hidden="true">🏭</span>
      <span>Katnor</span>
    </a>

    <!-- Placeholder cost-meter chip. TODO(phase 1): wire this to live
         spend data (per-run token/cost accounting) over the WebSocket
         event stream instead of a hardcoded value. -->
    <div
      class="flex shrink-0 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs text-[var(--color-text-muted)]"
      title="Spend so far today across all agents (placeholder)"
    >
      <span aria-hidden="true" class="text-[var(--color-success)]">●</span>
      <span>$0.00 today</span>
    </div>

    {#if authenticated}
      <button
        type="button"
        onclick={logout}
        class="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
      >
        Log out
      </button>
    {:else}
      <a
        href="/login"
        class="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
      >
        Log in
      </a>
    {/if}
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
            link.href
          )
            ? 'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
            : 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]'}"
        >
          <span aria-hidden="true">{link.icon}</span>
          <span>{link.label}</span>
        </a>
      {/each}
    </nav>

    <main class="order-1 flex-1 overflow-y-auto p-4 sm:order-2 sm:p-6">
      {@render children()}
    </main>
  </div>
</div>

<script lang="ts">
  import { fade, scale } from 'svelte/transition';
  import type { Snippet } from 'svelte';
  import { Icon } from '$lib/icons';

  /**
   * Centered dialog used for create flows (project, task). Rarely seen, so
   * it earns a real animation: backdrop fades (150ms), panel scales from
   * 0.96 with opacity (200ms, ease-out). Modals keep `transform-origin:
   * center` - they are not anchored to a trigger, unlike popovers.
   *
   * Closes on Escape and backdrop click. Locks body scroll while open,
   * focuses the panel on open, and returns focus to the opener on close.
   * Durations drop to 0 under `prefers-reduced-motion`.
   */
  let {
    open = $bindable(false),
    title,
    children,
    onclose = undefined,
  }: {
    open: boolean;
    title: string;
    children: Snippet;
    onclose?: (() => void) | undefined;
  } = $props();

  // Strong ease-out (Emil: never ease-in for UI - it delays the first
  // movement, the exact moment the user watches most closely).
  const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
  const reduceMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  const backdropMs = reduceMotion ? 0 : 150;
  const panelMs = reduceMotion ? 0 : 200;

  let panel = $state<HTMLElement | null>(null);
  let returnFocusTo = $state<Element | null>(null);

  function close(): void {
    open = false;
    onclose?.();
  }

  $effect(() => {
    if (!open) return;
    returnFocusTo = document.activeElement;
    document.body.style.overflow = 'hidden';
    panel?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (returnFocusTo instanceof HTMLElement) returnFocusTo.focus();
    };
  });
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="absolute inset-0 bg-black/40"
      aria-hidden="true"
      onclick={close}
      transition:fade={{ duration: backdropMs, easing: easeOut }}
    ></div>
    <div
      bind:this={panel}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      transition:scale={{ duration: panelMs, start: 0.96, opacity: 0, easing: easeOut }}
      class="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl outline-none"
    >
      <div
        class="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3"
      >
        <h2 class="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
        <button
          type="button"
          onclick={close}
          aria-label="Close dialog"
          class="btn-press flex shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] p-1.5 hover:bg-[var(--color-surface-muted)]"
        >
          <Icon name="x" label="Close dialog" />
        </button>
      </div>
      <div class="overflow-y-auto p-4">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

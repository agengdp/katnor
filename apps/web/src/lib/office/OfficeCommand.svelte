<script lang="ts">
  import { trpc } from '$lib/trpc';
  import { Icon } from '$lib/icons';

  /**
   * Bottom-center command bar for the Office page: one input that talks
   * to the room. `@nama` targets specific employees (with autocomplete);
   * no mention means everybody. Sends through the same path as Chat
   * (`messages.send` into #general with `mentions[]`), so waking the right
   * agents stays decided in exactly one place server-side
   * (@katnor/agents' `postMessage`).
   *
   * Bottom-anchored (chat-composer model) so it never covers the top
   * chrome (floor pills left, weather right). `shifted` docks it left of
   * the agent side panel, mirroring FloatingActivity. No open/close
   * animation by design: this is used dozens of times a day, so it
   * appears instantly and only the send button gives press feedback
   * (global 160ms scale). Dark glass matches the room pills.
   */

  interface CommandAgent {
    id: string;
    name: string;
    status: 'active' | 'paused' | 'offline';
  }

  let { agents = [], shifted = false }: { agents: CommandAgent[]; shifted?: boolean } = $props();

  let text = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let generalId = $state<string | null>(null);
  let mentionQuery = $state<string | null>(null);
  let highlight = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  const activeAgents = $derived(agents.filter((a) => a.status === 'active'));

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Employees addressed via `@Name` in the text (case-insensitive). */
  const mentioned = $derived.by((): CommandAgent[] => {
    const found: CommandAgent[] = [];
    for (const agent of activeAgents) {
      if (new RegExp(`@${escapeRegExp(agent.name)}(?![\\w])`, 'i').test(text)) {
        found.push(agent);
      }
    }
    return found;
  });

  /** Empty mention set = broadcast to everyone active. */
  const targets = $derived(mentioned.length > 0 ? mentioned : activeAgents);

  const suggestions = $derived.by((): CommandAgent[] => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    return activeAgents.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 6);
  });

  function refreshMentionQuery(): void {
    const el = inputEl;
    if (!el) {
      mentionQuery = null;
      return;
    }
    const pos = el.selectionStart ?? text.length;
    const match = /@([\w ]*)$/.exec(text.slice(0, pos));
    mentionQuery = match ? match[1] : null;
    highlight = 0;
  }

  function completeSuggestion(agent: CommandAgent): void {
    const el = inputEl;
    if (!el) return;
    const pos = el.selectionStart ?? text.length;
    const before = text.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    text = `${before.slice(0, at)}@${agent.name} ${text.slice(pos)}`;
    mentionQuery = null;
    notice = null;
    error = null;
    requestAnimationFrame(() => {
      el.focus();
      const cursor = at + agent.name.length + 2;
      el.setSelectionRange(cursor, cursor);
    });
  }

  function describeError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong talking to the server.';
  }

  async function send(): Promise<void> {
    const body = text.trim();
    if (body.length === 0 || sending) return;
    sending = true;
    error = null;
    notice = null;
    try {
      if (!generalId) {
        generalId = (await trpc().channels.getGeneral.query()).id;
      }
      const ids = targets.map((a) => a.id);
      if (ids.length === 0) {
        error = 'Belum ada karyawan aktif untuk menerima perintah.';
        return;
      }
      await trpc().messages.send.mutate({ channel_id: generalId, text: body, mentions: ids });
      notice =
        mentioned.length > 0
          ? `Terkirim ke ${mentioned.map((a) => a.name).join(', ')}.`
          : `Terkirim ke semua (${ids.length} karyawan).`;
      text = '';
      mentionQuery = null;
    } catch (err) {
      error = describeError(err);
    } finally {
      sending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (suggestions.length > 0 && mentionQuery !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlight = (highlight + 1) % suggestions.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlight = (highlight - 1 + suggestions.length) % suggestions.length;
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const pick = suggestions[highlight];
        if (pick) completeSuggestion(pick);
        return;
      }
      if (event.key === 'Escape') {
        mentionQuery = null;
        return;
      }
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
    }
  }

  // "/" focuses the bar from anywhere (outside another field), spotlight-style.
  $effect(() => {
    function onGlobalKeydown(event: KeyboardEvent): void {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      inputEl?.focus();
    }
    window.addEventListener('keydown', onGlobalKeydown);
    return () => window.removeEventListener('keydown', onGlobalKeydown);
  });
</script>

<!-- Bottom-center composer: above DecisionPopup (z-30), below the side
     panel (z-40). When the panel opens (w-80 + right-4 = 21rem), the
     center shifts left by half of that so the bar stays visually
     centered in the remaining room. The activity button stays
     bottom-right. -->
<div
  class="absolute bottom-4 left-1/2 z-20 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 {shifted
    ? 'sm:left-[calc(50%-10.5rem)]'
    : ''}"
>
  <!-- Status line sits ABOVE the bar so it floats over the 3D room, never
       pushing the input or shifting layout on send. -->
  <div aria-live="polite" class="pointer-events-none mb-1.5 flex justify-center">
    {#if error}
      <p class="office-cmd-status pointer-events-auto text-[var(--color-danger)]">{error}</p>
    {:else if notice}
      <p class="office-cmd-status pointer-events-auto text-[var(--color-success)]">{notice}</p>
    {:else if sending}
      <p class="office-cmd-status pointer-events-auto">Mengirim…</p>
    {/if}
  </div>

  <div class="office-cmd-bar">
    <Icon name="messageSquare" class="shrink-0 opacity-70" />
    <input
      bind:this={inputEl}
      bind:value={text}
      oninput={refreshMentionQuery}
      onclick={refreshMentionQuery}
      onkeyup={refreshMentionQuery}
      onkeydown={onKeydown}
      type="text"
      placeholder="Perintah ke kantor… @nama untuk spesifik, kosong = semua"
      aria-label="Perintah ke kantor"
      autocomplete="off"
      spellcheck="false"
      class="office-cmd-input"
    />
    {#if mentioned.length > 0}
      <span class="office-cmd-chip office-cmd-chip-target hidden sm:inline">
        @{mentioned.length === 1 ? mentioned[0].name : `${mentioned.length} orang`}
      </span>
    {:else}
      <span class="office-cmd-chip hidden sm:inline"> semua </span>
    {/if}
    <button
      type="button"
      onclick={() => void send()}
      disabled={sending || text.trim().length === 0}
      aria-label="Kirim perintah"
      class="office-cmd-send"
    >
      <Icon name="replyArrow" />
    </button>
  </div>

  {#if suggestions.length > 0}
    <!-- Opens UPWARD (above the bar) so it grows over the room, never
         over the DecisionPopup zone below. -->
    <div class="office-cmd-menu" role="listbox" aria-label="Pilih karyawan">
      {#each suggestions as agent, i (agent.id)}
        <button
          type="button"
          role="option"
          aria-selected={i === highlight}
          onmouseenter={() => (highlight = i)}
          onclick={() => completeSuggestion(agent)}
          class="office-cmd-option {i === highlight ? 'office-cmd-option-active' : ''}"
        >
          <span class="font-medium">@{agent.name}</span>
          {#if agent.status !== 'active'}
            <span class="text-xs opacity-70">({agent.status})</span>
          {/if}
        </button>
      {/each}
      <p class="office-cmd-hint">Tab pilih · Enter kirim</p>
    </div>
  {/if}
</div>

<style>
  .office-cmd-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(10, 10, 15, 0.72);
    color: #f0ead0;
    border: 1px solid rgba(255, 217, 160, 0.25);
    border-radius: 999px;
    padding: 8px 8px 8px 16px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.4);
    backdrop-filter: blur(8px);
  }
  .office-cmd-input {
    min-width: 0;
    flex: 1;
    background: transparent;
    border: 0;
    color: inherit;
    font-size: 14px;
    outline: none;
  }
  .office-cmd-bar:focus-within {
    border-color: rgba(255, 217, 160, 0.55);
    box-shadow:
      0 8px 28px rgb(0 0 0 / 0.4),
      0 0 0 2px rgba(253, 230, 138, 0.25);
  }
  .office-cmd-input::placeholder {
    color: rgba(240, 234, 208, 0.45);
  }
  .office-cmd-chip {
    flex-shrink: 0;
    border: 1px solid rgba(255, 217, 160, 0.25);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 12px;
    color: rgba(240, 234, 208, 0.7);
  }
  .office-cmd-chip-target {
    border-color: transparent;
    background: #fde68a;
    color: #101828;
    font-weight: 500;
  }
  .office-cmd-send {
    display: flex;
    height: 32px;
    width: 32px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: #fde68a;
    color: #101828;
  }
  .office-cmd-send:disabled {
    opacity: 0.4;
  }
  .office-cmd-status {
    border-radius: 6px;
    background: rgba(10, 10, 15, 0.72);
    padding: 4px 10px;
    font-size: 12px;
    color: #f0ead0;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.4);
  }
  .office-cmd-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid rgba(255, 217, 160, 0.25);
    background: rgba(10, 10, 15, 0.92);
    color: #f0ead0;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.5);
  }
  .office-cmd-option {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    text-align: left;
    font-size: 14px;
  }
  .office-cmd-option-active {
    background: rgba(253, 230, 138, 0.15);
  }
  .office-cmd-hint {
    border-top: 1px solid rgba(255, 217, 160, 0.25);
    padding: 4px 12px;
    font-size: 11px;
    color: rgba(240, 234, 208, 0.55);
  }
  @media (prefers-reduced-motion: reduce) {
    .office-cmd-bar {
      backdrop-filter: none;
    }
  }
</style>

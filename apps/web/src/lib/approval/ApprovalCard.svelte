<script lang="ts">
  import type { ApprovalKind, ApprovalStatus } from '@katnor/core';

export interface ApprovalCardRow {
  id: string;
  created_at: string;
  run_id: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
}

let {
  row,
  deciding = false,
  error = '',
  onDecide,
}: {
  row: ApprovalCardRow;
  deciding?: boolean;
  error?: string;
  onDecide: (decision: 'approved' | 'rejected', answer?: string) => void;
} = $props();

/**
 * One pending approval (hire / question / tool_call / spend), shared by
 * the Chat "Needs your decision" panel. Formerly inline in the old
 * Inbox page - extracted so the decision UI lives in exactly one place.
 * Decided-history rendering stays out: Chat only shows pending items.
 */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function kindLabel(kind: ApprovalKind): string {
  switch (kind) {
    case 'hire':
      return 'Hire request';
    case 'question':
      return 'Question';
    case 'tool_call':
      return 'Tool call';
    case 'spend':
      return 'Spend request';
    default:
      return kind;
  }
}
function hireName(payload: Record<string, unknown>): string {
  return asString(payload.name, 'Unnamed hire');
}
function hireModelSummary(payload: Record<string, unknown>): string {
  const model = asRecord(payload.model);
  const provider = asString(model.provider);
  const modelId = asString(model.model);
  if (provider && modelId) return `${provider} / ${modelId}`;
  return provider || modelId;
}
function questionText(payload: Record<string, unknown>): string {
  return asString(payload.question, '(question text missing)');
}
function questionOptions(payload: Record<string, unknown>): string[] {
  return asStringArray(payload.options);
}
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

let draftAnswer = $state('');
</script>

<article
  class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <span
      class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-text-muted)]"
    >
      {kindLabel(row.kind)}
    </span>
    <span class="text-xs text-[var(--color-text-muted)]">{formatTime(row.created_at)}</span>
  </div>

  {#if row.kind === 'hire'}
    <p class="text-sm font-medium">Hire {hireName(row.payload)}</p>
    {#if hireModelSummary(row.payload)}
      <p class="text-xs text-[var(--color-text-muted)]">Model: {hireModelSummary(row.payload)}</p>
    {/if}
  {:else if row.kind === 'question'}
    <p class="text-sm font-medium">{questionText(row.payload)}</p>
  {:else}
    <pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs"
      >{JSON.stringify(row.payload, null, 2)}</pre
    >
  {/if}

  {#if row.kind === 'question'}
    {#if questionOptions(row.payload).length > 0}
      <div class="flex flex-wrap gap-2">
        {#each questionOptions(row.payload) as option (option)}
          <button
            type="button"
            onclick={() => onDecide('approved', option)}
            disabled={deciding}
            class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
          >
            {option}
          </button>
        {/each}
      </div>
    {/if}
    <form
      class="flex flex-wrap items-center gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        if (draftAnswer.trim()) onDecide('approved', draftAnswer.trim());
      }}
    >
      <input
        type="text"
        aria-label="Your answer"
        bind:value={draftAnswer}
        placeholder="Type your answer…"
        disabled={deciding}
        class="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text)]"
      />
      <button
        type="submit"
        disabled={deciding || !draftAnswer.trim()}
        class="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
      >
        Answer
      </button>
    </form>
    <div>
      <button
        type="button"
        onclick={() => onDecide('rejected')}
        disabled={deciding}
        class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
      >
        Decline
      </button>
    </div>
  {:else}
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onDecide('approved')}
        disabled={deciding}
        class="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
      >
        Approve
      </button>
      <button
        type="button"
        onclick={() => onDecide('rejected')}
        disabled={deciding}
        class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  {/if}

  {#if error}
    <p class="text-xs text-[var(--color-danger)]">{error}</p>
  {/if}
</article>
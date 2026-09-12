<script lang="ts">
  import { page } from '$app/stores';
</script>

<div class="mx-auto flex max-w-2xl flex-col gap-4">
  <div class="flex items-center gap-3">
    <h1 class="text-2xl font-semibold">Project {$page.params.id}</h1>
    <span
      class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)]"
    >
      Coming in Phase 1
    </span>
  </div>
  <p class="text-[var(--color-text-muted)]">
    This project's kanban board will live here: columns from backlog to done, live card status,
    and a drawer with description, acceptance criteria, thread, run history, and artifacts for
    every task.
  </p>
</div>

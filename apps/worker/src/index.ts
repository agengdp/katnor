import { createBossClient, QUEUES } from '@katnor/agents';
import { createAgentRunHandler } from './handlers/agentRun.js';
import { codeIndex } from './handlers/codeIndex.js';
import { librarianIngest } from './handlers/librarianIngest.js';
import { createManagerStandupHandler } from './handlers/managerStandup.js';
import { createWikiLintHandler } from './handlers/wikiLint.js';
import { env } from './env.js';

async function main(): Promise<void> {
  const boss = createBossClient();
  const handlers = {
    agentRun: createAgentRunHandler(boss),
    librarianIngest,
    wikiLint: createWikiLintHandler(boss),
    codeIndex,
    managerStandup: createManagerStandupHandler(boss),
  };

  // pg-boss is an EventEmitter; Node throws if an 'error' event has no
  // listener, so this must be attached before start().
  boss.on('error', (error) => {
    console.error('[worker] pg-boss error:', error);
  });

  await boss.start();

  // Queues are first-class in pg-boss and must exist before send()/work()
  // will operate on them. createQueue is idempotent, so it's safe to call
  // on every boot.
  await boss.createQueue(QUEUES.AGENT_RUN);
  await boss.createQueue(QUEUES.LIBRARIAN_INGEST);
  await boss.createQueue(QUEUES.WIKI_LINT);
  await boss.createQueue(QUEUES.CODE_INDEX);
  await boss.createQueue(QUEUES.MANAGER_STANDUP);

  await boss.work(QUEUES.AGENT_RUN, handlers.agentRun);
  await boss.work(QUEUES.LIBRARIAN_INGEST, handlers.librarianIngest);
  await boss.work(QUEUES.WIKI_LINT, handlers.wikiLint);
  await boss.work(QUEUES.CODE_INDEX, handlers.codeIndex);
  await boss.work(QUEUES.MANAGER_STANDUP, handlers.managerStandup);

  // PLAN.md Phase 5's "scheduled runs (daily stand-up, weekly wiki lint)" -
  // pg-boss's own cron scheduler, not a hand-rolled poll loop. Both fire
  // with no `projectId` in the job data, which both handlers treat as
  // "every project" (see @katnor/agents' queues.ts doc comment) - simpler
  // than registering/deregistering one schedule per project as projects
  // come and go. `schedule()` is idempotent for the same name+cron, so
  // re-registering on every boot is safe.
  //
  // NOTE: written with no way to run this against a live pg-boss instance
  // in this sandbox - `schedule(name, cron, data, options)` and the `tz`
  // option are pg-boss's long-documented cron API, but this exact call
  // hasn't executed for real.
  await boss.schedule(QUEUES.WIKI_LINT, '0 9 * * 1', {}, { tz: 'UTC' });
  await boss.schedule(QUEUES.MANAGER_STANDUP, '0 8 * * *', {}, { tz: 'UTC' });

  // @katnor/llm's Anthropic adapter (used by the agent-run handler above)
  // reads ANTHROPIC_API_KEY directly via the SDK's own default credential
  // resolution, not through this app's own env.ts - so it isn't validated
  // there. Warn here instead of letting the first run fail with a less
  // obvious "invalid x-api-key" error from deep inside a tool-use loop.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      '[worker] ANTHROPIC_API_KEY is not set - every run for an agent on the "anthropic" provider will fail. ' +
        'See .env.example.',
    );
  }

  console.log(
    `[worker] @katnor/worker started - listening on queues: ${Object.values(QUEUES).join(', ')}`,
  );

  // Task assignments, mentions, colleague questions, and human messages
  // each enqueue an `agent-run` job directly the moment they happen (see
  // @katnor/agents' `triggerRun`/`postMessage`) rather than through a
  // polling scheduler, so this heartbeat is just a liveness signal, not a
  // placeholder for one. The "schedule" trigger kind (PLAN.md §4.1's
  // periodic check-ins) that genuinely needs a poll is the manager
  // stand-up/wiki-lint cron above (pg-boss's own scheduler, not this
  // interval) - a per-agent scheduled check-in beyond those two specific
  // jobs still isn't built.
  //
  // Per-agent "one run at a time" and a global concurrency cap (also
  // PLAN.md §4.1) aren't enforced yet either - pg-boss's own per-queue
  // concurrency limits `boss.work()` accepts would be the natural place to
  // add the global cap; a per-agent lock needs its own tracking (e.g. a
  // `running` flag alongside the agent row, checked before starting a job).
  const heartbeat = setInterval(() => {
    console.log('[worker] worker alive');
  }, env.WORKER_HEARTBEAT_MS);
  heartbeat.unref();

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down...`);
    clearInterval(heartbeat);
    boss
      .stop()
      .then(() => {
        console.log('[worker] stopped cleanly');
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error('[worker] error during shutdown:', error);
        process.exit(1);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('[worker] fatal error during startup:', error);
  process.exit(1);
});

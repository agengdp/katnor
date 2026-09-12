import { createBossClient, QUEUES } from '@katnor/agents';
import { createAgentRunHandler } from './handlers/agentRun.js';
import { codeIndex } from './handlers/codeIndex.js';
import { librarianIngest } from './handlers/librarianIngest.js';
import { createWikiLintHandler } from './handlers/wikiLint.js';
import { env } from './env.js';

async function main(): Promise<void> {
  const boss = createBossClient();
  const handlers = {
    agentRun: createAgentRunHandler(boss),
    librarianIngest,
    wikiLint: createWikiLintHandler(boss),
    codeIndex,
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

  await boss.work(QUEUES.AGENT_RUN, handlers.agentRun);
  await boss.work(QUEUES.LIBRARIAN_INGEST, handlers.librarianIngest);
  await boss.work(QUEUES.WIKI_LINT, handlers.wikiLint);
  await boss.work(QUEUES.CODE_INDEX, handlers.codeIndex);

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
  // placeholder for one. The one trigger kind that DOES need a poll -
  // "schedule" (PLAN.md §4.1's periodic check-ins, e.g. §4.2's daily
  // manager stand-up) - isn't built yet; a later phase should replace this
  // interval with one that also checks for due scheduled runs.
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

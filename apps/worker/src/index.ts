import { createBossClient, QUEUES } from './queues.js';
import { agentRun } from './handlers/agentRun.js';
import { librarianIngest } from './handlers/librarianIngest.js';
import { env } from './env.js';

// Phase 0 scope: pg-boss wiring and a heartbeat/health loop only. The real
// run executor and scheduler live in the handlers/ files and are stubbed
// there (see the TODOs in each) - this file just plugs the queue plumbing
// together so Phase 1 has something real to build on.

const handlers = { agentRun, librarianIngest };

async function main(): Promise<void> {
  const boss = createBossClient();

  // pg-boss is an EventEmitter; Node throws if an 'error' event has no
  // listener, so this must be attached before start().
  boss.on('error', (error) => {
    console.error('[worker] pg-boss error:', error);
  });

  await boss.start();

  // Queues are first-class in pg-boss and must exist before send()/work()
  // will operate on them. createQueue is idempotent, so it's safe to call
  // on every boot, including WIKI_LINT even though no handler is registered
  // for it yet - that keeps the topic ready for whichever Phase 3 job sends
  // to it first.
  await boss.createQueue(QUEUES.AGENT_RUN);
  await boss.createQueue(QUEUES.LIBRARIAN_INGEST);
  await boss.createQueue(QUEUES.WIKI_LINT);

  await boss.work(QUEUES.AGENT_RUN, handlers.agentRun);
  await boss.work(QUEUES.LIBRARIAN_INGEST, handlers.librarianIngest);

  console.log(
    `[worker] @katnor/worker started - listening on queues: ${Object.values(QUEUES).join(', ')}`,
  );

  // TODO(Phase 1, PLAN.md §4.1): replace this placeholder heartbeat with the
  // real scheduler-trigger poll - turning task assignments, mentions,
  // colleague questions, and scheduled check-ins into `agent-run` jobs (one
  // run per agent at a time via a per-agent lock, plus a global concurrency
  // cap). For now it just proves the process is alive.
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

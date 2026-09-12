import { agentsRouter } from './routers/agents.js';
import { approvalsRouter } from './routers/approvals.js';
import { artifactsRouter } from './routers/artifacts.js';
import { authRouter } from './routers/auth.js';
import { channelsRouter } from './routers/channels.js';
import { healthRouter } from './routers/health.js';
import { messagesRouter } from './routers/messages.js';
import { projectsRouter } from './routers/projects.js';
import { runsRouter } from './routers/runs.js';
import { secretsRouter } from './routers/secrets.js';
import { settingsRouter } from './routers/settings.js';
import { tasksRouter } from './routers/tasks.js';
import { teamsRouter } from './routers/teams.js';
import { toolConfigsRouter } from './routers/toolConfigs.js';
import { router } from './trpc.js';

// No `superjson` (or other) transformer is configured: it isn't in this
// phase's pinned dependency list, and nothing here needs to cross the wire
// as anything richer than plain JSON yet (see health.ping's comment for the
// one place that would otherwise want `Date` support). Add one here - and
// to the client in apps/web - together, if a later phase needs it.
export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  settings: settingsRouter,
  agents: agentsRouter,
  teams: teamsRouter,
  projects: projectsRouter,
  tasks: tasksRouter,
  channels: channelsRouter,
  messages: messagesRouter,
  runs: runsRouter,
  approvals: approvalsRouter,
  artifacts: artifactsRouter,
  toolConfigs: toolConfigsRouter,
  secrets: secretsRouter,
});

/**
 * The router's type, with no runtime import of this file's dependencies -
 * this is what apps/web imports (`import type { AppRouter } from
 * '@katnor/server'`, a devDependency there since only the type is ever
 * used - see apps/web/src/lib/trpc.ts) to get a fully-typed tRPC client
 * without pulling in the server's actual code.
 */
export type AppRouter = typeof appRouter;

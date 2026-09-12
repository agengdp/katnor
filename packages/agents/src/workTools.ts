import type { ToolCallApprovalPayload } from '@katnor/core';
import { mergeCompanySettings } from '@katnor/core';
import { approvalRepo, eventRepo } from '@katnor/db';
import type { ToolDefinition, ToolExecutionResult, WorkspaceProject } from '@katnor/tools';
import { getWorkspaceManager } from '@katnor/tools';
import type { AgentToolContext } from './context.js';

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

/** Maps this run's project row (a drizzle row, @katnor/agents-only) to the plain shape @katnor/tools' workspace manager needs. */
function toWorkspaceProject(project: NonNullable<AgentToolContext['project']>): WorkspaceProject {
  return { id: project.id, name: project.name, repos: project.repos };
}

const MAX_EXEC_OUTPUT_CHARS = 20_000;

function formatExecResult(result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean }): string {
  const parts = [
    `exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
    result.stdout ? `stdout:\n${result.stdout}` : null,
    result.stderr ? `stderr:\n${result.stderr}` : null,
  ].filter((part): part is string => Boolean(part));
  const joined = parts.join('\n\n') || '(no output)';
  return joined.length > MAX_EXEC_OUTPUT_CHARS ? `${joined.slice(0, MAX_EXEC_OUTPUT_CHARS)}\n...(truncated)` : joined;
}

// PLAN.md 4.2's "approval gates for pushes" - a v1 stand-in for a fuller
// dangerous-command classifier: `git push` is by far the most common way a
// coding agent's shell tool makes an externally-visible, hard-to-reverse
// change, so it's the one pattern gated in Phase 2.
const DANGEROUS_SHELL_PATTERN = /\bgit\s+push\b/i;
const GIT_PUSH_TOOL_NAME = 'shell:git_push';

/**
 * Checks `command` against `company.settings.approval_policy.tool_call`
 * before the `shell` tool is allowed to run it, mirroring how
 * ./orgTools.ts's `hire_agent` gates on `approval_policy.hire` and
 * ./companyTools.ts's `ask_human` pauses a run. Returns a `ToolExecutionResult`
 * (and sets `ctx.pauseRequested`) if the command must wait on the owner;
 * `undefined` means "go ahead and run it".
 *
 * "ask_once_per_project" is implemented by scanning prior *approved*
 * `tool_call` approvals for one already covering this project + dangerous
 * action, rather than a dedicated index - v1's approval volume is low
 * enough that an in-memory scan of `approvalRepo.list('approved')` is fine.
 */
async function gateDangerousShellCommand(
  command: string,
  ctx: AgentToolContext,
): Promise<ToolExecutionResult | undefined> {
  if (!DANGEROUS_SHELL_PATTERN.test(command)) return undefined;

  const settings = mergeCompanySettings(ctx.company.settings);
  const mode = settings.approval_policy.tool_call;
  if (mode === 'auto') return undefined;

  const projectId = ctx.project?.id ?? null;
  if (mode === 'ask_once_per_project' && projectId) {
    const approved = await approvalRepo.list('approved');
    const alreadyApproved = approved.some((row) => {
      if (row.kind !== 'tool_call') return false;
      const payload = row.payload as Partial<ToolCallApprovalPayload>;
      return payload.tool_name === GIT_PUSH_TOOL_NAME && payload.project_id === projectId;
    });
    if (alreadyApproved) return undefined;
  }

  const payload: ToolCallApprovalPayload = { tool_name: GIT_PUSH_TOOL_NAME, project_id: projectId, summary: command };
  const created = await approvalRepo.create({ run_id: ctx.run.id, kind: 'tool_call', payload });
  await eventRepo.append({ type: 'approval.requested', payload: { approval_id: created.id, kind: 'tool_call' } });
  ctx.pauseRequested = { approvalId: created.id };
  return {
    content: `"${command}" needs the owner's approval first (pending id ${created.id}). Ending this turn - you'll be re-triggered once decided.`,
  };
}

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const CLAUDE_CODE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Work tools (PLAN.md 4.3): `shell` and `claude_code` run inside the
 * project's workspace (a Docker container per project, or a plain local
 * directory in dev "host mode" - see @katnor/tools/src/workspace). Unlike
 * ./companyTools.ts/./orgTools.ts these need `ctx.project` (loaded by
 * ./runExecutor.ts from the run's task) and `ctx.company` (for the
 * approval-gate check above) - a run with no task/project can't use them.
 */
export const workTools: ToolDefinition<AgentToolContext>[] = [
  {
    name: 'shell',
    description:
      "Run a shell command inside this project's workspace, optionally scoped to one of its configured repos. Use this for git, package managers, tests, and any other CLI work.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: '"owner/repo" - one of the project\'s configured repos. Omit to run at the workspace root.',
        },
        command: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const command = str(input, 'command');
      if (!command) {
        return { content: 'shell requires command.', isError: true };
      }
      if (!ctx.project) {
        return { content: 'shell requires a project - this run has no task/project to work in.', isError: true };
      }

      const gated = await gateDangerousShellCommand(command, ctx);
      if (gated) return gated;

      const manager = getWorkspaceManager();
      const workspaceProject = toWorkspaceProject(ctx.project);
      await manager.ensureWorkspace(workspaceProject);

      const repoName = str(input, 'repo');
      const repo = repoName
        ? workspaceProject.repos.find((candidate) => `${candidate.owner}/${candidate.repo}` === repoName)
        : undefined;
      if (repoName && !repo) {
        return { content: `No repo "${repoName}" configured on this project.`, isError: true };
      }

      const result = await manager.exec(workspaceProject, command, {
        cwd: repo ? manager.repoPath(repo) : undefined,
        timeoutMs: SHELL_TIMEOUT_MS,
      });
      return { content: formatExecResult(result), isError: result.exitCode !== 0 };
    },
  },

  {
    name: 'claude_code',
    description:
      "Delegate a coding task to Claude Code, an autonomous coding agent, against one of this project's repos. It reads/edits files and runs commands on its own inside the workspace, then reports back what it did. Prefer this over `shell` for open-ended implementation work.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '"owner/repo" - one of the project\'s configured repos.' },
        prompt: { type: 'string', description: 'What to do, in as much detail as a human engineer would need.' },
      },
      required: ['repo', 'prompt'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const repoName = str(input, 'repo');
      const prompt = str(input, 'prompt');
      if (!repoName || !prompt) {
        return { content: 'claude_code requires repo and prompt.', isError: true };
      }
      if (!ctx.project) {
        return { content: 'claude_code requires a project - this run has no task/project to work in.', isError: true };
      }

      const manager = getWorkspaceManager();
      const workspaceProject = toWorkspaceProject(ctx.project);
      await manager.ensureWorkspace(workspaceProject);

      const repo = workspaceProject.repos.find((candidate) => `${candidate.owner}/${candidate.repo}` === repoName);
      if (!repo) {
        return { content: `No repo "${repoName}" configured on this project.`, isError: true };
      }

      // Runs the `claude` CLI non-interactively via the same `exec()` every
      // work tool uses (docker exec in Docker mode, a plain child_process in
      // host mode - see @katnor/tools/src/workspace) rather than embedding
      // @anthropic-ai/claude-agent-sdk's `query()` directly: the SDK itself
      // spawns this same CLI as a subprocess, so going through it a second
      // way here would just be two code paths for one mechanism. `-p`/
      // `--output-format json`/`--permission-mode acceptEdits` are Claude
      // Code CLI flags as of this writing; this sandbox has no network
      // access to verify them against a live install (see sandbox/Dockerfile).
      //
      // NOTE: `exec()` takes one shell command string, so `prompt` is
      // JSON-stringified and double-quoted for bash - that safely escapes
      // `"`/`\`/`$`/backticks, but an embedded real newline becomes a
      // literal two-character "\n" rather than surviving as a newline
      // (bash's double-quote escaping doesn't special-case `\n`). Good
      // enough for v1; a real argv-based exec would remove this caveat.
      const command = `claude -p ${JSON.stringify(prompt)} --output-format json --permission-mode acceptEdits`;
      const result = await manager.exec(workspaceProject, command, {
        cwd: manager.repoPath(repo),
        timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
        // In Docker mode the project container is otherwise isolated from
        // apps/worker's own env, so the CLI has no key to authenticate with
        // unless it's forwarded per-exec like this (host mode's exec()
        // already inherits the whole process env - see
        // @katnor/tools/src/workspace/host.ts - so this is a harmless
        // no-op override there).
        env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' },
      });
      return { content: formatExecResult(result), isError: result.exitCode !== 0 };
    },
  },
];

const SERVER_TOOL_NOT_CALLABLE_MESSAGE =
  'This is a server-side tool - Anthropic runs it directly and this execute() should never be invoked (see @katnor/llm\'s ServerToolBlock doc comment).';

/**
 * Declares Anthropic's server-side `web_search`/`web_fetch` (PLAN.md 4.3:
 * "web_search/web_fetch ... when the model is Claude") through the same
 * `ToolDefinition` mechanism as every other tool, purely so they can share
 * an agent's `tool_allowlist` and appear in `agentToolRegistry.listForModel`
 * - the `serverType` tag is what actually makes @katnor/llm's Anthropic
 * adapter declare them as server tools instead of custom ones (see
 * @katnor/tools' `ToolDefinition.serverType` doc comment); `execute` here
 * is unreachable in practice.
 */
export const serverTools: ToolDefinition<AgentToolContext>[] = [
  {
    name: 'web_search',
    description: 'Search the web for up-to-date information.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    serverType: 'web_search',
    async execute() {
      return { content: SERVER_TOOL_NOT_CALLABLE_MESSAGE, isError: true };
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch and read the content of a URL.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    serverType: 'web_fetch',
    async execute() {
      return { content: SERVER_TOOL_NOT_CALLABLE_MESSAGE, isError: true };
    },
  },
];

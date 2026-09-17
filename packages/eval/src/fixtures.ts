import { DEFAULT_BOARD_COLUMNS } from '@katnor/core';
import { agentRepo, companyRepo, projectRepo } from '@katnor/db';

/**
 * Fixed ids the eval run's project/agent are tagged with, distinct from
 * anything a real user of this deployment would name their own project or
 * hire - so a stray eval run is obviously identifiable in the dashboard,
 * and re-running the harness against the same database reuses the same
 * project/agent rather than piling up duplicates (each run still creates
 * its own fresh `task`/`run` rows - only the project/agent are shared).
 */
const EVAL_PROJECT_NAME = 'Katnor Eval';
const EVAL_AGENT_NAME = 'Eval Bot';

/**
 * A cheap, fast model for the eval agent - these tasks test whether the
 * run loop, tool schemas, and prompt wiring work end to end, not model
 * quality, so there is no reason to pay for a larger model here.
 */
const EVAL_MODEL_CONFIG = {
  provider: 'anthropic' as const,
  model: 'claude-haiku-4-5',
  effort: 'low' as const,
  thinking_display: 'omitted' as const,
  max_tokens: 1024,
};

async function findProjectByName(name: string) {
  const projects = await projectRepo.list();
  return projects.find((p) => p.name === name);
}

async function findAgentByName(name: string) {
  const agents = await agentRepo.list();
  return agents.find((a) => a.name === name);
}

/**
 * Ensures the company row, the eval project, and the eval agent all
 * exist, creating whichever are missing. Mirrors the exact field shapes
 * @katnor/agents' `create_project`/`hire_agent` tools use in production
 * (see ./companyTools.ts/./hiring.ts) rather than inventing a different
 * fixture shape - the point of this harness is to exercise the real run
 * loop, not a simplified stand-in for it. Each eval task still gets its
 * own task-thread channel (`channelRepo.getOrCreateTaskThread`, called by
 * ./runner.ts per task, same as `delegate_task` does in production) -
 * only the project/agent themselves are shared across runs.
 */
export async function ensureFixtures(): Promise<{ projectId: string; agentId: string }> {
  // getOrCreate seeds a default company if none exists yet - the same call
  // packages/db/src/seed.ts makes, safe to call again here.
  await companyRepo.getOrCreate({ name: 'Katnor Eval Co', settings: {} });

  let project = await findProjectByName(EVAL_PROJECT_NAME);
  if (!project) {
    project = await projectRepo.create({
      name: EVAL_PROJECT_NAME,
      description:
        "Fixture project for @katnor/eval - PLAN.md Phase 5's eval harness. Safe to delete; " +
        'recreated on the next run.',
      repos: [],
      workspace_id: null,
      board_settings: { columns: DEFAULT_BOARD_COLUMNS },
      wiki_path: 'wiki/katnor-eval',
    });
  }

  let agent = await findAgentByName(EVAL_AGENT_NAME);
  if (!agent) {
    agent = await agentRepo.create({
      name: EVAL_AGENT_NAME,
      title: 'Eval Agent',
      persona: {
        bio: "A fixture employee that only exists to run @katnor/eval's scripted tasks.",
        personality: 'Literal and to the point.',
        strengths: ['following instructions exactly'],
        style: 'Terse.',
      },
      system_prompt:
        'You are a fixture test employee used by an automated eval harness. Follow the task ' +
        'description and acceptance criteria exactly and literally - the eval script checks your ' +
        'output for specific text, so precision matters more than politeness or elaboration.',
      avatar: 'eval-bot',
      reports_to: null,
      team_id: null,
      model_config: EVAL_MODEL_CONFIG,
      tool_allowlist: ['save_artifact', 'send_message'],
      status: 'active',
      budget_daily_usd: '5',
      is_system: false,
    });
  }

  return { projectId: project.id, agentId: agent.id };
}

import { readArtifactText } from './grade.js';
import type { EvalGradeContext, EvalGradeResult, EvalTaskDef } from './types.js';

const SECRET_CODE = 'BLUE-42-QUAIL';
const ARTIFACT_MARKER = 'EVAL-ARTIFACT-OK';

/**
 * Shared first check every task's `grade()` needs: did the run even
 * finish successfully? Returns a failure result, or `null` when it's safe
 * to keep grading.
 */
function checkRunSucceeded({ run }: EvalGradeContext): EvalGradeResult | null {
  if (run.status !== 'succeeded') {
    return {
      passed: false,
      reason: `run ended as "${run.status}", not "succeeded" (summary: ${run.summary ?? '(empty)'})`,
    };
  }
  return null;
}

/**
 * PLAN.md Phase 5's "a set of scripted company tasks with graded
 * outcomes". Deliberately small (2 tasks) and deliberately cheap (a Haiku
 * agent, low effort, no work-tool/sandbox usage) - the goal is a fast
 * end-to-end smoke test of the run loop, prompt wiring, and tool-calling
 * path that can run on every relevant PR, not a broad quality benchmark.
 *
 * Each task is intentionally narrow enough to grade with a plain string
 * check against `run.summary` (set from the agent's own final text - see
 * @katnor/agents' runExecutor.ts) or a saved artifact's content, rather
 * than needing a second LLM call to judge the answer - a judge call would
 * add its own cost, latency, and flakiness to a harness whose whole point
 * is a reliable, fast CI signal.
 */
export const EVAL_TASKS: EvalTaskDef[] = [
  {
    key: 'echoes-a-fact',
    title: '[eval] Echo the secret code',
    description:
      `The secret code is "${SECRET_CODE}". Reply with one short sentence that repeats the secret ` +
      'code exactly, character for character. Do not call any tools - just reply with text.',
    acceptanceCriteria: `The final reply contains the exact string "${SECRET_CODE}".`,
    timeoutMs: 90_000,
    grade(ctx) {
      const failed = checkRunSucceeded(ctx);
      if (failed) return failed;
      const { run } = ctx;
      if (!(run.summary ?? '').includes(SECRET_CODE)) {
        return {
          passed: false,
          reason: `run.summary did not contain "${SECRET_CODE}" (got: ${run.summary ?? '(empty)'})`,
        };
      }
      return { passed: true, reason: `run succeeded and echoed "${SECRET_CODE}"` };
    },
  },

  {
    key: 'saves-an-artifact',
    title: '[eval] Save a marker artifact',
    description:
      'Call the save_artifact tool once: kind "doc", title "Eval note", content containing the ' +
      `exact marker string "${ARTIFACT_MARKER}" somewhere in it. Then reply with a one-sentence ` +
      'confirmation.',
    acceptanceCriteria:
      `An artifact linked to this task exists whose content includes the exact string ` +
      `"${ARTIFACT_MARKER}".`,
    timeoutMs: 120_000,
    async grade(ctx) {
      const failed = checkRunSucceeded(ctx);
      if (failed) return failed;
      const { artifacts } = ctx;
      if (artifacts.length === 0) {
        return { passed: false, reason: 'no artifact was created for this task' };
      }
      for (const artifact of artifacts) {
        let content: string;
        try {
          content = await readArtifactText(artifact.storage_key);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            passed: false,
            reason: `could not read artifact "${artifact.id}" content: ${message}`,
          };
        }
        if (content.includes(ARTIFACT_MARKER)) {
          return {
            passed: true,
            reason: `artifact "${artifact.id}" contains "${ARTIFACT_MARKER}"`,
          };
        }
      }
      return {
        passed: false,
        reason: `${artifacts.length} artifact(s) created, but none contained "${ARTIFACT_MARKER}"`,
      };
    },
  },
];

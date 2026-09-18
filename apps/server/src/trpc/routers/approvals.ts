import type { AskHumanPayload, HireApprovalPayload } from '@katnor/core';
import { APPROVAL_STATUSES } from '@katnor/core';
import { createAgentFromPayload, triggerRun } from '@katnor/agents';
import { approvalRepo, eventRepo, runRepo } from '@katnor/db';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';

/**
 * The Inbox page (PLAN.md 4.9): pending approvals AND pending questions
 * together, both modeled as `approval` rows - see the `question` kind's
 * doc comment in @katnor/core's enums.ts.
 */
export const approvalsRouter = router({
  list: protectedProcedure
    .input(z.object({ status: z.enum(APPROVAL_STATUSES).optional() }))
    .query(({ input }) => approvalRepo.list(input.status)),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => approvalRepo.getById(input.id)),

  /**
   * Approves or rejects a pending approval/question, performs whatever
   * that kind's decision actually means (a "hire" approval creates the
   * agent; a "question" needs `answer`), and wakes the run that asked -
   * with a `triggerRun` note describing what was decided, since there's
   * no channel message to represent it (see `triggerRun`'s `note` doc
   * comment in @katnor/agents).
   */
  decide: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        decision: z.enum(['approved', 'rejected']),
        /** Required when deciding a `kind: "question"` approval with `decision: "approved"`. */
        answer: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await approvalRepo.getById(input.id);
      if (!existing) {
        throw new Error(`No approval "${input.id}".`);
      }
      if (existing.status !== 'pending') {
        throw new Error(`Approval "${input.id}" was already ${existing.status}.`);
      }

      let payloadPatch: Record<string, unknown> | undefined;
      let note: string;

      if (existing.kind === 'hire') {
        const payload = existing.payload as unknown as HireApprovalPayload;
        if (input.decision === 'approved') {
          const created = await createAgentFromPayload(payload);
          note = `Your hire request for ${payload.name} was approved by the owner - they're now employee ${created.id}.`;
        } else {
          note = `Your hire request for ${payload.name} was declined by the owner.`;
        }
      } else if (existing.kind === 'question') {
        const payload = existing.payload as unknown as AskHumanPayload;
        if (input.decision === 'approved') {
          if (!input.answer) {
            throw new Error('An answer is required to approve a question.');
          }
          payloadPatch = { answer: input.answer };
          note = `The owner answered your question ("${payload.question}"): ${input.answer}`;
        } else {
          note = `The owner declined to answer your question ("${payload.question}").`;
        }
      } else {
        // "tool_call" / "spend" - not raised by anything until Phase 2's
        // work tools exist, but handled generically so the plumbing is
        // ready: no extra side effect beyond recording the decision.
        note = `Your ${existing.kind} request was ${input.decision} by the owner.`;
      }

      const decided = await approvalRepo.decide(input.id, {
        status: input.decision,
        decided_by: 'human',
        payloadPatch,
      });
      await eventRepo.append({
        type: 'approval.decided',
        payload: {
          approval_id: existing.id,
          kind: existing.kind,
          status: input.decision,
          decided_by: 'human',
        },
      });

      const originatingRun = await runRepo.getById(existing.run_id);
      if (originatingRun) {
        await triggerRun(ctx.boss, {
          agentId: originatingRun.agent_id,
          taskId: originatingRun.task_id,
          channelId: originatingRun.channel_id,
          trigger: 'human',
          note,
        });
      }

      return decided;
    }),
});

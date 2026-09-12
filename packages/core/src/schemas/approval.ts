import { z } from 'zod';
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '../enums.js';
import { withBase } from './base.js';

export const approvalFields = {
  kind: z.enum(APPROVAL_KINDS),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(APPROVAL_STATUSES),
  decided_by: z.string().nullable(),
  decided_at: z.date().nullable(),
};

export const approvalSchema = withBase(approvalFields);
export type Approval = z.infer<typeof approvalSchema>;

/**
 * A caller only proposes what needs approval; status and the decision
 * (decided_by/decided_at) are filled in once a human or policy decides.
 */
export const createApprovalInputSchema = z.object({
  kind: approvalFields.kind,
  payload: approvalFields.payload,
  status: approvalFields.status.default('pending'),
});
export type CreateApprovalInput = z.infer<typeof createApprovalInputSchema>;

import { z } from 'zod';
import { APPROVAL_KINDS } from '../enums.js';
import { withBase } from './base.js';
import { modelConfigSchema } from './modelConfig.js';

export const approvalModeSchema = z.enum(['auto', 'ask_once_per_project', 'always_ask']);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const approvalPolicySchema = z.object({
  hire: approvalModeSchema,
  tool_call: approvalModeSchema,
  spend: approvalModeSchema,
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

/** Sanity check: approval_policy is keyed by every ApprovalKind. */
export const APPROVAL_POLICY_KEYS = APPROVAL_KINDS;

export const companyBudgetsSchema = z.object({
  company_daily_usd: z.number().nonnegative(),
  project_daily_usd: z.number().nonnegative().optional(),
  agent_daily_usd: z.number().nonnegative().optional(),
});
export type CompanyBudgets = z.infer<typeof companyBudgetsSchema>;

export const companySettingsSchema = z.object({
  default_model: modelConfigSchema,
  budgets: companyBudgetsSchema,
  approval_policy: approvalPolicySchema,
});
export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const companyFields = {
  name: z.string().min(1),
  settings: companySettingsSchema,
};

export const companySchema = withBase(companyFields);
export type Company = z.infer<typeof companySchema>;

export const createCompanyInputSchema = z.object(companyFields);
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;

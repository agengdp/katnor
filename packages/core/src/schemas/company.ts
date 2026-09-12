import { z } from 'zod';
import { APPROVAL_KINDS } from '../enums.js';
import { withBase } from './base.js';
import { modelConfigSchema } from './modelConfig.js';

export const APPROVAL_MODES = ['auto', 'ask_once_per_project', 'always_ask'] as const;
export const approvalModeSchema = z.enum(APPROVAL_MODES);
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

/**
 * The settings every company should have from day one, used to fill in
 * whatever `company.settings` doesn't already specify. `company.settings` is
 * stored as a `Partial<CompanySettings>` in @katnor/db (Phase 0 seeded it as
 * `{}`, before there was anything to default), so any code that *reads*
 * settings should go through `mergeCompanySettings` below rather than
 * assume every key is present.
 */
export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  default_model: {
    provider: 'anthropic',
    model: 'claude-opus-5',
    effort: 'high',
    thinking_display: 'omitted',
    max_tokens: 8192,
  },
  budgets: {
    company_daily_usd: 50,
  },
  approval_policy: {
    // Hiring changes headcount and ongoing spend, so it's opt-in by
    // default; tool_call/spend aren't exercised by anything until Phase 2
    // adds real work tools, but default them sensibly now anyway.
    hire: 'always_ask',
    tool_call: 'auto',
    spend: 'ask_once_per_project',
  },
};

/**
 * Layers a possibly-partial (or entirely empty) `company.settings` value
 * over `DEFAULT_COMPANY_SETTINGS`, one level deep per top-level key
 * (`default_model`, `budgets`, `approval_policy` each fully replace the
 * default when present, rather than a deep field-by-field merge - every
 * caller so far only ever writes one of these three objects whole).
 */
export function mergeCompanySettings(partial: Partial<CompanySettings> | null | undefined): CompanySettings {
  return {
    default_model: partial?.default_model ?? DEFAULT_COMPANY_SETTINGS.default_model,
    budgets: partial?.budgets ?? DEFAULT_COMPANY_SETTINGS.budgets,
    approval_policy: partial?.approval_policy ?? DEFAULT_COMPANY_SETTINGS.approval_policy,
  };
}

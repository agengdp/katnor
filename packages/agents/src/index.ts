// @katnor/agents - the agent run loop, prompt builder, company tools, and
// hiring logic (hire_agent/update_agent/fire_agent/create_team). See PLAN.md
// sections 4.1 and 4.2.
//
// TODO: implemented in a later phase

export const AGENTS_PACKAGE_NAME = '@katnor/agents';

export type AgentTrigger = 'task' | 'mention' | 'schedule' | 'human';

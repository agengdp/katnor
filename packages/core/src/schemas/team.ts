import { z } from 'zod';
import { withBase } from './base.js';

export const teamFields = {
  name: z.string().min(1),
  lead_agent_id: z.string().nullable(),
};

export const teamSchema = withBase(teamFields);
export type Team = z.infer<typeof teamSchema>;

export const createTeamInputSchema = z.object({
  ...teamFields,
  lead_agent_id: teamFields.lead_agent_id.optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;

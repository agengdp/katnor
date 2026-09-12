import { relations } from 'drizzle-orm';
import { agent } from './agent.js';
import { artifact } from './artifact.js';
import { channel } from './channel.js';
import { kgEdge } from './kgEdge.js';
import { kgNode } from './kgNode.js';
import { message } from './message.js';
import { project } from './project.js';
import { run } from './run.js';
import { runStep } from './runStep.js';
import { task } from './task.js';
import { team } from './team.js';

/**
 * All `relations()` definitions live in this one file, separate from the
 * table definitions themselves, rather than inside e.g. agent.ts or
 * task.ts.
 *
 * Why: `relations(table, callback)` invokes `callback` immediately (it is
 * not deferred the way `.references(() => otherTable.column)` is - see the
 * comment in ./team.ts). If agent.ts, task.ts, and run.ts each imported
 * each other just to call `relations(...)` inline, the first module in
 * that import cycle to evaluate could try to read a sibling table binding
 * before that sibling has finished initializing, throwing a "cannot access
 * before initialization" error. Collecting every `relations()` call here
 * means this file imports every table it needs, but no table file imports
 * this one back - so by the time any `relations(...)` call below actually
 * runs, every table it references is guaranteed to already be fully
 * initialized.
 *
 * Only the tables called out as "FK-heavy" get relations defined here:
 * agent, task, run, run_step, message, artifact, kg_edge. Other tables
 * (team, project, channel, kg_node, ...) can still be the *target* of a
 * relation (e.g. `task.project`) without needing their own `relations()`
 * entry - that's only required for querying with `with: {...}` starting
 * from that other side.
 */

export const agentRelations = relations(agent, ({ one, many }) => ({
  team: one(team, { fields: [agent.team_id], references: [team.id] }),
  manager: one(agent, {
    fields: [agent.reports_to],
    references: [agent.id],
    relationName: 'agent_manager',
  }),
  directReports: many(agent, { relationName: 'agent_manager' }),
  runs: many(run),
  assignedTasks: many(task),
}));

export const taskRelations = relations(task, ({ one, many }) => ({
  project: one(project, { fields: [task.project_id], references: [project.id] }),
  assignee: one(agent, { fields: [task.assignee_id], references: [agent.id] }),
  parent: one(task, {
    fields: [task.parent_id],
    references: [task.id],
    relationName: 'task_parent',
  }),
  subtasks: many(task, { relationName: 'task_parent' }),
  runs: many(run),
  artifacts: many(artifact),
}));

export const runRelations = relations(run, ({ one, many }) => ({
  agent: one(agent, { fields: [run.agent_id], references: [agent.id] }),
  task: one(task, { fields: [run.task_id], references: [task.id] }),
  steps: many(runStep),
  artifacts: many(artifact),
}));

export const runStepRelations = relations(runStep, ({ one }) => ({
  run: one(run, { fields: [runStep.run_id], references: [run.id] }),
}));

export const messageRelations = relations(message, ({ one, many }) => ({
  channel: one(channel, { fields: [message.channel_id], references: [channel.id] }),
  replyTo: one(message, {
    fields: [message.reply_to],
    references: [message.id],
    relationName: 'message_reply_to',
  }),
  replies: many(message, { relationName: 'message_reply_to' }),
}));

export const artifactRelations = relations(artifact, ({ one }) => ({
  project: one(project, { fields: [artifact.project_id], references: [project.id] }),
  task: one(task, { fields: [artifact.task_id], references: [task.id] }),
  run: one(run, { fields: [artifact.run_id], references: [run.id] }),
}));

export const kgEdgeRelations = relations(kgEdge, ({ one }) => ({
  from: one(kgNode, {
    fields: [kgEdge.from_id],
    references: [kgNode.id],
    relationName: 'kg_edge_from',
  }),
  to: one(kgNode, {
    fields: [kgEdge.to_id],
    references: [kgNode.id],
    relationName: 'kg_edge_to',
  }),
}));

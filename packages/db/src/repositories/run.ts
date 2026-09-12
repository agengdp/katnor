import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { run } from '../schema/index.js';
import { ulid } from '../ulid.js';

export type RunRow = typeof run.$inferSelect;
export type CreateRunInput = Omit<
  typeof run.$inferInsert,
  'id' | 'created_at' | 'updated_at' | 'started_at' | 'status' | 'tokens_in' | 'tokens_out' | 'cost_usd'
>;
export type UpdateRunInput = Partial<Omit<typeof run.$inferInsert, 'id' | 'created_at' | 'agent_id'>>;

export interface ListRunsFilter {
  agent_id?: string;
  task_id?: string;
}

export async function create(input: CreateRunInput): Promise<RunRow> {
  const [created] = await db
    .insert(run)
    .values({ id: ulid(), status: 'queued', ...input })
    .returning();
  if (!created) {
    throw new Error('create(run): insert returned no row');
  }
  return created;
}

export async function getById(id: string): Promise<RunRow | undefined> {
  const [row] = await db.select().from(run).where(eq(run.id, id)).limit(1);
  return row;
}

/** Always bumps `updated_at`, in addition to whatever fields are in `patch`. */
export async function update(id: string, patch: UpdateRunInput): Promise<RunRow | undefined> {
  const [updated] = await db
    .update(run)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(run.id, id))
    .returning();
  return updated;
}

/**
 * Most recent first - the natural order for a Runs page.
 *
 * Built as two full, separately-typed query chains (rather than starting
 * one chain and conditionally calling `.where()` on it afterward) because
 * drizzle's query builder narrows its own type after `.orderBy()`/`.limit()`
 * in a way that no longer offers `.where()` - matching the same pattern
 * `./task.ts`'s `list()` already uses for its one optional filter.
 */
export async function list(filter: ListRunsFilter = {}): Promise<RunRow[]> {
  const conditions = [];
  if (filter.agent_id !== undefined) conditions.push(eq(run.agent_id, filter.agent_id));
  if (filter.task_id !== undefined) conditions.push(eq(run.task_id, filter.task_id));

  if (conditions.length === 0) {
    return db.select().from(run).orderBy(desc(run.started_at)).limit(200);
  }
  return db
    .select()
    .from(run)
    .where(and(...conditions))
    .orderBy(desc(run.started_at))
    .limit(200);
}

export interface SumCostFilter {
  agentId?: string;
  /** Runs belonging to any task under this project - see @katnor/agents' budget hard-stop check, the only caller that needs this. */
  projectId?: string;
}

/**
 * Total `cost_usd` across every run started at or after `since`, optionally
 * scoped to one agent or one project - "spend so far today" for the header
 * cost meter and the office's day/night tint (no filter, PLAN.md 4.8/4.9),
 * and for @katnor/agents' runExecutor.ts's budget hard-stop check (agent or
 * project filter, PLAN.md Phase 5).
 */
export async function sumCostSince(since: Date, filter: SumCostFilter = {}): Promise<number> {
  const conditions = [gte(run.started_at, since)];
  if (filter.agentId !== undefined) conditions.push(eq(run.agent_id, filter.agentId));
  if (filter.projectId !== undefined) {
    conditions.push(sql`${run.task_id} in (select id from task where project_id = ${filter.projectId})`);
  }
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${run.cost_usd}), 0)` })
    .from(run)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export interface AgentCost {
  agentId: string;
  totalUsd: number;
}

/** Per-agent totals since `since` - the cost dashboard's "by agent" breakdown (PLAN.md Phase 5). Agents with no runs in the window are simply absent, not zero-valued. */
export async function costByAgentSince(since: Date): Promise<AgentCost[]> {
  const rows = await db
    .select({ agentId: run.agent_id, total: sql<string>`coalesce(sum(${run.cost_usd}), 0)` })
    .from(run)
    .where(gte(run.started_at, since))
    .groupBy(run.agent_id);
  return rows.map((row) => ({ agentId: row.agentId, totalUsd: Number(row.total) }));
}

export interface ProjectCost {
  projectId: string;
  totalUsd: number;
}

/**
 * Per-project totals since `since`, via each run's task - the cost
 * dashboard's "by project" breakdown. A raw join (not the query builder):
 * `run` has no `project_id` of its own, only `task_id`, and a run with no
 * task (a hiring/org-tools run) contributes nothing here, same as it
 * contributes nothing to any project's knowledge graph or wiki either.
 *
 * NOTE: written with no way to run this against a live Postgres instance
 * in this sandbox - see kgNode.ts's `searchByEmbedding` for the same
 * caveat on raw `db.execute(sql\`...\`)` queries in this codebase.
 */
export async function costByProjectSince(since: Date): Promise<ProjectCost[]> {
  const result = await db.execute(sql`
    select t.project_id as project_id, coalesce(sum(r.cost_usd), 0) as total
    from run r
    join task t on t.id = r.task_id
    where r.started_at >= ${since}
    group by t.project_id
  `);
  return [...result].map((row) => {
    const typed = row as { project_id: string; total: string };
    return { projectId: typed.project_id, totalUsd: Number(typed.total) };
  });
}

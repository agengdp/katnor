import { createHash } from 'node:crypto';
import { QUEUES } from '@katnor/agents';
import { eventRepo, kgEdgeRepo, kgNodeRepo, projectRepo, wikiPageRepo } from '@katnor/db';
import { answerWithCitations, commit, embed, ensureProjectWiki, listPages, readPage, searchKnowledge, writePage } from '@katnor/knowledge';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';

async function requireProject(projectId: string) {
  const project = await projectRepo.getById(projectId);
  if (!project) throw new Error(`No project "${projectId}".`);
  return project;
}

/**
 * The Knowledge page (PLAN.md 4.9/4.4/4.5): wiki browse/edit, an ask box
 * with citations, and the graph explorer's data source. `reindexCode`/
 * `lintProject` just enqueue the corresponding worker job (see
 * @katnor/agents' queues.ts) - both jobs need @katnor/tools' Docker/host
 * workspace access, which only apps/worker has.
 */
export const knowledgeRouter = router({
  search: publicProcedure
    .input(z.object({ projectId: z.string(), query: z.string() }))
    .query(({ input }) => searchKnowledge(input.projectId, input.query)),

  askWiki: publicProcedure
    .input(z.object({ projectId: z.string(), question: z.string() }))
    .mutation(({ input }) => answerWithCitations(input.projectId, input.question)),

  listWikiPages: publicProcedure.input(z.object({ projectId: z.string() })).query(async ({ input }) => {
    const project = await requireProject(input.projectId);
    await ensureProjectWiki(project.id, project.name);
    const [paths, rows] = await Promise.all([listPages(project.id), wikiPageRepo.list(project.id)]);
    const byPath = new Map(rows.map((row) => [row.path, row]));
    return paths.map((path) => ({
      path,
      title: byPath.get(path)?.title ?? path,
      updatedAt: byPath.get(path)?.updated_at ?? null,
    }));
  }),

  getWikiPage: publicProcedure.input(z.object({ projectId: z.string(), path: z.string() })).query(async ({ input }) => {
    const content = await readPage(input.projectId, input.path);
    if (content === null) throw new Error(`No wiki page "${input.path}".`);
    return { path: input.path, content };
  }),

  /**
   * A human editing a page directly (PLAN.md 4.5's "humans edit in the
   * dashboard"). Writes the file, re-embeds it, upserts the DB mirror, and
   * commits - the same three steps ./librarian.ts's `writeDecisionPage`
   * does for an agent-authored page, just triggered by a save button
   * instead of an ingest job.
   */
  saveWikiPage: protectedProcedure
    .input(z.object({ projectId: z.string(), path: z.string(), title: z.string().min(1), content: z.string() }))
    .mutation(async ({ input }) => {
      const project = await requireProject(input.projectId);
      await ensureProjectWiki(project.id, project.name);
      await writePage(project.id, input.path, input.content);

      const contentHash = createHash('sha256').update(input.content).digest('hex');
      const embedding = await embed(input.content);
      const row = await wikiPageRepo.upsert({
        project_id: project.id,
        path: input.path,
        title: input.title,
        frontmatter: {},
        content_hash: contentHash,
        embedding,
      });
      await commit(project.id, `Owner edit: ${input.path}`);
      await eventRepo.append({
        type: 'wiki_page.updated',
        payload: { wiki_page_id: row.id, project_id: project.id, path: row.path },
      });
      return row;
    }),

  listGraph: publicProcedure.input(z.object({ projectId: z.string() })).query(async ({ input }) => {
    const [nodes, edges] = await Promise.all([
      kgNodeRepo.list({ project_id: input.projectId }),
      kgEdgeRepo.listForProject(input.projectId),
    ]);
    // Embeddings are large (1536 floats) and never rendered - stripped
    // before crossing the wire rather than sent and ignored.
    return { nodes: nodes.map(({ embedding: _embedding, ...rest }) => rest), edges };
  }),

  reindexCode: protectedProcedure.input(z.object({ projectId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(input.projectId);
    await ctx.boss.send(QUEUES.CODE_INDEX, { projectId: input.projectId });
    return { queued: true };
  }),

  lintProject: protectedProcedure.input(z.object({ projectId: z.string() })).mutation(async ({ ctx, input }) => {
    await requireProject(input.projectId);
    await ctx.boss.send(QUEUES.WIKI_LINT, { projectId: input.projectId });
    return { queued: true };
  }),
});

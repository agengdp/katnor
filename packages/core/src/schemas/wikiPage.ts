import { z } from 'zod';
import { withBase } from './base.js';
import { embeddingSchema } from './kgNode.js';

export const wikiPageFrontmatterSchema = z.object({
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
});
export type WikiPageFrontmatter = z.infer<typeof wikiPageFrontmatterSchema>;

export const wikiPageFields = {
  project_id: z.string(),
  path: z.string(),
  title: z.string().min(1),
  frontmatter: wikiPageFrontmatterSchema,
  content_hash: z.string(),
  embedding: embeddingSchema,
};

export const wikiPageSchema = withBase(wikiPageFields);
export type WikiPage = z.infer<typeof wikiPageSchema>;

export const createWikiPageInputSchema = z.object({
  ...wikiPageFields,
  frontmatter: wikiPageFields.frontmatter.default({}),
  embedding: wikiPageFields.embedding.optional(),
});
export type CreateWikiPageInput = z.infer<typeof createWikiPageInputSchema>;

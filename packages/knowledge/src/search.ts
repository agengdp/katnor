import { kgNodeRepo, wikiPageRepo } from '@katnor/db';
import { embed, embeddingsAvailable } from './embeddings.js';
import * as wikiStorage from './wikiStorage.js';

/**
 * One retrieved hit, whether it came from vector or keyword matching -
 * `search_knowledge`'s and `ask_wiki`'s common currency (PLAN.md 4.4:
 * "returning a compact context block with citations").
 */
export interface SearchCitation {
  kind: 'kg_node' | 'wiki_page';
  id: string;
  title: string;
  snippet?: string;
  score: number;
  /** wiki_page hits only - relative path under the project's wiki root, for reading its full content (see ./ask.ts). */
  path?: string;
}

const DEFAULT_LIMIT = 8;
const SNIPPET_RADIUS_CHARS = 100;

function extractSnippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, SNIPPET_RADIUS_CHARS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS_CHARS);
  const end = Math.min(content.length, idx + query.length + SNIPPET_RADIUS_CHARS);
  return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`;
}

async function vectorSearch(projectId: string, embedding: number[], limit: number): Promise<SearchCitation[]> {
  const [nodes, pages] = await Promise.all([
    kgNodeRepo.searchByEmbedding(embedding, { projectId, limit }),
    wikiPageRepo.searchByEmbedding(embedding, { projectId, limit }),
  ]);
  return [
    ...nodes.map((n): SearchCitation => ({ kind: 'kg_node', id: n.id, title: n.name, snippet: n.summary ?? undefined, score: n.score })),
    ...pages.map((p): SearchCitation => ({ kind: 'wiki_page', id: p.id, title: p.title, path: p.path, score: p.score })),
  ];
}

/**
 * Keyword fallback, used whenever embeddings aren't configured (or a query
 * embedding call fails). @katnor/db's keyword search only covers
 * name/summary (kg_node) or title/path (wiki_page) - a page's actual body
 * lives on disk, not in Postgres (see wikiPage.ts's `searchByKeyword` doc
 * comment) - so this additionally scans every page's real content for the
 * query term, which a vector search never needs to do since the embedding
 * already captures the body.
 */
async function keywordSearch(projectId: string, query: string, limit: number): Promise<SearchCitation[]> {
  const [nodes, titleMatches, allPaths] = await Promise.all([
    kgNodeRepo.searchByKeyword(query, { projectId, limit }),
    wikiPageRepo.searchByKeyword(query, { projectId, limit }),
    wikiPageRepo.list(projectId),
  ]);

  const nodeHits: SearchCitation[] = nodes.map((n) => ({
    kind: 'kg_node',
    id: n.id,
    title: n.name,
    snippet: n.summary ?? undefined,
    score: 0.5,
  }));

  const pageHits = new Map<string, SearchCitation>();
  const lowerQuery = query.toLowerCase();

  for (const page of titleMatches) {
    pageHits.set(page.id, { kind: 'wiki_page', id: page.id, title: page.title, path: page.path, score: 0.6 });
  }
  for (const page of allPaths) {
    if (pageHits.size >= limit * 2) break; // cheap upper bound before scoring/truncating below
    if (pageHits.has(page.id)) continue;
    const content = await wikiStorage.readPage(projectId, page.path);
    if (content && content.toLowerCase().includes(lowerQuery)) {
      pageHits.set(page.id, {
        kind: 'wiki_page',
        id: page.id,
        title: page.title,
        path: page.path,
        snippet: extractSnippet(content, query),
        score: 0.5,
      });
    }
  }

  return [...nodeHits, ...pageHits.values()];
}

/**
 * Hybrid search over a project's knowledge graph + wiki (PLAN.md 4.4's
 * `search_knowledge` tool): vector similarity when EMBEDDINGS_API_KEY is
 * configured, plain keyword matching otherwise - see ./embeddings.ts's doc
 * comment on why this degrades rather than errors.
 */
export async function searchKnowledge(projectId: string, query: string, limit = DEFAULT_LIMIT): Promise<SearchCitation[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const embedding = embeddingsAvailable() ? await embed(trimmed) : null;
  const hits = embedding ? await vectorSearch(projectId, embedding, limit) : await keywordSearch(projectId, trimmed, limit);

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

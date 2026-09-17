import { getProvider } from '@katnor/llm';
import { searchKnowledge, type SearchCitation } from './search.js';
import * as wikiStorage from './wikiStorage.js';

export interface WikiAnswer {
  answer: string;
  citations: SearchCitation[];
}

const ASK_MODEL = 'claude-sonnet-5';
const MAX_PAGE_CHARS = 4000;

const SYSTEM_PROMPT = [
  "Answer the user's question using ONLY the provided context (this project's wiki pages and",
  'knowledge graph entries). Cite what you used by its bracketed id, e.g. "[wiki:auth.md]" or',
  '"[node:abc123]", inline in your answer next to the claim it supports. If the context does not',
  'answer the question, say so plainly rather than guessing - do not use outside knowledge.',
].join('\n');

async function renderContext(hits: SearchCitation[], projectId: string): Promise<string> {
  const blocks = await Promise.all(
    hits.map(async (hit) => {
      if (hit.kind === 'kg_node') {
        return `[node:${hit.id}] ${hit.title}${hit.snippet ? ` - ${hit.snippet}` : ''}`;
      }
      const content = hit.path ? await wikiStorage.readPage(projectId, hit.path) : null;
      const body = content
        ? content.slice(0, MAX_PAGE_CHARS)
        : (hit.snippet ?? '(content unavailable)');
      return `[wiki:${hit.path ?? hit.id}] ${hit.title}\n${body}`;
    }),
  );
  return blocks.join('\n\n---\n\n');
}

/**
 * PLAN.md 4.5's `ask_wiki(question)`: retrieves relevant wiki pages +
 * knowledge-graph nodes (./search.ts) and answers with inline citations,
 * using a single one-shot `provider.step()` call (no tools, no agent
 * loop - this isn't a run, so nothing here is persisted as a `run_step`).
 * Shared by the `ask_wiki` company tool (@katnor/agents) and apps/server's
 * `knowledge.askWiki` procedure (the dashboard's ask box), so both give
 * the same answer to the same question.
 */
export async function answerWithCitations(
  projectId: string,
  question: string,
): Promise<WikiAnswer> {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return { answer: 'Ask a specific question and I can look it up.', citations: [] };
  }

  const hits = await searchKnowledge(projectId, trimmed, 8);
  if (hits.length === 0) {
    return {
      answer:
        "I don't have anything in this project's wiki or knowledge graph relevant to that yet.",
      citations: [],
    };
  }

  const context = await renderContext(hits, projectId);
  const provider = getProvider('anthropic');

  let result;
  try {
    result = await provider.step({
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `## Context\n\n${context}\n\n## Question\n\n${trimmed}` },
          ],
        },
      ],
      tools: [],
      model: ASK_MODEL,
      effort: 'medium',
      thinkingDisplay: 'omitted',
      maxTokens: 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { answer: `Couldn't reach the model to answer that: ${message}`, citations: hits };
  }

  if (result.stopReason === 'error' || result.stopReason === 'refusal') {
    return {
      answer: `Couldn't answer that: ${result.errorMessage ?? result.refusalCategory ?? result.stopReason}`,
      citations: hits,
    };
  }

  const textBlock = result.content.find((block) => block.type === 'text');
  const answer =
    textBlock && textBlock.type === 'text' && textBlock.text.trim().length > 0
      ? textBlock.text
      : '(no answer text returned)';
  return { answer, citations: hits };
}

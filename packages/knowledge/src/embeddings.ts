import { EMBEDDING_DIMENSIONS } from '@katnor/core';

/**
 * Embeddings are a separate concern from chat/agent models (PLAN.md's
 * `LLMProvider` interface, @katnor/llm, only covers the latter - Anthropic
 * itself has no embeddings API). This adapter calls OpenAI's
 * `text-embedding-3-small` directly over plain `fetch` (no SDK dependency,
 * same pattern as this system's other externally-hit HTTP APIs) because
 * its *native* output size is exactly `EMBEDDING_DIMENSIONS` (1536) - the
 * dimension Phase 0 already fixed into `kg_node.embedding`/
 * `wiki_page.embedding`'s pgvector column and @katnor/core's
 * `embeddingSchema` before this phase existed to choose otherwise. Gated
 * behind `EMBEDDINGS_API_KEY` (see .env.example) rather than reusing the
 * "openai_compatible" `provider_config` row Settings already has: that row
 * may point `base_url` at a non-OpenAI, non-embeddings endpoint (e.g.
 * Ollama), so conflating the two would silently break either use.
 *
 * When unset, `embed()` returns `null` rather than throwing - every caller
 * in this package (search.ts, extraction.ts's dedupe, librarian.ts) treats
 * a null embedding as "fall back to keyword-only matching for this text",
 * never as an error. This is what "hybrid search" degrades to gracefully
 * without an embeddings key configured, which this sandbox cannot itself
 * exercise (no network access to call OpenAI's API at all, let alone
 * verify this exact request/response shape against it).
 */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';

function getApiKey(): string | undefined {
  const key = process.env.EMBEDDINGS_API_KEY;
  return key && key.trim().length > 0 ? key : undefined;
}

interface OpenAiEmbeddingResponse {
  data: { embedding: number[] }[];
}

/** Embeds one string, or returns `null` if EMBEDDINGS_API_KEY isn't configured or the call fails. Never throws. */
export async function embed(text: string): Promise<number[] | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });
    if (!response.ok) {
      console.error(`[knowledge/embeddings] OpenAI embeddings request failed: ${response.status} ${response.statusText}`);
      return null;
    }
    const body = (await response.json()) as OpenAiEmbeddingResponse;
    const embedding = body.data[0]?.embedding;
    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error(
        `[knowledge/embeddings] unexpected embedding shape (length ${embedding?.length ?? 'undefined'}, expected ${EMBEDDING_DIMENSIONS})`,
      );
      return null;
    }
    return embedding;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge/embeddings] embed() failed: ${message}`);
    return null;
  }
}

/** True when EMBEDDINGS_API_KEY is configured - callers use this to decide whether to attempt vector search at all before bothering to embed a query. */
export function embeddingsAvailable(): boolean {
  return getApiKey() !== undefined;
}

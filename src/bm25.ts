/**
 * BM25 Search Implementation
 *
 * Okapi BM25 ranking function for full-text search over agent tools.
 * Used by the search_agent_tools MCP tool to find relevant tools by query.
 *
 * @see https://en.wikipedia.org/wiki/Okapi_BM25
 */

// ============================================
// Types
// ============================================

export interface BM25Options {
  /** Term frequency saturation parameter (default: 1.2) */
  k1?: number;
  /** Length normalization parameter (default: 0.75) */
  b?: number;
}

export interface BM25Document {
  /** Unique document identifier */
  id: string;
  /** Text content to index and search */
  text: string;
}

export interface BM25Result {
  /** Document ID */
  id: string;
  /** BM25 relevance score */
  score: number;
}

// ============================================
// Tokenizer
// ============================================

/** Simple whitespace + punctuation tokenizer with lowercasing */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ============================================
// BM25 Index
// ============================================

/**
 * In-memory BM25 search index.
 *
 * Build an index from documents, then query it to get ranked results.
 *
 * @example
 * ```typescript
 * const index = createBM25Index([
 *   { id: "tool-1", text: "greet a user by name" },
 *   { id: "tool-2", text: "search database records" },
 * ]);
 *
 * const results = index.search("greet");
 * // [{ id: "tool-1", score: 0.83 }]
 * ```
 */
export function createBM25Index(
  documents: BM25Document[],
  options: BM25Options = {},
) {
  const { k1 = 1.2, b = 0.75 } = options;

  // Tokenize all documents
  const docTokens: string[][] = documents.map((d) => tokenize(d.text));
  const docCount = documents.length;

  // Average document length
  const avgDl =
    docCount > 0
      ? docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docCount
      : 0;

  // Document frequency: how many documents contain each term
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // Term frequencies per document
  const tfs: Map<string, number>[] = docTokens.map((tokens) => {
    const freq = new Map<string, number>();
    for (const term of tokens) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
    return freq;
  });

  /**
   * Compute IDF for a term using the BM25 variant:
   * ln((N - df + 0.5) / (df + 0.5) + 1)
   */
  function idf(term: string): number {
    const n = df.get(term) ?? 0;
    return Math.log((docCount - n + 0.5) / (n + 0.5) + 1);
  }

  /**
   * Search the index with a text query.
   * Returns results sorted by descending BM25 score.
   */
  function search(query: string, limit?: number): BM25Result[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const scores: BM25Result[] = [];

    for (let i = 0; i < docCount; i++) {
      const dl = docTokens[i].length;
      const tf = tfs[i];
      let score = 0;

      for (const term of queryTerms) {
        const termFreq = tf.get(term) ?? 0;
        if (termFreq === 0) continue;

        const termIdf = idf(term);
        const numerator = termFreq * (k1 + 1);
        const denominator = termFreq + k1 * (1 - b + b * (dl / avgDl));
        score += termIdf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ id: documents[i].id, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return limit != null ? scores.slice(0, limit) : scores;
  }

  return { search };
}

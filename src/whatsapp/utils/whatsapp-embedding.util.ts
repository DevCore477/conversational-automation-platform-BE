/** Pure vector-math helpers for in-app semantic retrieval (no pgvector dependency). */

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankableItem {
  id: string;
  embedding: number[] | null;
}

/** Rank candidates by cosine similarity to a query embedding, dropping ones with no embedding. */
export function rankBySimilarity<T extends RankableItem>(
  candidates: T[],
  queryEmbedding: number[],
  topN: number,
): Array<T & { score: number }> {
  return candidates
    .filter((c): c is T & { embedding: number[] } => Array.isArray(c.embedding) && c.embedding.length > 0)
    .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, topN);
}

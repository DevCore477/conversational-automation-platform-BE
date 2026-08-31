import { cosineSimilarity, rankBySimilarity } from './whatsapp-embedding.util';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 when either vector is all zeros', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('compares only the overlapping length when vectors differ in size', () => {
    expect(cosineSimilarity([1, 1], [1, 1, 999])).toBeCloseTo(1);
  });
});

describe('rankBySimilarity', () => {
  const query = [1, 0, 0];

  it('ranks candidates by descending similarity', () => {
    const candidates = [
      { id: 'a', embedding: [0, 1, 0] }, // orthogonal -> 0
      { id: 'b', embedding: [1, 0, 0] }, // identical -> 1
      { id: 'c', embedding: [0.9, 0.1, 0] }, // close -> ~0.99
    ];

    const ranked = rankBySimilarity(candidates, query, 3);

    expect(ranked.map(r => r.id)).toEqual(['b', 'c', 'a']);
    expect(ranked[0].score).toBeCloseTo(1);
  });

  it('drops candidates with no embedding', () => {
    const candidates = [
      { id: 'a', embedding: null },
      { id: 'b', embedding: [1, 0, 0] },
      { id: 'c', embedding: [] },
    ];

    const ranked = rankBySimilarity(candidates, query, 10);

    expect(ranked.map(r => r.id)).toEqual(['b']);
  });

  it('respects topN', () => {
    const candidates = [
      { id: 'a', embedding: [1, 0, 0] },
      { id: 'b', embedding: [0.9, 0, 0] },
      { id: 'c', embedding: [0.8, 0, 0] },
    ];

    const ranked = rankBySimilarity(candidates, query, 2);

    expect(ranked).toHaveLength(2);
    expect(ranked.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array when no candidates have embeddings', () => {
    expect(rankBySimilarity([{ id: 'a', embedding: null }], query, 5)).toEqual([]);
  });
});

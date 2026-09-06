import { describe, it, expect } from 'vitest';
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import {
  retrieveTopK,
  retrieveTopKSessions,
  retrieveByQueries,
  retrieveSessionsByTurns,
  retrieveTopKByQueries,
  retrieveTopKByQueriesHybrid,
  extractLexicalKeywords,
  countLexicalMatches,
  expandContextWindow,
  meanPool,
  embedManyCached,
  embedOneCached,
  clearEmbeddingCache,
  snapshotEmbeddingCache,
  mergeEmbeddingCache,
  serializeEmbeddingCache,
  deserializeEmbeddingCache,
  hashText,
} from '../retrieval.js';
import { tableEmbedding } from './test-embedding.js';

describe('hashText', () => {
  it('is deterministic and stable', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('world'));
  });
});

describe('embedManyCached', () => {
  it('caches identical texts and returns one vector per input', async () => {
    clearEmbeddingCache();
    let calls = 0;
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        calls += texts.length;
        return texts.map(() => new Float64Array(4));
      },
    };
    const a = await embedManyCached(embedding, ['x', 'y']);
    const b = await embedManyCached(embedding, ['x', 'y']);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    // The second call is served entirely from the cache.
    expect(calls).toBe(2);
  });

  it('falls back to an empty vector when the provider returns fewer vectors', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async () => [],
    };
    const result = await embedManyCached(embedding, ['a', 'b']);
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBe(0);
    expect(result[1]!.length).toBe(0);
  });
});

describe('embedOneCached', () => {
  it('embeds a single text via the shared cache', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 2,
      embed: async (texts) => texts.map(() => new Float64Array([1, 2])),
    };
    const v = await embedOneCached(embedding, 'hello');
    expect(v).toBeInstanceOf(Float64Array);
    expect(v.length).toBe(2);
  });
});

describe('retrieveTopK', () => {
  it('returns top-k hits with text and score', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopK(embedding, 'q', ['turn a', 'turn b'], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.text).toBeDefined();
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty list for empty context', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopK(embedding, 'q', [], 5);
    expect(hits).toEqual([]);
  });

  it('reports each hit original context index', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopK(embedding, 'q', ['a', 'b', 'c'], 3);
    expect(hits.map((h) => h.index).sort()).toEqual([0, 1, 2]);
  });
});

describe('expandContextWindow', () => {
  it('includes neighbours around each hit and de-duplicates overlaps', () => {
    const context = ['a', 'b', 'c', 'd', 'e', 'f'];
    const expanded = expandContextWindow(context, [1, 4], 1);
    expect(expanded).toBe('a\nb\nc\nd\ne\nf');
  });

  it('clamps the window at the boundaries', () => {
    const context = ['a', 'b', 'c'];
    expect(expandContextWindow(context, [0], 1)).toBe('a\nb');
    expect(expandContextWindow(context, [2], 1)).toBe('b\nc');
  });

  it('skips invalid indices', () => {
    const context = ['a', 'b'];
    expect(expandContextWindow(context, [-1, 5], 1)).toBe('');
  });
});

describe('meanPool', () => {
  it('returns an empty vector for empty input', () => {
    expect(Array.from(meanPool([]))).toEqual([]);
  });

  it('averages equal-length vectors element-wise', () => {
    const result = meanPool([new Float64Array([1, 2]), new Float64Array([3, 4])]);
    expect(Array.from(result)).toEqual([2, 3]);
  });
});

describe('retrieveTopKSessions', () => {
  it('returns top-k sessions with text, index, and score', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopKSessions(embedding, 'q', [['turn a'], ['turn b']], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.text).toBe('turn a');
    expect(hits[0]!.sessionIndex).toBeGreaterThanOrEqual(0);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty list when all sessions are empty', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopKSessions(embedding, 'q', [[], []], 2);
    expect(hits).toEqual([]);
  });

  it('skips sessions whose pooled vector is empty', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      // Returning no vectors makes every turn vector empty, so the pooled
      // session vector is empty and the session is skipped.
      embed: async () => [],
    };
    const hits = await retrieveTopKSessions(embedding, 'q', [['turn a']], 2);
    expect(hits).toEqual([]);
  });
});

describe('retrieveByQueries', () => {
  it('merges sessions across queries, keeping one entry per session', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    const hits = await retrieveByQueries(embedding, ['q1', 'q2'], [['turn a'], ['turn b']], 2);
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.size).toBe(hits.length);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty list when all queries match no session', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async () => [],
    };
    const hits = await retrieveByQueries(embedding, ['q1', 'q2'], [['turn a']], 2);
    expect(hits).toEqual([]);
  });

  it('embeds all queries in one batched pass instead of one request per query', async () => {
    clearEmbeddingCache();
    const batches: string[][] = [];
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        batches.push([...texts]);
        return texts.map(() => new Float64Array([1, 0, 0, 0]));
      },
    };
    await retrieveByQueries(embedding, ['q1', 'q2', 'q3'], [['turn a'], ['turn b']], 2);
    // One batch for the flattened turns, one batch for the three queries.
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(['turn a', 'turn b']);
    expect(batches[1]).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('retrieveTopKByQueries', () => {
  it('merges turns across queries, keeping one entry per turn', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    const hits = await retrieveTopKByQueries(embedding, ['q1', 'q2'], ['turn a', 'turn b'], 2);
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.size).toBe(hits.length);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('caps the merged result to topK total turns', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    const hits = await retrieveTopKByQueries(
      embedding,
      ['q1', 'q2', 'q3'],
      ['a', 'b', 'c', 'd', 'e'],
      2,
    );
    // Even with three queries over five turns, the merged result is capped.
    expect(hits.length).toBe(2);
  });

  it('returns an empty list when all queries match no turn', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async () => [],
    };
    const hits = await retrieveTopKByQueries(embedding, ['q1', 'q2'], [], 2);
    expect(hits).toEqual([]);
  });

  it('embeds all queries in one batched pass instead of one request per query', async () => {
    clearEmbeddingCache();
    const batches: string[][] = [];
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        batches.push([...texts]);
        return texts.map(() => new Float64Array([1, 0, 0, 0]));
      },
    };
    await retrieveTopKByQueries(embedding, ['q1', 'q2', 'q3'], ['turn a', 'turn b'], 2);
    // One batch for the turns, one batch for the three queries.
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(['turn a', 'turn b']);
    expect(batches[1]).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('extractLexicalKeywords', () => {
  it('drops stopwords and keeps discriminating tokens', () => {
    const keywords = extractLexicalKeywords(['What book did I read about gardening?']);
    expect(keywords).toContain('book');
    expect(keywords).toContain('read');
    expect(keywords).toContain('gardening');
    expect(keywords).not.toContain('what');
    expect(keywords).not.toContain('did');
    expect(keywords).not.toContain('about');
  });

  it('drops time markers and small number words', () => {
    const keywords = extractLexicalKeywords(['How many weeks ago did I attend the sale?']);
    expect(keywords).not.toContain('weeks');
    expect(keywords).not.toContain('ago');
    expect(keywords).not.toContain('many');
    expect(keywords).toContain('attend');
    expect(keywords).toContain('sale');
  });

  it('de-duplicates tokens across queries and preserves first-seen order', () => {
    const keywords = extractLexicalKeywords(['book the flight', 'book hotel']);
    expect(keywords).toEqual(['book', 'flight', 'hotel']);
  });

  it('skips tokens shorter than three letters', () => {
    const keywords = extractLexicalKeywords(['go to the zoo']);
    // "go" and "to" are dropped (stopword / short), "zoo" is kept.
    expect(keywords).toEqual(['zoo']);
  });
});

describe('countLexicalMatches', () => {
  it('counts case-insensitive substring matches per turn', () => {
    const matches = countLexicalMatches(
      ['I planted the tomatoes.', 'I visited a museum.', 'The tomato saplings grew.'],
      ['tomato'],
    );
    expect(matches.get(0)).toBe(1);
    expect(matches.get(1)).toBeUndefined();
    expect(matches.get(2)).toBe(1);
  });

  it('counts multiple keyword matches in one turn', () => {
    const matches = countLexicalMatches(
      ['I attended the Nordstrom friends and family sale.'],
      ['nordstrom', 'sale', 'family'],
    );
    expect(matches.get(0)).toBe(3);
  });

  it('returns an empty map when no keyword is provided', () => {
    expect(countLexicalMatches(['any turn'], [])).toEqual(new Map());
  });

  it('drops keywords that appear in too many turns (common words)', () => {
    const context = [
      'a friend one',
      'a friend two',
      'a friend three',
      'a friend four',
      'a friend five',
      'a friend six',
      'the Nordstrom sale',
    ];
    const matches = countLexicalMatches(context, ['friend', 'nordstrom']);
    // "friend" appears in 6 turns (> MAX_KEYWORD_DOC_FREQUENCY), so it is
    // dropped and only "nordstrom" (one turn) drives the match.
    expect(matches.get(6)).toBe(1);
    expect(matches.get(0)).toBeUndefined();
  });
});

describe('retrieveTopKByQueriesHybrid', () => {
  it('guarantees a keyword-bearing turn a place over semantic distractors', async () => {
    clearEmbeddingCache();
    // Every turn gets the same vector, so the semantic pool is uninformative and
    // returns the first `topK` turns by insertion order. The evidence turn sits
    // at the tail, outside the semantic top-K, and must be recovered lexically.
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    const context = [
      'unrelated first turn',
      'unrelated second turn',
      'unrelated third turn',
      'unrelated fourth turn',
      'unrelated fifth turn',
      'I bought a Nordstrom smoker for the kitchen.',
    ];
    const hits = await retrieveTopKByQueriesHybrid(embedding, ['Nordstrom smoker'], context, 3);
    expect(hits.some((h) => h.text.includes('Nordstrom'))).toBe(true);
  });

  it('keeps the highest-match keyword turns first, then fills semantically', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    const context = [
      'irrelevant a',
      'The Nordstrom sale was great.',
      'The Nordstrom family sale ended.',
      'irrelevant b',
    ];
    const hits = await retrieveTopKByQueriesHybrid(
      embedding,
      ['Nordstrom family sale'],
      context,
      3,
    );
    // Both Nordstrom turns are keyword-bearing; the higher-match one leads.
    expect(hits[0]!.text).toContain('Nordstrom');
    expect(hits[0]!.text).toContain('family');
  });

  it('falls back to semantic results when no keyword matches', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    const hits = await retrieveTopKByQueriesHybrid(
      embedding,
      ['totally unmatched query'],
      ['turn one', 'turn two'],
      2,
    );
    expect(hits).toHaveLength(2);
  });

  it('falls back to semantic results when every query token is a stopword', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    // "how many weeks ago" extracts to no keywords, so hybrid returns the
    // semantic pool unchanged.
    const hits = await retrieveTopKByQueriesHybrid(
      embedding,
      ['how many weeks ago'],
      ['turn one', 'turn two'],
      2,
    );
    expect(hits).toHaveLength(2);
  });

  it('caps the result to topK even when many turns match', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 0, 0, 0])),
    };
    // Five turns all contain the rare keyword, but the result is capped to topK.
    const context = [
      'nordstrom one',
      'nordstrom two',
      'nordstrom three',
      'nordstrom four',
      'nordstrom five',
    ];
    const hits = await retrieveTopKByQueriesHybrid(embedding, ['nordstrom'], context, 2);
    expect(hits).toHaveLength(2);
  });
});

describe('embedding cache persistence', () => {
  it('round-trips entries through serialize/deserialize', () => {
    const cache = new Map<string, Float64Array>([
      ['hello', new Float64Array([0.1, -0.2, 0.3, 0.4])],
      ['world', new Float64Array([1, 0, 0, 0])],
    ]);
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(cache));
    expect(restored.size).toBe(2);
    // float32 round-trips within ~1e-7; integer-valued vectors are exact.
    const hello = restored.get('hello')!;
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(hello[i]! - [0.1, -0.2, 0.3, 0.4][i]!)).toBeLessThan(1e-6);
    }
    expect([...restored.get('world')!]).toEqual([1, 0, 0, 0]);
  });

  it('round-trips an empty cache', () => {
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(new Map()));
    expect(restored.size).toBe(0);
  });

  it('preserves float32 precision (enough for cosine similarity)', () => {
    const cache = new Map<string, Float64Array>([
      ['v', new Float64Array([0.123456789, -0.987654321])],
    ]);
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(cache));
    const v = restored.get('v')!;
    // float32 rounds to ~7 significant digits; the error stays below 1e-6.
    expect(Math.abs(v[0]! - 0.123456789)).toBeLessThan(1e-6);
    expect(Math.abs(v[1]! - -0.987654321)).toBeLessThan(1e-6);
  });

  it('round-trips multi-byte UTF-8 text keys', () => {
    const cache = new Map<string, Float64Array>([
      ['用户: 我搬到了上海', new Float64Array([1, 2, 3])],
      ['emoji 🎯 key', new Float64Array([4, 5, 6])],
    ]);
    const restored = deserializeEmbeddingCache(serializeEmbeddingCache(cache));
    expect([...restored.get('用户: 我搬到了上海')!]).toEqual([1, 2, 3]);
    expect([...restored.get('emoji 🎯 key')!]).toEqual([4, 5, 6]);
  });
});

describe('embedding cache snapshot/merge', () => {
  it('snapshots the current cache without mutating it', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map((t) => new Float64Array([t.length, 0, 0, 0])),
    };
    // Populate the shared cache through the public embed path.
    await embedManyCached(embedding, ['alpha']);
    const snapshot = snapshotEmbeddingCache();
    expect(snapshot.has('alpha')).toBe(true);
    // The snapshot is a copy, so clearing the live cache leaves it intact.
    clearEmbeddingCache();
    expect(snapshot.has('alpha')).toBe(true);
  });

  it('merge keeps existing entries and adds only missing ones', () => {
    clearEmbeddingCache();
    const external = new Map<string, Float64Array>([
      ['a', new Float64Array([1, 0])],
      ['b', new Float64Array([0, 1])],
    ]);
    mergeEmbeddingCache(external);
    mergeEmbeddingCache(new Map([['b', new Float64Array([9, 9])]]));
    const snapshot = snapshotEmbeddingCache();
    // Existing 'b' is authoritative and not overridden by the merge.
    expect([...snapshot.get('a')!]).toEqual([1, 0]);
    expect([...snapshot.get('b')!]).toEqual([0, 1]);
  });
});

describe('embedding cache deserialize error handling', () => {
  it('rejects a buffer with a bad magic', () => {
    const buf = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => deserializeEmbeddingCache(buf)).toThrow(/invalid embedding cache magic/);
  });

  it('rejects a buffer with an unsupported version', () => {
    const valid = serializeEmbeddingCache(new Map());
    const tampered = new Uint8Array(valid);
    tampered[4] = 99; // corrupt the version byte
    expect(() => deserializeEmbeddingCache(tampered)).toThrow(
      /unsupported embedding cache version/,
    );
  });
});

describe('retrieveSessionsByTurns', () => {
  it('recovers a session whose evidence turn is diluted by unrelated turns', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding(
      {
        question: [1, 0, 0],
        EVIDENCE: [0.9, Math.sqrt(0.19), 0],
        filler: [0, 1, 0],
        // Five distractor sessions, each uniformly related to the question.
        d0: [0.5, Math.sqrt(0.75), 0],
        d1: [0.5, Math.sqrt(0.75), 0],
        d2: [0.5, Math.sqrt(0.75), 0],
        d3: [0.5, Math.sqrt(0.75), 0],
        d4: [0.5, Math.sqrt(0.75), 0],
      },
      3,
    );
    // One long session: a single on-topic turn surrounded by eight turns that
    // are orthogonal to the question.
    const diluted = [
      'filler',
      'filler',
      'filler',
      'filler',
      'EVIDENCE',
      'filler',
      'filler',
      'filler',
      'filler',
    ];
    const sessions = [diluted, ['d0'], ['d1'], ['d2'], ['d3'], ['d4']];

    const bySession = await retrieveTopKSessions(embedding, 'question', sessions, 3);
    const byTurn = await retrieveSessionsByTurns(embedding, ['question'], sessions, 10, 3);

    // The mean-pooled centroid (cos ~0.106) sits below every distractor (0.5),
    // so session 0 is NOT retrieved at session granularity.
    expect(bySession.map((h) => h.sessionIndex)).not.toContain(0);
    // Scoring turns individually restores the evidence turn's full similarity
    // (0.9) and lifts the session to the top.
    expect(byTurn[0]!.sessionIndex).toBe(0);
    expect(byTurn[0]!.score).toBeCloseTo(0.9, 6);
  });

  it('attributes a repeated turn text to every session that contains it', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding(
      { question: [1, 0, 0], shared: [0.8, 0.6, 0], filler: [-1, 0, 0] },
      3,
    );
    const sessions = [
      ['shared', 'filler'],
      ['filler', 'shared'],
      ['filler', 'filler'],
    ];
    // Only the two turns that actually match are retrieved, so the session made
    // up entirely of filler turns is never attributed a score.
    const hits = await retrieveSessionsByTurns(embedding, ['question'], sessions, 2, 10);
    // The turn index is keyed per owning session, so the shared text is not
    // collapsed into a single session the way a global turn id would.
    expect(hits.map((h) => h.sessionIndex).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(hits[0]!.score).toBeCloseTo(0.8, 6);
    // A session with no matching turn is never returned.
    expect(hits).toHaveLength(2);
  });

  it('emits session ids identical to session-centroid retrieval', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding(
      { question: [1, 0, 0], a: [0.9, 0.436, 0], b: [0.7, 0.714, 0] },
      3,
    );
    const sessions = [['a'], ['b'], ['a', 'b']];
    const bySession = await retrieveTopKSessions(embedding, 'question', sessions, 10);
    const byTurn = await retrieveSessionsByTurns(embedding, ['question'], sessions, 10, 10);
    const expected = new Map(bySession.map((h) => [h.sessionIndex, h.id]));
    // Identity matters: the caller merges the two channels by session id.
    for (const hit of byTurn) {
      expect(hit.id).toBe(expected.get(hit.sessionIndex));
    }
    for (const hit of byTurn) {
      expect(hit.text).toBe(sessions[hit.sessionIndex]!.join('\n'));
    }
  });

  it('keeps the highest score across queries', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding({ q1: [1, 0, 0], q2: [0, 1, 0], turn: [0.6, 0.8, 0] }, 3);
    const hits = await retrieveSessionsByTurns(embedding, ['q1', 'q2'], [['turn']], 10, 10);
    expect(hits).toHaveLength(1);
    // cos(q1, turn) = 0.6, cos(q2, turn) = 0.8 -> the maximum wins.
    expect(hits[0]!.score).toBeCloseTo(0.8, 6);
  });

  it('caps the number of returned sessions', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding(
      {
        question: [1, 0, 0],
        t0: [0.9, 0.436, 0],
        t1: [0.8, 0.6, 0],
        t2: [0.7, 0.714, 0],
        t3: [0.6, 0.8, 0],
      },
      3,
    );
    const sessions = [['t0'], ['t1'], ['t2'], ['t3']];
    const hits = await retrieveSessionsByTurns(embedding, ['question'], sessions, 10, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.sessionIndex).toBe(0);
    expect(hits[1]!.sessionIndex).toBe(1);
  });

  it('skips excluded sessions before applying the cap', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding(
      { question: [1, 0, 0], t0: [0.9, 0.436, 0], t1: [0.8, 0.6, 0], t2: [0.7, 0.714, 0] },
      3,
    );
    const sessions = [['t0'], ['t1'], ['t2']];
    const alreadyRetrieved = await retrieveTopKSessions(embedding, 'question', sessions, 1);
    const excluded = new Set(alreadyRetrieved.map((h) => h.id));
    expect(excluded.size).toBe(1);
    // Exclusion happens before the cap, so the runner-up fills the freed slot
    // instead of the cap being consumed by a session already in hand.
    const hits = await retrieveSessionsByTurns(embedding, ['question'], sessions, 10, 2, excluded);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.id)).not.toContain([...excluded][0]);
  });

  it('reaches new sessions past the turns of already-retrieved ones', async () => {
    clearEmbeddingCache();
    // The already-retrieved session's turns occupy the very top of the turn
    // ranking, which is exactly why search depth decides whether this channel
    // adds anything at all.
    const at = (x: number): number[] => [x, Math.sqrt(1 - x * x), 0];
    const embedding = tableEmbedding(
      {
        question: [1, 0, 0],
        s0a: at(0.9),
        s0b: at(0.89),
        s0c: at(0.88),
        s0d: at(0.87),
        s0e: at(0.86),
        target: at(0.5),
        filler: [0, 1, 0],
      },
      3,
    );
    const sessions = [['s0a', 's0b', 's0c', 's0d', 's0e'], ['filler', 'target'], ['filler']];
    const held = await retrieveTopKSessions(embedding, 'question', sessions, 1);
    // Session 0 is the centroid winner, so the channel must look past its turns.
    expect(held[0]!.sessionIndex).toBe(0);

    const ids = new Set(held.map((h) => h.id));
    // Shallow: the five best turns all belong to the session already in hand.
    const shallow = await retrieveSessionsByTurns(embedding, ['question'], sessions, 5, 3, ids);
    expect(shallow).toEqual([]);
    // Deeper: one more turn is enough to reach the target session.
    const deep = await retrieveSessionsByTurns(embedding, ['question'], sessions, 6, 3, ids);
    expect(deep.map((h) => h.sessionIndex)).toEqual([1]);
  });

  it('returns no hits for empty inputs', async () => {
    clearEmbeddingCache();
    const embedding = tableEmbedding({ question: [1, 0, 0], a: [1, 0, 0] }, 3);
    expect(await retrieveSessionsByTurns(embedding, ['question'], [], 5, 3)).toEqual([]);
    expect(await retrieveSessionsByTurns(embedding, [], [['a']], 5, 3)).toEqual([]);
    expect(await retrieveSessionsByTurns(embedding, ['question'], [[], []], 5, 3)).toEqual([]);
    expect(await retrieveSessionsByTurns(embedding, ['question'], [['   ']], 5, 3)).toEqual([]);
  });

  it('adds no embedding calls once the turns and queries are cached', async () => {
    clearEmbeddingCache();
    let embedded = 0;
    const base = tableEmbedding({ question: [1, 0, 0], turn: [0.9, 0.436, 0] }, 3);
    const counting: EmbeddingModel = {
      dimension: () => 3,
      embed: async (texts) => {
        embedded += texts.length;
        return base.embed(texts);
      },
    };
    const sessions = [['turn'], ['turn'], ['turn']];
    // The centroid path already embeds every turn and the question.
    await retrieveTopKSessions(counting, 'question', sessions, 2);
    const after = embedded;
    // Turn vectors are the same vectors the centroid path computed, so scoring
    // at turn granularity is free: no additional provider traffic.
    await retrieveSessionsByTurns(counting, ['question'], sessions, 10, 2);
    expect(embedded).toBe(after);
  });
});

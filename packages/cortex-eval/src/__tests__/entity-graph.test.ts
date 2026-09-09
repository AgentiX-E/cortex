import { describe, expect, it } from 'vitest';
import { MemoryGraph } from '@agentix-e/cortex-core';
import { buildEntityGraph, extractEntityTokens, recallTurnsByActivation } from '../entity-graph.js';

describe('extractEntityTokens', () => {
  it('lower-cases and keeps content words at least three letters long', () => {
    expect(extractEntityTokens('I bought a Smoker for my Kitchen')).toEqual([
      'bought',
      'smoker',
      'kitchen',
    ]);
  });

  it('drops stopwords, pronouns, question words, and time markers', () => {
    const tokens = extractEntityTokens('What kitchen appliance did I buy ten days ago?');
    expect(tokens).not.toContain('what');
    expect(tokens).not.toContain('did');
    expect(tokens).not.toContain('ten');
    expect(tokens).not.toContain('days');
    expect(tokens).not.toContain('ago');
    expect(tokens).toContain('kitchen');
    expect(tokens).toContain('appliance');
  });

  it('de-duplicates while preserving first-seen order', () => {
    expect(extractEntityTokens('jewelry ring jewelry')).toEqual(['jewelry', 'ring']);
  });

  it('returns an empty list for stopword-only text', () => {
    expect(extractEntityTokens('what did i do')).toEqual([]);
  });
});

describe('buildEntityGraph', () => {
  it('maps each entity to the turns that mention it', () => {
    const context = [
      '[2023/06/10] user: my aunt gave me a piece of jewelry',
      '[2023/06/17] user: I collect jewelry at the market',
    ];
    const { entityToTurns } = buildEntityGraph(context);
    // "jewelry" appears in both turns; "aunt" only in the first.
    expect(entityToTurns.get('jewelry')).toEqual([0, 1]);
    expect(entityToTurns.get('aunt')).toEqual([0]);
  });

  it('strengthens a co-occurrence edge for entities in the same turn', () => {
    const context = ['[2023/06/10] user: my aunt gave me jewelry'];
    const { graph } = buildEntityGraph(context);
    // "aunt" and "jewelry" co-occur in one turn, so an edge exists.
    expect(graph.edgeWeight('aunt', 'jewelry')).toBeGreaterThan(0);
  });

  it('creates no edge for entities that never co-occur in a turn', () => {
    const context = [
      '[2023/06/10] user: my aunt likes tea',
      '[2023/06/17] user: I collect jewelry',
    ];
    const { graph } = buildEntityGraph(context);
    expect(graph.edgeWeight('aunt', 'jewelry')).toBe(0);
  });
});

describe('recallTurnsByActivation', () => {
  it('recalls a turn whose entity is one hop from a seed entity', () => {
    const context = [
      '[2023/06/10] user: my aunt gave me jewelry',
      '[2023/06/17] user: I went to the grocery store',
    ];
    const { graph, entityToTurns } = buildEntityGraph(context);
    // Seed "jewelry" activates "aunt" (co-occurring), which maps back to turn 0.
    const hits = recallTurnsByActivation(graph, entityToTurns, ['jewelry'], context);
    const indices = hits.map((h) => h.index);
    expect(indices).toContain(0);
  });

  it('reaches an entity two hops away through an intermediate co-occurrence', () => {
    const context = [
      '[2023/06/01] user: my aunt loves jewelry',
      '[2023/06/10] user: I started collecting jewelry',
      '[2023/06/17] user: collecting requires patience',
    ];
    const { graph, entityToTurns } = buildEntityGraph(context);
    // Seed "aunt" -> (hop 1) "jewelry" -> (hop 2) "collecting"; "collecting" maps
    // to turns 1 and 2, so both should be recalled even though neither mentions
    // "aunt" or "jewelry" directly with "aunt".
    const hits = recallTurnsByActivation(graph, entityToTurns, ['aunt'], context);
    const indices = new Set(hits.map((h) => h.index));
    expect(indices.has(1)).toBe(true);
    expect(indices.has(2)).toBe(true);
  });

  it('returns an empty list when the seed has no edges', () => {
    const context = ['[2023/06/10] user: my aunt gave me jewelry'];
    const { graph, entityToTurns } = buildEntityGraph(context);
    const hits = recallTurnsByActivation(graph, entityToTurns, ['nonexistent'], context);
    expect(hits).toEqual([]);
  });

  it('builds stable turn ids that match the turn-index id formula', () => {
    const context = ['[2023/06/10] user: my aunt gave me jewelry'];
    const { graph, entityToTurns } = buildEntityGraph(context);
    const hits = recallTurnsByActivation(graph, entityToTurns, ['jewelry'], context);
    // The id must be `t-${hashText(turn)}` (base36) so RRF fuses (not duplicates)
    // the graph hit with its semantic/lexical counterpart.
    for (const hit of hits) {
      expect(hit.id).toMatch(/^t-[0-9a-z]+$/);
    }
  });
});

describe('MemoryGraph spreading-activation integration', () => {
  it('uses the cortex-core graph as the activation engine', () => {
    const graph = new MemoryGraph();
    graph.strengthen('jewelry', 'aunt');
    graph.strengthen('jewelry', 'collecting');
    const activation = graph.spreadingActivation(['aunt'], 2);
    expect(activation.get('jewelry')).toBeGreaterThan(0);
    expect(activation.get('collecting')).toBeGreaterThan(0);
  });
});

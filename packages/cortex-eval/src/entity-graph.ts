import { MemoryGraph } from '@agentix-e/cortex-core';
import { extractLexicalKeywords, hashText, type RetrievalHit } from './retrieval.js';

/**
 * Maximum number of turns an entity may appear in to still count as a graph
 * node. Matches `MAX_KEYWORD_DOC_FREQUENCY` in retrieval.ts: an entity present
 * in more turns than this (a common word like "user" or "friend") is not
 * discriminative, so it is dropped before the co-occurrence graph is built.
 */
const ENTITY_MAX_DOC_FREQUENCY = 5;

/**
 * Extract normalized content-word entities from a single text. This is the
 * zero-LLM extraction step: it reuses the lexical channel's stopword and length
 * filters, so "jewelry", "aunt", "smoker" and "kitchen" surface as entities
 * while question words, pronouns, and time markers do not. Tokens are
 * lower-cased and de-duplicated in first-seen order.
 */
export function extractEntityTokens(text: string): string[] {
  return extractLexicalKeywords([text]);
}

/**
 * A per-context entity graph plus the entity→turn index used to map an activated
 * entity back to the turns that mention it. Node ids are the normalized surface
 * forms; edges are undirected co-occurrence edges strengthened once per turn in
 * which both entities appear.
 */
export type EntityGraph = {
  graph: MemoryGraph;
  entityToTurns: Map<string, number[]>;
};

/**
 * Build a co-occurrence graph over the given context. For each turn the rare
 * entities (document frequency ≤ `ENTITY_MAX_DOC_FREQUENCY`) are extracted; every
 * pair in the same turn gets a Hebbian co-occurrence edge. This is the cheap
 * deterministic replacement for an LLM fact-extraction pass — the SPRIG result
 * showed NER + co-occurrence + graph activation matches LLM-based construction
 * at zero token cost.
 */
export function buildEntityGraph(context: readonly string[]): EntityGraph {
  const graph = new MemoryGraph();
  const entityToTurns = new Map<string, number[]>();
  const turnEntities: string[][] = [];

  // Pass 1: extract per-turn candidates and count document frequency.
  // `extractEntityTokens` already de-duplicates within a text, so a turn's
  // entity list has no repeats and can be counted directly.
  const documentFrequency = new Map<string, number>();
  for (const turn of context) {
    const entities = extractEntityTokens(turn);
    turnEntities.push(entities);
    for (const entity of entities) {
      documentFrequency.set(entity, (documentFrequency.get(entity) ?? 0) + 1);
    }
  }

  // Rare entities only: a common word present in more than
  // `ENTITY_MAX_DOC_FREQUENCY` turns is not discriminative, so it is dropped
  // before indexing. Computing the rare set once avoids a per-entity lookup
  // with a fallback in the pass-2 filter.
  const rareEntities = new Set(
    [...documentFrequency.entries()]
      .filter(([, frequency]) => frequency <= ENTITY_MAX_DOC_FREQUENCY)
      .map(([entity]) => entity),
  );

  // Pass 2: index rare entities and strengthen co-occurrence edges.
  for (let i = 0; i < context.length; i++) {
    const unique = [...new Set(turnEntities[i]!.filter((entity) => rareEntities.has(entity)))];
    for (const entity of unique) {
      const turns = entityToTurns.get(entity);
      if (turns === undefined) {
        entityToTurns.set(entity, [i]);
      } else {
        turns.push(i);
      }
    }
    // Every pair of rare entities in the same turn co-activates.
    for (let a = 0; a < unique.length; a++) {
      for (let b = a + 1; b < unique.length; b++) {
        graph.strengthen(unique[a]!, unique[b]!, 'cooccurrence');
      }
    }
  }

  return { graph, entityToTurns };
}

/**
 * Recall turns by spreading activation from seed entities. Activation starts at
 * the seeds (score 1) and diffuses through co-occurrence edges (act · weight,
 * 0.5 decay per hop, two hops). A turn's graph score is the strongest activation
 * of any *non-seed* entity it mentions, so the arm only surfaces turns the
 * semantic/lexical channels did not already reach via the seed itself. Hits use
 * the same `t-${hashText(turn)}` id as the turn index, so RRF fuses (not
 * duplicates) them with their semantic/lexical counterparts.
 */
export function recallTurnsByActivation(
  graph: MemoryGraph,
  entityToTurns: Map<string, number[]>,
  seeds: readonly string[],
  context: readonly string[],
): RetrievalHit[] {
  const seedSet = new Set(seeds.map((seed) => seed.toLowerCase()));
  const activation = graph.spreadingActivation([...seeds], 2, 0.01);

  const turnScore = new Map<number, number>();
  // Iterate the entity→turn index rather than the activation map: every indexed
  // entity has a turn list by construction, and an entity with no activation
  // (or only seed activation) contributes nothing.
  for (const [entity, turns] of entityToTurns) {
    if (seedSet.has(entity)) {
      continue;
    }
    const act = activation.get(entity);
    if (act === undefined || act <= 0) {
      continue;
    }
    for (const turnIndex of turns) {
      turnScore.set(turnIndex, Math.max(turnScore.get(turnIndex) ?? 0, act));
    }
  }

  return [...turnScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([index, score]) => ({
      id: `t-${hashText(context[index]!)}`,
      text: context[index]!,
      score,
      index,
    }));
}

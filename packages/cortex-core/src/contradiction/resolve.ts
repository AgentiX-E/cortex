/**
 * Contradiction resolution via Bayesian evidence fusion. Each fact is treated as
 * evidence with a source trust prior; posterior belief determines the winner.
 * Temporal priority breaks ties when two facts are equally trusted.
 */
import type { Fact } from '../domain/fact.js';

export type Resolution = {
  winner: Fact;
  /** Posterior belief in the winner, in [0, 1]. */
  belief: number;
  /** All candidate facts considered, ranked. */
  ranked: Fact[];
};

/**
 * Resolve a set of contradictory facts (same subject+predicate, different object).
 * Preference: (1) highest posterior belief from source-trust-weighted evidence;
 * (2) most recent valid interval on tie.
 */
export function resolveContradiction(facts: readonly Fact[]): Resolution {
  if (facts.length === 0) {
    throw new Error('resolveContradiction: empty facts');
  }
  if (facts.length === 1) {
    return { winner: facts[0]!, belief: facts[0]!.confidence, ranked: [...facts] };
  }
  // Group by object value; aggregate evidence with a log-odds product.
  const byObject = new Map<string, Fact[]>();
  for (const f of facts) {
    const list = byObject.get(f.object) ?? [];
    list.push(f);
    byObject.set(f.object, list);
  }
  const scores = new Map<string, number>();

  for (const [object, list] of byObject) {
    let logOdds = 0;
    for (const f of list) {
      const p = clamp(f.confidence * f.sourceTrust, 0.001, 0.999);
      logOdds += Math.log(p / (1 - p));
    }
    const belief = 1 / (1 + Math.exp(-logOdds));
    scores.set(object, belief);
  }
  // Pick the object with the highest belief.
  let bestObject = facts[0]!.object;
  let bestBelief = -1;
  for (const [object, belief] of scores) {
    if (belief > bestBelief) {
      bestBelief = belief;
      bestObject = object;
    }
  }
  // Winner: the most trusted + most recent fact for the winning object.
  const candidates = byObject.get(bestObject)!;
  const winner = candidates.reduce((a, b) => {
    const sa = a.confidence * a.sourceTrust;
    const sb = b.confidence * b.sourceTrust;
    if (sb > sa) {
      return b;
    }
    if (sb === sa && b.validFrom > a.validFrom) {
      return b;
    }
    return a;
  });
  const ranked = [...facts].sort(
    (a, b) => (scores.get(b.object) ?? 0) - (scores.get(a.object) ?? 0),
  );
  return { winner, belief: bestBelief, ranked };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

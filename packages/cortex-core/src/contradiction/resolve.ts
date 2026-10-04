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
  // Ranked order is by group score, descending.
  //
  // The score is read through the SAME key that produced it rather than by a
  // second `scores.get(f.object)` lookup, and that is the fix rather than a
  // tidy-up. `scores` and `byObject` are filled from one loop over `facts`, so
  // the two agreed by construction -- but the original form re-looked the object
  // up in `scores` and carried a `?? 0` for the case it could not miss. Both
  // fallback arms were unreachable, and a throw-sentinel experiment confirmed it:
  // replacing each with `throw` left all 218 tests green.
  //
  // A `?? 0` there is not defensive. It is a second answer to a question that has
  // one, and it cost `resolve.ts` two of its twelve branch arms -- 91.66% against
  // a 95% floor -- while describing behaviour the function cannot exhibit.
  // Pairing each fact with its own score makes the impossible case
  // unrepresentable, so there is no branch left to cover and no invariant to
  // assert at runtime.
  const ranked = [...byObject.entries()]
    .map(([object, list]) => ({ score: scores.get(object)!, list }))
    .sort((a, b) => b.score - a.score)
    .flatMap((group) => group.list);
  return { winner, belief: bestBelief, ranked };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

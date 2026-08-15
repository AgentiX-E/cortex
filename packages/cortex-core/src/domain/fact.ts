/**
 * A bitemporal fact: the building block for temporal reasoning, knowledge update,
 * and contradiction resolution. Two time axes are recorded:
 *  - valid time: when the fact is true in the world;
 *  - system time: when the system learned (or superseded) the fact.
 */
export type Fact = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  /** World-time lower bound (epoch ms, inclusive). */
  validFrom: number;
  /** World-time upper bound (epoch ms, exclusive); Infinity means currently true. */
  validUntil: number;
  /** System-time lower bound (epoch ms). */
  systemFrom: number;
  /** System-time upper bound (epoch ms, exclusive); Infinity means current. */
  systemUntil: number;
  /** Origin of the fact. */
  source: string;
  /** Source trust in [0, 1]. */
  sourceTrust: number;
  /** Confidence in [0, 1]. */
  confidence: number;
};

export function isFactCurrentAt(fact: Fact, worldTime: number, systemTime = Infinity): boolean {
  const worldOk =
    fact.validFrom <= worldTime && (fact.validUntil === Infinity || worldTime < fact.validUntil);
  const systemOk =
    fact.systemFrom <= systemTime &&
    (fact.systemUntil === Infinity || systemTime < fact.systemUntil);
  return worldOk && systemOk;
}

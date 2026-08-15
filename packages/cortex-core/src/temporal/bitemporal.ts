/**
 * Bitemporal fact store queries: current-value lookup, as-of lookup, and conflict
 * detection between facts sharing the same (subject, predicate).
 */
import type { Fact } from '../domain/fact.js';
import { isFactCurrentAt } from '../domain/fact.js';

/** Return facts that are current at the given world and system times. */
export function currentFacts(
  facts: readonly Fact[],
  worldTime = Date.now(),
  systemTime = Infinity,
): Fact[] {
  return facts.filter((f) => isFactCurrentAt(f, worldTime, systemTime));
}

/** Return the highest-confidence current fact for a (subject, predicate) pair. */
export function currentValue(
  facts: readonly Fact[],
  subject: string,
  predicate: string,
  worldTime = Date.now(),
): Fact | undefined {
  let best: Fact | undefined;
  for (const f of facts) {
    if (f.subject !== subject || f.predicate !== predicate) {
      continue;
    }
    if (!isFactCurrentAt(f, worldTime)) {
      continue;
    }
    if (!best || f.confidence * f.sourceTrust > best.confidence * best.sourceTrust) {
      best = f;
    }
  }
  return best;
}

/** Detect facts that contradict each other on the same (subject, predicate). */
export function findContradictions(facts: readonly Fact[]): Fact[][] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const key = `${f.subject}\u0000${f.predicate}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const contradictions: Fact[][] = [];
  for (const list of groups.values()) {
    const distinct = new Set(list.map((f) => f.object));
    if (distinct.size > 1) {
      contradictions.push(list);
    }
  }
  return contradictions;
}

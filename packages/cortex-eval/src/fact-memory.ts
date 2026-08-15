/**
 * A minimal, deterministic memory system used to demonstrate the M2 feature
 * (value-driven retrieval + abstention) through the evaluation harness. Facts are
 * key=value strings; answering retrieves the key with the highest token overlap
 * and abstains when the confidence is below the configured threshold.
 */
import type { Answer, MemorySystem } from './types.js';

export type FactMemorySystemOptions = {
  /** If set, abstain (return null) when the best overlap is below this value. */
  abstainThreshold?: number;
  /** Fallback answer when the system never abstains (baseline behavior). */
  fallback?: string;
};

export class FactMemorySystem implements MemorySystem {
  readonly name: string;
  private readonly options: FactMemorySystemOptions;
  private readonly memory = new Map<string, string>();

  constructor(name: string, options: FactMemorySystemOptions = {}) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    for (const fact of context) {
      const entry = splitKeyValue(fact);
      if (entry) {
        this.memory.set(normalizeToken(entry.key), entry.value);
      }
    }

    const questionTokens = tokenize(question);
    let bestKey: string | null = null;
    let bestScore = 0;
    for (const key of this.memory.keys()) {
      const score = overlapScore(questionTokens, tokenize(key));
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }

    if (this.options.abstainThreshold != null && bestScore < this.options.abstainThreshold) {
      return null;
    }
    if (bestKey === null) {
      return this.options.fallback ?? null;
    }
    return this.memory.get(bestKey)!;
  }
}

export function splitKeyValue(fact: string): { key: string; value: string } | null {
  const idxEq = fact.indexOf('=');
  const idxColon = fact.indexOf(':');
  let idx = -1;
  if (idxEq !== -1 && idxColon !== -1) {
    idx = Math.min(idxEq, idxColon);
  } else if (idxEq !== -1) {
    idx = idxEq;
  } else if (idxColon !== -1) {
    idx = idxColon;
  }
  if (idx <= 0 || idx === fact.length - 1) {
    return null;
  }
  return { key: fact.slice(0, idx).trim(), value: fact.slice(idx + 1).trim() };
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function overlapScore(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  /* c8 ignore next -- unreachable: both sets are non-empty here, so union >= 1 */
  return union === 0 ? 0 : intersection / union;
}

function normalizeToken(s: string): string {
  return s.toLowerCase().trim();
}

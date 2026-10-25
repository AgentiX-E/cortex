/**
 * What a memory system has to satisfy to be measured beside Cortex, and what "comparable" means as a function.
 *
 * ## The mistake this module corrects
 *
 * The previous release graded competitor figures A / B / C and said a grade-C number "may not be used to claim
 * a gap". That was right about the **number** and wrong about the **system**. A vendor figure measured with an
 * unreproducible recipe is not comparable; the vendor's software, given the same questions, the same reader and
 * the same judge, is. The difference is not semantic — it is the difference between writing "Hindsight reports
 * 94.6% and we do not know how" and running Hindsight.
 *
 * So comparability becomes two things this file can compute:
 *
 * 1. a **provider contract** (`MemoryProvider`) that a competitor, and Cortex itself, implement; and
 * 2. a **comparison rule** (`comparability`) that decides, from two run configurations, whether their scores
 *    may be subtracted.
 *
 * ## Why Cortex implements the same contract
 *
 * A harness that runs competitors under one pipeline while Cortex keeps its own is measuring the pipelines.
 * The only way the number means anything is if Cortex is one more adapter in the same loop: same sessions
 * in, same `search` out, same reader, same judge. That is uncomfortable, because it removes every advantage
 * the product's own plumbing gave it. It is also the only version of the comparison that survives review.
 *
 * ## What the contract deliberately does not include
 *
 * **Answering.** A provider returns retrieved text, not an answer. Generation belongs to the harness, so the
 * reader is one variable rather than one per system. A system whose selling point is its own answer prompt can
 * still be measured — as a different reader — but then the configuration says so, and `comparability` says so.
 */

import type { LongMemEvalInstance } from './datasets/longmemeval-loader.js';

/** One turn, in the shape every provider agrees on. */
export type MemoryTurn = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

/** One session: a timestamped group of turns, which is what a memory system ingests. */
export type MemorySession = {
  readonly id: string;
  /** Epoch ms. The benchmark's own timestamp, not the time of ingestion — that difference is a whole finding. */
  readonly at: number;
  readonly turns: readonly MemoryTurn[];
};

export type IngestReport = {
  readonly sessions: number;
  readonly turns: number;
  /**
   * Sessions the provider could not take, with the reason.
   *
   * Reported rather than thrown: an ingest that silently drops a tenth of the corpus produces a score that
   * looks like a retrieval failure, and the first question anybody asks is "did it even read the history".
   */
  readonly skipped: readonly string[];
};

export type SearchHit = {
  readonly text: string;
  /** Provider-native score when it has one. Never compared across providers — only the order is. */
  readonly score?: number;
  readonly at?: number;
};

export type SearchOptions = {
  readonly limit: number;
  /** The instant the question is asked. A provider with a temporal model uses it; one without ignores it. */
  readonly asOf?: number;
};

/**
 * What each system is allowed to spend building its memory, reported so a comparison states its terms.
 *
 * `llm` means the store itself is built by a model (extraction, consolidation); `embedding` means vectors only;
 * `none` means a lexical index. This is not a quality ranking — it is the cost side of the ledger, and a
 * comparison between a `llm` provider and a `none` one is still fair as long as it is stated.
 */
export type BuildCost = 'llm' | 'embedding' | 'none';

export type MemoryProvider = {
  readonly name: string;
  readonly build: BuildCost;
  /** Load sessions into the store. Called once per question in isolated mode, once per run in global mode. */
  ingest(sessions: readonly MemorySession[]): Promise<IngestReport>;
  /** Retrieve what the question needs. No generation: the reader does that, once, for everyone. */
  search(query: string, options: SearchOptions): Promise<readonly SearchHit[]>;
  /** Drop everything, so the next question starts from nothing. */
  reset(): Promise<void>;
};

/** A run's configuration, which is the thing two scores have to share before they can be subtracted. */
export type RunConfig = {
  /** Dataset identity including the split and the row count, e.g. `longmemeval-s/500`. */
  readonly dataset: string;
  readonly questions: number;
  /** The model that turns retrieved text into an answer. */
  readonly reader: string;
  /** The model that grades the answer. */
  readonly judge: string;
  /** Which judge prompt, by name, because two prompts on one dataset disagree by more than the systems do. */
  readonly judgePolicy: string;
  /** How many hits the reader sees. A top-200 run and a top-10 run are different experiments. */
  readonly topK: number;
  /** The context ceiling, when the harness enforces one. Zero means "no ceiling". */
  readonly tokenBudget: number;
};

/**
 * Which fields differ between two runs, and what that difference costs the comparison.
 *
 * The mapping is the whole point, and it is a rule rather than a judgement:
 *
 * | Differing fields | Grade | What may be said |
 * | --- | --- | --- |
 * | none | `A` | "we are N points behind" |
 * | reader, judge, or judgePolicy only | `B` | "the direction is the same" |
 * | dataset, questions, topK or tokenBudget | `C` | nothing about the gap |
 *
 * `topK` and `tokenBudget` are in the third row on purpose. They are not presentation details: a run that
 * reads 200 hits and one that reads 10 are answering different questions, and the one with more context wins
 * for reasons that have nothing to do with memory.
 */
/**
 * `A` / `B` / `C`, and deliberately **not** exported as a named type.
 *
 * `acceptance.ts` already has a `Grade` for competitor figures. Two exported types with one name would collide
 * at the barrel and, worse, suggest the two are interchangeable. They are not: this one is computed from two run
 * configurations, that one is attached to a number by hand until a run exists to replace it.
 */
export type Comparability = {
  readonly grade: 'A' | 'B' | 'C';
  readonly differing: readonly (keyof RunConfig)[];
};

const HARD: readonly (keyof RunConfig)[] = ['dataset', 'questions', 'topK', 'tokenBudget'];
const SOFT: readonly (keyof RunConfig)[] = ['reader', 'judge', 'judgePolicy'];

/** Compare two run configurations. Total, deterministic, and the only place the grade is decided. */
export function comparability(left: RunConfig, right: RunConfig): Comparability {
  const keys: (keyof RunConfig)[] = [...HARD, ...SOFT];
  const differing = keys.filter((key) => left[key] !== right[key]);
  const grade: 'A' | 'B' | 'C' = differing.some((key) => HARD.includes(key))
    ? 'C'
    : differing.some((key) => SOFT.includes(key))
      ? 'B'
      : 'A';
  return { grade, differing };
}

/**
 * LongMemEval into the provider contract.
 *
 * Sessions arrive as parallel arrays (`haystack_session_ids`, `haystack_dates`, `haystack_sessions`), and the
 * three can in principle disagree in length. A missing date is **not** defaulted to "now": a session whose
 * timestamp is unknown cannot be placed, and pretending it happened at ingest time is the exact defect the
 * `time-anchor` assumption was introduced to record.
 */
export function toSessions(instance: LongMemEvalInstance): {
  readonly sessions: readonly MemorySession[];
  readonly undated: number;
} {
  const ids = instance.haystack_session_ids ?? [];
  const dates = instance.haystack_dates ?? [];
  const groups = instance.haystack_sessions ?? [];

  const sessions: MemorySession[] = [];
  let undated = 0;
  for (const [index, turns] of groups.entries()) {
    const parsed = Date.parse(dates[index] ?? '');
    if (!Number.isFinite(parsed)) {
      undated += 1;
      continue;
    }
    sessions.push({
      id: ids[index] ?? `${instance.question_id}#${index}`,
      at: parsed,
      turns: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    });
  }
  return { sessions, undated };
}

/**
 * An in-memory provider: the reference implementation of the contract, and the fixture every adapter is
 * tested against before it is pointed at a real system.
 *
 * It is deliberately lexical and deliberately dumb. Its job is to prove the harness works end to end on a
 * machine with no model, no key and no network — so that when a competitor adapter returns nothing, the fault
 * is known to be in the adapter.
 */
export class LexicalProvider implements MemoryProvider {
  readonly name = 'lexical-reference';
  readonly build: BuildCost = 'none';

  #sessions: MemorySession[] = [];

  async ingest(sessions: readonly MemorySession[]): Promise<IngestReport> {
    this.#sessions.push(...sessions);
    const turns = this.#sessions.reduce((total, session) => total + session.turns.length, 0);
    return { sessions: this.#sessions.length, turns, skipped: [] };
  }

  async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
    const asked = new Set(contentWords(query));
    if (asked.size === 0) return [];
    const scored: SearchHit[] = [];
    for (const session of this.#sessions) {
      if (options.asOf !== undefined && session.at > options.asOf) continue;
      const text = session.turns.map((turn) => turn.content).join(' ');
      const offered = new Set(contentWords(text));
      let hits = 0;
      for (const word of asked) if (offered.has(word)) hits += 1;
      if (hits === 0) continue;
      scored.push({ text, score: hits / asked.size, at: session.at });
    }
    return scored
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, options.limit);
  }

  async reset(): Promise<void> {
    this.#sessions = [];
  }
}

/** Words of three characters or more, folded. Short words are connectives and carry no topic. */
function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []).filter((word) => word.length >= 3);
}

/**
 * The loop that turns a provider contract into a number.
 *
 * ## What this measures, and what it deliberately does not
 *
 * Retrieval only. No answer is generated and no judge is called, because both need a model and the point of
 * this stage is that it runs on a machine with none. `docs/PLAN-COMPETITOR-HARNESS.md` calls this H0: the
 * pipeline is exercised end to end against a lexical control, so that when a real adapter returns nothing the
 * fault is provably in the adapter rather than in the harness.
 *
 * Retrieval is also the honest half of a memory comparison. A reader can paper over bad retrieval and a judge
 * can disagree with a reader, but "was the evidence in the top k" is a question about the store alone, it is
 * deterministic, and it cannot be tuned by prompt work.
 *
 * ## Why the gold is supplied, not read off the question
 *
 * `Question.goldTurns` exists and is used when present, but a benchmark that renders its evidence differently
 * from the provider cannot rely on string equality — the provider stored a session, the benchmark named a turn,
 * and the two only compare if both went through the same renderer. So the caller may pass `goldOf`, which is
 * what H1 will do for a provider that normalises text on ingest. A question with no gold is **excluded and
 * counted**, never scored as a miss: an unmeasurable question folded into the denominator is how a harness
 * reports a system as worse than it is.
 */

import type { Capability, BenchmarkDataset, Question } from './types.js';
import type { MemoryProvider, MemorySession } from './competitor.js';

/** How the store is fed between questions. */
export type RetrievalMode =
  /** A container per question. Nothing from an earlier question can help or hurt. */
  | 'isolated'
  /** One container for the whole run, which is closer to production and further from a fair test. */
  | 'global';

export type HarnessOptions = {
  /** Hits the provider may return per question, which is the `topK` the run configuration records. */
  readonly limit?: number;
  readonly mode?: RetrievalMode;
  /**
   * The evidence a correct answer had to come from.
   *
   * Defaults to `question.goldTurns`. Returning an empty array means "not measurable", which is counted
   * separately and left out of every rate.
   */
  readonly goldOf?: (question: Question) => readonly string[];
  /**
   * Whether the provider's hits are the sessions, in which case a hit matches when it **contains** a gold turn.
   *
   * True for the reference provider, which returns whole sessions; a provider that returns a single turn may
   * set it false and be compared by equality. The flag is part of the run configuration for the reason every
   * other one is: it changes the number.
   */
  readonly hitsContainGold?: boolean;
};

export type CapabilityScore = {
  readonly questions: number;
  readonly measured: number;
  readonly found: number;
};

export type ProviderScore = {
  readonly provider: string;
  readonly build: MemoryProvider['build'];
  /** Questions the run considered. */
  readonly questions: number;
  /** Questions with gold evidence, which is the denominator of every rate below. */
  readonly measured: number;
  /** Questions whose gold was excluded for having none. */
  readonly unmeasurable: number;
  /** Measured questions where at least one gold turn was covered. */
  readonly found: number;
  /** Measured questions where **every** gold turn was covered. Stricter, and reported separately. */
  readonly foundAll: number;
  /** Measured questions where the provider returned nothing at all. */
  readonly empty: number;
  readonly recallAtK: number;
  readonly recallAllAtK: number;
  /** Mean reciprocal rank of the first covered gold turn; zero when nothing was found. */
  readonly mrr: number;
  readonly sessions: number;
  readonly turns: number;
  readonly skipped: readonly string[];
  readonly byCapability: Readonly<Partial<Record<Capability, CapabilityScore>>>;
  /** Questions the provider's ingest reported as skipped, so a partial store is visible in the score line. */
  readonly ingestSkipped: number;
};

/**
 * The sessions a question brings, in the provider's shape.
 *
 * Two approximations are made here and both matter to a temporal provider, so both are stated rather than
 * hidden. **Sessions are positional**: the benchmark does not name them, and an id derived from content would
 * change whenever the content is normalised. **The timestamp is the question's**, because the dataset carries
 * one date per question rather than one per session — which means a provider filtering by `asOf` sees every
 * session as simultaneous. That is a real limit of this adapter, not of the provider, and it is why a temporal
 * comparison needs a dataset that carries session dates.
 */
export function sessionsOf(question: Question): readonly MemorySession[] {
  const groups: readonly (readonly string[])[] =
    question.sessions ?? question.context.map((turn) => [turn]);
  const at = questionDateMs(question) ?? 0;
  return groups.map((turns, index) => ({
    id: `${question.id}#${index}`,
    at,
    turns: turns.map((turn) => ({ role: 'user' as const, content: turn })),
  }));
}

/** The instant a question is asked, when the dataset carries one. */
function questionDateMs(question: Question): number | undefined {
  if (question.questionDate === undefined) return undefined;
  const parsed = Date.parse(question.questionDate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Run every provider over the same questions and report retrieval only.
 *
 * Sequential on purpose. A run is small, the providers hold state, and a concurrency bug in a measurement
 * harness produces a number that is wrong in a direction nobody can debug.
 */
export async function measureRetrieval(
  dataset: BenchmarkDataset,
  providers: readonly MemoryProvider[],
  options: HarnessOptions = {},
): Promise<readonly ProviderScore[]> {
  const limit = options.limit ?? 10;
  const mode = options.mode ?? 'isolated';
  const goldOf = options.goldOf ?? ((question: Question) => question.goldTurns ?? []);
  const contains = options.hitsContainGold ?? true;

  const scores: ProviderScore[] = [];
  for (const provider of providers) {
    let measured = 0;
    let unmeasurable = 0;
    let found = 0;
    let foundAll = 0;
    let empty = 0;
    let reciprocalRank = 0;
    let sessions = 0;
    let turns = 0;
    const skipped: string[] = [];
    const byCapability: Partial<Record<Capability, CapabilityScore>> = {};

    if (mode === 'global') await provider.reset();

    for (const question of dataset.questions) {
      if (mode === 'isolated') await provider.reset();

      const ingest = await provider.ingest(sessionsOf(question));
      sessions += ingest.sessions;
      turns += ingest.turns;
      skipped.push(...ingest.skipped);

      const bucket = byCapability[question.capability] ?? { questions: 0, measured: 0, found: 0 };
      byCapability[question.capability] = { ...bucket, questions: bucket.questions + 1 };

      const gold = goldOf(question);
      if (gold.length === 0) {
        unmeasurable += 1;
        continue;
      }
      measured += 1;

      const hits = await provider.search(question.question, { limit });
      if (hits.length === 0) empty += 1;

      const covered = (hit: { text: string }): boolean =>
        gold.some((turn) => (contains ? hit.text.includes(turn) : hit.text === turn));

      const firstIndex = hits.findIndex(covered);
      if (firstIndex >= 0) {
        found += 1;
        reciprocalRank += 1 / (firstIndex + 1);
      }
      if (
        gold.every((turn) =>
          hits.some((hit) => (contains ? hit.text.includes(turn) : hit.text === turn)),
        )
      ) {
        foundAll += 1;
      }

      const seen = byCapability[question.capability]!;
      byCapability[question.capability] = {
        ...seen,
        measured: seen.measured + 1,
        found: seen.found + (firstIndex >= 0 ? 1 : 0),
      };
    }

    if (mode === 'global') await provider.reset();

    scores.push({
      provider: provider.name,
      build: provider.build,
      questions: dataset.questions.length,
      measured,
      unmeasurable,
      found,
      foundAll,
      empty,
      recallAtK: measured === 0 ? 0 : found / measured,
      recallAllAtK: measured === 0 ? 0 : foundAll / measured,
      mrr: measured === 0 ? 0 : reciprocalRank / measured,
      sessions,
      turns,
      skipped,
      byCapability,
      ingestSkipped: skipped.length,
    });
  }
  return scores;
}

/**
 * A provider that retrieves nothing.
 *
 * Not a straw man: it is the floor that proves the loop can distinguish a system from an empty store. If this
 * ever scores above zero the harness is broken, and that is a cheaper thing to find than a wrong leaderboard.
 */
export class NullProvider implements MemoryProvider {
  readonly name = 'null-floor';
  readonly build = 'none' as const;

  async ingest(): Promise<{ sessions: number; turns: number; skipped: readonly string[] }> {
    return { sessions: 0, turns: 0, skipped: [] };
  }

  async search(): Promise<readonly never[]> {
    return [];
  }

  async reset(): Promise<void> {
    // Deliberately total: a floor that can fail is not a floor.
  }
}

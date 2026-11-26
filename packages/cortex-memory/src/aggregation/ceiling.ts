/**
 * The specification grammar's ceiling, as arithmetic rather than as a script.
 *
 * ## Why this is a module and not four hundred lines in `bench/`
 *
 * It began there, and the caller census said what was wrong with it in one line: eighteen new
 * exports with no production caller. A bench script is an entry point, so its exports are symbols a
 * customer never installs and nothing calls; the census is right to report them. The repair is not
 * an exemption in `tools/export-census-baseline.json` but the split this file is: the search is a
 * **function of a corpus question and a ledger**, and the script that feeds it a 100 MB corpus is a
 * caller like any other.
 *
 * The split has a second, larger consequence. `bench/` is outside the coverage boundary --
 * `vitest.config.ts` measures every TypeScript file under `src/` -- so arithmetic living there was
 * tested by no measurement at all. Here it is measured, on a history small enough to count by hand,
 * by `src/__tests__/ceiling.test.ts`.
 *
 * ## What the ceiling is
 *
 * An **upper bound** on what `reviewPass: 'spec'` could reach: for each question, is there any plan
 * the grammar can express -- one text keyword, one unit, `count` or `sum` -- that produces a number
 * the gold accepts? A `false` is decisive: no specifier, however good, could have produced the
 * answer from this ledger. A `true` is permission to spend a dispatch, and nothing more.
 *
 * It is not a prediction. Reaching the gold requires a reader to *choose* the plan that does, and a
 * gold reachable by forty plans out of four hundred is a different proposition from one reachable by
 * a single plan out of four hundred -- which is why `planShare` is reported and why the reading is
 * judged by `docs/PREREG-SPEC-CEILING-ADOPTED.md` 3 rather than by this number alone.
 *
 * ## The gate, and why the denominator moves with it
 *
 * `reviewPass: 'spec'` runs on `isTallyQuestion` -- an enumeration question asking for a count or a
 * total. A ceiling over the questions the pass never reaches is a ceiling over a population the
 * mechanism does not have, so `tallyEligible` is a field on every row and `summarise` reports the
 * gated numerator beside the full one. Neither replaces the other: a question outside the gate is
 * still evidence about the grammar.
 */

import { executeSpec } from './execute.js';
import { questionKeywords } from './keywords.js';
import { buildLedger, ledgerVocabulary, type Ledger } from './ledger.js';
import { renderAggregate } from './render.js';
import type { EventSpec } from './spec.js';
import { isTallyQuestion } from '../tally.js';

/** Words that carry no filter, because they are in every sentence of the corpus. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'many',
  'much',
  'did',
  'does',
  'was',
  'were',
  'have',
  'has',
  'had',
  'what',
  'which',
  'when',
  'where',
  'who',
  'whom',
  'that',
  'this',
  'these',
  'those',
  'with',
  'from',
  'been',
  'being',
  'there',
  'their',
  'about',
  'into',
  'over',
  'total',
  'altogether',
  'combined',
  'most',
  'least',
  'number',
  'times',
  'last',
  'past',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'day',
  'days',
  'you',
  'your',
  'can',
  'could',
  'would',
  'should',
  'tell',
  'give',
  'list',
  'name',
]);

/** One question as the corpus states it. Only the fields this measurement reads. */
export type DatasetQuestion = {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  /**
   * The gold, as the corpus states it -- and the corpus states it as a number for the questions
   * whose answer is a count.
   *
   * This was typed `string` and the type was a belief: the first dispatch that reached a real corpus
   * (`45750764632`) died on `gold.matchAll is not a function`, because a multi-session count question
   * carries `answer: 3` and not `"3"`. A type that the data does not satisfy is a type that has not
   * been read, and the reading that would have caught it is the one this file now performs.
   */
  readonly answer: string | number;
  readonly haystack_dates: readonly string[];
  readonly haystack_sessions: readonly (readonly {
    readonly role: string;
    readonly content: string;
  }[])[];
};

/** One question as a benchmark report states it. */
export type ArtifactQuestion = {
  readonly questionId: string;
  readonly question: string;
  readonly capability: string;
  readonly groundTruth: string | number;
  readonly correct: boolean;
};

/** A frozen list of ids, with the arithmetic the reading is judged against. */
export type PopulationFile = {
  readonly ids: readonly string[];
  readonly source?: Readonly<Record<string, unknown>>;
  readonly numericGold?: number;
  readonly floor?: number;
  readonly required?: number;
  readonly groups?: readonly { readonly name: string; readonly ids: readonly string[] }[];
};

/** What one question's search found. */
export type SpecSummary = {
  readonly questionId: string;
  readonly question: string;
  readonly gold: string;
  readonly goldNumbers: readonly number[];
  readonly copyCeiling: boolean;
  readonly grammarCeiling: boolean;
  /**
   * Whether `reviewPass: 'spec'` would run on this question at all.
   *
   * The pass is gated by `isTallyQuestion` -- an enumeration question asking for a count or a total
   * -- and a ceiling that counted a question the pass never reaches would be a ceiling over a
   * population the mechanism does not have. `grammar` is computed for every question regardless,
   * because a question outside the gate is still evidence about the grammar; the fold reports the
   * gated numerator beside it rather than replacing one with the other.
   */
  readonly tallyEligible: boolean;
  readonly matchingPlans: number;
  readonly plansTried: number;
  readonly planShare: number;
  readonly bestPlan: string | null;
  readonly ledgerSteps: number;
  readonly keywordsTried: number;
};

/** The turn shape the pipeline renders, so the ledger sees what the reader saw. */
function sessionsOf(question: DatasetQuestion): string[][] {
  return question.haystack_sessions.map((session, index) => {
    const date = question.haystack_dates[index] ?? '';
    return session.map((turn) => `[${date}] ${turn.role}: ${turn.content}`);
  });
}

/** Every number a gold answer would accept, so `5 days. 6 days ...` accepts both. */
function numbersInGold(gold: string | number): number[] {
  // A count question's gold is a number in the corpus and a string in the audit's tables; both are
  // the same gold, and coercing here is what makes one reader serve both.
  if (typeof gold === 'number') return [gold];
  const found: number[] = [];
  for (const match of gold.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(match[0].replaceAll(',', ''));
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/**
 * Every content word the history itself uses, which is the widest vocabulary a plan could select on.
 *
 * Rarest first and capped, because the search is quadratic in the vocabulary and a word in half the
 * rows cannot be the discriminating one. The cap is a search budget and is reported with the result,
 * so a ceiling measured under it is not read as a ceiling over the whole vocabulary.
 */
function historyKeywords(ledger: Ledger, cap = 600): string[] {
  const counts = new Map<string, number>();
  for (const row of ledger.rows) {
    for (const word of new Set(
      row.text
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/),
    )) {
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  // A word in more than a fifth of the rows selects almost everything, and a stem of it selects more.
  const ceiling = Math.max(2, Math.floor(ledger.steps / 5));
  return [...counts.entries()]
    .filter(([, seen]) => seen <= ceiling)
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .slice(0, cap)
    .map(([word]) => word);
}

/**
 * A keyword's stems, so a history vocabulary can reach an inflected form.
 *
 * `sold` has no stem that reaches `sell`, and no rule can invent the pair: that gap is why the
 * vocabulary a plan may choose from is measured twice rather than once.
 */
function withStems(words: readonly string[]): string[] {
  return [...new Set(words.flatMap((word) => [word, word.replace(/(?:ing|ed|es|s)$/, '')]))].filter(
    (word) => word.length >= 3,
  );
}

/**
 * Whether a computed value is one the gold accepts, within a tolerance rather than exactly.
 *
 * `0.1 + 0.2` is `0.30000000000000004` in binary floating point and a gold of `0.3` has to accept it;
 * six decimal places is finer than any currency, page count or day count in the corpus and coarser
 * than the representation error, so the tolerance is a statement about arithmetic rather than a
 * fudge factor.
 */
function accepts(goldNumbers: readonly number[], value: number): boolean {
  return goldNumbers.some((gold) => Math.abs(gold - value) < 1e-6);
}

/** The plans a question's own vocabulary can express over this ledger. */
function plansFor(
  ledger: Ledger,
  keywords: readonly string[],
  units: readonly (string | null)[],
): EventSpec[] {
  const plans: EventSpec[] = [];
  const scope: readonly [number, number] = [0, ledger.steps - 1];
  for (const keyword of keywords) {
    plans.push({
      scope,
      predicates: [{ field: 'text', op: 'contains', value: keyword }],
      operation: 'count',
    });
    for (const unit of units) {
      plans.push({
        scope,
        predicates:
          unit === null
            ? [{ field: 'text', op: 'contains', value: keyword }]
            : [
                { field: 'text', op: 'contains', value: keyword },
                { field: 'number', op: 'unit-is', value: unit },
              ],
        operation: 'sum',
      });
    }
  }
  return plans;
}

/** Whether any single row already carries an acceptable number. */
function copyCeiling(ledger: Ledger, goldNumbers: readonly number[]): boolean {
  return ledger.rows.some((row) =>
    row.numbers.some((number) => accepts(goldNumbers, number.value)),
  );
}

/** Measure one question, given its ledger, gold and the two vocabularies. */
function measureQuestion(input: {
  readonly questionId: string;
  readonly question: string;
  readonly gold: string | number;
  readonly ledger: Ledger;
  readonly vocabularyMode: 'question' | 'history';
  readonly maxKeywords?: number;
}): SpecSummary {
  const { ledger, vocabularyMode } = input;
  const vocabulary = ledgerVocabulary(ledger);
  const units: (string | null)[] = [null, ...vocabulary.units];
  const keywords =
    vocabularyMode === 'history'
      ? withStems(historyKeywords(ledger, input.maxKeywords ?? 600))
      : questionKeywords(input.question);
  const goldNumbers = numbersInGold(input.gold);

  const plans = plansFor(ledger, keywords, units);
  const hitting: string[] = [];
  for (const plan of plans) {
    const result = executeSpec(ledger, plan);
    // A plan that selected nothing is `empty` rather than a zero, so it is refused here and not by
    // the renderer: `count` of no rows is a legitimate zero and `sum` of no rows is not an answer.
    if (result.kind !== 'value') continue;
    const rendered = renderAggregate(result);
    if (rendered === null) continue;
    // `count` and `sum` are the only operations `plansFor` writes, so the value the renderer let
    // through is a number; the cast is a statement about the search, not a hope about the executor.
    if (accepts(goldNumbers, result.value as number)) {
      hitting.push(
        `${plan.operation}(${plan.predicates.map((predicate) => JSON.stringify(predicate.value)).join(',')}) → ${rendered}`,
      );
    }
  }

  return {
    questionId: input.questionId,
    question: input.question,
    gold: String(input.gold),
    goldNumbers,
    copyCeiling: copyCeiling(ledger, goldNumbers),
    grammarCeiling: hitting.length > 0,
    tallyEligible: isTallyQuestion(input.question),
    matchingPlans: hitting.length,
    plansTried: plans.length,
    planShare: plans.length === 0 ? 0 : hitting.length / plans.length,
    bestPlan: hitting[0] ?? null,
    ledgerSteps: ledger.steps,
    keywordsTried: keywords.length,
  };
}

/** Measure one corpus question end to end: build the ledger, then search the grammar. */
export function measure(
  corpus: DatasetQuestion,
  vocabularyMode: 'question' | 'history',
  maxKeywords?: number,
  gold?: string | number,
): SpecSummary {
  return measureQuestion({
    questionId: corpus.question_id,
    question: corpus.question,
    gold: gold ?? corpus.answer,
    ledger: buildLedger(sessionsOf(corpus)),
    vocabularyMode,
    ...(maxKeywords === undefined ? {} : { maxKeywords }),
  });
}

/** Median of a list of numbers, with an empty list reported as zero rather than NaN. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

/**
 * Fold the per-question rows into the numbers a registration is judged on.
 *
 * The return type is written out rather than named by an alias, because a declaration file cannot
 * name a type that is not exported and exporting it would only add a symbol whose sole caller is
 * this signature.
 */
export function summarise(
  summaries: readonly SpecSummary[],
  vocabularyMode: 'question' | 'history',
): {
  readonly vocabulary: 'question' | 'history';
  readonly questions: number;
  readonly numeric: number;
  readonly copy: number;
  readonly grammar: number;
  /** Questions with a numeric gold that `reviewPass: 'spec'` would actually run on. */
  readonly eligible: number;
  /** Of those, how many the grammar reaches -- the number a dispatch is judged against. */
  readonly grammarOfEligible: number;
  /** Median share of the search that reached the gold, over the questions the pass would run on. */
  readonly planShareMedian: number;
} {
  const numeric = summaries.filter((summary) => summary.goldNumbers.length > 0);
  const eligible = numeric.filter((summary) => summary.tallyEligible);
  return {
    vocabulary: vocabularyMode,
    questions: summaries.length,
    numeric: numeric.length,
    copy: numeric.filter((summary) => summary.copyCeiling).length,
    grammar: numeric.filter((summary) => summary.grammarCeiling).length,
    eligible: eligible.length,
    grammarOfEligible: eligible.filter((summary) => summary.grammarCeiling).length,
    planShareMedian: median(eligible.map((summary) => summary.planShare)),
  };
}

/**
 * Resolve the population to measure, refusing any selection that cannot be read cleanly.
 *
 * Two sources, and the difference between them is what the gold *is*. A named population carries ids
 * only, so the gold is the corpus answer. A report carries the gold it was graded on, which can
 * differ from the corpus answer -- the judge's gold and the dataset's `answer` field are two
 * statements about the same question -- and the ceiling has to be measured against the one the run
 * was scored on, or the two readings describe different questions.
 *
 * A named id the corpus does not carry is returned in `missing` and **not** silently dropped: an
 * absent question lowers the denominator and raises the ceiling, which is the one direction this
 * measurement must never move by accident.
 */
export function selectPopulation(input: {
  readonly dataset: readonly DatasetQuestion[];
  readonly artifact: { readonly questions: readonly ArtifactQuestion[] } | null;
  readonly population: PopulationFile | null;
  readonly capability: string | null;
  readonly includeCorrect: boolean;
}): { readonly selected: { corpus: DatasetQuestion; gold: string }[]; readonly missing: string[] } {
  const byId = new Map(input.dataset.map((question) => [question.question_id, question]));
  const selected: { corpus: DatasetQuestion; gold: string }[] = [];
  const missing: string[] = [];

  if (input.population !== null) {
    for (const id of input.population.ids) {
      const corpus = byId.get(id);
      if (corpus === undefined) {
        missing.push(id);
        continue;
      }
      selected.push({ corpus, gold: String(corpus.answer) });
    }
    return { selected, missing };
  }

  for (const question of input.artifact?.questions ?? []) {
    if (input.capability !== null && question.capability !== input.capability) continue;
    if (!input.includeCorrect && question.correct) continue;
    const corpus = byId.get(question.questionId);
    if (corpus === undefined) {
      missing.push(question.questionId);
      continue;
    }
    selected.push({ corpus, gold: String(question.groundTruth) });
  }
  return { selected, missing };
}

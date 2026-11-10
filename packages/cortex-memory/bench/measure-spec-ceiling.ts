/**
 * The ceiling of the specification grammar, measured offline before anything is dispatched.
 *
 * ## The question this answers, and why it has to be asked before the run
 *
 * `reviewPass: 'tally'` was dispatched on a hypothesis -- "the reader can find the operands and
 * cannot add them, so let the product add" -- and the run priced that hypothesis at −9.5
 * multi-session questions. The autopsy found the operands were wrong, which means the hypothesis was
 * never really about arithmetic; it was about *which quantity counts*. The next mechanism,
 * `reviewPass: 'spec'`, replaces the reader's per-line judgement with a typed plan over a
 * programme-built ledger. Before paying for a dispatch, there is a cheap question that decides
 * whether the dispatch can succeed at all:
 *
 * > **Is there any plan in this grammar that produces the gold answer?**
 *
 * This tool answers it by search rather than by opinion. For each failed question it enumerates every
 * plan the grammar can express over the vocabulary *the question itself supplies* -- one text keyword
 * from the question, one unit from the ledger's own vocabulary, `count` or `sum` -- executes each one
 * with the real executor, and reports whether any of them lands on a number the gold accepts.
 *
 * ## What a ceiling of N means, and what it does not
 *
 * It is an **upper bound**, and a generous one: the search is allowed to try every keyword and every
 * unit, including the correct one, which a model writing a plan from the question alone would have to
 * guess. So a failure here is stronger than a failure in a run -- if no plan exists, no specifier,
 * however good, could have produced the answer from this ledger. That is the finding worth having.
 *
 * It is not a prediction of accuracy. Reaching the gold requires the model to *choose* the plan that
 * does, and a plan that reaches the gold on one question may be one of forty that all do. The tool
 * prints how many plans reached it, because a gold reachable by forty plans is a different
 * proposition from one reachable by a single plan.
 *
 * ## The two ceilings
 *
 * `grammar` is the number above. `copy` is weaker and reported beside it: does any single row carry a
 * number the gold accepts? A question with no copy and no plan is not a specification problem at all,
 * and counting it against the grammar would misdirect the next increment.
 *
 * Usage:
 *   node --import tsx bench/measure-spec-ceiling.ts \
 *     --dataset /workspace/data/longmemeval_s_cleaned.json \
 *     --artifact /workspace/art-42533236864/benchmark-cortex-memory-ablation-report.json \
 *     [--capability MR] [--all] [--json out.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { buildLedger, ledgerVocabulary, type Ledger } from '../src/aggregation/ledger.js';
import { questionKeywords } from '../src/aggregation/keywords.js';
import { executeSpec } from '../src/aggregation/execute.js';
import { renderAggregate } from '../src/aggregation/render.js';
import type { EventSpec } from '../src/aggregation/spec.js';

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

type DatasetQuestion = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_dates: string[];
  haystack_sessions: { role: string; content: string }[][];
};

type ArtifactQuestion = {
  questionId: string;
  question: string;
  capability: string;
  groundTruth: string;
  correct: boolean;
};

type SpecSummary = {
  questionId: string;
  question: string;
  gold: string;
  goldNumbers: number[];
  copyCeiling: boolean;
  grammarCeiling: boolean;
  matchingPlans: number;
  bestPlan: string | null;
  ledgerSteps: number;
  keywordsTried: number;
};

/** The turn shape the pipeline renders, so the ledger sees what the reader saw. */
function sessionsOf(question: DatasetQuestion): string[][] {
  return question.haystack_sessions.map((session, index) => {
    const date = question.haystack_dates[index] ?? '';
    return session.map((turn) => `[${date}] ${turn.role}: ${turn.content}`);
  });
}

/** Every number a gold answer would accept, so `5 days. 6 days ...` accepts both. */
function numbersInGold(gold: string): number[] {
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
function historyKeywords(ledger: Ledger): string[] {
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
    .slice(0, Number(flag('max-keywords') ?? 600))
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

/** Whether a computed value is one the gold accepts. */
function accepts(
  goldNumbers: readonly number[],
  value: number | string | readonly string[] | Readonly<Record<string, number>>,
): boolean {
  if (typeof value !== 'number') return false;
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

/** Measure one question. */
function measure(
  question: ArtifactQuestion,
  dataset: DatasetQuestion,
  vocabularyMode: 'question' | 'history',
): SpecSummary {
  const ledger = buildLedger(sessionsOf(dataset));
  const vocabulary = ledgerVocabulary(ledger);
  const units: (string | null)[] = [null, ...vocabulary.units];
  const keywords =
    vocabularyMode === 'history'
      ? withStems(historyKeywords(ledger))
      : questionKeywords(question.question);
  const goldNumbers = numbersInGold(question.groundTruth);

  const hitting: string[] = [];
  for (const plan of plansFor(ledger, keywords, units)) {
    const result = executeSpec(ledger, plan);
    const rendered = renderAggregate(result);
    if (rendered === null) continue;
    if (result.kind !== 'value') continue;
    if (accepts(goldNumbers, result.value)) {
      hitting.push(
        `${plan.operation}(${plan.predicates.map((predicate) => JSON.stringify(predicate.value)).join(',')}) → ${rendered}`,
      );
    }
  }

  return {
    questionId: question.questionId,
    question: question.question,
    gold: question.groundTruth,
    goldNumbers,
    copyCeiling: copyCeiling(ledger, goldNumbers),
    grammarCeiling: hitting.length > 0,
    matchingPlans: hitting.length,
    bestPlan: hitting[0] ?? null,
    ledgerSteps: ledger.steps,
    keywordsTried: keywords.length,
  };
}

/** Read `--flag value` pairs, which is all this tool's command line needs. */
function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index === process.argv.length - 1
    ? null
    : (process.argv[index + 1] as string);
}

function main(): void {
  const datasetPath = flag('dataset');
  const artifactPath = flag('artifact');
  if (datasetPath === null || artifactPath === null) {
    console.error(
      'usage: --dataset <path> --artifact <path> [--capability MR] [--all] [--json out.json]',
    );
    process.exit(2);
  }
  const capability = flag('capability');
  const includeCorrect = process.argv.includes('--all');
  const vocabularyMode = flag('keywords') === 'history' ? 'history' : 'question';

  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as DatasetQuestion[];
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    questions: ArtifactQuestion[];
  };
  const byId = new Map(dataset.map((question) => [question.question_id, question]));

  const selected = artifact.questions.filter(
    (question) =>
      (capability === null || question.capability === capability) &&
      (includeCorrect || !question.correct),
  );

  const summaries: SpecSummary[] = [];
  for (const question of selected) {
    const source = byId.get(question.questionId);
    if (source === undefined) {
      console.error(`missing from the dataset: ${question.questionId}`);
      continue;
    }
    summaries.push(measure(question, source, vocabularyMode));
  }

  const numeric = summaries.filter((summary) => summary.goldNumbers.length > 0);
  const reachable = numeric.filter((summary) => summary.grammarCeiling);
  const copied = numeric.filter((summary) => summary.copyCeiling);

  console.log(`vocabulary: ${vocabularyMode}`);
  console.log(`questions: ${summaries.length}  with a numeric gold: ${numeric.length}`);
  console.log(`copy ceiling   : ${copied.length}/${numeric.length}`);
  console.log(`grammar ceiling: ${reachable.length}/${numeric.length}`);
  console.log('');
  console.log('id            copy  grammar  plans  gold');
  for (const summary of summaries) {
    const copy = summary.goldNumbers.length === 0 ? ' n/a' : summary.copyCeiling ? ' yes' : '  no';
    const grammar =
      summary.goldNumbers.length === 0 ? '     ' : summary.grammarCeiling ? '     yes' : '      no';
    console.log(
      `${summary.questionId}  ${copy}  ${grammar}  ${String(summary.matchingPlans).padStart(5)}  ${summary.gold.slice(0, 44).replaceAll('\n', ' ')}`,
    );
  }

  const out = flag('json');
  if (out !== null) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          capability,
          vocabulary: vocabularyMode,
          summaries,
          copy: copied.length,
          grammar: reachable.length,
          numeric: numeric.length,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nwrote ${out}`);
  }
}

main();

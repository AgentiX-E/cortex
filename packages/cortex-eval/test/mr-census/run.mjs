/**
 * Multi-session failure census: what a wrong answer is made of, read from an archived artifact.
 *
 * ## Why this is a script and not a paragraph
 *
 * Step 23 measured the same taxonomy three times with three throwaway scripts, and the first of the
 * three was wrong in a way worth keeping: it read the answer as the first number in the Step 2 block,
 * which is the `2` in "Step 2". Every count question then looked like a disagreement between its list
 * and its answer (44 questions, 31 disagreeing) and the finding evaporated once the extractor was
 * fixed. **A reading that lives in a shell history cannot be re-checked, and an unchallenged reading
 * is how a wrong one survives.**
 *
 * So the taxonomy lives here, with its definitions next to the numbers they produce.
 *
 * ## What it splits, and why those splits
 *
 * 1. **Answer shape** — an abstention, a number against a numeric gold, a number against a text gold,
 *    text against text. These need different work: an abstention is a decision the reader made, a
 *    numeric mismatch is arithmetic or evidence, a text mismatch is the judge or the reader.
 * 2. **Gold coverage** — whether every gold turn reached the reader (`carried === total`), some did,
 *    or none did. `carried === total` with a wrong answer is a reader failure; `carried < total` is a
 *    retrieval failure; `carried === 0` is a question the system never had a chance at.
 * 3. **Abstentions that carry a list** — the population the recovery pass exists for. On three archived
 *    runs every MR abstention carried a non-empty Step 1 list, and `ABS` carried none of 30, which is
 *    the control that makes it a statement about lists rather than about declining.
 *
 * Nothing here is a judgement about quality. It is the same containment test `tr-failure-class.ts`
 * uses and it carries the same limits.
 *
 * ## Usage
 *
 *     node test/mr-census/run.mjs --report /workspace/run-<id>/benchmark-cortex-memory-ablation-report.json
 *     node test/mr-census/run.mjs --report ... --json    # machine-readable
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// The recovery pass's own predicate, not a copy of it. A reading that re-implemented "is this list
// non-empty" would produce a number about a different question than the one the product asks -- the
// rule `test/echo/run.mjs` follows for `OutputGuard` and `test/card-volume/run.mjs` for `splitSentences`.
import { declinedItems } from '../../../cortex-memory/dist/index.js';

const INT = /^\s*(-?\d+)(?:\.0+)?\s*$/;
const COUNT = /\b(?:how many|number of|total number|count of)\b/i;

/**
 * A question whose answer depends on resolving "last month" against the conversation's own clock.
 *
 * The corpus is dated 2023 and the reader is told nothing about when "now" is, so a relative expression
 * has to be resolved against the evidence rather than against the wall clock. Measured on the adopted
 * configuration, MR questions carrying one answered **48.5%** against 68.2% for those that do not --
 * a 19.7pp gap on 33 of 121 questions, which is where the temporal work starts. The split is reported
 * for every capability because TR is the capability it is *named* for and has never been measured.
 */
const RELATIVE_TIME =
  /\b(?:last|past|this|previous|recent|recently|lately|ago|yesterday|today|tonight|now|currently|current|these days|so far)\b/i;

/**
 * What kind of wrong answer this is.
 *
 * `numeric off by -1` is separated from `numeric far off` because they are different claims: the first
 * is the count-by-one error that four archived runs reproduce, the second is a different question being
 * answered.
 */
export function answerShape(record) {
  const answer = (record.answer ?? '').trim();
  if (answer === '') return 'abstained';
  const gold = String(record.groundTruth ?? '').trim();
  const a = INT.exec(answer);
  const g = INT.exec(gold);
  if (a !== null && g !== null) {
    const delta = Number(a[1]) - Number(g[1]);
    if (Math.abs(delta) <= 3) return `numeric ${delta >= 0 ? '+' : ''}${delta}`;
    return 'numeric far off';
  }
  if (a !== null) return 'numeric answer, text gold';
  if (g !== null) return 'text answer, numeric gold';
  return 'text mismatch';
}

/** How much of this question's gold the reader actually held. */
export function goldCoverage(record) {
  const overlap = record.goldOverlap;
  if (overlap === undefined || overlap === null) return 'unrecorded';
  const total = Math.max(1, overlap.total);
  if (overlap.carried >= total) return 'complete';
  if (overlap.carried === 0) return 'none';
  return 'partial';
}

const tally = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
};

function census(questions) {
  const byCapability = {};
  for (const capability of ['MR', 'TR', 'KU', 'IE', 'ABS']) {
    const rows = questions.filter((question) => question.capability === capability);
    if (rows.length === 0) continue;
    const failures = rows.filter((question) => !question.correct);
    const abstentions = failures.filter((question) => (question.answer ?? '').trim() === '');
    byCapability[capability] = {
      questions: rows.length,
      correct: rows.length - failures.length,
      failures: failures.length,
      shapes: tally(failures.map(answerShape)),
      coverage: tally(failures.map(goldCoverage)),
      abstentions: abstentions.length,
      abstentionsWithList: abstentions.filter(
        (question) => declinedItems(question.rawOutput ?? '').length > 0,
      ).length,
      // The recovery pass's signature, so a run that used it is legible from the artifact alone.
      recovered: rows.filter((question) => (question.rawOutput ?? '').includes('ITEMS YOU LISTED'))
        .length,
      // Accuracy on questions that need a relative time resolved, and on those that do not. Reported
      // as a pair because either alone invites the wrong reading: a capability can be strong on both
      // and weak on neither, or look strong overall while failing most of one kind.
      relativeTime: (() => {
        const withTime = rows.filter((question) => RELATIVE_TIME.test(question.question ?? ''));
        const without = rows.filter((question) => !RELATIVE_TIME.test(question.question ?? ''));
        const rate = (set) =>
          set.length === 0 ? null : `${set.filter((q) => q.correct).length}/${set.length}`;
        return { withTime: rate(withTime), without: rate(without) };
      })(),
    };
  }
  return byCapability;
}

function main() {
  const at = process.argv.indexOf('--report');
  if (at < 0)
    throw new Error('pass --report <path to benchmark-cortex-memory-ablation-report.json>');
  const path = process.argv[at + 1];
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const questions = report.questions ?? [];
  const result = {
    what: 'Multi-session failure census: answer shape, gold coverage, and abstentions that contradict their own list.',
    source: basename(path),
    generatedFrom: {
      questionCount: report.questionCount,
      runs: report.runs,
      config: report.memoryArmConfig,
    },
    byCapability: census(questions),
    // The split that decides the next experiment: a wrong answer with complete coverage is the
    // reader's, one with partial coverage is retrieval's, and they need opposite work.
    mrVerdict: (() => {
      const mr = questions.filter((question) => question.capability === 'MR' && !question.correct);
      if (mr.length === 0) return 'no multi-session failures';
      const complete = mr.filter((question) => goldCoverage(question) === 'complete').length;
      const partial = mr.filter((question) => goldCoverage(question) === 'partial').length;
      return `${complete} reader (complete coverage) / ${partial} retrieval (partial) / ${mr.length - complete - partial} unrecorded`;
    })(),
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const [capability, row] of Object.entries(result.byCapability)) {
    process.stdout.write(
      `${capability}: ${row.correct}/${row.questions} correct, ${row.failures} failures\n` +
        `  shapes:   ${row.shapes.map(([name, n]) => `${name} ${n}`).join(' · ')}\n` +
        `  coverage: ${row.coverage.map(([name, n]) => `${name} ${n}`).join(' · ')}\n` +
        `  abstained: ${row.abstentions} (${row.abstentionsWithList} with a non-empty Step 1 list)\n` +
        `  relative time: ${row.relativeTime.withTime ?? 'none'} with · ${row.relativeTime.without ?? 'none'} without\n`,
    );
  }
  process.stdout.write(`\nMR: ${result.mrVerdict}\n`);
}

/** Write the reading beside the script, for the same reason `card-volume` does. */
function writeResult(path) {
  const at = process.argv.indexOf('--report');
  const report = JSON.parse(readFileSync(process.argv[at + 1], 'utf8'));
  writeFileSync(
    path,
    `${JSON.stringify({ ...census(report.questions ?? []), source: basename(process.argv[at + 1]) }, null, 1)}\n`,
  );
}

if (process.argv[1]?.endsWith('run.mjs')) {
  if (process.argv.includes('--write')) writeResult(new URL('./result.json', import.meta.url));
  main();
}

#!/usr/bin/env node
/**
 * How much of the score a mechanism can reach, counted by **two** witnesses instead of one.
 *
 *     node tools/ceiling-witnesses.mjs <report.json> [--list] [--self-test]
 *
 * Exit codes: `0` a reading, `2` a usage error, `3` the artifact cannot be paired (delegated to
 * `paired-flip.mjs`'s own refusals), `4` a record the delivery question cannot be asked of.
 *
 * ## The defect this file exists to name
 *
 * `MEASURE-REACHABLE-HEADROOM.md` §2 computes the harness ceiling as
 *
 *     1 - (never - demonstrated) / n
 *
 * where `never` is the questions this arm answers wrongly in every repetition and `demonstrated` is how
 * many of those the **control** answers at least once. `96.00` on the 500 comes from that expression, and
 * so does the sentence that follows it -- *"twenty of the twenty-six questions this arm never answers are
 * questions the reference pipeline never answers either ... no amount of work on this arm moves them"*.
 *
 * That sentence treats one witness as the only witness. The artifact carries a second and stronger one for
 * exactly this question: `goldOverlap.goldDelivered` says, per gold turn, whether **this arm's own prompt**
 * carried it. A question whose gold the prompt delivered is not a question "no pipeline reaches" -- it is a
 * question the reader was shown the answer to and decided wrongly, and a decision mechanism is aimed at
 * exactly that. `failure-classes.mjs` calls the two halves `misselected` and `absent`, and until this round
 * it drew that line on `goldTurns`, which `question-record.ts` writes as *"the text of every gold turn,
 * delivered or not"* -- so the one instrument that could have supplied the second witness was reading a
 * text that does not distinguish them.
 *
 * ## What the two witnesses are, and what neither of them promises
 *
 * | witness | field | what it establishes |
 * | --- | --- | --- |
 * | control | `ablation.*CorrectByRun` | a pipeline in this repository answered it, so the corpus admits an answer |
 * | own prompt | `goldOverlap.goldDelivered` | the gold's operand was in the window this arm built, so delivery is not what failed |
 *
 * Neither is a promise that a mechanism exists. The first is evidence that the question is answerable; the
 * second is evidence that the **evidence arrived**. A question can satisfy both and still be beyond every
 * mechanism in the queue, and a question can fail both and still be reachable by a third pipeline's
 * retrieval. What the pair does is replace one number with a range: `ceiling(control)` is what a fix that
 * only did what the control already does could reach, `ceiling(shown)` is what a fix that made the reader
 * use evidence it was already given could reach, and the truth is in between or above the second.
 *
 * ## Why `unknown` is a column rather than folded in
 *
 * A gold whose content terms are all stop words and which states no number (`Yes`, `Dark Souls 3 DLC` when
 * the terms are short) has no operand to search for. Answering "delivered" for it would make the second
 * witness a rubber stamp, and answering "absent" would make it a claim about content that is not there.
 * `operandReach` returns `'unknown'` for that shape, this table prints it, and `ceiling(shown)` treats it as
 * unreachable -- the conservative direction, because an unreachable question understates the ceiling and an
 * over-stated ceiling is a promise.
 *
 * ## What it refuses
 *
 * - an artifact the pairing instrument refuses (no masks, a mask that disagrees with the question list);
 * - a `never` question whose record carries no `goldOverlap`, because the second witness is that field;
 * - an id the question list does not contain, which would silently shrink the denominator.
 */

import { readFileSync } from 'node:fs';

import { summarisePaired } from '../packages/cortex-eval/dist/paired-flip.js';

import { operandReach, Refusal } from './failure-classes.mjs';
import { casesFrom } from './paired-flip.mjs';

/** The two witnesses for one capability, and the ceiling each of them states. */
function witnessesFor(capability, recordsById) {
  const never = capability.neverRight;
  let control = 0;
  let shown = 0;
  let unknown = 0;
  const rows = [];
  for (const entry of never) {
    const record = recordsById.get(entry.questionId);
    if (record === undefined) {
      throw new Refusal(
        `question ${entry.questionId} is in the reading and not in the question list; counting it as ` +
          'unreachable shrinks the ceiling and dropping it silently shrinks the denominator',
      );
    }
    const overlap = record.goldOverlap;
    if (overlap === null || typeof overlap !== 'object' || !Array.isArray(overlap.goldTurns)) {
      throw new Refusal(
        `question ${entry.questionId} carries no \`goldOverlap.goldTurns\`, so the second witness -- what ` +
          'the prompt delivered -- cannot be read and the ceiling would be stated by one witness alone',
      );
    }
    const reach = operandReach(String(record.groundTruth ?? ''), overlap, entry.questionId);
    if (reach === 'delivered') shown += 1;
    else if (reach === 'unknown') unknown += 1;
    if (entry.control === 'every') control += 1;
    rows.push({ questionId: entry.questionId, control: entry.control, reach });
  }
  const total = capability.total;
  return {
    capability: capability.capability,
    total,
    never: never.length,
    control,
    shown,
    unknown,
    // The questions the two witnesses actually disagree about, which is not `shown - control`: a question
    // reached by both counts in both columns, and the difference of the totals cancels it.
    bothWays: rows.filter((row) => row.reach === 'delivered' && row.control !== 'every').length,
    // Both ceilings subtract the questions neither witness reaches. `shown` and `control` are counted
    // separately rather than unioned, because a question can satisfy both and a union would need an
    // intersection term this table does not have room to be wrong about.
    ceilingControl: 100 * (1 - (never.length - control) / total),
    // The unknown column is printed and **not** subtracted: a question whose gold states no operand has not
    // been reached, and counting it as reached would make this ceiling a promise. It is a column rather than
    // a silent exclusion so that a reader can see how much of the gap between the two ceilings is
    // unmeasurable rather than delivered.
    ceilingShown: 100 * (1 - (never.length - shown) / total),
    rows,
  };
}

function render(readings) {
  const lines = [];
  lines.push('ceiling: what a mechanism can reach, by the control and by this arm\'s own prompt');
  lines.push(
    `${'capability'.padEnd(16)}${'n'.padStart(5)}${'never'.padStart(7)}${'control'.padStart(9)}` +
      `${'shown'.padStart(7)}${'unknown'.padStart(9)}${'ceiling(c)'.padStart(12)}${'ceiling(s)'.padStart(12)}`,
  );
  for (const reading of readings) {
    lines.push(
      `${reading.capability.padEnd(16)}${String(reading.total).padStart(5)}` +
        `${String(reading.never).padStart(7)}${String(reading.control).padStart(9)}` +
        `${String(reading.shown).padStart(7)}${String(reading.unknown).padStart(9)}` +
        `${reading.ceilingControl.toFixed(2).padStart(12)}` +
        `${reading.ceilingShown.toFixed(2).padStart(12)}`,
    );
  }
  const suite = readings.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      never: sum.never + row.never,
      control: sum.control + row.control,
      shown: sum.shown + row.shown,
      unknown: sum.unknown + row.unknown,
      bothWays: sum.bothWays + row.bothWays,
    }),
    { total: 0, never: 0, control: 0, shown: 0, unknown: 0, bothWays: 0 },
  );
  lines.push(
    `${'suite'.padEnd(16)}${String(suite.total).padStart(5)}${String(suite.never).padStart(7)}` +
      `${String(suite.control).padStart(9)}${String(suite.shown).padStart(7)}` +
      `${String(suite.unknown).padStart(9)}` +
      `${(100 * (1 - (suite.never - suite.control) / suite.total)).toFixed(2).padStart(12)}` +
      `${(100 * (1 - (suite.never - suite.shown) / suite.total)).toFixed(2).padStart(12)}`,
  );
  return { lines, suite };
}

function readReport(path) {
  return readReportFrom(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * The same two steps `readReport` takes, from an object rather than a path.
 *
 * `selfTest` builds its report in memory, and a self-test that wrote a file to run itself would be a
 * self-test that can fail for reasons the code under test did not cause.
 */
function readReportFrom(report) {
  const paired = casesFrom(report);
  if ('error' in paired) throw new Refusal(paired.error);
  const reading = summarisePaired(paired.cases);
  const recordsById = new Map(report.questions.map((record) => [record.questionId, record]));
  return { reading, recordsById };
}

function selfTest() {
  // A four-question population where the two witnesses disagree on exactly one question: `q1` is never
  // right, the control never answers it, and this arm's prompt carried the gold. Under the control-only
  // ceiling that question is a ceiling of the harness; under the prompt witness it is a decision fault.
  const questions = [
    {
      questionId: 'q1',
      capability: 'multi-session',
      route: 'multi-session',
      correct: false,
      answer: '$220',
      groundTruth: '$720',
      goldOverlap: {
        carried: 2,
        total: 2,
        goldTurns: ['The deposit was $720 in total.'],
        goldDelivered: [true],
      },
    },
    {
      questionId: 'q2',
      capability: 'multi-session',
      route: 'multi-session',
      correct: false,
      answer: '27',
      groundTruth: 'The deposit was 38 dollars.',
      goldOverlap: {
        carried: 1,
        total: 4,
        goldTurns: ['I set the thermostat.', 'The deposit was 38 dollars.'],
        goldDelivered: [true, false],
      },
    },
    {
      questionId: 'q3',
      capability: 'temporal',
      route: 'temporal',
      correct: true,
      answer: '21 days',
      groundTruth: '21 days',
      goldOverlap: { carried: 1, total: 1, goldTurns: ['That was 21 days ago.'], goldDelivered: [true] },
    },
    {
      questionId: 'q4',
      capability: 'temporal',
      route: 'temporal',
      correct: false,
      answer: 'Yes',
      groundTruth: 'Yes',
      goldOverlap: { carried: 1, total: 2, goldTurns: ['Yes.'], goldDelivered: [true] },
    },
  ];
  // `q1` and `q2` wrong in every repetition on this arm; the control answers `q1` never and `q2` always.
  const report = {
    questions,
    ablation: {
      baselineCorrectByRun: ['0110', '0110'],
      featureCorrectByRun: ['0010', '0010'],
    },
  };
  const { reading, recordsById } = readReportFrom(report);
  const byName = new Map(reading.capabilities.map((row) => [row.capability, row]));
  const multi = witnessesFor(byName.get('multi-session'), recordsById);
  if (multi.never !== 2) throw new Error(`self-test: multi-session must hold two never-right, read ${multi.never}`);
  if (multi.control !== 1) throw new Error(`self-test: the control answers one of them, read ${multi.control}`);
  if (multi.shown !== 1) throw new Error(`self-test: the prompt carried one operand, read ${multi.shown}`);
  if (multi.unknown !== 0) throw new Error(`self-test: no gold here is operand-less, read ${multi.unknown}`);
  if (multi.ceilingControl.toFixed(2) !== '50.00') {
    throw new Error(`self-test: ceiling(control) must read 50.00 on this fixture, read ${multi.ceilingControl}`);
  }
  // The two witnesses disagree on `q1` -- the prompt carried its gold and the control never answered it --
  // which is the only reason this tool exists. Asserted at the question rather than on the totals, because
  // the totals agree here (one control, one prompt) and a net-zero fixture would pass a total-level check.
  const disagreed = multi.rows.find((row) => row.questionId === 'q1');
  if (disagreed === undefined || disagreed.control !== 'none' || disagreed.reach !== 'delivered') {
    throw new Error(`self-test: \`q1\` must be a prompt-witness question the control misses, read ${JSON.stringify(disagreed)}`);
  }
  const temporal = witnessesFor(byName.get('temporal'), recordsById);
  if (temporal.never !== 1) throw new Error(`self-test: temporal must hold one never-right, read ${temporal.never}`);
  if (temporal.unknown !== 1) {
    throw new Error(`self-test: an operand-less gold must land in \`unknown\`, read ${temporal.unknown}`);
  }
  // One never, none reached, and one of them operand-less: the unknown must not lift the ceiling, because a
  // witness that answers "yes" for a gold with nothing in it is not a witness.
  if (temporal.ceilingShown.toFixed(2) !== '50.00') {
    throw new Error(`self-test: ceiling(shown) must not be lifted by an unknown, read ${temporal.ceilingShown}`);
  }

  // And the refusal, because an id outside the question list would silently move the denominator.
  let refused = false;
  try {
    witnessesFor(
      {
        capability: 'multi-session',
        total: 2,
        neverRight: [{ questionId: 'absent-from-the-list', control: 'none' }],
      },
      recordsById,
    );
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refused = true;
  }
  if (!refused) throw new Error('self-test: an id outside the question list must be refused');

  console.log(
    'self-test: two witnesses on a fixture where they disagree, `unknown` excluded from the ceiling, ' +
      'an id outside the question list refused',
  );
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const files = argv.filter((argument) => !argument.startsWith('--'));
  if (files.length !== 1) {
    console.error('usage: node tools/ceiling-witnesses.mjs <report.json> [--list]');
    process.exitCode = 2;
    return;
  }
  const { reading, recordsById } = readReport(files[0]);
  const readings = reading.capabilities.map((capability) =>
    witnessesFor(capability, recordsById),
  );
  const { lines, suite } = render(readings);
  if (argv.includes('--list')) {
    for (const row of readings) {
      for (const entry of row.rows) {
        lines.push(
          `  ${entry.questionId.padEnd(14)} ${row.capability.padEnd(16)} control=${entry.control.padEnd(6)} ` +
            `prompt=${entry.reach}`,
        );
      }
    }
  }
  lines.push(
    '  control: the reference pipeline answered it at least once. shown: this arm\'s own prompt carried the ' +
      'gold\'s operand. unknown: the gold states no operand, so "was it shown" has no answer.',
  );
  lines.push(
    `the two witnesses disagree about ${String(suite.bothWays)} of the ${String(suite.never)} never-right ` +
      'questions: the prompt carried the gold and the control never answered it.',
  );
  console.log(lines.join('\n'));
}

if (process.argv[1] && process.argv[1].endsWith('ceiling-witnesses.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`REFUSED: ${error.message}`);
    // Exit `4` rather than `1`: a refusal is a statement about the record, and a caller scripting several
    // artifacts needs to tell "this one cannot be read" from "the tool broke".
    process.exitCode = 4;
  }
}

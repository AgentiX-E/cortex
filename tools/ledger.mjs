#!/usr/bin/env node
/**
 * What two increments are worth together, from the reports already on disk.
 *
 *     node tools/ledger.mjs silent=run-a/benchmark-cortex-memory-ablation-report.json \
 *                           answer-line=run-b/benchmark-cortex-memory-ablation-report.json
 *
 * ## Why this is a command and not a sentence
 *
 * Each arm's report carries its own delta, and the next roadmap sentence is the sum: `silent` is
 * registered at +9 questions and `answer-line` at +6, so the pair is worth +15. That sentence assumes the
 * two increments bought **different** questions, and no artifact in this repository states whether they
 * did. Two columns of opaque hex ids are not a check -- at 100 questions a three-question overlap is
 * invisible by eye and large enough to turn +15 into +12.
 *
 * The arithmetic is also where a subtle loss hides: if one increment buys a question and another sells it,
 * the two nets read `+1` and `-1`, and every sum says zero. The truth is that two treatments moved the same
 * question in opposite directions, which is a reason not to ship them together and is invisible in both
 * deltas.
 *
 * ## What it reads, and the two envelopes it refuses to conflate
 *
 * Two shapes reach this tool: the memory arm's ablation report, which nests the result under `ablation`,
 * and a raw `AblationResult` written on its own. The adapter lives here and the arithmetic does not move --
 * `ledgerOf` and `portfolioOf` in `cortex-eval` are the only definition of bought and sold, which is the
 * same reason `paired-test.mjs` adapts two envelopes rather than implementing a second comparison.
 *
 * A report that predates `discordantQuestions` is **refused by name**, not read as an increment that bought
 * nothing: absent and empty render identically in a portfolio and mean opposite things, and only one of
 * them belongs in a union.
 *
 * ## What it does not claim
 *
 * A union is not the combined arm's score. Each increment is measured against its own baseline, so a pair
 * measured separately can still interact when one sits on top of the other. The union is the **ceiling
 * under perfect additivity** and the sum is that ceiling's assumption; what this tool establishes is
 * whether the assumption was ever available, before a dispatch is spent proving it.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { ledgerOf, portfolioOf } from '../packages/cortex-eval/dist/index.js';

/**
 * Two modes, and the difference is which baseline the purchases are counted against.
 *
 * **Within-run** (`<label>=<report>`): each increment is read from its own artifact's `discordantQuestions`,
 * which records the feature against the **reference pipeline inside that same run**. Two such increments are
 * commensurable only because that reference arm is the same party in both — not because their control is the
 * same. Run against two archived asks this mode reported an overlap of 208 of 448, and that number says the
 * two runs both beat the same third party; it says nothing about route isolation (§13.131).
 *
 * **Across runs** (`--across <label>=<report> --control <report>`): the baseline is one named run, and the
 * verdicts are paired by question id. This is the comparison every roadmap sentence actually registers, and
 * it is the mode the tool lacked when the first portfolio was read.
 *
 * Mixing the two is refused by name, because a union over two different third parties prints as confidently
 * as a valid one.
 */
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

function takeOption(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write(`${name} needs a value\n`);
        process.exit(2);
      }
      values.push(value);
    } else if (argv[index].startsWith(`${name}=`)) {
      values.push(argv[index].slice(name.length + 1));
    }
  }
  return values;
}

const controlPaths = takeOption('--control');
const acrossArgs = takeOption('--across');

/**
 * The positional `<label>=<path>` arguments, with every option and its value skipped.
 *
 * Scanned rather than filtered, because an option's value does not start with `--` and would otherwise be
 * read as an increment -- which is how a control file and an arm file would end up as two arms with one of
 * them labelled by a path.
 */
const args = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--control' || arg === '--across') {
    index += 1;
    continue;
  }
  if (arg.startsWith('--')) continue;
  args.push(arg);
}

if (args.length === 0 && acrossArgs.length === 0) {
  process.stderr.write(
    'usage: node tools/ledger.mjs <label>=<report.json> [<label>=<report.json> ...] [--json]\n' +
      '       node tools/ledger.mjs --control <report.json> --across <label>=<report.json> ... [--json]\n',
  );
  process.exit(2);
}

if (controlPaths.length > 1) {
  process.stderr.write(`--control takes one report; got ${controlPaths.length}\n`);
  process.exit(2);
}

if (controlPaths.length === 1 && acrossArgs.length === 0) {
  process.stderr.write('--control is only meaningful with at least one --across arm\n');
  process.exit(2);
}

if (acrossArgs.length > 0 && controlPaths.length === 0) {
  process.stderr.write('--across needs --control: a cross-run pair has no baseline otherwise\n');
  process.exit(2);
}

if (controlPaths.length === 1 && args.length > 0) {
  const mixed = args
    .map((arg) => arg.slice(0, Math.max(arg.indexOf('='), 0)))
    .filter((label) => label.length > 0);
  process.stderr.write(
    `refusing to mix: ${mixed.join(', ')} given as a within-run increment beside --across arms. ` +
      'A within-run increment is measured against its own artifact\'s reference arm and a cross-run one ' +
      'against the control file, so a union of the two would be a number over two different baselines. ' +
      'Pass every arm with --across, or drop --control.\n',
  );
  process.exit(2);
}

/**
 * The result inside one report file, from either envelope.
 *
 * Keyed on `ablation` rather than on a file name, because the two artifacts that carry a result are named
 * for the arm that produced them and a name check would silently stop matching the day a report is renamed.
 */
function resultOf(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const nested = parsed.ablation;
  if (nested !== null && typeof nested === 'object' && 'discordantQuestions' in nested)
    return nested;
  if ('discordantQuestions' in parsed) return parsed;
  return nested !== null && typeof nested === 'object' ? nested : parsed;
}

function splitLabel(arg) {
  const at = arg.indexOf('=');
  if (at === -1) {
    process.stderr.write(`expected <label>=<path>, got ${arg}\n`);
    process.exit(2);
  }
  return [arg.slice(0, at), arg.slice(at + 1)];
}

/**
 * A report's per-question verdicts, keyed by question id, from the envelope the workflow uploads.
 *
 * The ids are what make two runs comparable at all: `discordantQuestions` records verdicts for one pair and
 * names neither the pair nor the run, so a set difference across runs has to be computed from the roster.
 * A report without `questions` predates the roster field and is refused by name rather than paired as an
 * arm whose verdicts are all absent.
 */
function verdictsOf(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const questions = parsed.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(
      `${file} carries no per-question roster, so it cannot be paired across runs: absent verdicts and ` +
        'a run that answered nothing would look the same',
    );
  }
  const verdicts = new Map();
  const promptChars = new Map();
  for (const question of questions) {
    const id = question.questionId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${file} has a question without a questionId, so its verdicts cannot be paired`);
    }
    if (verdicts.has(id)) {
      throw new Error(`${file} names ${id} twice: a run cannot answer one question twice`);
    }
    verdicts.set(id, question.correct === true);
    // Kept per question because it is the only field that says which questions a treatment actually reached.
    // Absent is not zero here either: a report that predates the field cannot be read as "nothing was treated".
    promptChars.set(id, typeof question.promptChars === 'number' ? question.promptChars : null);
  }
  return { verdicts, promptChars, generatedAt: parsed.generatedAt ?? 'unknown', questions };
}

/**
 * One increment measured against a named run, question for question.
 *
 * The arithmetic is `ledgerOf`'s, not this file's: the diff is turned into the shape a report's
 * `discordantQuestions` already has, so bought, sold, the duplicate refusal and the portfolio are computed
 * by one definition in `cortex-eval` and this mode cannot drift from the within-run one.
 */
function acrossIncrement(label, file, control) {
  const arm = verdictsOf(file);
  const ids = [...control.verdicts.keys()];
  const missing = ids.filter((id) => !arm.verdicts.has(id));
  const extra = [...arm.verdicts.keys()].filter((id) => !control.verdicts.has(id));
  if (missing.length > 0 || extra.length > 0) {
    const describe = (list) => `${list.length} (${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''})`;
    throw new Error(
      `${label} and the control are not the same roster: the control has ${describe(missing)} id(s) the arm ` +
        `lacks and the arm has ${describe(extra)} the control lacks. A cross-run pair needs one question ` +
        'set on both sides, or the diff is partly a diff of the dataset',
    );
  }
  const bought = [];
  const sold = [];
  for (const id of ids) {
    const before = control.verdicts.get(id);
    const after = arm.verdicts.get(id);
    if (!before && after) bought.push(id);
    else if (before && !after) sold.push(id);
  }
  const ledger = ledgerOf(label, {
    discordantQuestions: { baselineIncorrectFeatureCorrect: bought, baselineCorrectFeatureIncorrect: sold },
  });
  return { ledger, generatedAt: arm.generatedAt, split: splitOf(ids, control, arm, bought, sold) };
}

/**
 * The same ledger, cut by whether the treatment actually reached the question.
 *
 * `promptChars` is the arm's own statement of how many characters the prompt it rendered contained, so two
 * runs that disagree on it disagree on the treatment and two that agree did not. That gives every cross-run
 * pair a **noise realisation it measures on itself**: the questions the treatment did not reach are the
 * questions on which the pair's net change is pure reader and judge variation, at the same temperature, on
 * the same configuration, over the same roster. Section 13.135 records what that bought the first time it
 * was computed -- 466 untouched questions moved 20 up and 13 down, net +7, while the 34 questions the ask
 * reached moved 2 and 0.
 *
 * A pair is only splittable when both sides carry the field for every question. `null` means "this report
 * cannot say", and a question in that state is counted rather than assumed untouched -- the same rule the
 * `threshold` and `sessionBudget` fields are read under.
 */
function splitOf(ids, control, arm, bought, sold) {
  const buckets = {
    treated: { questions: 0, bought: 0, sold: 0 },
    untouched: { questions: 0, bought: 0, sold: 0 },
    unknown: { questions: 0, bought: 0, sold: 0 },
  };
  for (const id of ids) {
    const before = control.promptChars.get(id);
    const after = arm.promptChars.get(id);
    const bucket =
      before === null || after === null ? 'unknown' : before === after ? 'untouched' : 'treated';
    buckets[bucket].questions += 1;
    if (bought.includes(id)) buckets[bucket].bought += 1;
    if (sold.includes(id)) buckets[bucket].sold += 1;
  }
  return {
    ...buckets,
    /** True when every question could be classified, which is the precondition for reading the split. */
    complete: buckets.unknown.questions === 0,
  };
}

const acrossMode = controlPaths.length === 1;
const control = acrossMode ? verdictsOf(controlPaths[0]) : null;
const readings = acrossMode
  ? acrossArgs.map((arg) => {
      const [label, file] = splitLabel(arg);
      return acrossIncrement(label, file, control);
    })
  : args.map((arg) => {
      const [label, file] = splitLabel(arg);
      return { ledger: ledgerOf(label, resultOf(file)), generatedAt: 'within-run' };
    });

const increments = readings.map((reading) => reading.ledger);

const portfolio = portfolioOf(increments);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: acrossMode ? 'across' : 'within-run',
        ...(acrossMode
          ? { control: { path: controlPaths[0], generatedAt: control.generatedAt } }
          : {}),
        increments,
        portfolio,
        // Present only when there is a control to compare prompts against, because attribution is a property
        // of a pair and not of a run.
        ...(acrossMode
          ? { reach: readings.map((reading) => ({ label: reading.ledger.label, ...reading.split })) }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const lines = [];
lines.push('', 'Increment ledgers', '');
if (acrossMode) {
  // The control's identity is printed before the arithmetic, because the arithmetic is only as good as the
  // claim that every arm above was measured against this one run.
  lines.push(
    `- control: ${controlPaths[0]} generatedAt=${control.generatedAt} roster=${control.verdicts.size}`,
  );
  lines.push('');
}
for (const reading of readings) {
  const increment = reading.ledger;
  const origin = acrossMode ? ' (from across)' : '';
  lines.push(
    `- ${increment.label}${origin}: bought ${increment.bought.length}, sold ${increment.sold.length}, ` +
      `net ${increment.bought.length - increment.sold.length}`,
  );
  if (increment.bought.length > 0) lines.push(`    bought: ${increment.bought.join(', ')}`);
  if (increment.sold.length > 0) lines.push(`    sold:   ${increment.sold.join(', ')}`);
  if (reading.split) lines.push(...splitLines(reading.split));
}

/**
 * The reach split, rendered as a reading rather than a footnote.
 *
 * The untouched bucket is printed first among the two because it is the one that costs nothing to obtain and
 * is the one a net change has to beat: it is the same pair of runs, the same configuration, the same roster
 * and the same temperature on questions whose prompts are byte-identical, so whatever it moved is the amount
 * this pair moves by itself. The excess is stated as arithmetic -- the treated bucket's net minus what the
 * untouched bucket's own bought and sold rates predict for that many questions -- and never as a p-value,
 * because 34 questions do not support one.
 */
function splitLines(split) {
  const out = [];
  const net = (bucket) => bucket.bought - bucket.sold;
  for (const [name, bucket] of [
    ['treated  (promptChars differ)   ', split.treated],
    ['untouched (promptChars identical)', split.untouched],
  ]) {
    out.push(
      `    ${name}: ${bucket.questions} questions, bought ${bucket.bought}, sold ${bucket.sold}, ` +
        `net ${net(bucket) >= 0 ? '+' : ''}${net(bucket)}`,
    );
  }
  if (!split.complete) {
    out.push(
      `    ${split.unknown.questions} question(s) carry no promptChars on at least one side, so the split ` +
        'above is over the rest and not over the roster',
    );
  }
  if (split.untouched.questions === 0) {
    out.push('    no untouched question to price the noise against: this pair says nothing about attribution');
    return out;
  }
  const rate = net(split.untouched) / split.untouched.questions;
  const expected = rate * split.treated.questions;
  const excess = net(split.treated) - expected;
  out.push(
    `      the untouched bucket is this pair's own noise realisation, at ${(100 * rate).toFixed(2)}% net per ` +
      `question, so ${split.treated.questions} treated questions would move ${expected >= 0 ? '+' : ''}` +
      `${expected.toFixed(1)} by themselves; the treatment's excess is ${excess >= 0 ? '+' : ''}` +
      `${excess.toFixed(1)} question(s)`,
  );
  if (excess <= 0) {
    out.push(
      '      ATTRIBUTION FAILS: the treated questions moved no more than untouched ones, so this net is not ' +
        'evidence about the treatment whatever its sign',
    );
  }
  return out;
}

lines.push('', 'Portfolio', '');
lines.push(`- Distinct questions bought: ${portfolio.bought.length}`);
lines.push(`- Sum of the per-increment purchases: ${portfolio.summedBought}`);
lines.push(
  `- Double-counted by the sum: ${portfolio.summedBought - portfolio.bought.length}` +
    (portfolio.doubleCounted.length > 0 ? ` (${portfolio.doubleCounted.join(', ')})` : ''),
);
lines.push(`- Distinct questions sold: ${portfolio.sold.length}`);
lines.push(`- Sum of the per-increment losses: ${portfolio.summedSold}`);

if (portfolio.conflicting.length > 0) {
  lines.push(
    '',
    `- CONFLICT: ${portfolio.conflicting.join(', ')} — bought by one increment and sold by another, so a ` +
      'sum of nets cancels them to nothing and the pair should not ship together without a decision.',
  );
}

/** What the union means depends on the mode, so the closing sentence is written by the mode. */
const bounds = acrossMode
  ? '- Every arm above was measured against the one control named on the first line, so these purchases are ' +
    'comparable by construction and the union is the ceiling under perfect additivity. It is still a ' +
    'ceiling and not a score: two treatments applied together can interact.'
  : '- Each increment was measured against its OWN artifact\'s reference arm, not against a shared control, ' +
    'so this union answers "do the two runs beat the same third party on the same questions" and not "may ' +
    'these two treatments be added". Use --control with --across for the latter.';

lines.push(
  '',
  portfolio.summedBought === portfolio.bought.length
    ? `${bounds} The gains are disjoint, so the sum equals the union.`
    : `${bounds} The gains overlap, so the sum overstates the pair by ` +
        `${portfolio.summedBought - portfolio.bought.length} question(s).`,
  '',
);

process.stdout.write(`${lines.join('\n')}\n`);

#!/usr/bin/env node
/**
 * What changed between a control artifact and a treatment artifact, delivery by delivery.
 *
 *     node tools/window-pair.mjs --control control/report.json --treated run/report.json \
 *                                [--wired wired.json] [--json]
 *
 * ## Why five of §13.153.5's six criteria need the pair and not one run
 *
 * The criteria are statements about what *changed*, and a single artifact cannot say what changed. Three of
 * them are the same comparison on different partitions of the roster:
 *
 * | criterion | the comparison |
 * | --- | --- |
 * | 2, the delivered multiset is unchanged per question | multiset of the delivered turns, per question |
 * | 3, the mechanism is administered on the temporal route and nowhere else | which capability the changed questions belong to |
 * | 6, nothing outside the administered set moves beyond the reader floor | verdict flips among the untouched |
 *
 * Reporting the diff once and partitioning it three ways is what keeps them from disagreeing: a tool that
 * answered them separately would eventually answer them inconsistently, and the reader would have no way to
 * tell which number was the wrong one.
 *
 * ## A multiset difference is not a result, it is a comparability failure
 *
 * The two artifacts come from two commits. If a pool moved between them -- a retrieval change, a budget
 * change, a parser change -- then a difference in delivery order no longer means the mechanism ran, and the
 * reading "the reorder changed forty questions" is the one that looks like a finding. So the verdict line
 * says `not comparable` and criterion 2 fails, rather than printing an order count that a reader would
 * attribute to the mechanism.
 *
 * ## The prompt reading, and why it was added after the criteria
 *
 * "Nothing outside the administered set moved" is a claim about **prompts**, and this tool's evidence for it
 * was the delivered turns: a route whose turns did not reorder was treated as a route whose prompt did not
 * move. That is true for the mechanism this file was written for and false in general -- an instruction-block
 * ask changes no turn at all, so every one of its questions reads as untouched and the criterion becomes
 * vacuous exactly where it is most needed.
 *
 * `promptDigest` (§13.171) is the field that answers the question directly, and until now no tool read it.
 * It is reported as three states, because an artifact written before the field existed has no digest and
 * "no measurement" must not render as "equal" -- the archived runs are precisely where a cross-run prompt
 * comparison is most tempting.
 *
 * The line `length is not identity` is the reason the digest is worth a section. Every reach table in this
 * campaign was asserted against `promptChars`, and a swapped instruction line of the same length is invisible
 * to it. When that count is non-zero, a comparison somebody called "byte-identical" was a comparison of
 * lengths.
 *
 * ## Two words that mean different things in the two tools
 *
 * `window-wired.mjs` reports `converted` for the questions it moves that the control answers **wrong** --
 * its population, not an outcome. This tool reports `converted` for the ones the treatment answers **right**
 * among that population. Both numbers are in every reading and they are the same number 7 only by
 * coincidence on the control artifact, which is exactly the kind of coincidence that gets quoted as
 * progress. The detail line therefore prints `converted X of Y reachable-and-wrong`, never a bare fraction.
 *
 * ## What it does not read
 *
 * Criterion 1 (the parse resolves every delivered turn) is a product property measured on the control
 * artifact by `window-wired.mjs` and it does not depend on the treatment, so this tool prints it as not
 * read rather than re-deriving a number from a different input.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

/** The share of untouched questions whose verdict may flip before the floor is considered breached. */
const READER_FLOOR = 0.05;

const USAGE = `window-pair — the delivered diff between a control artifact and a treatment artifact

usage:
  node tools/window-pair.mjs --control <report.json> --treated <report.json> [--wired <json>] [--json]

  --control  the registered control artifact for this arm
  --treated  the run whose delivery is being read
  --wired    optional: the JSON summary from window-wired --json, to cross-check the moved set and to read
             criteria 4 and 5, whose populations are the questions that tool identifies

prints, per capability and in total: questions, multiset changes, order changes, untouched flips, the
prompt identity (digest-equal / digest-differs / unmeasured, with the count of pairs whose prompts changed
bytes at the same length), and then one line per criterion with its denominator. Exit 0 when every criterion it can read is met, 1 when one is
not, 2 when the pair cannot be compared at all.
`;

function fail(message) {
  process.stderr.write(`window-pair: ${message}\n`);
  process.exit(2);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read the ${label} artifact (${path}): ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === '--control' || arg === '--treated' || arg === '--wired') {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} needs a path`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`unrecognised argument ${arg}; see --help`);
  }
  if (options.control === undefined || options.treated === undefined) {
    fail('both --control and --treated are required; see --help');
  }
  return options;
}

/** The delivered turns of one record, in order. */
function delivered(record) {
  return (record.turns ?? []).map((turn) => String(turn.text ?? ''));
}

/**
 * Every question on both sides, joined by id.
 *
 * An inner join is refused by name rather than performed: the difference between "this question did not
 * move" and "this question is not in that artifact" is the difference between a denominator of 500 and one
 * of 495, and the second number is printed nowhere.
 */
function join(control, treated) {
  const left = new Map(control.map((record) => [record.questionId, record]));
  const right = new Map(treated.map((record) => [record.questionId, record]));
  const missingRight = [...left.keys()].filter((id) => !right.has(id)).sort();
  const missingLeft = [...right.keys()].filter((id) => !left.has(id)).sort();
  if (missingRight.length > 0 || missingLeft.length > 0) {
    fail(
      `the artifacts do not hold the same questions.\n  in the control only: ${missingRight.slice(0, 10).join(', ') || '-'}\n  in the treated only: ${missingLeft.slice(0, 10).join(', ') || '-'}`,
    );
  }
  return [...left.keys()]
    .sort()
    .map((id) => ({ id, control: left.get(id), treated: right.get(id) }));
}

/**
 * Whether the two runs sent the same prompt, read from the digest and never from the length.
 *
 * ## Why this is three states and not a boolean
 *
 * `promptChars` was the campaign's proxy for "did the prompt move" for a dozen rounds, and it cannot answer
 * the question: a run that swaps one instruction line for another of the same length reports an unchanged
 * prompt under it, which is the shape every reach table is asserted in. §13.171 added `promptDigest` for
 * exactly this and no tool read it -- `promptCharsEqual` was computed here and printed nowhere, which is an
 * instrument that measures a fact and reports none.
 *
 * The third state is not tidiness. An artifact written before the field existed has no digest, and folding
 * "no digest" into "equal" would report an identity nobody checked -- on the archived runs, which are
 * precisely where a cross-run prompt comparison is most tempting.
 *
 * ## Why the length is kept beside it
 *
 * Because the interesting case is a pair that agrees on length and differs on bytes: that is a change no
 * previous reading of this campaign could see, and printing its count is how the next reader learns that the
 * old proxy was blind rather than merely coarse.
 */
function promptIdentity(control, treated) {
  const left = control.promptDigest;
  const right = treated.promptDigest;
  const measured =
    typeof left === 'string' && left !== '' && typeof right === 'string' && right !== '';
  const lengthEqual =
    typeof control.promptChars === 'number' && typeof treated.promptChars === 'number'
      ? control.promptChars === treated.promptChars
      : undefined;
  return {
    state: measured ? (left === right ? 'digest-equal' : 'digest-differs') : 'unmeasured',
    lengthEqual,
  };
}

/** One row per question: what the delivery did, what the prompt did, and what the verdict did. */
function compare(row) {
  const before = delivered(row.control);
  const after = delivered(row.treated);
  const sortJoin = (turns) => [...turns].sort().join('\u0000');
  const identity = promptIdentity(row.control, row.treated);
  return {
    id: row.id,
    capability: row.treated.capability ?? row.control.capability ?? 'unknown',
    multisetChanged: sortJoin(before) !== sortJoin(after),
    orderChanged: before.join('\u0000') !== after.join('\u0000'),
    controlCorrect: row.control.correct === true,
    treatedCorrect: row.treated.correct === true,
    promptIdentity: identity.state,
    // Kept as a reading in its own right -- and printed only where it disagrees with the digest, because a
    // length that agrees with identity tells a reader nothing they do not already have.
    promptCharsEqual: identity.lengthEqual,
  };
}

function tally(rows) {
  const byCapability = new Map();
  for (const row of rows) {
    const entry = byCapability.get(row.capability) ?? {
      capability: row.capability,
      questions: 0,
      multisetChanged: 0,
      orderChanged: 0,
      untouchedFlips: 0,
      untouched: 0,
      promptEqual: 0,
      promptMoved: 0,
      promptUnmeasured: 0,
    };
    entry.questions += 1;
    if (row.multisetChanged) entry.multisetChanged += 1;
    if (row.orderChanged) entry.orderChanged += 1;
    if (row.promptIdentity === 'digest-equal') entry.promptEqual += 1;
    else if (row.promptIdentity === 'digest-differs') entry.promptMoved += 1;
    else entry.promptUnmeasured += 1;
    if (!row.multisetChanged && !row.orderChanged) {
      entry.untouched += 1;
      if (row.controlCorrect !== row.treatedCorrect) entry.untouchedFlips += 1;
    }
    byCapability.set(row.capability, entry);
  }
  return [...byCapability.values()].sort((left, right) =>
    left.capability < right.capability ? -1 : left.capability > right.capability ? 1 : 0,
  );
}

function pct(part, whole) {
  return whole === 0 ? '0.0%' : `${((100 * part) / whole).toFixed(1)}%`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const control = readJson(options.control, 'control');
  const treated = readJson(options.treated, 'treated');
  const wires = options.wired === undefined ? undefined : readJson(options.wired, 'wired');

  const rows = join(control.questions ?? [], treated.questions ?? []).map(compare);
  const totals = tally(rows);
  const multisetChanged = rows.filter((row) => row.multisetChanged);
  const orderChanged = rows.filter((row) => row.orderChanged);
  const untouched = rows.filter((row) => !row.multisetChanged && !row.orderChanged);
  const untouchedFlips = untouched.filter((row) => row.controlCorrect !== row.treatedCorrect);

  // The prompt reading, and the one number in it that no previous instrument in this campaign could produce:
  // a pair whose prompts have the same length and different bytes.
  const promptEqual = rows.filter((row) => row.promptIdentity === 'digest-equal');
  const promptMoved = rows.filter((row) => row.promptIdentity === 'digest-differs');
  const promptUnmeasured = rows.filter((row) => row.promptIdentity === 'unmeasured');
  const lengthBlind = promptMoved.filter((row) => row.promptCharsEqual === true);

  // Criterion 3 is about the route the mechanism reached, so the offenders are the changed questions on any
  // capability other than the temporal one -- and a multiset change on an untouched route is the same
  // defect seen in the other direction.
  const routeOffenders = [
    ...multisetChanged,
    ...orderChanged.filter((row) => !row.multisetChanged),
  ].filter((row) => row.capability !== 'TR');

  const comparable = multisetChanged.length === 0;
  const comparisons = {
    2: {
      met: comparable,
      detail: comparable
        ? `the delivered multiset is unchanged on all ${rows.length} questions`
        : `${multisetChanged.length} question(s) changed what they contain, so the pair is not comparable and no order reading is attributable: ${multisetChanged
            .slice(0, 10)
            .map((row) => row.id)
            .join(', ')}`,
    },
    3: {
      met: routeOffenders.length === 0,
      detail:
        routeOffenders.length === 0
          ? `every changed delivery is on the temporal route (${orderChanged.length} of them)`
          : `${routeOffenders.length} question(s) outside the temporal route changed: ${routeOffenders
              .slice(0, 10)
              .map((row) => `${row.id} (${row.capability})`)
              .join(', ')}`,
    },
    6: {
      met: comparable && untouchedFlips.length / Math.max(1, untouched.length) <= READER_FLOOR,
      detail: comparable
        ? `untouched flips: ${untouchedFlips.length} of ${untouched.length} (${pct(untouchedFlips.length, untouched.length)}) against a ${(100 * READER_FLOOR).toFixed(1)}% floor`
        : 'not readable while criterion 2 fails',
    },
  };

  // Criteria 4 and 5 are read over the population the replay identified, because "moved" is a property of
  // the product on a question and not a property of the pair: a question can be reordered by the mechanism
  // and come back in the same order if the window's turns were already leading.
  let wiredCross;
  if (wires !== undefined) {
    const wiredMoved = (wires.moved ?? []).map((entry) => ({
      id: entry.id,
      correct: entry.correct === true,
    }));
    const wiredIds = new Set(wiredMoved.map((entry) => entry.id));
    const pairIds = new Set(orderChanged.map((row) => row.id));
    const wiredOnly = [...wiredIds].filter((id) => !pairIds.has(id)).sort();
    const pairOnly = [...pairIds].filter((id) => !wiredIds.has(id)).sort();
    const reachableWrong = wiredMoved.filter((entry) => !entry.correct);
    const reachableRight = wiredMoved.filter((entry) => entry.correct);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const converted = reachableWrong.filter((entry) => byId.get(entry.id)?.treatedCorrect === true);
    const sold = reachableRight.filter((entry) => byId.get(entry.id)?.treatedCorrect === false);
    comparisons['4'] = {
      met: converted.length >= 4,
      detail:
        `converted ${converted.length} of ${reachableWrong.length} reachable-and-wrong (bar 4)` +
        // The registered population is 7, and it is a property of the product on the control artifact. A
        // different number here means the replay was run against something else, so the bar is being applied
        // to a population it was not written for -- said out loud rather than absorbed into the fraction.
        (reachableWrong.length === 7 ? '' : ' -- note: the registered population is 7'),
    };
    comparisons['5'] = {
      met: sold.length <= 1,
      detail: `sold ${sold.length} of ${reachableRight.length} the control gets right (bar 1)`,
    };
    wiredCross = { wiredOnly, pairOnly };
  }

  const verdicts = Object.entries(comparisons).sort(
    (left, right) => Number(left[0]) - Number(right[0]),
  );
  const failed = verdicts.filter(([, value]) => !value.met).map(([key]) => key);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          control: options.control,
          treated: options.treated,
          questions: rows.length,
          multisetChanged: multisetChanged.map((row) => row.id),
          orderChanged: orderChanged.map((row) => row.id),
          untouchedFlips: untouchedFlips.map((row) => row.id),
          promptIdentity: {
            digestEqual: promptEqual.map((row) => row.id),
            digestDiffers: promptMoved.map((row) => row.id),
            unmeasured: promptUnmeasured.map((row) => row.id),
            lengthIsNotIdentity: lengthBlind.map((row) => row.id),
          },
          byCapability: totals,
          comparisons,
          wiredCross,
          comparable,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(failed.length === 0 ? 0 : 1);
  }

  const lines = [
    'the delivered pair, read question by question',
    `control: ${options.control}`,
    `treated: ${options.treated}`,
    '',
    `${'capability'.padEnd(11)}${'questions'.padStart(10)}${'multiset'.padStart(10)}${'order'.padStart(8)}${'flips'.padStart(8)}`,
  ];
  for (const entry of totals) {
    lines.push(
      `${entry.capability.padEnd(11)}${String(entry.questions).padStart(10)}${String(entry.multisetChanged).padStart(10)}${String(entry.orderChanged).padStart(8)}${String(entry.untouchedFlips).padStart(8)}`,
    );
  }
  lines.push(
    `${'total'.padEnd(11)}${String(rows.length).padStart(10)}${String(multisetChanged.length).padStart(10)}${String(orderChanged.length).padStart(8)}${String(untouchedFlips.length).padStart(8)}`,
    '',
    `multiset changes: ${multisetChanged.length}`,
    `order changes: ${orderChanged.length}`,
    `untouched flips: ${untouchedFlips.length} of ${untouched.length}`,
    `prompt identity: ${promptEqual.length} digest-equal, ${promptMoved.length} digest-differs, ${promptUnmeasured.length} unmeasured`,
  );
  for (const entry of totals) {
    lines.push(
      `  ${entry.capability.padEnd(9)}${String(entry.promptEqual).padStart(6)}/${String(entry.questions).padEnd(6)} digest-equal`,
    );
  }
  if (lengthBlind.length > 0) {
    lines.push(
      `length is not identity: ${lengthBlind.length} question(s) changed bytes at the same length: ${lengthBlind
        .slice(0, 10)
        .map((row) => `${row.id} (${row.capability})`)
        .join(', ')}`,
    );
  }
  if (promptUnmeasured.length > 0) {
    lines.push(
      `prompt identity is unmeasured on ${promptUnmeasured.length} question(s) -- no digest on at least one side, which is a missing field and not a match`,
    );
  }
  lines.push(
    '',
    'criterion 1: not read here (a product property, measured by window-wired on the control artifact)',
  );
  for (const [key, value] of verdicts) {
    lines.push(`criterion ${key}: ${value.met ? 'met' : 'FAILED'} -- ${value.detail}`);
  }
  if (wiredCross !== undefined) {
    lines.push(
      '',
      'cross-check against the replay',
      `  wired only: ${wiredCross.wiredOnly.join(', ') || '-'}`,
      `  pair only: ${wiredCross.pairOnly.join(', ') || '-'}`,
    );
  }
  lines.push(
    '',
    failed.length === 0
      ? 'verdict: every criterion read here is met'
      : `verdict: criterion ${failed.join(', ')} failed`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();

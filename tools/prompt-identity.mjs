#!/usr/bin/env node
/**
 * Did the two dispatches send the same prompt?
 *
 * ## The gate this replaces a reading of
 *
 * `docs/MEASURE-TURN-WIDTH.md` registered the width axis with one clause that was not about accuracy:
 * *the four routes the cap cannot reach must reproduce their prompts byte for byte.* Run `45340177345`
 * failed it, and the failure was established by reading two artifacts by hand: 252 questions on the
 * unreached routes, **32** with a different prompt digest, **6** of those with a different delivered set.
 * Reading 500 records by hand is not an instrument. This file is, and it prints the same three numbers
 * from the same two files.
 *
 * ## Why identity is a digest and not a length
 *
 * `promptChars` is the evidence characters and `deliveredPromptChars` is the whole prompt, so a pair of
 * lengths separates "the evidence moved" from "the overhead around it moved" -- and that split is the
 * interesting one, because the overhead is instructions and a header and nothing else, so when it moves
 * by a constant on questions whose evidence is unchanged the explanation is a code difference rather than
 * a retrieval difference. But a length cannot separate *the same prompt* from *a prompt that changed
 * inside its budget*, which is exactly the question. `promptDigest` is a 64-bit hash of the text, so
 * equality of digests is equality of prompts, and the four verdicts below are ordered by what they can
 * prove rather than by what is convenient:
 *
 * | verdict | evidence chars | overhead chars | digest | what it means |
 * | --- | --- | --- | --- | --- |
 * | `identical` | equal | equal | equal | the same prompt, as far as 64 bits can say |
 * | `overhead` | equal | **differ** | differ | the evidence is the same and the frame around it is not |
 * | `evidence` | **differ** | any | differ | the delivered set, order or width changed |
 * | `unattributed` | equal | equal | **differ** | same lengths, different bytes: a same-length edit |
 * | `unmeasured` | any | any | one side missing | nothing can be said, and it is not a pass |
 *
 * `unmeasured` is a verdict rather than a skip for the reason `unrun` is a status rather than a pass in
 * `docs/ACCEPTANCE-MATRIX.md`: an artifact that dropped the digest tallies as a failure to compare, and a
 * gate that silently counted those as equal would pass on the next artifact that stopped recording.
 *
 * ## Why the partition is by cap reachability
 *
 * A cap that cannot reach a route has no business changing that route's prompt, so on those questions any
 * difference is a confound. On the routes the cap reaches, a difference is the treatment. Splitting the
 * population is therefore not a convenience: it is the only split on which "no difference" is a claim
 * about the instrument rather than a claim about the mechanism. The tool takes the reachable list as an
 * argument defaulting to what the registration names, so a dispatch at a different width can be read with
 * the same two files.
 *
 * ## The precondition it prints first
 *
 * A pair's identity number is only about *one repetition of each run* -- each record carries the digest of
 * the first repetition, and the count of distinct prompts the question cost within its own run is
 * `promptVariants`. On run `45340177345` that count is **2 on eighteen questions**, so on those the four
 * passes were not four repetitions, and a between-run difference there cannot be attributed to the
 * config. The tool prints that census before the pair table, the way `turn-width.mjs` prints its replay
 * fidelity before its sweep: a number whose precondition is unstated is the defect this repository has
 * twice paid for.
 *
 * ## Usage
 *
 *     node tools/prompt-identity.mjs <a.json> <b.json> [--reachable multi-session,temporal] [--json]
 *     node tools/prompt-identity.mjs --self-test
 */

import { readFileSync } from 'node:fs';

/** The routes a per-turn cap reaches under the registered arm. Overridable, because a dispatch may differ. */
export const CAP_REACHABLE_ROUTES = Object.freeze(['multi-session', 'temporal']);

const verdictOf = (a, b) => {
  if (a === undefined || b === undefined) return 'unmeasured';
  if (a.promptDigest === undefined || b.promptDigest === undefined) return 'unmeasured';
  if (a.promptDigest === b.promptDigest) return 'identical';
  const evidenceMoved = a.promptChars !== b.promptChars;
  if (evidenceMoved) return 'evidence';
  const overhead = (record) => (record.deliveredPromptChars ?? 0) - (record.promptChars ?? 0);
  return overhead(a) === overhead(b) ? 'unattributed' : 'overhead';
};

const tally = () => ({ identical: 0, overhead: 0, evidence: 0, unattributed: 0, unmeasured: 0 });

/**
 * Compare two archived reports, question by question.
 *
 * Pairing is by `questionId` and never by position: a capability-scoped dispatch carries a different
 * roster, and two files that were read positionally would compare question 3 of `MR` against question 3
 * of `IE` and call the difference a treatment.
 */
export function identity(reportA, reportB, options = {}) {
  const reachable = options.reachable ?? CAP_REACHABLE_ROUTES;
  const reachableSet = new Set(reachable);
  const index = (report) => new Map((report.questions ?? []).map((record) => [record.questionId, record]));
  const a = index(reportA);
  const b = index(reportB);

  const partitions = { reachable: tally(), unreachable: tally() };
  const pairs = [];
  const overheadDeltas = new Map();
  const ids = new Set([...a.keys(), ...b.keys()]);
  for (const id of ids) {
    const left = a.get(id);
    const right = b.get(id);
    const record = left ?? right;
    const route = record.route;
    const partition = reachableSet.has(route) ? 'reachable' : 'unreachable';
    const verdict = verdictOf(left, right);
    partitions[partition][verdict] += 1;
    const pair = {
      questionId: id,
      route,
      capability: record.capability,
      verdict,
      evidenceChars: [left?.promptChars, right?.promptChars],
      deliveredChars: [left?.deliveredPromptChars, right?.deliveredPromptChars],
    };
    pairs.push(pair);
    if (verdict === 'overhead' || verdict === 'unattributed') {
      const delta =
        (right?.deliveredPromptChars ?? 0) -
        (right?.promptChars ?? 0) -
        ((left?.deliveredPromptChars ?? 0) - (left?.promptChars ?? 0));
      overheadDeltas.set(delta, (overheadDeltas.get(delta) ?? 0) + 1);
    }
  }

  const variants = (report) => {
    const counts = new Map();
    let multi = 0;
    for (const record of report.questions ?? []) {
      const value = record.promptVariants;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (typeof value === 'number' && value > 1) multi += 1;
    }
    return { counts, multi };
  };

  const unreachable = partitions.unreachable;
  const measured = unreachable.identical + unreachable.overhead + unreachable.evidence + unreachable.unattributed;
  // Two gates, because the registration and the reading of it are not the same sentence and the
  // difference is 26 questions on run `45340177345`.
  //
  // `docs/PREREGISTRATION-TURN-WIDTH.md` §4 writes the internal control as *on `IE`, `KU`, `ABS` and
  // `assistant`, `promptChars` is identical between the two sides on every question* -- the **evidence
  // characters**. `promptChars` cannot see the frame around the evidence, so a dispatch whose evidence
  // reproduced and whose instruction block grew by a constant passes the clause as written and fails the
  // clause as anyone would read it. Both are printed: the registered one is the contract this dispatch
  // was bound by, and the strict one is the property every later comparison needs. Collapsing them into
  // one verdict would either void a dispatch that met its own contract or hide 26 questions that did not
  // reproduce.
  const shared = [];
  if (measured === 0) shared.push('no question on an unreached route was comparable');
  if (unreachable.evidence > 0) shared.push(`${unreachable.evidence} unreached prompt(s) moved in the evidence`);
  if (unreachable.unmeasured > 0) shared.push(`${unreachable.unmeasured} unreached question(s) are unmeasured`);
  const strictOnly = [];
  if (unreachable.overhead > 0) strictOnly.push(`${unreachable.overhead} unreached prompt(s) moved in the frame`);
  if (unreachable.unattributed > 0) strictOnly.push(`${unreachable.unattributed} unreached prompt(s) differ at equal length`);

  return {
    partitions,
    pairs,
    overheadDeltas: [...overheadDeltas.entries()].sort((left, right) => left[0] - right[0]),
    variants: { a: variants(reportA), b: variants(reportB) },
    gates: {
      registered: { pass: shared.length === 0, reasons: shared },
      strict: { pass: shared.length === 0 && strictOnly.length === 0, reasons: [...shared, ...strictOnly] },
    },
    // Kept as the strict reading, because a caller that asked "did the pair reproduce" means the prompt.
    gate: { pass: shared.length === 0 && strictOnly.length === 0, reasons: [...shared, ...strictOnly] },
  };
}

const ROW = ['identical', 'overhead', 'evidence', 'unattributed', 'unmeasured'];

/** The table, then the frame deltas, then the gate. Nothing is rounded into a verdict. */
export function renderIdentity(reading) {
  const lines = [];
  const header =
    'partition'.padEnd(12) + ROW.map((name) => name.padStart(12)).join('') + 'total'.padStart(9);
  lines.push(header);
  for (const partition of ['reachable', 'unreachable']) {
    const row = reading.partitions[partition];
    const total = ROW.reduce((sum, name) => sum + row[name], 0);
    lines.push(
      partition.padEnd(12) + ROW.map((name) => String(row[name]).padStart(12)).join('') + String(total).padStart(9),
    );
  }
  if (reading.overheadDeltas.length > 0) {
    lines.push('');
    lines.push('frame delta (delivered - evidence, right minus left):');
    for (const [delta, count] of reading.overheadDeltas) {
      lines.push(`  ${String(delta).padStart(6)} chars  ${String(count).padStart(4)} question(s)`);
    }
  }
  for (const side of ['a', 'b']) {
    const { counts, multi } = reading.variants[side];
    const rendered = [...counts.entries()]
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .map(([value, count]) => `${value}:${count}`)
      .join(' ');
    lines.push('');
    lines.push(
      `within-run promptVariants ${side}: ${rendered || 'none'}  (` +
        `${multi} question(s) sent more than one prompt inside one run)`,
    );
  }
  lines.push('');
  lines.push(
    reading.gates.registered.pass
      ? 'GATE (registered: evidence characters) PASS'
      : `GATE (registered: evidence characters) FAIL: ${reading.gates.registered.reasons.join('; ')}`,
  );
  lines.push(
    reading.gates.strict.pass
      ? 'GATE (strict: prompt digests) PASS'
      : `GATE (strict: prompt digests) FAIL: ${reading.gates.strict.reasons.join('; ')}`,
  );
  return lines.join('\n');
}

function selfTest() {
  let checks = 0;
  const assert = (condition, message) => {
    checks += 1;
    if (!condition) throw new Error(`self-test: ${message}`);
  };
  const record = (id, route, digest, evidence, delivered, variants = 1) => ({
    questionId: id,
    route,
    capability: 'MR',
    promptDigest: digest,
    promptChars: evidence,
    deliveredPromptChars: delivered,
    promptVariants: variants,
  });
  const report = (records) => ({ questions: records });

  // A pair that agrees on an unreached route and moves on a reached one: the gate's clean case, and the
  // partition has to keep the two apart or the movement on the treatment would fail the instrument.
  const clean = identity(
    report([record('u1', 'knowledge-update', 'aaa', 1000, 1200), record('r1', 'multi-session', 'bbb', 2000, 3000)]),
    report([record('u1', 'knowledge-update', 'aaa', 1000, 1200), record('r1', 'multi-session', 'ccc', 2400, 3400)]),
  );
  assert(clean.partitions.unreachable.identical === 1, 'an unreached match is identical');
  assert(clean.partitions.reachable.evidence === 1, 'a reached prompt that moved is evidence');
  assert(clean.gate.pass, 'movement the cap can reach does not fail the instrument');

  // The frame moved and the evidence did not: the 26-question signature, and the delta is what names it.
  const frame = identity(
    report([record('u1', 'assistant', 'aaa', 1000, 1200)]),
    report([record('u1', 'assistant', 'bbb', 1000, 1325)]),
  );
  assert(frame.partitions.unreachable.overhead === 1, 'equal evidence with a longer frame is overhead');
  assert(frame.overheadDeltas[0][0] === 125 && frame.overheadDeltas[0][1] === 1, 'the delta is reported');
  assert(!frame.gate.pass, 'a frame that moved on an unreached route fails the gate');
  // The two gates disagree here on purpose: this is the shape of 26 questions of `45340177345`, where the
  // registered clause was about `promptChars` and the property every later pair needs is about the prompt.
  assert(frame.gates.registered.pass, 'the registered clause reads evidence characters and is met');
  assert(!frame.gates.strict.pass, 'the strict clause reads the prompt and is not');

  // Same length, different bytes: the cell a length comparison cannot see at all.
  const quiet = identity(
    report([record('u1', 'flat', 'aaa', 1000, 1200)]),
    report([record('u1', 'flat', 'bbb', 1000, 1200)]),
  );
  assert(quiet.partitions.unreachable.unattributed === 1, 'equal lengths and unequal digests are unattributed');
  assert(!quiet.gate.pass, 'an unattributable difference fails the gate');

  // A missing digest is unmeasured, never identical.
  const blind = identity(
    report([record('u1', 'abstention', undefined, 1000, 1200)]),
    report([record('u1', 'abstention', 'bbb', 1000, 1200)]),
  );
  assert(blind.partitions.unreachable.unmeasured === 1, 'a missing digest is unmeasured');
  assert(!blind.gate.pass, 'unmeasured is not a pass');

  // A question that exists on one side only is unmeasured in its own partition rather than dropped.
  const half = identity(report([record('u1', 'temporal', 'aaa', 10, 20)]), report([]));
  assert(half.partitions.reachable.unmeasured === 1, 'a one-sided question is unmeasured');
  assert(half.pairs.length === 1, 'a one-sided question is still a pair');

  // Pairing is by id: two rosters ordered differently must compare the same records.
  const left = identity(
    report([record('u1', 'flat', 'aaa', 1, 2), record('u2', 'flat', 'bbb', 3, 4)]),
    report([record('u2', 'flat', 'bbb', 3, 4), record('u1', 'flat', 'aaa', 1, 2)]),
  );
  assert(left.partitions.unreachable.identical === 2, 'pairing ignores order');
  assert(left.gate.pass, 'a reordered roster of equal prompts passes');

  // An empty pair is not a pass: "nothing differed" and "nothing was compared" are different claims.
  assert(!identity(report([]), report([])).gate.pass, 'an empty comparison cannot pass');

  // The reachable list is an argument, so a dispatch at a different width can be read with the same files.
  //
  // The same pair reads three ways, and the three readings are the argument for making it an argument:
  // under the default registration a `temporal` difference is the treatment and is filed on the reached
  // side, and the gate then fails for a different reason -- nothing was measured where a difference would
  // have been an instrument failure, so the pair cannot testify about the instrument at all. Naming no
  // route is the strictest reading, where the same difference has no explanation. And a pair that pairs a
  // reached difference with an unreached match can pass, which is the shape every real pair has.
  const moved = () =>
    identity(
      report([record('u1', 'temporal', 'aaa', 10, 20)]),
      report([record('u1', 'temporal', 'bbb', 10, 20)]),
    );
  assert(moved().partitions.reachable.unattributed === 1, 'a reached difference is filed on the reached side');
  assert(!moved().gate.pass, 'and a pair with nothing on the unreached side cannot pass');
  assert(
    moved().gate.reasons.some((reason) => reason.includes('no question on an unreached route')),
    'the reason says the pair could not testify',
  );
  const narrowed = identity(
    report([record('u1', 'temporal', 'aaa', 10, 20)]),
    report([record('u1', 'temporal', 'bbb', 10, 20)]),
    { reachable: [] },
  );
  assert(!narrowed.gate.pass, 'an empty reachable list is the strictest reading and fails on any difference');
  assert(narrowed.partitions.unreachable.unattributed === 1, 'with nowhere for the difference to be explained');
  const paired = identity(
    report([record('u1', 'temporal', 'aaa', 10, 20), record('u2', 'flat', 'ccc', 5, 7)]),
    report([record('u1', 'temporal', 'bbb', 10, 20), record('u2', 'flat', 'ccc', 5, 7)]),
    { reachable: ['temporal'] },
  );
  assert(paired.gate.pass, 'a reached difference beside an unreached match passes the instrument');

  // The within-run census is printed from each file, so a pair whose repetitions were not repetitions is
  // visible before its difference is attributed.
  const variants = identity(report([record('u1', 'flat', 'aaa', 1, 2, 2)]), report([]));
  assert(variants.variants.a.multi === 1, 'a question with two prompts is counted');
  assert(variants.variants.b.multi === 0, 'the other side counts its own');

  const rendered = renderIdentity(frame);
  assert(rendered.includes('GATE (strict: prompt digests) FAIL'), 'the render states the strict verdict');
  assert(rendered.includes('GATE (registered: evidence characters) PASS'), 'and the registered one');
  assert(rendered.includes('125 chars'), 'the render prints the frame delta');

  process.stdout.write(`prompt-identity self-test: ${checks} checks passed\n`);
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const flag = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length < 2) {
    process.stderr.write(
      'usage: node tools/prompt-identity.mjs <a.json> <b.json> ' +
        '[--reachable route,route] [--json] | --self-test\n',
    );
    process.exitCode = 2;
  } else {
    const [pathA, pathB] = positional;
    const reachable = flag('--reachable');
    const reading = identity(
      JSON.parse(readFileSync(pathA, 'utf8')),
      JSON.parse(readFileSync(pathB, 'utf8')),
      reachable === undefined ? {} : { reachable: reachable.split(',').filter((value) => value !== '') },
    );
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderIdentity(reading)}\n`);
    }
    if (!reading.gate.pass) process.exitCode = 1;
  }
}

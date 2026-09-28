#!/usr/bin/env node
/**
 * Read the channel B vs channel C contrast at the artifact layer.
 *
 * Channel B was the earlier attempt at a non-oracle annotation source: read the
 * question only, and fall back to `candidateSides`. It was falsified by
 * measurement — it yields exactly ONE side on the five-word pool, and
 * `discriminateContext` declines to annotate with fewer than two. So B's
 * annotation is a structural no-op, not a tuning problem.
 *
 * Channel C reads the *retrieval* instead. This tool exists so the claim "C
 * yields >= 2 where B yields 1" is checked against the real module on the real
 * fixtures, not only inside the unit suite that defines the fixtures. A claim
 * whose only witness is the test that asserts it is not yet a measured claim.
 *
 * It reports, per fixture arm:
 *   - sides produced by B (`candidateSides` on the question alone)
 *   - sides produced by C (`retrievalCandidateSides` on the retrieved turns)
 *   - whether each annotates at all, and whether the two rendered strings
 *     differ. Byte-identical arms would mean the switch is dead.
 *
 * Usage: node tools/read-channel-c-contrast.mjs
 */

import {
  candidateSides,
  discriminateContext,
  renderDiscriminatedContext,
  retrievalCandidateSides,
} from '../packages/cortex-eval/dist/candidate-context.js';

/**
 * The discriminating fixture: one head ("bike") carried by two modifiers
 * ("cargo", "racing"), with `cargo` recurring so the slot is established by the
 * retrieval rather than by a single mention.
 */
const DISCRIMINATING = [
  { index: 0, text: 'user: I rode the cargo bike to the coast.' },
  { index: 1, text: 'user: I rode the cargo bike again on Sunday.' },
  { index: 2, text: 'user: The racing bike stayed in the garage.' },
  { index: 3, text: 'user: The blue car needed a service.' },
  { index: 4, text: 'user: The blue car was serviced in June.' },
  { index: 5, text: 'user: The red car was in the shop.' },
];

/**
 * The five-word pool that falsified channel B: the whole retrieval is one
 * bag of words, so the question-only path can only ever merge it into one side.
 *
 * This is also the sharper of the two fixtures, because C is stronger here than
 * on the fixture above. That one carries decoy `car` turns, which give a rival
 * slot three alternatives; `the contested slot is the one with the most
 * alternatives` then prefers it and discards the bike pair. The pool below has
 * no decoys, so the bike pair survives. Both fixtures are reported rather than
 * only the flattering one.
 */
const FIVE_WORD_POOL = [
  { index: 0, text: 'user: I rode the bike along the coast.' },
  { index: 1, text: 'user: The cargo bike carried the load.' },
  { index: 2, text: 'user: The racing bike was faster.' },
];

const RETRIEVED_TEXT = DISCRIMINATING.map((turn) => turn.text).join('\n');

function sidesOf(label, sides) {
  const rendered = sides.length === 0 ? '[]' : JSON.stringify(sides);
  console.log(`  ${label.padEnd(6)} ${String(sides.length).padStart(2)} side(s)  ${rendered}`);
}

function arm(name, turns, question) {
  console.log(`\n=== ${name} ===`);
  const b = candidateSides({ question, turns });
  const c = retrievalCandidateSides({ question, retrieved: turns });
  sidesOf('B:', b);
  sidesOf('C:', c);

  const annotated = (sides) => {
    const { clusters } = discriminateContext(turns, { question, sidesOverride: sides });
    if (clusters.length === 0) return null;
    return renderDiscriminatedContext(RETRIEVED_TEXT, clusters, { question });
  };

  const bText = annotated(b);
  const cText = annotated(c);
  console.log(`  B annotates: ${bText !== null}`);
  console.log(`  C annotates: ${cText !== null}`);
  if (bText === null && cText === null) {
    console.log('  arms identical: both declined (no annotation either way)');
    return { b: b.length, c: c.length, annotated: false, identical: true };
  }
  if (bText === null || cText === null) {
    console.log('  arms differ: one annotates, the other declines');
    return { b: b.length, c: c.length, annotated: true, identical: false };
  }
  const identical = bText === cText;
  console.log(`  arms byte-identical: ${identical}`);
  return { b: b.length, c: c.length, annotated: true, identical };
}

function main() {
  const question = 'Which bike did I ride?';

  const discriminating = arm('discriminating retrieval (the B7 fixture)', DISCRIMINATING, question);
  const pool = arm('five-word pool (the fixture that falsified B)', FIVE_WORD_POOL, question);

  console.log('\n--- contrast verdict ---');
  const clauseB = discriminating.b < 2;
  const clauseC = discriminating.c >= 2;
  console.log(
    `on the discriminating fixture: B yields ${discriminating.b} (sub-two: ${clauseB}), ` +
      `C yields ${discriminating.c} (at-least-two: ${clauseC})`,
  );
  if (!clauseB) {
    console.log('>>> CONTRADICTED: B did NOT collapse to one side, so the premise is wrong.');
    return 1;
  }
  if (!clauseC) {
    console.log('>>> CONTRADICTED: C did NOT reach two sides, so the fix does not deliver.');
    return 1;
  }
  console.log('CONFIRMED: non-oracle, and C clears the two-side bar B cannot.');
  return 0;
}

process.exit(main());

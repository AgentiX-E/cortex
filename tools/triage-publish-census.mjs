#!/usr/bin/env node
/**
 * The publishing rule, censused on real user speech instead of sampled on 60 hand-picked rows.
 *
 *     node tools/triage-publish-census.mjs --corpus <turns.json> [--verdicts <file>] [--json]
 *
 * ## Why this exists
 *
 * `§10.2` gate 3 wants a false-share upper bound of 5%. The numbers behind it were `0/12` on a
 * hand-labelled sample and `0/1,467` on persona facts where the publishing rule never fired at all
 * -- an upper bound over a mechanism that did not run. Neither can say how often the rule publishes
 * something it should not, because neither contains enough publications to count.
 *
 * A publication is the only way a private fact reaches the shared store, so the quantity the gate is
 * really about is: **among the rows this rule publishes, how many carry a private circumstance?**
 * That needs a denominator of publications, and 60 rows do not have one.
 *
 * ## The corpus
 *
 * `--corpus` is a JSON file of user utterances, deduplicated by exact text, extracted from the
 * benchmark artifacts this project already produces (`tools/extract-user-turns.py`). It is *not*
 * filtered for "sentences that look organisational": the census has to see the trigger words in
 * their natural distribution, which is exactly what the six-hundred-row scale of `p04` could not do.
 *
 * ## The denominator, and the two rates it produces
 *
 * | rate | numerator / denominator | what it answers |
 * | ---- | ----------------------- | --------------- |
 * | publication rate | published / all utterances | how much of what a user says leaves the device |
 * | **false-share rate** | adjudicated-private / published | of what leaves, how much should not have |
 *
 * The second rate is the gate. Its denominator is small on purpose -- 211 out of 47,490 -- and a
 * bound on it is a statement about every publication the product will ever make, which is the only
 * place a bound is worth having.
 *
 * ## Adjudication is an external file, deliberately
 *
 * `--verdicts` joins a JSON file of `{index, verdict, class, why}` records written by a reader who
 * saw only the row and the published policy. The tool never guesses: a row without a verdict is
 * counted as `unjudged`, and the report refuses to state a rate while any publication is unjudged.
 * That is the same rule `p06` applies to a corpus that never fires the mechanism -- no number is
 * better than a number about nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { RULE_TABLE, classify } from '../packages/cortex-core/dist/triage/rules.js';

/** Wilson score upper bound, 95%. Same definition the documents quote. */
export function wilsonUpper(successes, n, z = 1.959_963_984_540_054) {
  if (n === 0) return 1;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / denominator);
}

export function census(turns, verdicts = new Map(), options = {}) {
  const { deferShared = false } = options;
  const shared = RULE_TABLE.find((rule) => rule.scope === 'shared');
  if (!shared) throw new Error('the table has no shared rule, so nothing can ever be published');

  const rows = turns.map((text, index) => {
    const decision = classify(text);
    const match = shared.pattern.exec(text);
    // `deferShared` is the A4 ablation and nothing else: the private rules still run, but a
    // deferral lands in the shared store instead of the private one. It is one predicate, which is
    // the point -- the ablation has to be the smallest possible change from the real policy, or it
    // measures the change rather than the mechanism.
    const publishes = decision.scope === 'shared' || (deferShared && decision.scope === 'defer');
    return {
      index,
      text,
      scope: decision.scope,
      rule: decision.rule,
      trigger: publishes && match ? match[0] : null,
      verdict: verdicts.get(index)?.verdict ?? null,
      class: verdicts.get(index)?.class ?? null,
      why: verdicts.get(index)?.why ?? null,
    };
  });

  const published = rows.filter((row) => row.scope === 'shared' || (deferShared && row.scope === 'defer'));
  const judged = published.filter((row) => row.verdict !== null);
  const unjudged = published.length - judged.length;
  const errors = judged.filter((row) => row.verdict === 'private');

  const triggers = {};
  for (const row of published) {
    const key = (row.trigger ?? '?').toLowerCase();
    triggers[key] = (triggers[key] ?? 0) + 1;
  }

  const byClass = {};
  for (const row of errors)
    byClass[row.class ?? 'unspecified'] = (byClass[row.class ?? 'unspecified'] ?? 0) + 1;

  return {
    policy: deferShared ? 'defer-shared' : 'shipped',
    utterances: rows.length,
    published: published.length,
    publicationRate: published.length / rows.length,
    judged: judged.length,
    unjudged,
    errors: errors.length,
    // Only meaningful when every publication has been read. A rate over a partly-read set is a
    // rate about the part that was read, which is the mistake this file exists to avoid.
    falseShare: unjudged === 0 && published.length > 0 ? errors.length / published.length : null,
    falseShareUpper:
      unjudged === 0 && published.length > 0 ? wilsonUpper(errors.length, published.length) : null,
    triggers,
    byClass,
    rows: published,
    errorRows: errors,
  };
}

function report(result) {
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  if (result.policy === 'defer-shared') {
    console.log('policy                defer-shared (A4 ablation: a deferral is published)');
    console.log(
      `published             ${result.published} of ${result.utterances} (${percent(
        result.publicationRate,
      )})`,
    );
    console.log(
      'note                  this is an ablation, not a gate: the false-share rate it produces is',
    );
    console.log(
      '                      a rate about rows nobody read, so no rate is printed and the exit',
    );
    console.log('                      code is 0 by construction. Read the count, not the ratio.');
    return;
  }
  console.log(`utterances            ${result.utterances}`);
  console.log(`published             ${result.published} (${percent(result.publicationRate)})`);
  console.log(
    `judged                ${result.judged}${result.unjudged ? ` (${result.unjudged} unjudged)` : ''}`,
  );
  if (result.falseShare === null) {
    console.log(
      'false-share           NOT MEASURED — every publication has to be read before a rate exists',
    );
  } else {
    console.log(
      `false-share           ${result.errors}/${result.published} = ${percent(result.falseShare)} ` +
        `(Wilson 95% upper ${percent(result.falseShareUpper)})`,
    );
  }
  console.log(`triggers              ${JSON.stringify(result.triggers)}`);
  if (result.errors > 0) console.log(`error classes         ${JSON.stringify(result.byClass)}`);
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1];
  };
  const corpusPath = arg('--corpus');
  if (!corpusPath) {
    console.error(
      'usage: triage-publish-census.mjs --corpus <turns.json> [--verdicts <file>] [--json] [--out <file>] [--defer-shared]',
    );
    return 2;
  }
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const turns = corpus.turns;
  if (!Array.isArray(turns)) throw new Error(`${corpusPath} has no turns array`);

  const verdictPath = arg('--verdicts');
  const verdicts = new Map();
  if (verdictPath) {
    for (const record of JSON.parse(readFileSync(verdictPath, 'utf8')).rows) {
      verdicts.set(record.index, record);
    }
  }

  const deferShared = argv.includes('--defer-shared');
  const result = census(turns, verdicts, { deferShared });
  const out = arg('--out');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else report(result);
  // The ablation reports a count and never gates. Its publication set is mostly rows no reader has
  // seen, so a false-share rate over it would be a ratio over an unread denominator -- the exact
  // thing this file refuses to print anywhere else.
  if (deferShared) return 0;
  // A gate is a thing that can fail. Unjudged publications are a failure of the measurement, and a
  // false-share upper bound above 5% is a failure of the rule.
  if (result.unjudged > 0) return 1;
  return result.falseShareUpper !== null && result.falseShareUpper <= 0.05 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  process.exitCode = main();
}

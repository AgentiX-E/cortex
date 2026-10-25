#!/usr/bin/env node
/**
 * Retrieval-only comparison of memory providers, on a dataset generated in-repo.
 *
 *     node tools/competitor-harness.mjs [--limit 10] [--people 8] [--json]
 *
 * Nothing here calls a model: the providers are the lexical reference implementation and a provider that
 * returns nothing. The second exists so the table has a floor; a comparison whose bottom row is not zero is
 * measuring arithmetic.
 *
 * ## The gold, and why this tool derives it
 *
 * `Question.goldTurns` is produced by the LongMemEval loader and is the honest field to use. The synthetic
 * generator does not emit it, so this tool derives the gold as "the context turns that state the expected
 * answer" — which is true by construction for a generated dataset and false for a real one. That is why the
 * header says so and why a real run passes `goldOf` instead.
 */

import {
  LexicalProvider,
  NullProvider,
  comparability,
  measureRetrieval,
} from '../packages/cortex-eval/dist/index.js';
import { generateSyntheticBenchmark } from '../packages/cortex-eval/dist/datasets/synthetic-benchmark.js';
import { CortexSessionProvider } from '../packages/cortex-memory/dist/index.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const asJson = argv.includes('--json');
const limit = Number(flag('--limit') ?? 10);
const people = Number(flag('--people') ?? 8);

const dataset = generateSyntheticBenchmark({ numPeople: people, seed: 7 });

/** The gold as the generator guarantees it: the turns that state the answer. */
const goldOf = (question) => {
  const expected = question.expected;
  if (expected === null) return [];
  const needle = expected.toLowerCase();
  return question.context.filter((turn) => turn.toLowerCase().includes(needle));
};

// Cortex's own selection, twice: unbounded (the recall ceiling of what the store holds) and at its real
// session budget (what the reader is actually offered). The gap between the two rows is the budget's cost,
// and it is the number this tool was built to make visible.
const now = Date.now();
const providers = [
  new LexicalProvider(),
  new CortexSessionProvider({ now }),
  new CortexSessionProvider({ now, sessionBudget: 8 }),
  new NullProvider(),
];

const scores = await measureRetrieval(dataset, providers, {
  limit,
  mode: 'isolated',
  goldOf,
});

const config = {
  dataset: `${dataset.name}/${dataset.questions.length}`,
  questions: dataset.questions.length,
  reader: 'none (retrieval only)',
  judge: 'none (retrieval only)',
  judgePolicy: 'n/a',
  topK: limit,
  tokenBudget: 0,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ config, scores }, null, 2)}\n`);
  process.exit(0);
}

const pad = (value, width) => String(value).padEnd(width);
const pct = (value) => `${(100 * value).toFixed(1)}%`;

process.stdout.write(`retrieval-only comparison — ${dataset.name}/${dataset.questions.length}\n`);
process.stdout.write(
  `gold: derived from the expected answer, which is exact for a generated dataset and not for a real one\n\n`,
);

process.stdout.write(
  `${pad('provider', 20)}${pad('build', 11)}${pad('recall@k', 10)}${pad('all-gold', 10)}${pad('mrr', 8)}${pad('found', 10)}${pad('empty', 7)}unmeasurable\n`,
);
for (const score of scores) {
  process.stdout.write(
    `${pad(score.provider, 20)}${pad(score.build, 11)}${pad(pct(score.recallAtK), 10)}${pad(pct(score.recallAllAtK), 10)}${pad(score.mrr.toFixed(3), 8)}${pad(`${score.found}/${score.measured}`, 10)}${pad(score.empty, 7)}${score.unmeasurable}\n`,
  );
}

const capabilities = [
  ...new Set(scores.flatMap((score) => Object.keys(score.byCapability))),
].sort();
if (capabilities.length > 0) {
  process.stdout.write(
    `\n${pad('capability', 12)}${scores.map((score) => pad(score.provider, 20)).join('')}\n`,
  );
  for (const capability of capabilities) {
    const cells = scores.map((score) => {
      const bucket = score.byCapability[capability];
      return pad(bucket === undefined ? '—' : `${bucket.found}/${bucket.measured}`, 20);
    });
    process.stdout.write(`${pad(capability, 12)}${cells.join('')}\n`);
  }
}

// The comparison is a function of the two configurations, so the tool states it rather than leaving the reader
// to assume the two runs are on one axis.
const sameRun = comparability(config, config);
process.stdout.write(
  `\nconfiguration: k=${limit}, mode=isolated, reader/judge=none\ncomparability(identical): ${sameRun.grade}\n`,
);
process.stdout.write(
  '\nscope: lexical-reference covers ordering and the empty store; cortex-session covers admission, the\n' +
    'session budget, the relevance key and the hit order. Both declare build=none, so neither row was\n' +
    'produced by a model.\n',
);
process.stdout.write(
  `\nThis table is a pipeline check, not a result. Its floor is zero by construction, and its ceiling here is\n` +
    `reached: the synthetic corpus writes each fact as \`name attribute=value\`, so a term-overlap signal scores\n` +
    `the gold turn 1.0 by construction. The remaining gap to lexical-reference is its stopword-free tokeniser\n` +
    `(\`what\` in the question inflates its denominator) rather than a difference in retrieval quality. So\n` +
    `cortex-session reading 100% and 1.000 means the signal is wired, not that the system is at SOTA. A corpus\n` +
    `that can separate lexical systems has to come from outside this repository; see\n` +
    `docs/PLAN-COMPETITOR-HARNESS.md.\n`,
);

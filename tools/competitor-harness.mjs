#!/usr/bin/env node
/**
 * Retrieval-only comparison of memory providers, on the synthetic set or on LongMemEval-S.
 *
 *     node tools/competitor-harness.mjs [--limit 10] [--people 8] [--json]
 *     node tools/competitor-harness.mjs --data data/longmemeval_s_cleaned.json [--questions 100] [--json]
 *
 * Nothing here calls a model: the providers are the lexical reference implementation, Cortex's own session
 * adapter, and a provider that returns nothing. The last exists so the table has a floor; a comparison whose
 * bottom row is not zero is measuring arithmetic.
 *
 * ## Two datasets, two kinds of gold, and the difference is the point
 *
 * `Question.goldTurns` is produced by the LongMemEval loader from `answer_session_ids` — an annotation in the
 * dataset. That is the only gold this tool will subtract on.
 *
 * The synthetic generator emits no `goldTurns`, so on that path this tool derives the gold as "the context turns
 * that state the expected answer", which is true by construction for a generated corpus and false for a real one.
 * That derivation also makes the synthetic set unable to separate lexical systems: the generator writes each
 * fact as `name attribute=value`, so the question's terms appear verbatim in its own gold and any overlap signal
 * scores it `1.0`. The tool says so in its output rather than leaving a reader to over-read a 100%.
 *
 * ## Why `--questions` stratifies
 *
 * Taking the first 100 rows of the file would take whatever capability the file happens to start with. The
 * sampler rounds across capabilities in a fixed order with a fixed intra-group sort, so the subset is
 * reproducible from `(path, count)` alone and every capability that exists is represented.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  LexicalProvider,
  NullProvider,
  comparability,
  createLlmFromEnv,
  createLlmJudge,
  createProviderReader,
  measureRetrieval,
  toJudgeQuestionType,
} from '../packages/cortex-eval/dist/index.js';
import { loadLongMemEval } from '../packages/cortex-eval/dist/datasets/longmemeval-loader.js';
import { generateSyntheticBenchmark } from '../packages/cortex-eval/dist/datasets/synthetic-benchmark.js';
import { CortexSessionProvider } from '../packages/cortex-memory/dist/index.js';
import { createSutProvider } from './competitor-sut.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const asJson = argv.includes('--json');
/**
 * Also write the machine-readable payload to this path, while still printing the table.
 *
 * ## Why this is not `--json > file`
 *
 * A pipeline ran each reading stage twice: once with `--json > file` for the paired test and once piped to
 * `tee` for the human table. Both invocations call the model, so the artifact and the printed table came from
 * **two different samples** — and they disagreed: 344 vs 339 correct for the same arm, on the same questions,
 * with the same prompt.
 *
 * That is worse than waste. A reader comparing the table with `competitor-paired.txt` finds a 17-question
 * movement in one and 10 in the other, and has no way to know which is the run. The paired test was right and
 * the table described a different run, which is the defect class this project keeps finding: two artifacts that
 * claim to describe one experiment.
 *
 * One invocation, two outputs, and the file is what was printed.
 */
const jsonOut = flag('--json-out');
const limit = Number(flag('--limit') ?? 10);
const people = Number(flag('--people') ?? 8);
const wanted = Number(flag('--questions') ?? 100);
// Overrides the token budget of the priced row, so a test (or a reader) can force the budget below one session
// and watch the trim happen. 2,800 is the default because that is Contextier's mean context on this benchmark.
const budgetTokens = Number(flag('--budget-tokens') ?? 2800);
/**
 * Run the reading stage as well as the retrieval stage.
 *
 * Off by default because it needs a model and a key, and H0's whole point was that the harness runs without
 * either. On, every question is read once per named provider and graded once, so the cost is
 * `questions x providers x 2` model calls.
 */
const readAnswers = argv.includes('--read');
/**
 * Which reader prompt the reading stage sends.
 *
 * `con` is the control — the plain Chain-of-Note prompt the first accuracy reading was taken with. `dispatch`
 * adds a per-capability clause: dates and arithmetic for temporal questions, value enumeration for
 * knowledge-update, cross-conversation collection for multi-session, and a statement of the block order.
 * `dispatch2` is `dispatch` with the multi-session clause replaced by a procedure that demands an artefact — the
 * blocks as dated fact rows, then an enumerated candidate list, then an operation shown. The arms are identical on
 * every other capability, so `con -> dispatch -> dispatch2` is two steps of one variable each.
 */
const readerMode = flag('--reader') ?? 'con';
if (readerMode !== 'con' && readerMode !== 'dispatch' && readerMode !== 'dispatch2') {
  throw new Error(`--reader must be 'con', 'dispatch' or 'dispatch2', got '${readerMode}'`);
}

/**
 * Which providers get read.
 *
 * Not every arm: a provider that returns nothing, and an arm that differs only in budget, would each cost a
 * reader call per question to say something already visible in the recall column. These four are the ones whose
 * accuracy answers a question the recall column cannot: the reference, the unbounded product, and two priced
 * budgets.
 */
const DEFAULT_READ_ARMS = [
  'lexical-reference',
  'cortex-session',
  'cortex/trim-2.8k',
  'cortex/trim-6.8k',
];

/**
 * Which arms to read, overridable because the cost is linear in both questions and arms.
 *
 * The four-arm setting is right for a hundred questions. On the full five hundred it is four thousand model calls,
 * and the two arms that answer the question are the reference and the unbounded product — the budget arms repeat
 * an answer the recall column already gives.
 */
const READ_ARMS =
  flag('--read-arms') === undefined
    ? DEFAULT_READ_ARMS
    : flag('--read-arms')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
const dataPath = flag('--data') ?? process.env['LONGMEMEVAL_PATH'];

/**
 * Take `count` questions, round-robin across capabilities in a fixed order.
 *
 * Within a capability the rows are sorted by `id`, so the subset depends on `(instances, count)` and nothing
 * else — no clock, no hash seed, no file order. A subset that cannot be reproduced makes every number taken on
 * it unusable for a later comparison.
 */
function stratify(questions, count) {
  const groups = new Map();
  for (const question of questions) {
    const bucket = groups.get(question.capability);
    if (bucket === undefined) groups.set(question.capability, [question]);
    else bucket.push(question);
  }
  for (const bucket of groups.values())
    bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const order = [...groups.keys()].sort();
  const picked = [];
  let round = 0;
  while (picked.length < count) {
    let added = 0;
    for (const capability of order) {
      const bucket = groups.get(capability);
      if (bucket === undefined || round >= bucket.length) continue;
      picked.push(bucket[round]);
      added += 1;
      if (picked.length === count) break;
    }
    if (added === 0) break;
    round += 1;
  }
  return picked;
}

let dataset;
let goldOf;
let provenance;

if (dataPath === undefined) {
  dataset = generateSyntheticBenchmark({ numPeople: people, seed: 7 });
  // The gold as the generator guarantees it: the turns that state the answer.
  goldOf = (question) => {
    const expected = question.expected;
    if (expected === null) return [];
    const needle = expected.toLowerCase();
    return question.context.filter((turn) => turn.toLowerCase().includes(needle));
  };
  provenance =
    'gold: derived from the expected answer, which is exact for a generated dataset and not for a real one';
} else {
  const parsed = JSON.parse(readFileSync(dataPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${dataPath} must contain a JSON array of LongMemEval instances`);
  }
  const loaded = loadLongMemEval(parsed);
  const subset = stratify(loaded.questions, Math.min(wanted, loaded.questions.length));
  dataset = { name: `${loaded.name}/s`, questions: subset };
  // The only gold this tool subtracts on: an annotation in the file, not an inference.
  goldOf = (question) => question.goldTurns ?? [];
  provenance =
    `gold: Question.goldTurns from answer_session_ids (${parsed.length} instances in file, ` +
    `${subset.length} sampled round-robin across capabilities)`;
}

/**
 * Character budget for the token-denominated rows.
 *
 * The published systems report their context cost in tokens: Mem0 6,787 mean, Zep 4,408 median, Contextier
 * 2,807 mean. `cortex-eval` counts no tokeniser, so the conversion is `tokens * 4` characters and it is stated
 * here rather than buried in the output -- an English token is about four characters, and a reader comparing
 * this column with a vendor's should know which side is exact.
 */
const charsForTokens = (tokens) => tokens * 4;

// Cortex's own selection, in four arms. The first is the recall ceiling of what the store holds; the rest are
// what a reader is actually offered at a bounded budget, and they differ only in *how* the budget is spent:
//
//   - whole   : `selectSessionBudget`, all-or-nothing per session (the shipped rule);
//   - turn    : `selectTurnsWithinBudget`, trim inside a session (LongMemEval's `GRANULARITY: turn`);
//   - tokens  : the same trim, priced in characters at a budget the published systems also report.
//
// Printing all four is the ablation: a granularity claim that is not measured against the whole-session rule
// on one corpus is a preference, not a result.
const now = Date.now();
const providers = [
  new LexicalProvider(),
  new CortexSessionProvider({ now }),
  new CortexSessionProvider({ now, sessionBudget: 8, label: 'cortex/whole-8t' }),
  new CortexSessionProvider({ now, sessionBudget: 8, trim: true, label: 'cortex/trim-8t' }),
  new CortexSessionProvider({
    now,
    sessionBudget: charsForTokens(budgetTokens),
    budgetUnit: 'chars',
    trim: true,
    label: `cortex/trim-${(budgetTokens / 1000).toFixed(1)}k`,
  }),
  new NullProvider(),
];

/**
 * A competitor's own code, as one more arm.
 *
 * `--sut mem0` launches `tools/competitor-sut/mem0_driver.py` and treats it like any other provider, which is the
 * whole point: the reader, the judge, the data, the top-k and the budget are ours, and the only thing that differs
 * is whose memory system is answering. That is what makes the resulting number quotable rather than a vendor's
 * claim about their own configuration.
 *
 * The manifest is printed before any score, because a competitor's number without its commit and settings is the
 * same failure as one of ours without its arm name.
 */
const sutDriver = flag('--sut');
const sut = sutDriver === undefined ? null : await createSutProvider({ driver: sutDriver });
if (sut !== null) providers.push(sut);

let reader = null;
let judge = null;
if (readAnswers) {
  // A missing key has to fail loudly: a run that silently skipped the reading stage would print a table with no
  // accuracy column and be read as a run that measured accuracy.
  const llm = createLlmFromEnv(process.env);
  const grade = createLlmJudge(llm);
  reader = createProviderReader(llm, readerMode);
  judge = (question, answer) =>
    grade(
      question.question,
      answer,
      question.expected ?? '',
      toJudgeQuestionType(question.questionType ?? '', question.capability === 'ABS'),
    );
}

const scores = await measureRetrieval(dataset, providers, {
  limit,
  mode: 'isolated',
  goldOf,
  ...(reader === null || judge === null ? {} : { answer: reader, judge, accuracyFor: READ_ARMS }),
});

// The reader and judge are named by the model that actually ran, not by "deepseek": `comparability()` compares
// these strings, so a run whose configuration says `deepseek-chat` and whose calls went to `deepseek-v4-pro`
// would be graded A against a run it does not match.
const readerName = readAnswers
  ? `${process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'} (chain-of-note/${readerMode}, one request)`
  : 'none (retrieval only)';
const judgeName = readAnswers
  ? `${process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'} (official per-type templates)`
  : 'none (retrieval only)';

const config = {
  dataset: `${dataset.name}/${dataset.questions.length}`,
  questions: dataset.questions.length,
  reader: readerName,
  judge: judgeName,
  judgePolicy: readAnswers ? 'longmemeval-official-per-type' : 'n/a',
  topK: limit,
  tokenBudget: 0,
};

if (jsonOut !== undefined) {
  // Written before the table so a crash in rendering cannot cost the artifact, and with the same object the
  // table is rendered from, so the two cannot describe different runs.
  writeFileSync(jsonOut, `${JSON.stringify({ config, scores }, null, 2)}\n`);
}

if (asJson) {
  const body = `${JSON.stringify({ config, scores }, null, 2)}\n`;
  // `process.exit` does not wait for stdout to drain, and a pipe buffer is 8 KiB. The failure this prevents is
  // silent and it happened: with one record per question the payload crossed 8 KiB, and every consumer read a
  // file that stopped mid-string at char 8190 -- a truncated JSON document rather than an error. The callback
  // form of `write` fires only once the chunk has been handed to the operating system, so awaiting it is what
  // makes exit safe here.
  //
  // Redirecting to a file did not show this, because a file write is synchronous; only a pipe does. That is why
  // it survived until a tool started piping the output.
  await new Promise((resolve, reject) => {
    process.stdout.write(body, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
  process.exit(0);
}

const pad = (value, width) => String(value).padEnd(width);
const pct = (value) => `${(100 * value).toFixed(1)}%`;

process.stdout.write(
  `${readAnswers ? 'retrieval + reading' : 'retrieval-only'} comparison — ` +
    `${dataset.name}/${dataset.questions.length}\n`,
);
process.stdout.write(`${provenance}\n`);

// The competitor's own description of itself, printed before any number it produced. `notes` carries the driver's
// configuration — which embedder, whether the LLM ran at ingest — which is exactly what a reader needs in order to
// decide whether the row can be set beside a published figure at all.
if (sut !== null) {
  process.stdout.write(
    `system under test: ${sut.manifest.name} ${sut.manifest.version} (build=${sut.manifest.build}) — ` +
      `${sut.manifest.notes}\n`,
  );
}
process.stdout.write('\n');

process.stdout.write(
  `${pad('provider', 20)}${pad('build', 7)}${pad('recall@k', 10)}${pad('all-gold', 10)}${pad('mrr', 8)}${pad('acc', 9)}${pad('~tok', 8)}unmeasurable\n`,
);
for (const score of scores) {
  // `~tok` is `meanContextChars / 4`, the same conversion `charsForTokens` applies to the budget. It is what the
  // published systems report, so it is the only column here that can be set beside a vendor figure at all.
  const tokens = Math.round(score.meanContextChars / 4);
  // `—` and `0.0%` are different cells. An arm that was not read has no accuracy; one that was read and got
  // everything wrong has zero, and collapsing the two would let a skipped stage read as a failed one.
  const acc =
    score.accuracy === null ? '—' : `${pct(score.accuracy)} (${score.correct}/${score.read})`;
  process.stdout.write(
    `${pad(score.provider, 20)}${pad(score.build, 7)}${pad(pct(score.recallAtK), 10)}${pad(pct(score.recallAllAtK), 10)}${pad(score.mrr.toFixed(3), 8)}${pad(acc, 9)}${pad(tokens, 8)}${score.unmeasurable}\n`,
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
      if (bucket === undefined) return pad('—', 20);
      // `found/measured` is retrieval; `acc` is what the reader did with it. Both, because a family can be found
      // and then lost in reading, and that is the difference a repair follows from.
      const shown =
        bucket.read === 0
          ? `${bucket.found}/${bucket.measured}`
          : `${bucket.found}/${bucket.measured} a${bucket.correct}/${bucket.read}`;
      return pad(shown, 20);
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
  dataPath === undefined
    ? `\nThis table is a pipeline check, not a result. Its floor is zero by construction, and its ceiling here is\n` +
        `reached: the synthetic corpus writes each fact as \`name attribute=value\`, so a term-overlap signal scores\n` +
        `the gold turn 1.0 by construction. The remaining gap to lexical-reference is its stopword-free tokeniser\n` +
        `(\`what\` in the question inflates its denominator) rather than a difference in retrieval quality. So\n` +
        `cortex-session reading 100% and 1.000 means the signal is wired, not that the system is at SOTA. A corpus\n` +
        `that can separate lexical systems has to come from outside this repository; see\n` +
        `docs/PLAN-COMPETITOR-HARNESS.md.\n`
    : `\nGold here is annotated (\`answer_session_ids\`), not derived, and the corpus is not one we wrote. What this\n` +
        `table still cannot say: a hit is counted when its session text contains a gold turn, so a provider that\n` +
        `returns whole sessions is scored on recall of evidence, not on answer accuracy. There is no reader and no\n` +
        `judge on this path, which is why the numbers are not comparable with a QA benchmark's accuracy.\n`,
);

// Two counts a score cannot carry. `refusals` is the system declining a search; `emptyResults` is it answering
// with nothing. Both are claims about the system and they point opposite ways — a run that collapsed them would
// turn a broken driver into a retrieval failure, which is the defect this repository keeps finding in its own
// instruments.
//
// `ingestSkips` is the third, and it is the one that produced a wrong number: on run 40519523383 mem0's vector
// store was built 1536 dimensions wide and fed 1024-dimension vectors, so every `add` failed with an
// `AssertionError`, every session was skipped, and the resulting empty index scored `0.0%` — a retrieval failure
// printed where there had been no retrieval. It is printed whenever it is non-zero, and the row above means
// nothing without it.
if (sut !== null) {
  process.stdout.write(
    `\nsystem under test: ${String(sut.refusals.length)} refusal(s), ` +
      `${String(sut.emptyResults)} empty result(s) of ${String(dataset.questions.length)} question(s).\n`,
  );
  for (const refusal of sut.refusals.slice(0, 5)) {
    process.stdout.write(`  — ${refusal.error}\n`);
  }
  // Printed whether or not anything was refused. The first version printed only when the skip count was
  // non-zero, which made "every session was stored" and "ingest was never called" the same output — the
  // collapse this whole section exists to prevent, one level down. Run 40614772262 (mem0, 100 questions,
  // 0 refusals) is the counter-example: it is a good run and its log cannot say so.
  process.stdout.write(
    `ingest: ${String(sut.ingestedSessions)} of ${String(sut.offeredSessions)} session(s) stored, ` +
      `${String(sut.ingestSkips.length)} refused.\n`,
  );
  for (const skip of sut.ingestSkips.slice(0, 5)) {
    process.stdout.write(`  — ${skip}\n`);
  }
  await sut.close();
}

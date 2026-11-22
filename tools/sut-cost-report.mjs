#!/usr/bin/env node
/**
 * What each arm cost, beside what it scored.
 *
 * ## Why this is a separate file and not a column in the harness
 *
 * The harness measures one run and knows only what its providers told it. A comparison across systems needs one more
 * number that no single arm owns: the shared reader and judge, which every arm pays identically and which therefore
 * belongs in a column that says so. Putting it in the harness would have made `accuracy` and `cost` two numbers from
 * two different instrumentations of the same run.
 *
 * ## The two cost columns, and why they are not added together
 *
 * * `context` -- characters of retrieved text per question, divided by four. This is the number the published
 *   systems report (Mem0 6,787 mean tokens, Zep 4,408 median), so it is the only one that can be set beside a vendor
 *   figure at all.
 * * `own` -- tokens the system itself spent, from the metering proxy. Zero for a retrieval-only system, and the
 *   whole bill for one that builds and navigates.
 *
 * They are printed apart because they answer different questions. A system with a small context and a large own-bill
 * is doing its work at ingest; one with a large context and no own-bill is paying in prompt length instead. Adding
 * them would produce a single number that hides which of the two a repair should target -- the same collapse this
 * repository keeps recording.
 *
 * ## Prices are a table with a date, not a constant
 *
 * DeepSeek's list price is ¥2 per million prompt tokens on a cache miss and ¥8 per million completion tokens, as of
 * 2026-11-22. It is an input because a reviewer should be able to re-price a run without editing code, and it is
 * printed in the header because a money column without its price date is a number that cannot be checked.
 */

import { readFileSync } from 'node:fs';

const flag = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

/**
 * Prices per million tokens, in yuan.
 *
 * A cache *hit* is cheaper (¥0.5/M) and this tool does not model it: the harness sends the same system prompt on
 * every question, so a real bill is lower than this column, never higher. Stated rather than silently assumed,
 * because a cost table that under-reports without saying so is worse than one that over-reports and does.
 */
const PRICE = {
  prompt: Number(flag('price-prompt') ?? 2),
  completion: Number(flag('price-completion') ?? 8),
  date: flag('price-date') ?? '2026-11-22',
};

const readPath = flag('read');
if (readPath === undefined) {
  process.stderr.write(
    'usage: node tools/sut-cost-report.mjs --read competitor-read.json [--stats stats.json]\n',
  );
  process.exit(2);
}

const payload = JSON.parse(readFileSync(readPath, 'utf8'));
const scores = Array.isArray(payload) ? payload : (payload.scores ?? payload.providers ?? []);
if (!Array.isArray(scores) || scores.length === 0) {
  process.stderr.write(`${readPath} carries no provider scores\n`);
  process.exit(2);
}

const yuan = (tokens, price) => (tokens / 1_000_000) * price;

function row(score) {
  const measured = Math.max(Number(score.measured ?? 0), 1);
  const contextPerQuestion = Math.round(Number(score.meanContextChars ?? 0) / 4);
  const own = score.usage ?? null;
  const ownPerQuestion =
    own === null
      ? null
      : Math.round((Number(own.promptTokens ?? 0) + Number(own.completionTokens ?? 0)) / measured);
  const ownPrompt = own === null ? 0 : Number(own.promptTokens ?? 0);
  const ownCompletion = own === null ? 0 : Number(own.completionTokens ?? 0);
  const ownCost =
    own === null ? null : yuan(ownPrompt, PRICE.prompt) + yuan(ownCompletion, PRICE.completion);
  return {
    provider: score.provider,
    answerer: score.answerer ?? 'none',
    accuracy:
      score.accuracy === null || score.accuracy === undefined
        ? '—'
        : `${(score.accuracy * 100).toFixed(1)}%`,
    read: score.read ?? 0,
    measured,
    contextPerQuestion,
    ownPerQuestion,
    // Per question, because the column sits beside `own tok/q` and a total under a per-question heading is a
    // 30x error at n=30 that no reader would catch. Run 45011905117 printed `¥13.91` for memcog under this
    // heading: it was two arms' spend, and one question of one arm cost ¥3.48.
    ownCostPerQuestion: ownCost === null ? null : ownCost / measured,
  };
}

const rows = scores.map(row);

const pad = (text, width) => String(text).padEnd(width);
process.stdout.write(
  `cost and accuracy — read from ${readPath}\n` +
    `prices: ¥${PRICE.prompt}/M prompt, ¥${PRICE.completion}/M completion (list, ${PRICE.date}); cache hits not modelled, so this over-reports\n\n`,
);
process.stdout.write(
  `${pad('provider', 20)}${pad('by', 6)}${pad('acc', 9)}${pad('read', 6)}${pad('ctx tok/q', 10)}${pad('own tok/q', 10)}${pad('own ¥/q', 10)}\n`,
);
for (const entry of rows) {
  process.stdout.write(
    `${pad(entry.provider, 20)}${pad(entry.answerer, 6)}${pad(entry.accuracy, 9)}${pad(entry.read, 6)}` +
      `${pad(entry.contextPerQuestion, 10)}${pad(entry.ownPerQuestion === null ? '—' : entry.ownPerQuestion, 10)}` +
      `${pad(entry.ownCostPerQuestion === null ? '—' : entry.ownCostPerQuestion.toFixed(3), 10)}\n`,
  );
}

/**
 * The column the table cannot express, printed as a paragraph rather than a number.
 *
 * Every arm in one run shares the reader and the judge, so those tokens are identical across rows and add nothing to
 * a comparison. What does differ is whether the reader *is* shared: a `self` row's accuracy came from the system's
 * own generator, so its "own" column includes the answering cost while a `shared` row's does not. Subtracting the
 * two accuracies without stating that is the error `ProviderScore.answerer` exists to prevent.
 */
const selfAnswered = rows
  .filter((entry) => entry.answerer === 'self')
  .map((entry) => entry.provider);
const shared = rows.filter((entry) => entry.answerer === 'shared').map((entry) => entry.provider);
process.stdout.write(
  '\n' +
    (selfAnswered.length > 0
      ? `self-answering arms (own generator, shared judge): ${selfAnswered.join(', ')} — their accuracy includes a reader, ` +
        'so a gap against a shared arm is reader plus memory, not memory.\n'
      : 'no self-answering arm in this run.\n') +
    (shared.length > 0 ? `shared-reader arms: ${shared.join(', ')}\n` : ''),
);
if (rows.some((entry) => entry.ownPerQuestion === null)) {
  process.stdout.write(
    'an arm printing `—` for its own tokens did not report them; that is "not measured", not "free".\n',
  );
}

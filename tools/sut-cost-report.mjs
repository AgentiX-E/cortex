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
    // The half of `ownPerQuestion` that the answering model actually read. A self-answering arm's prompt column is
    // the only context cost it has -- it reports no retrieved context -- so this is its denominator in the
    // normalised view below, and the completion tokens are the part that must not be counted as context.
    ownPromptPerQuestion: own === null ? null : Math.round(ownPrompt / measured),
    // Per question, because the column sits beside `own tok/q` and a total under a per-question heading is a
    // 30x error at n=30 that no reader would catch. Run 45011905117 printed `¥13.91` for memcog under this
    // heading: it was two arms' spend, and one question of one arm cost ¥3.48.
    ownCostPerQuestion: ownCost === null ? null : ownCost / measured,
  };
}

const rows = scores.map(row);

/**
 * The normalised column: accuracy per million prompt tokens the system caused to be **read**.
 *
 * The denominator is not the context the row handed the reader, and the difference is not academic. Mem0 hands the
 * reader 359 tokens per question and spends 603,503 of its own turning sessions into facts; a reader-only denominator
 * therefore ranks the most expensive arm this repository has ever measured as the most efficient one, by a factor of
 * 39. That is also how a vendor's "context per question" figure flatters an extraction system, so this column exists
 * to make the flattery impossible rather than to repeat it.
 *
 * A `self` arm has no separate reader: its own prompt *is* its context, so its ingest spend must not be added twice.
 * A `shared` arm pays twice and both halves are counted: what the reader read plus what the system spent producing it.
 *
 * `null` when there is nothing to normalise: an arm that was not read has no accuracy, and an arm that read zero
 * tokens has no denominator. Neither becomes a zero, because a zero here sorts to the bottom of a ranking it did not
 * enter.
 */
function efficiency(entry) {
  if (entry.accuracy === '—') return null;
  const accuracy = Number(entry.accuracy.replace('%', '')) / 100;
  const promptTokens =
    entry.ownPromptPerQuestion === null
      ? entry.contextPerQuestion
      : entry.ownPromptPerQuestion + (entry.answerer === 'self' ? 0 : entry.contextPerQuestion);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  return { accuracy, promptTokens, perMillion: (accuracy * 1_000_000) / promptTokens };
}

const efficiencyOf = new Map(rows.map((entry) => [entry.provider, efficiency(entry)]));

/**
 * How much accuracy a row would need to match the best row's accuracy per token, and whether that is even possible.
 *
 * This is the arithmetic that makes an efficiency verdict independent of the accuracy noise. A row that costs 3.8x
 * the tokens of another needs 3.8x its accuracy to draw; once that product exceeds 100% the ordering cannot be
 * reversed by any measurement error at all, which is a stronger statement than a paired test at n=30 can make.
 */
const ranked = rows
  .map((entry) => ({ entry, eff: efficiencyOf.get(entry.provider) }))
  .filter((item) => item.eff !== null)
  .sort((a, b) => b.eff.perMillion - a.eff.perMillion);

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

if (ranked.length >= 2) {
  const best = ranked[0];
  process.stdout.write(
    '\nnormalised: accuracy per million prompt tokens the system caused to be read\n' +
      `${pad('provider', 20)}${pad('prompt tok/q', 13)}${pad('acc', 9)}${pad('pts / 1M tok', 13)}can it draw?\n`,
  );
  for (const item of ranked) {
    // The accuracy this row would need to match the leader's ratio. Above 100% is not a forecast, it is a proof
    // that no accuracy outcome can change the ranking -- which is why it is printed as `cannot` rather than as a
    // very large number a reader might try to interpret.
    const needed = best.eff.accuracy * (item.eff.promptTokens / best.eff.promptTokens);
    const verdict =
      item === best
        ? '— (leader)'
        : needed > 1
          ? `cannot, needs ${(needed * 100).toFixed(0)}%`
          : `drawable at ${(needed * 100).toFixed(1)}%`;
    process.stdout.write(
      `${pad(item.entry.provider, 20)}${pad(item.eff.promptTokens, 13)}` +
        `${pad(`${(item.eff.accuracy * 100).toFixed(1)}%`, 9)}${pad(item.eff.perMillion.toFixed(2), 13)}${verdict}\n`,
    );
  }
  process.stdout.write(
    `\nthe leader is ${best.entry.provider} at ${best.eff.perMillion.toFixed(2)} points per million tokens. A row that ` +
      'cannot draw needs more than 100% accuracy, so its position does not depend on the sample size; a row that can ' +
      'is a question for a paired test, not for this table.\n',
  );

  /**
   * Head to head against one named arm, which is the only form of this comparison a decision can use.
   *
   * The ranking above answers "who spends least per point" and the leader is whichever row that is; the question a
   * mechanism decision asks is different -- "could this competitor draw with *our* arm at the tokens it spends" -- and
   * naming the arm is how the answer stays checkable. `--reference cortex-session` on the 30-question run prints that
   * Mastra would need 238% accuracy, which is what makes the verdict independent of the paired test's noise.
   */
  const referenceName = flag('reference');
  const reference = ranked.find((item) => item.entry.provider === referenceName);
  if (referenceName !== undefined && reference === undefined) {
    process.stderr.write(`${referenceName} is not a row with an accuracy in ${readPath}\n`);
  }
  if (reference !== undefined) {
    const lines = ranked
      .filter((item) => item !== reference)
      .map((item) => {
        const needed =
          reference.eff.accuracy * (item.eff.promptTokens / reference.eff.promptTokens);
        const verdict =
          needed > 1
            ? `cannot (${(needed * 100).toFixed(0)}%)`
            : `at ${(needed * 100).toFixed(1)}%`;
        return `${item.entry.provider} ${verdict}`;
      });
    process.stdout.write(
      `\nto draw with ${reference.entry.provider} (${(reference.eff.accuracy * 100).toFixed(1)}%, ` +
        `${reference.eff.promptTokens} tok/q) each row would need: ${lines.join('; ')}\n`,
    );
  }
}

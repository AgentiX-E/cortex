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

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const asJson = process.argv.includes('--json');

if (args.length === 0) {
  process.stderr.write(
    'usage: node tools/ledger.mjs <label>=<report.json> [<label>=<report.json> ...] [--json]\n',
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

const increments = args.map((arg) => {
  const at = arg.indexOf('=');
  if (at === -1) {
    process.stderr.write(`expected <label>=<path>, got ${arg}\n`);
    process.exit(2);
  }
  const label = arg.slice(0, at);
  const file = arg.slice(at + 1);
  return ledgerOf(label, resultOf(file));
});

const portfolio = portfolioOf(increments);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ increments, portfolio }, null, 2)}\n`);
  process.exit(0);
}

const lines = [];
lines.push('', 'Increment ledgers', '');
for (const increment of increments) {
  lines.push(
    `- ${increment.label}: bought ${increment.bought.length}, sold ${increment.sold.length}, ` +
      `net ${increment.bought.length - increment.sold.length}`,
  );
  if (increment.bought.length > 0) lines.push(`    bought: ${increment.bought.join(', ')}`);
  if (increment.sold.length > 0) lines.push(`    sold:   ${increment.sold.join(', ')}`);
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

lines.push(
  '',
  portfolio.summedBought === portfolio.bought.length
    ? '- The per-increment gains are disjoint, so their sum is the ceiling under perfect additivity. ' +
        'That is a ceiling, not a score: each increment was measured against its own baseline.'
    : `- The per-increment gains overlap, so the sum overstates the pair by ` +
        `${portfolio.summedBought - portfolio.bought.length} question(s). The union is the ceiling.`,
  '',
);

process.stdout.write(`${lines.join('\n')}\n`);

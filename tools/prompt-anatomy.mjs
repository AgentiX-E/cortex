#!/usr/bin/env node
/**
 * Where a rendered prompt spends its characters, and how much of it a prefix cache could ever reuse.
 *
 *     node tools/prompt-anatomy.mjs [--ask enumerated] [--contract abstention] [--budget 48000]
 *                                   [--observed-median 46851] [--json]
 *
 * ## The one thing this measures that no artifact can
 *
 * §13.140.5 registered a prediction the first instrumented artifact will settle: **what share of the
 * prompt the provider serves from its prefix cache**. The prediction was written as a measurement
 * because it looked like one, and this tool shows it is a **consequence**: the prompt begins with the
 * evidence block, so its prefix is question-specific from its first byte. A prefix cache matches a
 * prefix; there is nothing before the evidence to match.
 *
 * What is left is a 9-character invariant (`EVIDENCE:\n`), and that is the ceiling on the current
 * order. The instruction block -- the only text identical across questions -- sits **last**.
 *
 * So the prediction is not "under 5%, let us see"; it is "0% by construction, and here is the size of
 * the prize the order is throwing away".
 *
 * ## Why the prize is worth printing, and why it is not a licence to reorder
 *
 * Reordering is a real treatment with a real cost of its own: the instruction is at the end because
 * the model reads it after the evidence, and `fitToBudget` shrinks evidence to keep that block intact
 * (§12.9). Moving it changes what the reader attends to, so an accuracy reading is required -- but the
 * *price* of the change is computable here, offline, with no model call. A treatment that can state its
 * own prize before it is dispatched is the rule §13.126.4 set for the retrieval axis and §13.141.6
 * restated for routes: state the ceiling before spending a run on it.
 *
 * ## What it deliberately does not do
 *
 * - No model, no dataset, no artifact: it renders from the built package, so it runs on a clean tree.
 * - No claim about wall-clock or a provider's cache policy. Only the character arithmetic.
 * - No write. The numbers are printed; the registration is a document edit made by hand, because a
 *   tool that edited the pre-registration could edit it into agreeing with itself.
 */

import { buildPrompt } from '../packages/cortex-memory/dist/prompt.js';

/** The rendering boilerplate `buildPrompt` puts around the question. Measured, not assumed. */
const EVIDENCE_HEADER = 'EVIDENCE:\n';
const QUESTION_PREFIX = 'QUESTION: ';

/**
 * The asks worth rendering.
 *
 * Listed here rather than imported because `EvidenceAsk` is a type and this is a script: a type does
 * not exist at runtime, and a tool that imported a *value* list would fail the day the list moved to
 * where the types live. The list is checked against the package by `test_prompt_anatomy.py`, which
 * renders every entry and fails if one produces the empty instruction.
 */
const ASKS = [
  'route',
  'extractive',
  'aggregate',
  'computed',
  'enumerated',
  'sweep',
  'aggregation',
  'silent',
  'answer-line',
  'recommend',
  'derive',
];

const CONTRACTS = [
  'extractive',
  'abstention',
  'temporal',
  'assistant',
  'knowledge-update',
  'abstention-evidence-blocks',
];

function parse(argv) {
  const options = { ask: 'enumerated', contract: 'abstention', budget: 48000, observedMedian: 46851, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--ask':
        options.ask = value;
        index += 1;
        break;
      case '--contract':
        options.contract = value;
        index += 1;
        break;
      case '--budget':
        options.budget = Number(value);
        index += 1;
        break;
      case '--observed-median':
        options.observedMedian = Number(value);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(
          `unrecognised argument ${JSON.stringify(flag)}; this script takes --ask, --contract, ` +
            '--budget, --observed-median and --json',
        );
    }
  }
  if (!Number.isFinite(options.budget) || options.budget <= 0) {
    throw new Error(`--budget must be a positive number, got ${JSON.stringify(options.budget)}`);
  }
  return options;
}

/**
 * Split one rendered prompt into its three parts.
 *
 * Rendered with no evidence and an empty question, so the difference between the total and the
 * boilerplate is the instruction block exactly -- no subtraction of estimated evidence lengths, which
 * is what a reader of a roster artifact could attempt and get wrong (`promptChars` is post-fit).
 */
function anatomyOf(ask, contract, options = {}) {
  // The temporal contract renders a date and the others ignore one, so it is passed only there --
  // which is what the arm does (`#promptWithDate`).
  const rendered = buildPrompt('', [], contract, {
    ask,
    ...(contract === 'temporal' ? { questionDate: '2023/05/20' } : {}),
    ...options,
  });
  const prompt = rendered.prompt;
  // The order claim is asserted rather than assumed: this tool's central number is "the invariant
  // prefix is the evidence header", and a prompt that began anywhere else would make that number a
  // coincidence of the layout rather than a property of it.
  if (!prompt.startsWith(EVIDENCE_HEADER)) {
    throw new Error(
      `the ${contract}/${ask} prompt does not begin with ${JSON.stringify(EVIDENCE_HEADER)}; ` +
        'the anatomy below assumes it does',
    );
  }
  const questionAt = prompt.indexOf(QUESTION_PREFIX);
  if (questionAt < 0) {
    throw new Error(`the ${contract}/${ask} prompt has no ${JSON.stringify(QUESTION_PREFIX)} marker`);
  }
  // The shell the reader gets with nothing to read: the evidence placeholder, the question line, and
  // the two blank-line separators `buildPrompt` joins with.
  const shell = questionAt + QUESTION_PREFIX.length + 2;
  const instruction = prompt.length - shell;
  return {
    contract,
    ask,
    total: prompt.length,
    instruction,
    // What a prefix cache could match today: the invariant text before the first question-specific
    // byte, which is the header and nothing else.
    prefixToday: EVIDENCE_HEADER.length,
    // What it could match with the instruction block moved to the front: the whole block, since the
    // question that follows it differs per question.
    prefixIfReordered: instruction,
  };
}

function main() {
  const options = parse(process.argv.slice(2));
  const rows = [];
  for (const contract of CONTRACTS) {
    for (const ask of ASKS) {
      rows.push(anatomyOf(ask, contract));
    }
  }

  const selected = rows.filter((row) => row.ask === options.ask);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ budget: options.budget, rows, selected }, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push('# Prompt anatomy');
  lines.push('');
  lines.push(
    `Rendered from \`packages/cortex-memory/dist/prompt.js\` with no evidence and an empty question, so`,
  );
  lines.push('`instruction` is the block that is identical on every question for that route.');
  lines.push('');
  lines.push(`## The ask under test: \`${options.ask}\``);
  lines.push('');
  lines.push('| contract | prompt (empty evidence) | of which instruction | share of a 46,851-char prompt |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of selected) {
    const share = ((row.instruction / options.observedMedian) * 100).toFixed(2);
    lines.push(
      `| \`${row.contract}\` | ${row.total} | **${row.instruction}** | ${share}% |`,
    );
  }
  lines.push('');
  lines.push('## The prefix a cache could match');
  lines.push('');
  lines.push('| order | invariant prefix | of a 46,851-char prompt |');
  lines.push('| --- | ---: | ---: |');
  const today = selected[0].prefixToday;
  const reordered = selected[0].prefixIfReordered;
  lines.push(`| evidence first (shipped) | **${today}** chars | ${((today / options.observedMedian) * 100).toFixed(2)}% |`);
  lines.push(
    `| instruction first | **${reordered}** chars | ${((reordered / options.observedMedian) * 100).toFixed(2)}% |`,
  );
  lines.push('');
  lines.push(
    `A prefix cache matches a prefix. Today the prefix is \`EVIDENCE:\\n\` -- ${today} characters -- so the`,
  );
  lines.push(
    'reusable share is bounded by the evidence header rather than by any property of the reader, the',
  );
  lines.push('budget or the model. **That is the whole of §13.140.5\u2019s second prediction: it is 0 by construction.**');
  lines.push('');
  lines.push(`## The rest of the grid (${rows.length} cells)`);
  lines.push('');
  lines.push('| contract | ask | instruction |');
  lines.push('| --- | --- | ---: |');
  for (const row of rows.filter((entry) => entry.ask !== options.ask)) {
    lines.push(`| \`${row.contract}\` | \`${row.ask}\` | ${row.instruction} |`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();

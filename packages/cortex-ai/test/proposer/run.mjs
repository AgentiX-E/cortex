/**
 * The proposer driven by a real, on-device model. Not part of `pnpm test`.
 *
 * ## Why this script exists
 *
 * Every other test of the proposal layer feeds it exact model output. That is the right way to test
 * the gates and the wrong way to answer the only question a reader has: *does a model small enough
 * to run on a laptop produce anything these gates keep?* This script answers that with a number,
 * over the same sixty hand-labelled sentences the rule layer is measured on, and it stores the
 * answer so a later run can be compared rather than argued with.
 *
 * ## What it needs
 *
 *   - network access to a weights host. `huggingface.co` is unreachable from some build hosts;
 *     `CORTEX_HF_ENDPOINT` exists so a mirror can be used, and the endpoint is printed with the
 *     result so a reading is never detached from where its weights came from.
 *   - about 400 MB of weights for the default checkpoint, and a few minutes of CPU.
 *
 * Usage:
 *
 *     node test/proposer/run.mjs                       # default checkpoint, all 60 sentences
 *     node test/proposer/run.mjs --limit 10 --dry     # smoke: load the model, one batch
 *
 * ## What it is not
 *
 * It is not a quality benchmark and does not produce one. It reports **compliance** -- how often a
 * model produced JSON the gates could use, and what the gates did with it -- because that is what
 * decides whether the layer is worth shipping. Whether the atoms are *good* is a human judgement on
 * the card, and no number here substitutes for it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROPOSER_PROMPT_VERSION,
  TriageProposer,
  buildProposerPrompt,
} from '@agentix-e/cortex-core';
import { env, pipeline } from '@huggingface/transformers';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../../cortex-core/src/triage/__tests__/fixtures/triage-labels.json');
const MODEL = process.env.CORTEX_PROPOSER_MODEL ?? 'onnx-community/Qwen2.5-0.5B-Instruct';
const ENDPOINT = process.env.CORTEX_HF_ENDPOINT ?? 'https://hf-mirror.com';
const DTYPE = process.env.CORTEX_PROPOSER_DTYPE ?? 'q4';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

/**
 * Weights come from wherever `CORTEX_HF_ENDPOINT` points, and the endpoint is recorded.
 *
 * A reading whose model provenance is "whatever was cached" is not a reading. The parity script for
 * the embedding upgrade learned this the expensive way: two runs compared "the same model" that
 * were not the same artefact.
 */
env.remoteHost = ENDPOINT;
env.allowLocalModels = true;
env.allowRemoteModels = true;

/** One generation, no sampling, so a re-run of this script reproduces the reply for a given model. */
class LocalModel {
  constructor(generator) {
    this.generator = generator;
    this.calls = 0;
    this.seconds = 0;
  }

  async complete(prompt) {
    this.calls += 1;
    const started = Date.now();
    const out = await this.generator([{ role: 'user', content: prompt }], {
      max_new_tokens: 192,
      do_sample: false,
      return_full_text: false,
    });
    this.seconds += (Date.now() - started) / 1000;
    const first = out?.[0];
    const generated = first?.generated_text;
    if (typeof generated === 'string') return generated;
    const last = Array.isArray(generated) ? generated[generated.length - 1] : undefined;
    return typeof last?.content === 'string' ? last.content : '';
  }

  async completeStructured(prompt) {
    return this.complete(prompt);
  }
}

/**
 * Parse the fenced-or-not JSON a model actually emits.
 *
 * Deliberately **not** `parseJson` from the package: that function throws, and this script wants to
 * count how many replies were unparseable rather than stop at the first one. The gates downstream
 * are the shipped ones; only the parse is duplicated, and the duplication is visible here.
 */
/** `1 candidate(s) withheld (1 ungrounded)` -> `['ungrounded']`, repeated per count. */
function reasonsIn(detail) {
  // `[^()]` and not `.*`: the detail itself contains "candidate(s)", and a greedy match starts at
  // that parenthesis and reads "withheld" as a reason. The first run of this script reported an
  // empty reason list next to forty-four failures because of exactly that.
  const inside = detail.match(/\(([^()]*)\)$/);
  if (inside === null) return [];
  return inside[1]
    .split(',')
    .flatMap((part) => {
      const [count, reason] = part.trim().split(' ');
      return reason === undefined ? [] : Array.from({ length: Number(count) }, () => reason);
    });
}

/** The first line of a reply, collapsed -- enough to see the failure, short enough to store. */
function head(raw) {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function readJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * The counts, derived only from `perRow` so a previous run can be re-summarised.
 *
 * Kept as a pure function for a reason the first run demonstrated: the summary and the rows are two
 * renderings of the same data, and when they disagree the reading is void. A function that takes the
 * rows makes the disagreement impossible rather than merely unlikely.
 */
function summarise(perRow, meta) {
  const proposed = perRow.filter((row) => row.outcome === 'proposed');
  const tally = (key) => {
    const counts = new Map();
    for (const row of perRow) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1));
  };
  const reasons = new Map();
  for (const row of perRow) {
    for (const reason of row.withheld ?? []) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    for (const reason of row.detail === undefined ? [] : reasonsIn(row.detail)) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  return {
    model: meta.model,
    endpoint: meta.endpoint,
    dtype: meta.dtype,
    promptVersion: meta.promptVersion,
    sentences: perRow.length,
    proposed: proposed.length,
    factsKept: proposed.reduce((sum, row) => sum + row.facts, 0),
    candidates: proposed.reduce((sum, row) => sum + row.candidates, 0),
    withheld: [...reasons.values()].reduce((sum, count) => sum + count, 0),
    secondsPerSentence: Number(((meta.seconds ?? 0) / Math.max(perRow.length, 1)).toFixed(2)),
    outcomes: tally('outcome'),
    withheldReasons: [...reasons.entries()].sort(),
    perRow,
  };
}

async function main() {
  /**
   * `--from` re-summarises a previous run instead of generating again.
   *
   * Generation is the expensive part and the model is deterministic here, so a change to the way
   * results are *counted* should not cost another five minutes of CPU and should not risk producing
   * a slightly different set of replies that then gets attributed to the counting change.
   */
  const from = value('from', undefined);
  if (from !== undefined) {
    const previous = JSON.parse(readFileSync(from, 'utf8'));
    console.log(JSON.stringify({ ...summarise(previous.perRow, previous), perRow: undefined }, null, 2));
    return;
  }

  const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows;
  const limit = Number(value('limit', String(rows.length)));
  const sample = rows.slice(0, limit);

  console.log(`loading ${MODEL} (dtype ${DTYPE}) from ${ENDPOINT}`);
  const generator = await pipeline('text-generation', MODEL, { dtype: DTYPE });

  /**
   * The proposer is constructed with a raw-completion model, so `completeStructured` returns text.
   * That is the honest configuration: an on-device model has no JSON mode, and the gates must cope
   * with text -- exactly what `PlatformLanguageModel` does in the browser.
   */
  const model = new LocalModel(generator);
  const proposer = new TriageProposer({ llm: model, model: MODEL });

  const perRow = [];
  for (const row of sample) {
    const started = Date.now();
    let reply = '';
    try {
      reply = await model.complete(buildProposerPrompt(row.text));
    } catch (error) {
      perRow.push({ id: row.id, outcome: 'generation-error', detail: String(error).slice(0, 120) });
      continue;
    }
    const parsed = readJson(reply);
    if (parsed === undefined) {
      perRow.push({ id: row.id, outcome: 'unparseable', replyChars: reply.length, replyHead: head(reply) });
      continue;
    }

    // Re-run the shipped gates over the parsed reply: one more call is avoided by feeding the value
    // straight to a proposer whose model returns it. Cheaper and it keeps the gates identical.
    const valueProposer = new TriageProposer({
      llm: { complete: async () => '', completeStructured: async () => parsed },
      model: MODEL,
    });
    const result = await valueProposer.propose(row.text);
    perRow.push({
      id: row.id,
      gold: row.gold,
      outcome: result.ok ? 'proposed' : `failed:${result.failure.reason}`,
      ms: Date.now() - started,
      // The reply is kept for the length of one debugging session, not forever: a reading that
      // says "ungrounded" without showing what the model wrote cannot be acted on.
      replyHead: head(reply),
      ...(result.ok
        ? {
            facts: result.proposal.facts.length,
            withheld: result.proposal.withheld.map((entry) => entry.reason),
            candidates: result.proposal.candidates,
          }
        : { detail: result.failure.detail.slice(0, 160) }),
    });
  }

  const summary = summarise(perRow, {
    model: MODEL,
    endpoint: ENDPOINT,
    dtype: DTYPE,
    promptVersion: PROPOSER_PROMPT_VERSION,
    seconds: model.seconds,
  });

  writeFileSync(join(HERE, 'live-result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, perRow: undefined }, null, 2));
  if (flag('dry')) console.log('dry run: nothing is claimed about quality from this output');
}

await main();

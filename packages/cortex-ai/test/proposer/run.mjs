/**
 * The proposer driven by a real model -- on this device, or over an API. Not part of `pnpm test`.
 *
 * ## Why this script exists
 *
 * Every other test of the proposal layer feeds it exact model output. That is the right way to test
 * the gates and the wrong way to answer the only question a reader has: *does a model small enough
 * to run on a laptop produce anything these gates keep?* This script answers that with a number,
 * over the same sixty hand-labelled sentences the rule layer is measured on, and it stores the
 * answer so a later run can be compared rather than argued with.
 *
 * ## Two backends, one script, one report
 *
 * `--llm local` (the default) runs an on-device checkpoint: network access to a weights host, about
 * 400 MB, a few minutes of CPU. `--llm remote` runs an OpenAI-compatible provider, which is the only
 * way to ask whether the four gates behave the same way on a model that is not 0.5B. The backend is
 * resolved by `resolveLlmProfile` -- the same function the product uses -- so `--llm remote` without
 * a key is an error here too, and the report carries the profile line rather than a model name that
 * implies a backend.
 *
 * The point of running this on both is not "which model is better". It is that the step-9 reading
 * (44 of 60 replies copied the prompt's example, every one dropped as ungrounded) is a statement
 * about **a small model and a gate**, and a large model cannot reproduce the failure it measured.
 * Running both is how that distinction stops being an assumption.
 *
 * Usage:
 *
 *     node test/proposer/run.mjs                       # default checkpoint, all 60 sentences
 *     node test/proposer/run.mjs --limit 10 --dry     # smoke: load the model, one batch
 *     node test/proposer/run.mjs --llm remote --model deepseek-chat
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
import {
  ProfileError,
  OpenAICompatibleLLM,
  describeProfile,
  readApiKey,
  resolveLlmProfile,
} from '@agentix-e/cortex-ai';
import { createLocalLLM } from '@agentix-e/cortex-ai/local';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../../cortex-core/src/triage/__tests__/fixtures/triage-labels.json');
// The switches belong to `resolveLlmProfile`: `CORTEX_LLM_BACKEND`, `CORTEX_LOCAL_MODEL`,
// `CORTEX_LOCAL_DTYPE`, `CORTEX_HF_ENDPOINT`, and the three `CORTEX_LLM_*` for the remote backend.
// This script used to define its own two (`CORTEX_PROPOSER_MODEL`, `CORTEX_PROPOSER_DTYPE`), and a
// second naming scheme for the same decision is how a run ends up on a checkpoint nobody recorded.

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
/**
 * What `--llm` and `--model` mean, read once.
 *
 * Declared from the argument *or* the environment, and here rather than at module scope because the
 * first version of this change resolved the backend before `argv` was parsed: `--llm remote` was
 * accepted, ignored, and the run quietly loaded the checkpoint -- a flag that does nothing is worse
 * than a flag that does not exist, because the transcript then says "remote".
 */
/**
 * The mirror is this host's default, and the profile is where it is recorded.
 *
 * `DEFAULT_WEIGHT_HOST` in `cortex-ai` is the official Hub, which is the right default for a library:
 * naming a third-party mirror in shipped code would be a decision taken on the user's behalf. On a
 * build host that cannot reach the Hub, the default belongs here, in the script, where it is visible
 * and printed -- and it is set through the same environment variable the profile reads, rather than
 * through a second parameter that could disagree with it.
 */
process.env['CORTEX_HF_ENDPOINT'] ??= 'https://hf-mirror.com';

function resolveBackend() {
  return value('llm', process.env.CORTEX_LLM_BACKEND ?? 'local');
}

function resolveModel() {
  return value('model', undefined);
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
    // One field instead of `endpoint` + `dtype`: those three could disagree with each other, and a
    // reading whose provenance is three strings that might not match is worse than one string that
    // cannot be assembled by hand.
    profile: meta.profile ?? '(unrecorded)',
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

  const backend = resolveBackend();
  const chosen = resolveModel();
  let profile;
  try {
    profile = resolveLlmProfile(
      {
        backend,
        ...(chosen === undefined ? {} : { model: chosen }),
        // The recorded readings were taken at q4 (about 400 MB on disk). The profile's own default is
        // fp32 -- the unquantised weights, which is the safe thing for a library to assume -- so a
        // script that wants the same checkpoint the numbers came from has to say so. Thirty seconds
        // of a connect timeout is what forgetting it costs, because fp32 is a different file.
        dtype: value('dtype', 'q4'),
      },
      process.env,
    );
  } catch (error) {
    if (error instanceof ProfileError) {
      console.error(`configuration: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  let model;
  if (profile.backend === 'local') {
    console.log(`loading ${profile.model} (dtype ${profile.dtype}) from ${profile.weightHost}`);
    /**
     * The shipped adapter, not a second one.
     *
     * This script used to hand-roll a `pipeline` call and a tiny `LocalModel` around it, and the
     * hand-rolled version read `env.remoteHost` from the wrong place: after a refactor it silently
     * talked to `huggingface.co` instead of the configured mirror and died on a connect timeout,
     * while `createLocalLLM` in the same repository was talking to the mirror correctly. Two
     * implementations of "load a checkpoint" is one too many, and this is the one that was wrong.
     */
    model = await createLocalLLM({
      model: profile.model,
      dtype: profile.dtype,
      maxNewTokens: 192,
      env: { remoteHost: profile.weightHost },
    });
  } else {
    console.log(`calling ${profile.model} at ${profile.baseUrl}`);
    model = new OpenAICompatibleLLM({
      baseUrl: profile.baseUrl,
      apiKey: readApiKey(process.env),
      model: profile.model,
    });
  }
  const identity = { model: profile.model, provider: profile.backend };
  // Constructed so the same options the product uses are exercised by the type system; the loop
  // below feeds parsed replies through a second proposer rather than paying for one call per gate.
  const proposer = new TriageProposer({ llm: model, ...identity });
  void proposer;

  const startedAt = Date.now();
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
      ...identity,
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
    model: profile.model,
    profile: describeProfile(profile),
    promptVersion: PROPOSER_PROMPT_VERSION,
    // Wall clock over the generation loop, so a local checkpoint and a provider are measured the same
    // way: seconds of generation per sentence, not seconds of the run (which would include the load).
    seconds: (Date.now() - startedAt) / 1000,
  });

  // `--out` exists so a second configuration does not overwrite the first reading: two backends, two
  // files, and the comparison is a diff instead of a memory.
  const out = join(HERE, value('out', 'live-result.json'));
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(`wrote ${out}`);
  console.log(JSON.stringify({ ...summary, perRow: undefined }, null, 2));
  if (flag('dry')) console.log('dry run: nothing is claimed about quality from this output');
}

await main();

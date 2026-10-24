#!/usr/bin/env node
/**
 * A3, as three commands: prepare the cards, review them twice, score the decisions.
 *
 * ## Why this exists
 *
 * A3 has been pre-registered since the plan was written -- "acceptance rate difference >= 10pp,
 * n >= 20, paired" -- and until this script existed there was **no way to produce that number**.
 * A criterion nobody can compute is a sentence. This is the instrument; the clicks are still a
 * person's, and the script says so rather than pretending otherwise.
 *
 * ## The three steps
 *
 *     node tools/a3-review.mjs prepare --out /tmp/a3/cards.json --limit 20 [--llm local]
 *     node tools/a3-review.mjs review  --cards /tmp/a3/cards.json --decisions /tmp/a3/decisions.jsonl
 *     node tools/a3-review.mjs dosage  --cards /tmp/a3/cards.json
 *     node tools/a3-review.mjs score   --decisions /tmp/a3/decisions.jsonl
 *
 * `prepare` needs a model: each card is proposed to exactly as the product would, so the atoms are
 * what a user would actually see. `--llm none` produces the source arm only, which makes the review
 * unpaired -- useful for a dry run, not for the criterion.
 *
 * ## Two decisions that make the measurement mean something
 *
 * 1. **The same card, twice.** A3 is about presentation, so each card is judged once as the sentence
 *    the person said and once as the model's split of it. Comparing different cards would measure
 *    the cards.
 * 2. **The order alternates.** Even-indexed cards show the sentence first, odd-indexed cards show the
 *    atoms first, so a fatigue effect lands on both arms instead of on whichever came second.
 *
 * A third, less comfortable one: the arms are **not hidden**. A reviewer who edits a card knows
 * whether they are editing a sentence or an atom, and hiding that would need a different interface
 * rather than a different flag. It is recorded here because it is a limitation of the measurement,
 * not a detail of the implementation.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { positionEffect, scoreA3 } from '../packages/cortex-eval/dist/index.js';
import {
  ProfileError,
  describeProfile,
  readApiKey,
  resolveLlmProfile,
} from '../packages/cortex-ai/dist/index.js';
import { DisclosureSession } from '../packages/cortex-memory/dist/index.js';
import { PROPOSER_PROMPT_VERSION, TriageProposer } from '../packages/cortex-core/dist/index.js';
import { SqliteStorage } from '../packages/cortex-storage/dist/storage/sqlite.js';

const FIXTURE = new URL(
  '../packages/cortex-core/src/triage/__tests__/fixtures/triage-labels.json',
  import.meta.url,
);

function options(argv) {
  const out = {
    command: argv[0],
    llm: process.env['CORTEX_LLM_BACKEND'] ?? 'none',
    dtype: process.env['CORTEX_LOCAL_DTYPE'] ?? 'q4',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return out;
}

/**
 * The proposer for whatever configuration was asked for, plus the record of what that was.
 *
 * The record is the point. Two `cards.json` files built from different checkpoints are otherwise
 * indistinguishable, and the whole question this step asks -- does a stronger model give the review
 * anything to measure -- is answered by comparing them.
 */
async function buildProposer(backend, model, dtype) {
  const profile = resolveLlmProfile(
    { backend, ...(model === undefined ? {} : { model }), ...(dtype === undefined ? {} : { dtype }) },
    process.env,
  );

  if (profile.backend === 'local') {
    const { createLocalLLM } = await import('../packages/cortex-ai/dist/local/index.js');
    const client = await createLocalLLM({
      model: profile.model,
      dtype: profile.dtype,
      env: { remoteHost: profile.weightHost },
    });
    return {
      proposer: new TriageProposer({ llm: client, model: profile.model, provider: 'local' }),
      profile,
    };
  }

  const { OpenAICompatibleLLM } = await import('../packages/cortex-ai/dist/index.js');
  const client = new OpenAICompatibleLLM({
    baseUrl: profile.baseUrl,
    apiKey: readApiKey(process.env),
    model: profile.model,
  });
  return {
    proposer: new TriageProposer({ llm: client, model: profile.model, provider: 'remote' }),
    profile,
  };
}

/**
 * How different the two arms actually are, per card.
 *
 * Normalised the way the grounding gate normalises, so "the model trimmed the leading clause" is not
 * reported as a rewrite because of a double space.
 */
function classifyCard(card) {
  const norm = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const atoms = card.atoms ?? [];
  if (atoms.length === 0) return 'none';
  if (atoms.length >= 2) return 'split';
  return norm(atoms[0]) === norm(card.source) ? 'identical' : 'one-different';
}

async function prepare(config) {
  const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows;
  const limit = Number(config.limit ?? 20);
  // Every row is offered, in fixture order, and the ones that produce a card are kept until the arm
  // is full. Filtering by the gold label first was the obvious version and it under-filled the arm:
  // two rows labelled `defer` are judged private by the current table, so asking for twenty "defer"
  // rows yielded eighteen pairs -- one short of the pre-registered count, for a reason that has
  // nothing to do with the treatment.
  const candidates = rows;

  const home = `${dirname(config.out)}/stores`;
  mkdirSync(home, { recursive: true });
  const storage = {
    private: new SqliteStorage({ filename: `${home}/private.db` }),
    shared: new SqliteStorage({ filename: `${home}/shared.db` }),
  };
  const backend = config.llm ?? process.env['CORTEX_LLM_BACKEND'] ?? 'none';
  const built =
    backend === 'none'
      ? { proposer: undefined, profile: undefined }
      : await buildProposer(backend, config.model, config.dtype);
  const session = new DisclosureSession({
    private: storage.private,
    shared: storage.shared,
    ...(built.proposer === undefined ? {} : { proposer: built.proposer }),
  });

  const cards = [];
  for (const row of candidates) {
    if (cards.length >= limit) break;
    const { card } = await session.say(row.text, { id: row.id });
    if (card === null) continue;
    const atoms = [];
    if (built.proposer !== undefined) {
      const result = await session.propose(card.id);
      if (result.ok) for (const fact of result.proposal.facts) atoms.push(fact.text);
    }
    cards.push({
      cardId: card.id,
      gold: row.gold,
      source: card.text,
      atoms,
      ...(built.profile === undefined ? {} : { profile: describeProfile(built.profile) }),
      // The prompt is a variable of the treatment: v2 and v3 differ only in how they ask for a
      // split, and a `cards.json` that did not name its prompt would make the two files
      // indistinguishable -- which is the mistake this file exists to prevent, caught in itself.
      promptVersion: PROPOSER_PROMPT_VERSION,
    });
    console.error(`  ${card.id}: ${atoms.length} atom(s)`);
  }

  writeFileSync(config.out, `${JSON.stringify({ prepared: new Date().toISOString(), cards }, null, 2)}\n`);
  console.error(`wrote ${cards.length} card(s) to ${config.out}`);
  if (built.profile !== undefined) console.error(`profile: ${describeProfile(built.profile)}`);
  await storage.private.close();
  await storage.shared.close();
}

async function review(config) {
  const { cards } = JSON.parse(readFileSync(config.cards, 'utf8'));
  const decisions = config.decisions;
  const done = new Set();
  if (existsSync(decisions)) {
    for (const line of readFileSync(decisions, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const trial = JSON.parse(line);
      done.add(`${trial.cardId}:${trial.arm}`);
    }
  }

  // Lines from an async iterator rather than `rl.question`: a piped stdin (which is how this gets
  // smoke-tested) ends with the last line, and `question` on a finished stream leaves a promise that
  // never settles. An iterator turns that into a plain `done`.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async () => {
    const { value, done: ended } = await lines.next();
    return ended === true ? null : String(value).trim();
  };
  const ask = async (label) => {
    process.stdout.write(label);
    return nextLine();
  };

  console.log(`A3 review: ${cards.length} card(s), each shown twice. [a]ccept  [d]ismiss  [e]dit  [s]kip`);
  let written = 0;

  for (const [index, card] of cards.entries()) {
    // Alternate which presentation comes first, so a fatigue effect does not land on one arm.
    const order = index % 2 === 0 ? ['source', 'atoms'] : ['atoms', 'source'];
    for (const arm of order) {
      if (done.has(`${card.cardId}:${arm}`)) continue;
      const shown = arm === 'source' ? [card.source] : card.atoms;
      if (shown.length === 0) {
        console.log(`\n[${card.cardId}] ${arm}: (no atoms were proposed -- skipped)`);
        continue;
      }

      console.log(`\n[${index + 1}/${cards.length}] ${arm}`);
      for (const line of shown) console.log(`    ${line}`);

      const started = Date.now();
      let decision = null;
      while (decision === null) {
        const answer = await ask('  a=accept  d=dismiss  e=edit  s=skip > ');
        if (answer === null) {
          rl.close();
          console.log(`\ninput ended after ${written} decision(s); progress is saved in ${decisions}`);
          return;
        }
        const key = answer.toLowerCase();
        if (key === 'a') decision = { kind: 'accept' };
        else if (key === 'd') decision = { kind: 'dismiss' };
        else if (key === 's') decision = { kind: 'skip' };
        else if (key === 'e') {
          const text = await ask('  edited wording > ');
          if (text !== null && text !== '') decision = { kind: 'edit', editedTo: text };
        }
      }
      if (decision.kind === 'skip') continue;

      appendFileSync(
        decisions,
        `${JSON.stringify({
          cardId: card.cardId,
          arm,
          decision: decision.kind,
          ...(decision.editedTo === undefined ? {} : { editedTo: decision.editedTo }),
          elapsedMs: Date.now() - started,
        })}\n`,
      );
      written += 1;
    }
  }
  rl.close();
  console.log(`\n${written} decision(s) written to ${decisions}. Now run: score --decisions ${decisions}`);
}

function score(config) {
  const trials = readFileSync(config.decisions, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const result = scoreA3(trials);

  console.log(`${result.pairCount} pair(s), ${result.discordant} discordant`);
  for (const arm of result.arms) {
    console.log(
      `  ${arm.arm.padEnd(7)} ${arm.accepted}/${arm.trials} accepted (${(arm.rate * 100).toFixed(1)}%, ` +
        `95% CI ${(arm.interval.lower * 100).toFixed(1)}-${(arm.interval.upper * 100).toFixed(1)}%), ` +
        `${arm.edited} edited, median ${arm.medianMs ?? '-'} ms`,
    );
  }
  console.log(`  delta ${result.deltaPp.toFixed(1)}pp, exact McNemar p=${result.mcnemarP.toFixed(4)}`);

  // The arm medians above are per-arm totals, and with an alternating order they mix two positions.
  // Printing them without this line invites a reading the data cannot support -- the first dataset had
  // the first showing slower in twenty pairs out of twenty, at nine times the median.
  const position = positionEffect(trials);
  if (position.pairs > 0) {
    console.log(
      `  position ${position.firstSlower}/${position.pairs} pair(s) took longer on the first showing ` +
        `(median ${position.firstMedianMs} ms vs ${position.secondMedianMs} ms)`,
    );
    if (position.firstSlower / position.pairs >= 0.75) {
      console.log(
        '           the arm medians above are confounded by position: reading a card is the cost,',
      );
      console.log('           so compare arms within a position, not across them');
    }
  }
  console.log(`\n${result.verdict.toUpperCase()}: ${result.reason}`);
}

/**
 * The gate that has to pass before the clicks are worth spending.
 *
 * A3 asks whether showing atoms beats showing the sentence. If both arms show the same text, the
 * answer is "they are identical" for reasons that have nothing to do with presentation -- and the
 * experiment cannot be told apart from no experiment. Step 13 measured 14 of 20 cards with identical
 * arms and one split; this command is that arithmetic, made mechanical so a later run cannot be
 * argued into existence by a paragraph.
 *
 * The threshold is pre-registered in docs/03 section 7.1.1: at least half the cards must carry two
 * or more atoms. It is a gate on **the treatment**, not on the result -- passing it says the
 * experiment is worth running, not that atoms will win.
 */
function dosage(config) {
  const { cards } = JSON.parse(readFileSync(config.cards, 'utf8'));
  const kinds = ['split', 'one-different', 'identical', 'none'];
  const counts = new Map(kinds.map((kind) => [kind, 0]));
  for (const card of cards) counts.set(classifyCard(card), (counts.get(classifyCard(card)) ?? 0) + 1);

  const usable = cards.length - (counts.get('none') ?? 0);
  const split = counts.get('split') ?? 0;
  const share = usable === 0 ? 0 : split / usable;
  const distinct = (key) => [...new Set(cards.map((card) => card[key] ?? '(unrecorded)'))];

  console.log(`${cards.length} card(s), ${usable} with a proposal`);
  for (const kind of kinds) {
    const label = {
      split: 'two or more atoms (the treatment)',
      'one-different': 'one atom, reworded or trimmed',
      identical: 'one atom, the same text as the sentence',
      none: 'no proposal at all',
    }[kind];
    console.log(`  ${String(counts.get(kind) ?? 0).padStart(4)}  ${label}`);
  }
  console.log(`  treatment share: ${(share * 100).toFixed(1)}% of ${usable} (gate: 50%)`);
  for (const profile of distinct('profile')) console.log(`  profile: ${profile}`);
  for (const prompt of distinct('promptVersion')) console.log(`  prompt: ${prompt}`);
  console.log(share >= 0.5 ? '\nGATE PASS: the arms differ enough to measure.' : `\nGATE FAIL: ${split}/${usable} cards carry two or more atoms. Collecting clicks now would measure the model, not the presentation.`);
}

const config = options(process.argv.slice(2));
if (config.command === 'prepare') await prepare(config);
else if (config.command === 'review') await review(config);
else if (config.command === 'score') score(config);
else if (config.command === 'dosage') dosage(config);
else {
  console.error('expected: prepare | review | score | dosage');
  process.exit(1);
}

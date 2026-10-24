#!/usr/bin/env node
/**
 * The disclosure chain, runnable: say something, answer the question, read what a colleague sees.
 *
 * ## What this is, and what it is not
 *
 * It is the **demo** of `DisclosureSession` -- the smallest thing that makes the write side, the card
 * queue, the proposal layer and the read side observable in one place, across process boundaries,
 * against two real SQLite files. It is not a product surface: no shell, no prompts, no history, and
 * no tests of its own. What it is for is answering the question a test cannot -- *who calls this, and
 * what does a person see when it fails?* -- and leaving a transcript behind that a reader can rerun.
 *
 * Every command is one process. That is deliberate: the state has to be on disk, not in memory, for
 * the second command to work, which is the property the session's own test can only simulate.
 *
 * ## Usage
 *
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo say "I moved to Berlin in March."
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo cards
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo propose <id> --llm local
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo accept <id> --atom 0
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo check shared "The plan moves to Thursday [[c3]]."
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo facts
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo release <id> --acknowledge rule-override
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo releases
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo export
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo ask shared
 *
 * `--llm local` loads an on-device model through `@agentix-e/cortex-ai/local` and needs weights (the
 * default checkpoint is 0.5B, about 400 MB quantised). `--llm remote` reads `CORTEX_LLM_BASE_URL`,
 * `CORTEX_LLM_API_KEY` and `CORTEX_LLM_MODEL` from the environment and never from a file here.
 * `--llm` defaults to `CORTEX_LLM_BACKEND`, and to `none`: the chain admits, asks and publishes
 * without a model, and a demo that quietly loaded one would hide that.
 *
 * The two backends are resolved by `resolveLlmProfile`, which prints a one-line record before doing
 * anything. That line is what makes a transcript attributable: a reading produced by a 0.5B
 * checkpoint and one produced by an API model are otherwise two paragraphs that look alike.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Built artefacts by path, the way `tools/export-census.mjs` imports the census: this script lives
// outside every package's resolution graph on purpose, so it cannot become a dependency of one.
import { SqliteStorage } from '../packages/cortex-storage/dist/storage/sqlite.js';
import { DisclosureSession } from '../packages/cortex-memory/dist/index.js';
import { TriageProposer } from '../packages/cortex-core/dist/index.js';
import {
  ProfileError,
  describeProfile,
  readApiKey,
  resolveLlmProfile,
} from '../packages/cortex-ai/dist/index.js';

function parse(argv) {
  const options = {
    home: '.cortex-demo',
    atom: undefined,
    acknowledge: undefined,
    llm: process.env['CORTEX_LLM_BACKEND'] ?? 'none',
    model: undefined,
    // The recorded readings used q4 (about 400 MB for the 0.5B checkpoint). The profile's own
    // default is fp32 -- unquantised, and the safe thing to be silent about -- so this tool names
    // the quantisation it uses and prints it, rather than inheriting a library default.
    dtype: process.env['CORTEX_LOCAL_DTYPE'] ?? 'q4',
    id: undefined,
  };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = argv[index + 1];
      if (name === 'atom') options.atom = Number(value);
      else if (name === 'home') options.home = value;
      else if (name === 'llm') options.llm = value;
      else if (name === 'model') options.model = value;
      else if (name === 'dtype') options.dtype = value;
      else if (name === 'id') options.id = value;
      else if (name === 'acknowledge') options.acknowledge = value;
      else throw new Error(`unknown option --${name}`);
      index += 1;
    } else {
      rest.push(token);
    }
  }
  return { ...options, command: rest[0], args: rest.slice(1) };
}

/**
 * The proposer, built from a resolved profile.
 *
 * `none` is a first-class value, not a fallback: the chain admits, asks and publishes without a
 * model. `remote` without a key is an **error**, never a downgrade to `local` -- a silent downgrade
 * would let a transcript claim an API model while a 0.5B checkpoint produced every atom, and nothing
 * in the output would show it.
 */
async function buildProposer(backend, model, dtype) {
  if (backend === 'none') return { proposer: undefined, profile: undefined };
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

function renderCard(card) {
  const lines = [`${card.id}  ${card.state}  ${card.reason}`];
  lines.push(`    text: ${card.text}`);
  if (card.proposal !== undefined) {
    lines.push(`    offered (${card.proposal.promptVersion}, ${card.proposal.model ?? 'unknown model'}):`);
    card.proposal.facts.forEach((fact, index) => {
      const marks = fact.redactions.map((span) => `${span.kind}[${span.start},${span.end})`).join(' ');
      lines.push(`      [${index}] ${fact.text}${marks === '' ? '' : `  (mask ${marks})`}`);
    });
    if (card.proposal.withheld.length > 0) {
      lines.push(
        `    withheld: ${card.proposal.withheld.map((row) => row.reason).join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

async function main() {
  const { command, args, home, atom, llm, model, dtype, id, acknowledge } = parse(process.argv.slice(2));
  if (command === undefined) {
    throw new Error(
      'expected a command: say | facts | cards | propose | accept | dismiss | release | releases | ask | check | export',
    );
  }

  mkdirSync(home, { recursive: true });
  const storage = {
    private: new SqliteStorage({ filename: join(home, 'private.db') }),
    shared: new SqliteStorage({ filename: join(home, 'shared.db') }),
  };
  let built;
  try {
    built = await buildProposer(llm, model, dtype);
  } catch (error) {
    if (error instanceof ProfileError) {
      console.error(`configuration: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const { proposer, profile } = built;
  const session = new DisclosureSession({
    private: storage.private,
    shared: storage.shared,
    ...(proposer === undefined ? {} : { proposer }),
  });

  try {
    if (command === 'say') {
      const text = args.join(' ');
      if (text.trim() === '') throw new Error('say needs a sentence');
      const { admission, card } = await session.say(text, id === undefined ? {} : { id });
      if (!admission.stored) {
        console.log(`withheld by ${admission.withheld.rule}: ${admission.withheld.policy}`);
        console.log('not stored anywhere, and no card exists for it.');
      } else {
        console.log(`${admission.id}  stored ${admission.visibility}  (rule: ${admission.triage.rule ?? 'none, deferred'})`);
        // `null` has two different causes and the operator has to be able to tell them apart: a rule
        // answered the question, or the turn holds no claim to ask about. Printing the first message
        // for the second case would be the CLI lying about what the rules did -- they deferred it,
        // and it was the claims gate, not a rule, that declined to open a question.
        if (card !== null) console.log(renderCard(card));
        else if (admission.triage.scope === 'defer') {
          console.log('no question: this turn contains no claim, only requests or questions, so it is');
          console.log('stored privately and there is nothing a colleague could be shown.');
        } else console.log('no question: the rules already answered it.');
      }
    } else if (command === 'cards') {
      const cards = await session.cards();
      console.log(cards.length === 0 ? 'no cards' : cards.map(renderCard).join('\n\n'));
    } else if (command === 'propose') {
      const cardId = args[0];
      if (cardId === undefined) throw new Error('propose needs a card id');
      if (profile !== undefined) console.log(`profile: ${describeProfile(profile)}`);
      const result = await session.propose(cardId);
      if (!result.ok) {
        console.log(`no proposal (${result.failure.reason}): ${result.failure.detail}`);
        console.log('the card keeps the sentence the person said.');
      } else {
        console.log(renderCard(await session.cards().then((cards) => cards.find((card) => card.id === cardId))));
      }
    } else if (command === 'accept') {
      const cardId = args[0];
      if (cardId === undefined) throw new Error('accept needs a card id');
      const card = await session.accept(cardId, atom === undefined ? {} : { atom });
      if (card.refused === undefined) {
        console.log(`${card.id}  ${card.state}  published: ${card.text}`);
      } else {
        console.log(`${card.id}  still ${card.state}  refused by ${card.refused.rule}: ${card.refused.policy}`);
        console.log('nothing was published; the card keeps the sentence it had.');
      }
    } else if (command === 'release') {
      const id = args[0];
      if (id === undefined) throw new Error('release needs a fact id (see the `facts` command)');
      try {
        const { record } = await session.release(id, { acknowledge: acknowledge ?? '' });
        console.log(`released ${record.id}: rule ${record.rule} overridden`);
        console.log(`  policy: ${record.policy}`);
        console.log(`  digest: ${record.digestAlgorithm} ${record.digest.slice(0, 16)}…`);
        console.log(`  recorded at ${new Date(record.releasedAt).toISOString()}` + (record.completedAt === null ? ' (INCOMPLETE)' : ''));
      } catch (error) {
        // The writer throws the warning itself, so the CLI does not restate the policy in its own
        // words -- one sentence, one source.
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    } else if (command === 'releases') {
      const records = await session.releases();
      console.log(`${records.length} override(s)`);
      for (const record of records) {
        const done = record.completedAt === null ? 'INCOMPLETE' : 'complete';
        console.log(`  ${record.id}  ${record.rule}  ${done}  ${record.digest.slice(0, 12)}…`);
        console.log(`      ${record.text}`);
      }
    } else if (command === 'facts') {
      // `evidence('private')` is what the *owner* can see, which is both stores -- a private task
      // reads the shared window too. The label said "in the private store" and then listed a shared
      // row, which is the kind of caption that teaches a reader the wrong model.
      const rows = await session.evidence('private');
      console.log(`${rows.length} row(s) visible to the owner`);
      for (const row of rows) {
        const fact = row.value;
        console.log(`  ${row.key}  [${row.origin}]  rule:${fact.triage.rule ?? '-'}  ${fact.text}`);
      }
    } else if (command === 'dismiss') {
      const cardId = args[0];
      if (cardId === undefined) throw new Error('dismiss needs a card id');
      const card = await session.dismiss(cardId);
      console.log(`${card.id}  ${card.state}`);
    } else if (command === 'check') {
      const task = args[0];
      const draft = args.slice(1).join(' ');
      if (task !== 'shared' && task !== 'private') throw new Error('check needs a scope: shared or private');
      if (draft.trim() === '') throw new Error('check needs a draft');
      const scan = await session.check(draft, { task });
      console.log(`${scan.verdict}  (${scan.findings.length} finding(s)) for a ${task} task`);
      for (const finding of scan.findings) {
        const why = finding.excusedBy === undefined ? '' : `  excused by ${finding.excusedBy}`;
        console.log(`  ${finding.kind}${finding.rule === null ? '' : ` [${finding.rule}]`}: ${finding.excerpt}${why}`);
      }
    } else if (command === 'export') {
      console.log(await session.export());
    } else if (command === 'ask') {
      const task = args[0];
      if (task !== 'shared' && task !== 'private') throw new Error('ask needs a scope: shared or private');
      const rows = await session.evidence(task);
      console.log(`${rows.length} row(s) visible to a ${task} task`);
      for (const row of rows) {
        console.log(`  ${row.key ?? '<no id>'}  [${row.origin}]  ${row.value.text}`);
      }
    } else {
      throw new Error(`unknown command ${JSON.stringify(command)}`);
    }
  } finally {
    await storage.private.close();
    await storage.shared.close();
  }
}

await main();

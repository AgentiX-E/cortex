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
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo export
 *     node tools/triage-demo.mjs --home /tmp/cortex-demo ask shared
 *
 * `--llm local` loads a small on-device model through `@agentix-e/cortex-ai/local` and needs weights
 * (the default checkpoint is 0.5B, about 400 MB quantised). `--llm openai` reads
 * `CORTEX_LLM_BASE_URL`, `CORTEX_LLM_API_KEY` and `CORTEX_LLM_MODEL` from the environment and never
 * from a file in this repository.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Built artefacts by path, the way `tools/export-census.mjs` imports the census: this script lives
// outside every package's resolution graph on purpose, so it cannot become a dependency of one.
import { SqliteStorage } from '../packages/cortex-storage/dist/storage/sqlite.js';
import { DisclosureSession } from '../packages/cortex-memory/dist/index.js';
import { TriageProposer } from '../packages/cortex-core/dist/index.js';

function parse(argv) {
  const options = { home: '.cortex-demo', atom: undefined, llm: 'none', model: undefined, id: undefined };
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
      else if (name === 'id') options.id = value;
      else throw new Error(`unknown option --${name}`);
      index += 1;
    } else {
      rest.push(token);
    }
  }
  return { ...options, command: rest[0], args: rest.slice(1) };
}

/**
 * The proposer, built only when a model was asked for.
 *
 * `none` is a first-class value, not a fallback: the chain admits, asks and publishes without a
 * model, and a demo that quietly loaded one would hide that.
 */
async function buildProposer(llm, model) {
  if (llm === 'none') return undefined;
  if (llm === 'local') {
    const { createLocalLLM } = await import('../packages/cortex-ai/dist/local/index.js');
    const id = model ?? process.env['CORTEX_LOCAL_MODEL'] ?? 'onnx-community/Qwen2.5-0.5B-Instruct';
    const client = await createLocalLLM({
      model: id,
      dtype: 'q4',
      env: { remoteHost: process.env['CORTEX_HF_ENDPOINT'] ?? 'https://hf-mirror.com' },
    });
    return new TriageProposer({ llm: client, model: id });
  }
  if (llm === 'openai') {
    const { OpenAICompatibleLLM } = await import('../packages/cortex-ai/dist/index.js');
    const baseUrl = process.env['CORTEX_LLM_BASE_URL'];
    const apiKey = process.env['CORTEX_LLM_API_KEY'];
    const id = process.env['CORTEX_LLM_MODEL'] ?? model;
    if (baseUrl === undefined || apiKey === undefined || id === undefined) {
      throw new Error(
        '--llm openai needs CORTEX_LLM_BASE_URL, CORTEX_LLM_API_KEY and CORTEX_LLM_MODEL in the ' +
          'environment: this repository never stores a key',
      );
    }
    const client = new OpenAICompatibleLLM({ baseUrl, apiKey, model: id });
    return new TriageProposer({ llm: client, model: id });
  }
  throw new Error(`unknown --llm ${JSON.stringify(llm)}: expected none, local or openai`);
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
  const { command, args, home, atom, llm, model, id } = parse(process.argv.slice(2));
  if (command === undefined) {
    throw new Error('expected a command: say | cards | propose | accept | dismiss | ask | check | export');
  }

  mkdirSync(home, { recursive: true });
  const storage = {
    private: new SqliteStorage({ filename: join(home, 'private.db') }),
    shared: new SqliteStorage({ filename: join(home, 'shared.db') }),
  };
  const proposer = await buildProposer(llm, model);
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
        console.log(card === null ? 'no question: the rules already answered it.' : renderCard(card));
      }
    } else if (command === 'cards') {
      const cards = await session.cards();
      console.log(cards.length === 0 ? 'no cards' : cards.map(renderCard).join('\n\n'));
    } else if (command === 'propose') {
      const cardId = args[0];
      if (cardId === undefined) throw new Error('propose needs a card id');
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

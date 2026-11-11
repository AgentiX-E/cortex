#!/usr/bin/env node
/**
 * Cortex as the **child** in the system-under-test protocol.
 *
 * `tools/competitor-sut/` puts a competitor's store behind `PROTOCOL.md` so this repository can read it. This
 * file is the same protocol in the other direction: a competitor's harness spawns it and asks the three
 * questions, so *our* store can be read by *their* harness, their answer prompt and their judge.
 *
 * ## Why the protocol and not an import
 *
 * Their harness is Python and its provider is an ABC with five methods. This side is a Node package with a
 * build step. The process boundary is the only interface both sides already have, and reusing
 * `tools/competitor-sut/PROTOCOL.md` byte for byte means the two directions cannot drift into two protocols.
 * The op names, the response envelope and the failure semantics are that document's, unchanged.
 *
 * ## What is being measured, and what is deliberately not
 *
 * `search` returns admitted turns and **never answers**. Their harness generates the answer from its own
 * prompt (21,366 characters of it, `MEASURE-COMPETITOR-PAIRING.md` §6), so the number this adapter feeds is a
 * measurement of *our retrieval* under *their* reader and *their* judge. Our evidence assembly, contracts and
 * repairs are not exercised here -- if they were, the run would be a measurement of two systems sharing a
 * judge rather than of one variable.
 *
 * That is the intended reading. `MEASURE-COMPETITOR-PAIRING.md` §5 licenses this run as the only way to answer
 * "how much of the 4.40 points is harness", and a harness effect can only be isolated by holding the harness
 * fixed.
 *
 * ## Configuration
 *
 * All of it is environment, because their `Provider.initialize(config)` carries an `extras` dict and a
 * `container_tag` rather than a constructor: the parent passes nothing this side can rely on, so the arm is
 * named here.
 *
 * | variable | default | what it is |
 * | --- | --- | --- |
 * | `CORTEX_ADAPTER_LABEL` | `cortex-session` | the row label in their report |
 * | `CORTEX_ADAPTER_SESSION_BUDGET` | unbounded | the admission ceiling, in `budgetUnit` |
 * | `CORTEX_ADAPTER_BUDGET_UNIT` | `turns` | `turns` or `chars` |
 * | `CORTEX_ADAPTER_THRESHOLD` | `0` | the relevance floor |
 * | `CORTEX_ADAPTER_TRIM` | `0` | `1` turns on turn-level trimming |
 * | `CORTEX_ADAPTER_NOW` | dispatch time | the clock the date arithmetic reads |
 *
 * ## The one rule this file adds to `PROTOCOL.md`
 *
 * `search` must return **at most** `limit` hits. Their harness passes `limit` as a session count and this
 * adapter's `limit` is a hit count, exactly the unit error `provider.ts` records at 25.4% recall — so the
 * ceiling is enforced here, on the way out, rather than trusted to the caller's number.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Where `CortexSessionProvider` lives, tried in the order a reader would try it.
 *
 * The bridge is copied into the competitor's tree (`adapters/cortex_bridge.mjs`), so a relative import of this
 * repository's `dist/` cannot resolve: it is not an ancestor any more. Three candidates are tried and all three
 * are named in the error, because "cannot find module" from inside someone else's harness is not a message
 * anyone can act on:
 *
 * 1. `CORTEX_ADAPTER_MEMORY` — an absolute path, which is what the README's two-command recipe sets.
 * 2. Beside this file: `../../packages/cortex-memory/dist/index.js`, which is right when the tool runs from
 *    this repository, as every test of it does.
 * 3. Under the working directory: `packages/cortex-memory/dist/index.js`, for a harness started from the root
 *    of this checkout.
 */
async function loadMemory() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CORTEX_ADAPTER_MEMORY,
    join(here, '..', '..', 'packages', 'cortex-memory', 'dist', 'index.js'),
    resolve(process.cwd(), 'packages', 'cortex-memory', 'dist', 'index.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return await import(pathToFileURL(candidate).href);
  }
  throw new Error(
    `cannot find cortex-memory's build; tried ${candidates.join(', ')}. Run \`pnpm build\` in the checkout and ` +
      'set CORTEX_ADAPTER_MEMORY to the absolute path of packages/cortex-memory/dist/index.js',
  );
}

const { CortexSessionProvider } = await loadMemory();

const number = (raw, fallback) => {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`not a number: ${JSON.stringify(raw)}`);
  }
  return value;
};

function configuration() {
  return {
    label: process.env.CORTEX_ADAPTER_LABEL ?? 'cortex-session',
    now: number(process.env.CORTEX_ADAPTER_NOW, Date.now()),
    sessionBudget: number(process.env.CORTEX_ADAPTER_SESSION_BUDGET, Number.POSITIVE_INFINITY),
    threshold: number(process.env.CORTEX_ADAPTER_THRESHOLD, 0),
    budgetUnit: process.env.CORTEX_ADAPTER_BUDGET_UNIT === 'chars' ? 'chars' : 'turns',
    trim: process.env.CORTEX_ADAPTER_TRIM === '1',
  };
}

const config = configuration();

/**
 * A fresh store per `reset`, because the provider accumulates and there is no removal method.
 *
 * Their harness calls `clear(container_tag)` between containers, and a store that kept its sessions would
 * answer every question from every corpus it had ever seen — which scores well and measures nothing.
 */
function fresh() {
  return new CortexSessionProvider({
    now: config.now,
    label: config.label,
    sessionBudget: config.sessionBudget,
    threshold: config.threshold,
    budgetUnit: config.budgetUnit,
    trim: config.trim,
  });
}

let provider = fresh();

/** Their `UnifiedSession` is `{session_id, messages: [{role, content, timestamp?}]}`; this is the other shape. */
function toProviderSessions(sessions) {
  if (!Array.isArray(sessions)) throw new Error('ingest needs a `sessions` array');
  return sessions.map((session, index) => {
    const id = session?.id ?? session?.session_id;
    if (typeof id !== 'string' || id === '') {
      throw new Error(`session ${index} has no string id`);
    }
    const turns = session.turns ?? session.messages;
    if (!Array.isArray(turns)) throw new Error(`session ${id} has no turns`);
    return {
      id,
      // Their `timestamp` is an ISO string on `UnifiedMessage`; `at` may come as ms on the session. Epoch 0 is
      // the honest fallback: it keeps the session before every `asOf` rather than inventing a date.
      at: number(session.at, 0),
      turns: turns.map((turn, position) => {
        const role = turn?.role === 'assistant' ? 'assistant' : 'user';
        const content = typeof turn?.content === 'string' ? turn.content : '';
        if (content === '') {
          throw new Error(`session ${id} turn ${position} has no string content`);
        }
        return { role, content };
      }),
    };
  });
}

async function handle(request) {
  switch (request.op) {
    case 'manifest':
      return {
        ok: true,
        name: config.label,
        // `none`: the ranking signal is term overlap and no model is called. Declaring anything else would
        // misreport the cost class this run sits in, which is the one field a reader uses to decide whether two
        // rows came from the same kind of machine.
        build: 'none',
        version: 'cortex-session/1',
        notes: [
          `budget=${config.sessionBudget === Number.POSITIVE_INFINITY ? 'unbounded' : config.sessionBudget}`,
          `unit=${config.budgetUnit}`,
          `threshold=${config.threshold}`,
          `trim=${config.trim ? 'turn' : 'session'}`,
          'retrieval only: the answer is generated by the harness prompt, not by this store',
        ].join('; '),
      };
    case 'reset':
      provider = fresh();
      return { ok: true };
    case 'ingest': {
      const report = await provider.ingest(toProviderSessions(request.sessions));
      return { ok: true, sessions: report.sessions, turns: report.turns, skipped: [...report.skipped] };
    }
    case 'search': {
      const limit = number(request.limit, Number.POSITIVE_INFINITY);
      const hits = await provider.search(String(request.query ?? ''), {
        limit,
        ...(request.asOf === undefined || request.asOf === null ? {} : { asOf: request.asOf }),
      });
      // The ceiling is enforced rather than trusted: see the header.
      return {
        ok: true,
        hits: hits.slice(0, limit).map((hit) => ({
          text: hit.text,
          ...(hit.score === undefined ? {} : { score: hit.score }),
          ...(hit.at === undefined ? {} : { at: hit.at }),
        })),
      };
    }
    case 'shutdown':
      return { ok: true, then: 'exit' };
    default:
      throw new Error(`unknown op ${JSON.stringify(request?.op)}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

for await (const line of lines) {
  if (line.trim() === '') continue;
  let response;
  let exit = false;
  try {
    response = await handle(JSON.parse(line));
    exit = response.then === 'exit';
    delete response.then;
  } catch (error) {
    // A failure is a valid response, not a broken pipe: `PROTOCOL.md`'s third failure row. The parent records
    // "the system refused this question" separately from "the system returned nothing".
    response = { ok: false, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (exit) break;
}

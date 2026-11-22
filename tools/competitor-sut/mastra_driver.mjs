#!/usr/bin/env node
/**
 * Mastra's observational memory as a system under test, on the same model Cortex reads with.
 *
 * ## What is being measured, stated before the first line of code
 *
 * Mastra publishes **94.87 on LongMemEval** with a `gpt-5-mini` reader and **84.23 with `gpt-4o`**, from the same
 * memory system. That 10.64-point spread is the reason this driver exists in this shape: the number is a property
 * of the reader as much as of the memory, so a comparison against Cortex -- which reads with DeepSeek -- has to run
 * Mastra's memory with DeepSeek too, or it is a comparison of two readers wearing two systems' names.
 *
 * It is *not* a reproduction of their 94.87. Their harness, ingest order and prompt are unpublished ("run data not
 * found", `COMPETITOR-CODE-AVAILABILITY.md` §4). What this driver does is run **their memory mechanism** -- Observer
 * compresses older messages into observations, Reflector consolidates them, the agent answers from the observation
 * log plus the recent window -- over our corpus, with our question dates, on one model. The manifest says so, and the
 * report grades the row as a `self`-reader comparison rather than as an `A`.
 *
 * ## Why `saveMessages` and not `agent.generate` for the ingest
 *
 * `agent.generate` persists the turn *and* produces a reply, which would spend one extra model call per ingested
 * turn: 275,000 calls for 500 questions, none of which is part of what Mastra's memory does. `saveMessages` writes
 * the transcript and lets observational memory watch it, which is the mechanism under test.
 *
 * ## Why every model is pinned to the proxy
 *
 * Three model positions exist here -- the answering agent, the Observer and the Reflector -- and `'auto'` selection
 * would fill the last two with a Gemini default when a Google key is present, or with "a low-cost model for the
 * active provider", which is a decision made by Mastra about Mastra. Both are set explicitly to the same DeepSeek
 * model the answering agent uses, so "the same LLM" is one field in the manifest and one row in the token table.
 *
 * ## Why the fetch wrapper
 *
 * `X-Sut-Label` is how the metering proxy separates `mastra/observe` from `mastra/answer`. Observational memory runs
 * in the background while `settled()` waits, so a driver that labelled by wall-clock phase would mislabel whichever
 * cycle landed after the flag flipped. The label is read from a module-level variable at request time; the phases
 * are sequential because `ingest` awaits `settled()` before returning.
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// The protocol channel, captured before anything can print. Mastra logs through `console` in several places, and a
// banner on stdout is a protocol failure the parent will report and abort on.
const protocolOut = process.stdout.write.bind(process.stdout);
const say = (object) => protocolOut(`${JSON.stringify(object)}\n`);

// Everything else goes to stderr, which the parent captures and keeps.
process.stdout.write = process.stderr.write.bind(process.stderr);

const { Agent } = await import('@mastra/core/agent');
const { Memory } = await import('@mastra/memory');
const { LibSQLStore } = await import('@mastra/libsql');
const { createDeepSeek } = await import('@ai-sdk/deepseek');

const LABEL_PREFIX = 'mastra';
let phase = `${LABEL_PREFIX}/observe`;

const baseUrl = (process.env.SUT_LLM_BASE_URL ?? 'http://127.0.0.1:8399/v1').replace(/\/$/, '');
const modelId = process.env.SUT_LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const storePath = process.env.MASTRA_STORE ?? `/tmp/mastra-store-${process.pid}.db`;
const threadId = () => `longmemeval-${randomUUID()}`;
const resourceId = 'longmemeval';

/**
 * A `fetch` that stamps the phase label, and nothing else.
 *
 * The request is passed through untouched: a wrapper that added fields would be a second place Mastra's prompts could
 * change, and the system under test is entitled to send what it sends.
 */
const labelledFetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? {});
  headers.set('X-Sut-Label', phase);
  return fetch(input, { ...init, headers });
};

const deepSeek = createDeepSeek({
  apiKey: process.env.SUT_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? 'proxy',
  baseURL: baseUrl,
  fetch: labelledFetch,
});

/** The proxy's counter for this system, or `null` when there is no proxy in the path. */
async function usageBlock() {
  try {
    const response = await fetch(`${baseUrl.replace(/\/v1$/, '')}/stats?prefix=${LABEL_PREFIX}`);
    const stats = await response.json();
    return {
      usage: {
        calls: Number(stats.calls ?? 0),
        prompt_tokens: Number(stats.prompt_tokens ?? 0),
        completion_tokens: Number(stats.completion_tokens ?? 0),
      },
    };
  } catch {
    return {};
  }
}

const memoryVersion = createRequire(import.meta.url)('@mastra/memory/package.json').version;

// The parent directory is created here because the path arrives from the environment.
//
// libsql reports a missing parent as `ConnectionFailed("Unable to open connection to local database <path>: 14")`
// -- SQLITE_CANTOPEN, which reads like a permissions or corruption problem and is neither. Three reading steps
// were handed `MASTRA_STORE=<workspace>/.cache/mastra/store.db` while the step that actually ingested the corpus
// used the default `/tmp` path, so `.cache/mastra/` was never created: each reading stage died at import, and
// because the step piped a dead process into `tee` it reported success with a zero-byte artifact. Two repairs
// went in for that: this one, and `set -o pipefail` on the steps that pipe.
mkdirSync(dirname(storePath), { recursive: true });

const storage = new LibSQLStore({ id: 'mastra-sut', url: `file:${storePath}` });

/**
 * Observational memory, with the two thresholds that decide how it behaves on a 115k-token haystack.
 *
 * `messageTokens` is the unobserved-token trigger and defaults to 30k. It is exposed because it is the one number
 * that changes what the arm measures: too high and nothing is ever compressed (the agent reads the whole transcript,
 * which is not the mechanism), too low and every turn becomes an observation (which is a summariser, not a memory
 * system). The default is left at Mastra's own unless the environment overrides it, and the manifest reports it. An
 * empty value means the default rather than zero: `Number('')` is `0`, and a zero trigger would observe every turn --
 * the workflow passes this through as an optional input, and an input left blank arrives as an empty string.
 *
 * `temporalMarkers` is Mastra's own answer to relative-time questions: a marker inserted before a message that
 * follows a gap of ten minutes, which the Observer can anchor to. It is on, because LongMemEval's temporal family is
 * a quarter of the population and turning it off would measure a weaker configuration than the one the vendor
 * documents.
 */
const messageTokens = Number(process.env.MASTRA_MESSAGE_TOKENS ?? '') || 30_000;
const temporalMarkers = (process.env.MASTRA_TEMPORAL_MARKERS ?? '1') !== '0';

const memory = new Memory({
  storage,
  options: {
    observationalMemory: {
      // One `model` for all three positions -- the answering agent, the Observer and the Reflector. Mastra rejects
      // `model` together with `observation.model`/`reflection.model`, and that mutual exclusion is a gift here: it
      // makes "the same LLM" a single field rather than three that could drift apart.
      model: deepSeek(modelId),
      observation: {
        messageTokens,
        // A text-only endpoint: forwarding images would either be rejected or silently dropped by the provider, and
        // the corpus has none.
        observeAttachments: false,
      },
      temporalMarkers,
    },
  },
});

const agent = new Agent({
  id: 'mastra-sut',
  name: 'mastra-sut',
  instructions:
    'Answer the user question from the conversation history you have. Be concise, and answer with the value asked ' +
    'for rather than with a description of where it is. If the history does not contain the answer, say "I do not ' +
    'know".',
  model: deepSeek(modelId),
  memory,
});

let currentThread = threadId();
let sessions = 0;
let turns = 0;

/**
 * One protocol session as Mastra messages.
 *
 * `createdAt` is the session instant plus one second per turn, because observational memory's temporal markers are
 * computed from message timestamps and a transcript whose messages all share one instant has no gaps to mark.
 */
function toMessages(session) {
  const at = Number(session.at ?? Date.now());
  return (session.turns ?? []).map((turn, index) => ({
    id: randomUUID(),
    threadId: currentThread,
    resourceId,
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    createdAt: new Date(at + index * 1000),
    content: { format: 2, parts: [{ type: 'text', text: String(turn.content ?? '') }] },
  }));
}

const handlers = {
  async manifest() {
    return {
      ok: true,
      name: 'mastra',
      build: 'llm',
      answers: true,
      version: `@mastra/memory@${memoryVersion}`,
      llm: { provider: 'deepseek-compatible', model: modelId, base_url: baseUrl },
      config: { observationalMemory: true, messageTokens, temporalMarkers },
      notes:
        'Mastra observational memory (Observer + Reflector) answering on its own generator. NOT a reproduction of ' +
        "the vendor's 94.87: their harness, ingest order and prompt are unpublished. What is held fixed is the " +
        'corpus, the question dates, the judge, and the model -- the answering agent, the Observer and the ' +
        'Reflector all run on the same DeepSeek model named above.',
      ...(await usageBlock()),
    };
  },

  async reset() {
    // A new thread per question, and the old one deleted. Isolation is what the protocol means by `reset`, and a
    // store that kept every question's 115k tokens would be several gigabytes by question 400.
    const old = currentThread;
    currentThread = threadId();
    sessions = 0;
    turns = 0;
    try {
      await memory.deleteThread(old);
    } catch {
      // Deleting a thread that was never created is not a failure. The next question starts empty either way.
    }
    return { ok: true };
  },

  async ingest(request) {
    phase = `${LABEL_PREFIX}/observe`;
    const skipped = [];
    let stored = 0;
    let storedTurns = 0;
    try {
      await memory.createThread({ threadId: currentThread, resourceId, title: 'longmemeval' });
    } catch {
      // `createThread` throws when the id exists. With a fresh uuid per question that only happens if a previous
      // question reused the id, which it cannot; ignoring keeps a benign race from failing the whole ingest.
    }
    for (const session of request.sessions ?? []) {
      const messages = toMessages(session);
      if (messages.length === 0) {
        skipped.push(`session ${String(session.id ?? '?')} had no turns`);
        continue;
      }
      try {
        await memory.saveMessages({ messages });
        stored += 1;
        storedTurns += messages.length;
      } catch (error) {
        skipped.push(`session ${String(session.id ?? '?')}: ${error?.message ?? String(error)}`);
      }
    }
    // Observation is asynchronous. Without this the answering step would run while the Observer is still working,
    // which is a race whose outcome depends on the runner's speed -- the one thing a measurement cannot depend on.
    try {
      await memory.settled();
    } catch (error) {
      skipped.push(`observational memory did not settle: ${error?.message ?? String(error)}`);
    }
    sessions += stored;
    turns += storedTurns;
    return { ok: true, sessions: stored, turns: storedTurns, skipped, ...(await usageBlock()) };
  },

  async search() {
    // No ranked retrieval to hand over. The observation log is the context and the agent reads it directly.
    return {
      ok: true,
      hits: [],
      notes: 'mastra observational memory has no ranked retrieval; see `answer`',
    };
  },

  async answer(request) {
    phase = `${LABEL_PREFIX}/answer`;
    const date = request.askedAt;
    // The same prompt shape MemCog's own harness builds, so the two self-answering systems differ in their memory
    // and not in how the question was phrased to them.
    const prompt =
      date === undefined
        ? `Question: ${request.query}\nAnswer:`
        : `Current Date: ${date}\nQuestion: ${request.query}\nAnswer:`;
    try {
      const result = await agent.generate(prompt, {
        memory: { thread: currentThread, resource: resourceId },
      });
      // `settled` again: the answering turn itself may trigger an observation, and a run that left it pending would
      // close the storage connection underneath it.
      await memory.settled();
      return { ok: true, answer: String(result.text ?? ''), ...(await usageBlock()) };
    } catch (error) {
      return {
        ok: false,
        error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
        ...(await usageBlock()),
      };
    }
  },
};

const rl = createInterface({ input: process.stdin });
let closing = false;

for await (const line of rl) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    say({ ok: false, error: `request is not JSON: ${error.message}` });
    continue;
  }
  const handler = handlers[request.op];
  if (handler === undefined) {
    if (request.op === 'shutdown') {
      say({ ok: true });
      closing = true;
      break;
    }
    say({ ok: false, error: `unknown op ${JSON.stringify(request.op)}` });
    continue;
  }
  try {
    say(await handler(request));
  } catch (error) {
    say({ ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` });
  }
  if (request.op === 'shutdown') {
    closing = true;
    break;
  }
}

if (closing) {
  try {
    await memory.settled();
  } catch {
    // Nothing to wait for on the way out.
  }
}
process.exit(0);

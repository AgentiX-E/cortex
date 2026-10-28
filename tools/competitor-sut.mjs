#!/usr/bin/env node
/**
 * Turn a competitor's process into a `MemoryProvider`.
 *
 * ## What this file is for
 *
 * Requirement: a competitor's number is only worth quoting if we ran their code with our reader on our data.
 * `tools/competitor-sut/PROTOCOL.md` is the three-operation contract; this is the parent side of it. Everything
 * that can go wrong with someone else's program is classified here, once, so the harness above never has to
 * guess whether a zero means "found nothing" or "died".
 *
 * ## The three verdicts, and why they are different
 *
 * | what happened | verdict | because |
 * | --- | --- | --- |
 * | the process exited, or a response timed out, or a line was not JSON | **run fails** | the comparison did not happen; a table printed anyway would be read as a result |
 * | the driver answered `{"ok": false}` | **this question fails** | the system refused this question, which is a claim about the system |
 * | the driver answered `{"ok": true, "hits": []}` | **found nothing** | also a claim, and the opposite one |
 *
 * Collapsing the last two is the defect this repository keeps finding in its own instruments, so the adapter
 * returns them as different things and prints both counts.
 *
 * ## Why the manifest is mandatory
 *
 * `name`, `build` and `version` are read before the first call and travel into the report. Three times now a
 * number in this project has been attributed to the wrong system; a competitor's number that arrives without the
 * commit that produced it is the same failure with an extra party.
 *
 * ## Usage
 *
 *     node tools/competitor-sut.mjs --driver mem0 [--python python3] [--timeout-ms 600000]
 *
 * With no arguments it runs the reference driver through a round trip and prints the protocol's own transcription,
 * which is what the test suite asserts against.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT_DIR = join(HERE, 'competitor-sut');

/** Drivers this adapter knows how to launch. A competitor is added here and nowhere else. */
const DRIVERS = {
  reference: { script: 'stub_driver.py', name: 'reference/lexical' },
  mem0: { script: 'mem0_driver.py', name: 'mem0' },
};

/** The default patience for one operation. Ingest of a five-hundred-turn haystack is minutes, not seconds. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Raised when the comparison did not happen: the driver never produced a usable answer.
 *
 * A distinct class rather than an `Error` string because the harness has to abort the run, and a caller that
 * catches everything would otherwise turn a dead competitor into a zero.
 */
export class SutFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'SutFailure';
  }
}

/** One request/response pair, with the timeout, the parse and the shape all checked. */
class Channel {
  #child;
  #pending = null;
  #buffer = [];
  #closed = null;
  #stderr = '';

  constructor(command, args, options) {
    this.#child = spawn(command, args, {
      cwd: options.cwd ?? SUT_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      if (this.#pending !== null) {
        const resolve = this.#pending;
        this.#pending = null;
        resolve(line);
      } else {
        this.#buffer.push(line);
      }
    });
    this.#child.stderr.on('data', (chunk) => {
      this.#stderr += String(chunk);
    });
    this.#child.on('exit', (code) => {
      this.#closed = code;
      if (this.#pending !== null) {
        const resolve = this.#pending;
        this.#pending = null;
        resolve(null);
      }
    });
  }

  /** `stderr` so a failure can quote what the program said about itself. */
  get stderr() {
    return this.#stderr;
  }

  async send(request, timeoutMs) {
    if (this.#closed !== null) {
      throw new SutFailure(
        `driver had already exited (code ${String(this.#closed)}) before ${String(request.op)}`,
      );
    }
    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
    // A buffered line is an answer to an earlier request that arrived late; taking it would shift every
    // subsequent answer by one, which is the worst possible failure mode for a request/response channel.
    if (this.#buffer.length > 0) {
      throw new SutFailure(
        `driver sent ${String(this.#buffer.length)} unsolicited line(s) before ${String(request.op)}: ` +
          `${JSON.stringify(this.#buffer[0].slice(0, 200))}`,
      );
    }
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(
          new SutFailure(
            `${String(request.op)} produced no response within ${String(timeoutMs)} ms` +
              (this.#stderr === '' ? '' : `; stderr tail: ${tail(this.#stderr)}`),
          ),
        );
      }, timeoutMs);
      this.#pending = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
    if (line === null) {
      throw new SutFailure(
        `${String(request.op)} produced no response; driver exited ${String(this.#closed)}` +
          (this.#stderr === '' ? '' : `; stderr tail: ${tail(this.#stderr)}`),
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SutFailure(
        `${String(request.op)} answered with a line that is not JSON: ${JSON.stringify(line.slice(0, 200))}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
      throw new SutFailure(
        `${String(request.op)} answered without an \`ok\` boolean: ${JSON.stringify(line.slice(0, 200))}`,
      );
    }
    return parsed;
  }

  async close() {
    try {
      await this.send({ op: 'shutdown' }, 10_000);
    } catch {
      // A driver that cannot shut down politely still has to die, or the job hangs.
      this.#child.kill('SIGKILL');
    }
    if (this.#closed === null) {
      await new Promise((resolve) => {
        this.#child.on('exit', resolve);
        setTimeout(() => {
          this.#child.kill('SIGKILL');
          resolve();
        }, 5_000);
      });
    }
  }
}

/** The last few hundred characters of stderr, which is where a Python traceback puts its reason. */
function tail(text, limit = 600) {
  return text.length <= limit ? text : text.slice(-limit);
}

/**
 * Build a `MemoryProvider` over one driver process.
 *
 * The provider is stateful on purpose: `ingest` and `search` both go to the same child, so a system that caches
 * internally keeps its cache between the two, which is what it would do in production.
 */
export async function createSutProvider({ driver, python = 'python3', env = {}, timeoutMs, cwd } = {}) {
  const spec = DRIVERS[driver];
  if (spec === undefined) {
    throw new SutFailure(
      `unknown system-under-test ${JSON.stringify(driver)}; known: ${Object.keys(DRIVERS).join(', ')}`,
    );
  }
  const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = new Channel(python, [join(SUT_DIR, spec.script)], { env, ...(cwd === undefined ? {} : { cwd }) });

  const manifest = await channel.send({ op: 'manifest' }, budget);
  if (!manifest.ok) {
    throw new SutFailure(`${spec.name} could not describe itself: ${String(manifest.error)}`);
  }
  for (const field of ['name', 'build', 'version']) {
    if (typeof manifest[field] !== 'string') {
      throw new SutFailure(`${spec.name} manifest has no string \`${field}\`: ${JSON.stringify(manifest)}`);
    }
  }
  if (!['llm', 'embedding', 'none'].includes(manifest.build)) {
    throw new SutFailure(`${spec.name} declared build ${JSON.stringify(manifest.build)}, which is not a cost class`);
  }

  /** Per-question refusals, kept so the summary can separate them from empty results. */
  const refusals = [];
  let emptyResults = 0;
  /**
   * Sessions the system would not take, and how many it was offered.
   *
   * Separate from `refusals` because the two failures happen at different times and mean different things: a
   * refusal is one question the system would not answer, an ingest skip is corpus that never entered the store.
   * Run 40519523383 read `0.0%` while its ingest was refusing every session — the search then had an empty index
   * to search, so the miss was a property of the plumbing and the row was read as a property of mem0.
   */
  const ingestSkips = [];
  let ingestedSessions = 0;
  let offeredSessions = 0;

  return {
    name: manifest.name,
    build: manifest.build,
    /** What the driver says about its own configuration, verbatim, for the report to print. */
    manifest,
    refusals,
    get emptyResults() {
      return emptyResults;
    },
    ingestSkips,
    get ingestedSessions() {
      return ingestedSessions;
    },
    get offeredSessions() {
      return offeredSessions;
    },
    async ingest(sessions) {
      const response = await channel.send({ op: 'ingest', sessions }, Math.max(budget, 1_800_000));
      if (!response.ok) {
        // Both the driver's own words and its per-session list, because a run that stored nothing has to be
        // diagnosable from the failure alone — there is no table afterwards to look at.
        const detail = Array.isArray(response.skipped) ? response.skipped.slice(0, 3).join('; ') : '';
        throw new SutFailure(
          `ingest refused: ${String(response.error)}${detail === '' ? '' : ` [${detail}]`}`,
        );
      }
      const skipped = Array.isArray(response.skipped) ? response.skipped.map(String) : [];
      offeredSessions += sessions.length;
      ingestedSessions += Number(response.sessions ?? 0);
      ingestSkips.push(...skipped);
      // The protocol's own rule, applied to every driver rather than to the ones that remembered to check. A
      // driver may report this itself and the ones that do are clearer about why; this is what stops a driver
      // that did not from turning an empty store into 500 misses and a `0.0%` row.
      if (offeredSessions > 0 && ingestedSessions === 0) {
        const first = skipped[0] ?? 'the driver reported no reason';
        throw new SutFailure(
          `ingest stored 0 of ${String(offeredSessions)} session(s); the store is empty and every search would ` +
            `be a miss: ${first}`,
        );
      }
      return {
        sessions: Number(response.sessions ?? 0),
        turns: Number(response.turns ?? 0),
        skipped,
      };
    },
    async search(query, options) {
      const limit = Number(options.limit ?? 0);
      const response = await channel.send(
        { op: 'search', query, limit, ...(options.asOf === undefined ? {} : { asOf: options.asOf }) },
        budget,
      );
      if (!response.ok) {
        // A refusal is a claim about the system, not about the run. Recorded and returned empty so the question
        // is scored as a miss with a reason rather than aborting a 500-question run at question 12.
        refusals.push({ query, error: String(response.error) });
        return [];
      }
      if (!Array.isArray(response.hits)) {
        throw new SutFailure(`search answered without a \`hits\` array: ${JSON.stringify(response).slice(0, 200)}`);
      }
      if (response.hits.length > limit) {
        throw new SutFailure(
          `search returned ${String(response.hits.length)} hits for a limit of ${String(limit)}; ` +
            'the contract is a ceiling and a system that ignores it is not being compared',
        );
      }
      if (response.hits.length === 0) emptyResults += 1;
      return response.hits.map((hit) => ({
        text: String(hit.text),
        ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
        ...(typeof hit.at === 'number' ? { at: hit.at } : {}),
      }));
    },
    async reset() {
      const response = await channel.send({ op: 'reset' }, budget);
      if (!response.ok) throw new SutFailure(`reset refused: ${String(response.error)}`);
    },
    async close() {
      await channel.close();
    },
  };
}

/** The round trip the tests assert against: no competitor, no key, no network. */
async function selftest() {
  const provider = await createSutProvider({ driver: 'reference' });
  await provider.ingest([
    {
      id: 's1',
      at: 1_685_000_000_000,
      turns: [
        { role: 'user', content: 'I adopted a golden retriever named Biscuit in May.' },
        { role: 'assistant', content: 'Lovely name.' },
      ],
    },
  ]);
  // A query with a term actually in the corpus: a round trip that returns nothing cannot tell a working channel
  // from a broken one, and this test exists to tell those apart.
  const hits = await provider.search('golden retriever', { limit: 2 });
  await provider.reset();
  const afterReset = await provider.search('golden retriever', { limit: 2 });
  await provider.close();
  process.stdout.write(
    `${JSON.stringify(
      {
        manifest: provider.manifest,
        hits: hits.length,
        firstHit: hits[0]?.text ?? null,
        afterReset: afterReset.length,
        refusals: provider.refusals.length,
      },
      null,
      2,
    )}\n`,
  );
  // Two assertions, and both are about the protocol rather than the ranking: a channel that returns nothing on a
  // query whose term is present proves nothing, and a driver that survives `reset` would make every
  // isolated-mode number after the first question wrong.
  if (hits.length === 0) throw new SutFailure('the reference driver found nothing in a corpus it was given');
  if (afterReset.length !== 0) throw new SutFailure('reset left retrievable text behind');
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('competitor-sut.mjs')) {
  await selftest();
}

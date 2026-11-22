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
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT_DIR = join(HERE, 'competitor-sut');

/**
 * Drivers this adapter knows how to launch. A competitor is added here and nowhere else.
 *
 * `interpreter` defaults to the Python the caller passed, because six of the seven systems in this census are
 * Python packages. Mastra is not: it is a TypeScript framework, and a driver that shelled out to `python -c
 * "import mastra"` would be a driver for a system that does not exist. The field is per-driver so the protocol stays
 * language-agnostic -- which it always was, since it is newline-delimited JSON over stdio.
 */
const DRIVERS = {
  reference: { script: 'stub_driver.py', name: 'reference/lexical' },
  mem0: { script: 'mem0_driver.py', name: 'mem0' },
  // §13.304. The one competitor with a same-reader, same-question, published number (MemStrata's matched-reader
  // arm, 438/500). It is a server rather than a library, so the driver speaks HTTP to a process this repository
  // does not start: `letta_driver.py` refuses to run unless the endpoint behaves like the archived V1 server,
  // because the name `letta` now installs a different product (the terminal agent `letta-code`) and the
  // framework's own `main` branch is a pointer README.
  letta: { script: 'letta_driver.py', name: 'letta' },
  // Memory-as-cognition: the store is built by a model and navigated by one, so there is no ranked list to hand a
  // reader. `mastra` is the same shape from the other direction -- observational memory compresses a window and
  // replies from the compression -- so both declare `answers: true` in their manifest and are graded by the shared
  // judge on their own generator.
  memcog: { script: 'memcog_driver.py', name: 'memcog' },
  mastra: { script: 'mastra_driver.mjs', name: 'mastra', interpreter: 'node' },
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
      // Forwarded *and* kept. Kept, because a failure message quotes the tail (`tail()`), and forwarded, because a
      // driver's stderr is the only place a vendor package's own progress output ever appears: MemCog prints its
      // five build steps there, and a job that only ever sees them after a failure sees them never. Run 45002769709
      // spent thirty-six minutes in that blind spot -- the step's log held the step's name and nothing else.
      const text = String(chunk);
      this.#stderr += text;
      process.stderr.write(text);
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
 * Where the metering proxy's ledger lives, when the system under test is being run through one.
 *
 * Only loopback counts. A driver pointed straight at a vendor endpoint has no `/stats` to read and reports no
 * `usage` at all, which the report prints as `—`; the subtraction below exists for the proxied case and must not
 * turn a vendor-direct run into a failure.
 */
function meteringEndpoint(base) {
  if (base === undefined || base === '') return null;
  try {
    const url = new URL(base);
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    return loopback ? `${url.origin}/stats` : null;
  } catch {
    return null;
  }
}

/**
 * What the **job** had already spent under this system's label before this arm started.
 *
 * The proxy's counter is job-scoped, not arm-scoped: it is started once for the workflow and kept alive across the
 * retrieval step and the three reading arms, because it is also what the reading steps are metered by. Every driver
 * in `DRIVERS` reports `/stats?prefix=<its own name>` verbatim -- which is the right thing for a driver to report
 * and the wrong thing to attribute to one arm.
 *
 * Run 45011905117 is what that costs. Its `competitor-read.json` carried memcog at `2,799,803` tokens per question
 * and `¥13.91`; the job ledger held 5,339 calls and 11,199,346 prompt tokens across **four** arms. `5,148,346` --
 * the retrieval arm plus the `con` arm, exactly -- was what the row had recorded, and dividing a two-arm total by
 * two questions printed four times the cost of one question. The numbers closed to the token, which is how the
 * defect was identified rather than argued about: segmenting `sut-llm-calls.jsonl` at each return to `q1` gave
 * ¥3.36 / 3.60 / 3.51 / 3.45 per question for the four arms, so the row that said ¥13.91 was describing ¥3.48.
 *
 * The fix is a baseline: read the counter before the arm spends anything and subtract it. A driver cannot do this
 * itself, because a driver does not know whether another arm of the same system ran before it in this job.
 */
async function readMeteringBaseline(name, base) {
  const endpoint = meteringEndpoint(base);
  if (endpoint === null) return null;
  let response;
  try {
    response = await fetch(`${endpoint}?prefix=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new SutFailure(
      `the metering proxy at ${endpoint} could not be read before ${name} started ` +
        `(${error?.message ?? String(error)}); without a baseline this arm's cost would be the job's cost`,
    );
  }
  if (!response.ok) {
    throw new SutFailure(
      `the metering proxy at ${endpoint} answered ${String(response.status)} for ${name}; without a baseline ` +
        "this arm's cost would be the job's cost",
    );
  }
  const stats = await response.json();
  return {
    calls: Number(stats.calls ?? 0),
    promptTokens: Number(stats.prompt_tokens ?? 0),
    completionTokens: Number(stats.completion_tokens ?? 0),
  };
}

/**
 * This arm's own spend, given what the driver reported and what the job had already spent under its label.
 *
 * Exported because it is the whole of the arithmetic and a test can pin it without a proxy, a driver or a key.
 */
export function subtractUsage(reported, baseline) {
  const scoped = {
    calls: reported.calls - baseline.calls,
    promptTokens: reported.promptTokens - baseline.promptTokens,
    completionTokens: reported.completionTokens - baseline.completionTokens,
  };
  if (scoped.calls < 0) {
    throw new SutFailure(
      `the driver reported ${String(reported.calls)} call(s) while the job had already spent ` +
        `${String(baseline.calls)} under this label; its counter is not the proxy's cumulative counter, so this ` +
        "arm's cost cannot be attributed -- and a cost column that cannot be attributed is not one",
    );
  }
  return {
    // Tokens can only go backwards if the call count did, and that case is the one above; a negative here would be
    // a proxy that restarted mid-arm, which the run has to see rather than round away.
    calls: scoped.calls,
    promptTokens: Math.max(0, scoped.promptTokens),
    completionTokens: Math.max(0, scoped.completionTokens),
  };
}

/**
 * Build a `MemoryProvider` over one driver process.
 *
 * The provider is stateful on purpose: `ingest` and `search` both go to the same child, so a system that caches
 * internally keeps its cache between the two, which is what it would do in production.
 */
export async function createSutProvider({
  driver,
  python = 'python3',
  env = {},
  timeoutMs,
  cwd,
} = {}) {
  const spec = DRIVERS[driver];
  if (spec === undefined) {
    throw new SutFailure(
      `unknown system-under-test ${JSON.stringify(driver)}; known: ${Object.keys(DRIVERS).join(', ')}`,
    );
  }
  const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = new Channel(spec.interpreter ?? python, [join(SUT_DIR, spec.script)], {
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });

  /**
   * Close the child before throwing, for every check between here and the return.
   *
   * A spawned driver that is never closed keeps the readline stream and the child handle alive, so the parent's
   * event loop never empties and a **failing** pre-flight hangs instead of failing. The `usage-scope` self-test
   * found this the moment a pre-flight check was added that can throw: the third case printed its error and then
   * sat there for four minutes.
   */
  const abort = async (error) => {
    await channel.close();
    return error;
  };

  const manifest = await channel.send({ op: 'manifest' }, budget);
  if (!manifest.ok) {
    throw await abort(
      new SutFailure(`${spec.name} could not describe itself: ${String(manifest.error)}`),
    );
  }
  for (const field of ['name', 'build', 'version']) {
    if (typeof manifest[field] !== 'string') {
      throw await abort(
        new SutFailure(
          `${spec.name} manifest has no string \`${field}\`: ${JSON.stringify(manifest)}`,
        ),
      );
    }
  }
  if (!['llm', 'embedding', 'none'].includes(manifest.build)) {
    throw await abort(
      new SutFailure(
        `${spec.name} declared build ${JSON.stringify(manifest.build)}, which is not a cost class`,
      ),
    );
  }
  /**
   * `answers: true` is a claim about the architecture, and it has a cost consequence that must be declared with it.
   *
   * A system that generates its own answer calls a model per question; a system that only retrieves calls none. So
   * `answers: true` next to `build: 'embedding'` is a contradiction rather than a configuration, and it would put a
   * model-driven row in the embedding cost class where the budget sweep reads it as cheap.
   */
  const answers = manifest.answers === true;
  if (answers && manifest.build !== 'llm') {
    throw await abort(
      new SutFailure(
        `${spec.name} declares answers:true, which spends a model call per question, but build ` +
          `${JSON.stringify(manifest.build)}; a self-answering system is an \`llm\` build`,
      ),
    );
  }

  /**
   * The job's spend under this label before this arm, read here because here is the last moment it is still zero.
   *
   * The driver has answered `manifest` and nothing else; every operation that spends a model call comes after this
   * line. Read from the arm's own environment first, because `SUT_LLM_BASE_URL` is set at workflow level and a
   * caller that passes it per-provider would otherwise get a baseline from a proxy this arm never talks to.
   */
  let baseline;
  try {
    baseline = await readMeteringBaseline(
      manifest.name,
      env['SUT_LLM_BASE_URL'] ?? process.env['SUT_LLM_BASE_URL'],
    );
  } catch (error) {
    throw await abort(error);
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
  /**
   * The system's own spend, as last reported **minus what the job had already spent under its label**.
   *
   * Carried on the response rather than asked for separately, because a driver that queried its metering proxy after
   * every call would double the number of round trips to answer a question nobody asks until the arm is over. The
   * latest reading wins: the counter is cumulative, so the final response of the arm carries the total.
   *
   * "Cumulative" is the word that had to be qualified. It is cumulative for the *job*, and the four arms of one
   * comparison share a proxy, so the first arm after another one used to report both arms' spend. See
   * `readMeteringBaseline`.
   */
  let lastUsage = null;
  const noteUsage = (response) => {
    const reported = response.usage;
    if (reported === null || typeof reported !== 'object') return;
    const absolute = {
      calls: Number(reported.calls ?? 0),
      promptTokens: Number(reported.prompt_tokens ?? 0),
      completionTokens: Number(reported.completion_tokens ?? 0),
    };
    lastUsage = baseline === null ? absolute : subtractUsage(absolute, baseline);
  };

  return {
    name: manifest.name,
    build: manifest.build,
    /** What the driver says about its own configuration, verbatim, for the report to print. */
    manifest,
    /**
     * The job's spend under this label when the arm started, so a progress line can report arm-local tokens.
     *
     * Exposed rather than kept private because the harness's per-question line is the only live readout a
     * twenty-minute ingest has, and a line reading `11.20M token(s) cumulative` for an arm that has spent 3.5M is
     * the same defect as the cost column, one layer up.
     */
    usageBaseline: baseline,
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
    /**
     * Present only when the driver reports one.
     *
     * `null` rather than zeros: a system whose spend was never observed is not a free system, and a table that
     * printed `0` for it would be read as one. The harness turns this into `ProviderScore.usage` at the end of the
     * arm, which is the only moment the number is complete.
     */
    get usage() {
      return lastUsage;
    },
    async ingest(sessions) {
      const response = await channel.send({ op: 'ingest', sessions }, Math.max(budget, 1_800_000));
      if (!response.ok) {
        // Both the driver's own words and its per-session list, because a run that stored nothing has to be
        // diagnosable from the failure alone — there is no table afterwards to look at.
        const detail = Array.isArray(response.skipped)
          ? response.skipped.slice(0, 3).join('; ')
          : '';
        throw new SutFailure(
          `ingest refused: ${String(response.error)}${detail === '' ? '' : ` [${detail}]`}`,
        );
      }
      noteUsage(response);
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
        {
          op: 'search',
          query,
          limit,
          ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
        },
        budget,
      );
      if (!response.ok) {
        // A refusal is a claim about the system, not about the run. Recorded and returned empty so the question
        // is scored as a miss with a reason rather than aborting a 500-question run at question 12.
        refusals.push({ query, error: String(response.error) });
        return [];
      }
      if (!Array.isArray(response.hits)) {
        throw new SutFailure(
          `search answered without a \`hits\` array: ${JSON.stringify(response).slice(0, 200)}`,
        );
      }
      if (response.hits.length > limit) {
        throw new SutFailure(
          `search returned ${String(response.hits.length)} hits for a limit of ${String(limit)}; ` +
            'the contract is a ceiling and a system that ignores it is not being compared',
        );
      }
      noteUsage(response);
      if (response.hits.length === 0) emptyResults += 1;
      return response.hits.map((hit) => ({
        text: String(hit.text),
        ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
        ...(typeof hit.at === 'number' ? { at: hit.at } : {}),
      }));
    },
    ...(answers
      ? {
          /**
           * The system's own generator, for systems whose retrieval and reasoning are one act.
           *
           * The budget is the ingest budget rather than the per-operation one: a navigator makes two to seven model
           * calls and reads pages between them, which is minutes when the pages are transcripts. A refusal is
           * recorded and answered with an empty string, because "this question could not be navigated" is a claim
           * about the system and must not abort a five-hundred-question run at question twelve.
           */
          async answer(query, options = {}) {
            const response = await channel.send(
              {
                op: 'answer',
                query,
                ...(options.askedAt === undefined ? {} : { askedAt: options.askedAt }),
              },
              Math.max(budget, 1_800_000),
            );
            if (!response.ok) {
              refusals.push({ query, error: String(response.error) });
              return '';
            }
            if (typeof response.answer !== 'string') {
              throw new SutFailure(
                `answer produced no string: ${JSON.stringify(response).slice(0, 200)}`,
              );
            }
            noteUsage(response);
            return response.answer;
          },
        }
      : {}),
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
  if (hits.length === 0)
    throw new SutFailure('the reference driver found nothing in a corpus it was given');
  if (afterReset.length !== 0) throw new SutFailure('reset left retrievable text behind');
}

/**
 * The self-answering half of the protocol, over the same reference driver.
 *
 * Four properties, and each one is a way the optional operation can be half-implemented:
 *
 * 1. a driver that does **not** declare `answers` must not expose the method -- a parent that always attached it
 *    would call `answer` on Mem0 and get an unknown-op refusal for all five hundred questions;
 * 2. a driver that does must produce a string, not `undefined` cast through a template;
 * 3. the usage it reports must arrive at the provider, because a cost column fed by nothing prints zeros;
 * 4. `search` must still work, because the harness collects hits for the context-cost column even when the arm's
 *    accuracy came from its own generator.
 */
async function answerSelftest() {
  const silent = await createSutProvider({ driver: 'reference' });
  if (typeof silent.answer === 'function') {
    throw new SutFailure('a driver without `answers` exposed an answer method');
  }
  if (silent.usage !== null) {
    throw new SutFailure('a driver that reported no usage produced a usage object');
  }
  await silent.close();

  const speaking = await createSutProvider({
    driver: 'reference',
    env: { STUB_ANSWERS: '1' },
  });
  if (speaking.manifest.answers !== true) {
    throw new SutFailure('the self-answering driver did not declare `answers: true`');
  }
  await speaking.ingest([
    { id: 's1', at: 1_685_000_000_000, turns: [{ role: 'user', content: 'I live in London.' }] },
  ]);
  const answer = await speaking.answer('where does the user live', { limit: 10 });
  const hits = await speaking.search('london', { limit: 2 });
  const usage = speaking.usage;
  await speaking.close();

  process.stdout.write(
    `${JSON.stringify(
      {
        answers: speaking.manifest.answers,
        build: speaking.manifest.build,
        answer,
        hits: hits.length,
        usage,
      },
      null,
      2,
    )}\n`,
  );
  if (typeof answer !== 'string' || answer.length === 0) {
    throw new SutFailure('the self-answering driver produced no answer');
  }
  if (usage === null || usage.calls < 1) {
    throw new SutFailure('the usage the driver reported did not reach the provider');
  }
  if (speaking.manifest.build !== 'llm') {
    throw new SutFailure('a self-answering driver reported a non-llm build');
  }
}

/**
 * The cost-attribution half: one arm's spend is the counter's reading minus the counter's reading when it started.
 *
 * Three cases, because the subtraction has three outcomes and only one of them is a number:
 *
 * | what the proxy says | what the arm reports | because |
 * | --- | --- | --- |
 * | `0` before the arm | its own calls | nothing to subtract, and the reported figure is already arm-local |
 * | `900` before the arm | **fails** | the driver's counter is not the proxy's counter; the arm's cost is unknown |
 * | nothing at all | **fails** before spending | a job-scoped counter with no baseline prices the job, not the arm |
 *
 * The third one is the reason the baseline is read at construction rather than lazily: a run that discovers at
 * minute forty that it cannot attribute its cost has already spent it.
 */
async function usageScopeSelftest() {
  const pure = subtractUsage(
    { calls: 9, promptTokens: 9_000, completionTokens: 900 },
    { calls: 7, promptTokens: 7_000, completionTokens: 700 },
  );

  const withProxy = async (payload, body) => {
    const server = createServer((request, response) => {
      if (payload === 'error') {
        response.writeHead(503).end('no ledger');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String(server.address().port)}/v1`;
    try {
      return await body(base);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  const corpus = [
    { id: 's1', at: 1_685_000_000_000, turns: [{ role: 'user', content: 'I live in London.' }] },
  ];

  const fresh = await withProxy(
    { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
    async (base) => {
      const provider = await createSutProvider({
        driver: 'reference',
        env: { SUT_LLM_BASE_URL: base, STUB_ANSWERS: '1' },
      });
      await provider.ingest(corpus);
      await provider.answer('where does the user live');
      const result = { baseline: provider.usageBaseline, usage: provider.usage };
      await provider.close();
      return result;
    },
  );

  let misattributed = null;
  await withProxy(
    { calls: 900, prompt_tokens: 900_000, completion_tokens: 9_000 },
    async (base) => {
      const provider = await createSutProvider({
        driver: 'reference',
        env: { SUT_LLM_BASE_URL: base, STUB_ANSWERS: '1' },
      });
      try {
        await provider.ingest(corpus);
        // `ingest` and `search` on the reference driver report no `usage`; the counter arrives with the operation
        // that spends a model call, which is where this arm has to notice it cannot be priced.
        await provider.answer('where does the user live');
      } catch (error) {
        misattributed = `${error.name}: ${error.message}`;
      }
      await provider.close();
    },
  ).catch(() => {});

  let unreadable = null;
  await withProxy('error', async (base) => {
    try {
      await createSutProvider({ driver: 'reference', env: { SUT_LLM_BASE_URL: base } });
    } catch (error) {
      unreadable = `${error.name}: ${error.message}`;
    }
  });

  process.stdout.write(`${JSON.stringify({ pure, fresh, misattributed, unreadable }, null, 2)}\n`);

  if (pure.calls !== 2 || pure.promptTokens !== 2_000) {
    throw new SutFailure(`the subtraction is wrong: ${JSON.stringify(pure)}`);
  }
  if (fresh.baseline?.calls !== 0 || (fresh.usage?.calls ?? 0) < 1) {
    throw new SutFailure(`a clean proxy produced no arm-local usage: ${JSON.stringify(fresh)}`);
  }
  if (misattributed === null || !misattributed.includes('cannot be attributed')) {
    throw new SutFailure('an arm whose counter was below the baseline was priced anyway');
  }
  if (unreadable === null || !unreadable.includes('without a baseline')) {
    throw new SutFailure('a proxy with no ledger was allowed to start an arm it could not price');
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('competitor-sut.mjs')) {
  if (process.argv[2] === 'answer') await answerSelftest();
  else if (process.argv[2] === 'usage-scope') await usageScopeSelftest();
  else await selftest();
}

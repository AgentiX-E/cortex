#!/usr/bin/env node
/**
 * What a stored transcript costs per question, measured rather than argued.
 *
 * ## The claim this exists to keep honest
 *
 * `Corpus` reads the whole transcript on every question (`sessions()`), so `askStored()` is O(corpus). That
 * is a real cost and the design accepted it on an argument: the answer path is **already** O(corpus), because
 * `answerSessions` admits every turn in the caller's `context` before it selects anything. If that is true,
 * the read is a constant factor on work that was already being done, and storing the transcript changes
 * nothing about the shape of the cost.
 *
 * If it is false — if the read dominates assembly by more than 2x — the design is wrong in the direction that
 * matters, and the registered fallback is to drop `askStored` and keep only `remember` (the caller passes the
 * context it just stored). `docs/07-sota-v4-review-and-plan.md` §6 writes that down as a falsifiable clause
 * before the code existed; this file is how it is checked.
 *
 * ## Why 10^5 turns and not a fixture
 *
 * Because the ratio is only interesting at a size where the two halves have different shapes. On ten turns
 * both are microseconds and the answer is noise. 10^5 turns is 500 sessions of 200, roughly a year of one
 * person's conversations, and it is the size the design's own reading-amplification argument names.
 *
 * ## What is timed, and what is held constant
 *
 * | reading | what runs |
 * | --- | --- |
 * | `read` | `corpus.sessions()` — one full scan of two tables, JSON-parsed and grouped |
 * | `assemble` | `answerSessions(question, sessions)` over the same array, with a stub reader |
 * | `stored` | `askStored(question)` — the two together, through the product's public method |
 *
 * The reader is a stub that returns a constant: this measures the machine's work, not a provider's latency,
 * and a network call in either arm would swamp both. `maxPromptChars` is the registered arm's room, because
 * the alternative — no cap on 10^5 turns — builds a twelve-megabyte prompt and measures string concatenation
 * instead.
 *
 * ## Why every reading is the fastest of three, not one sample
 *
 * Because the artifact is read by a gate that asserts an ordering between two of them — `stored >= assemble`,
 * i.e. the stored path does at least the work the assembly path does — and two single samples of a loaded
 * machine do not preserve an ordering that holds for the code. Measured on 2026-11-16 while a browser suite
 * ran beside this: `assemble` 2004.87 ms against `stored` 1848.67 ms, an inversion of 8% in a relationship
 * that is a *decomposition* of the same work. The check was right and the estimator was not: load only ever
 * adds time, so the minimum over repetitions is the sample least contaminated by it, and it is the estimator
 * every later comparison in this file uses.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, '../cortex-docs/evidence/corpus/read-cost.json');

const { MemoryEmbeddingCacheStore } = await import(
  join(REPO, 'packages/cortex-core/dist/index.js')
);
const { Corpus } = await import(join(REPO, 'packages/cortex-memory/dist/corpus.js'));
const { CortexMemory } = await import(join(REPO, 'packages/cortex-memory/dist/memory.js'));
const { SqliteStorage } = await import(
  join(REPO, 'packages/cortex-storage/dist/storage/sqlite.js')
);

const NOW = 1_759_470_000_000;
const SESSIONS = 500;
const TURNS_PER_SESSION = 200;
const ROOM = 48_000;

/** The stub reader. Constant, so the two arms differ only in what the machine does. */
const llm = {
  complete: () => Promise.resolve('Anke'),
  completeStructured: () => Promise.resolve({}),
};

/**
 * One turn of plausible prose.
 *
 * Deterministic, and different in every session: a corpus of one repeated sentence would let a JSON parser
 * intern the string and make the read look cheaper than it is.
 */
function turn(session, ordinal) {
  return (
    `[2023/05/${String((ordinal % 28) + 1).padStart(2, '0')} (Sat) 10:00] user: In session ${String(session)} ` +
    `I mentioned turn ${String(ordinal)} about the invoice for the bicycle repair, ` +
    'and Anke said it would be settled before the end of the month.'
  );
}

const dir = mkdtempSync(join(tmpdir(), 'cortex-corpus-read-'));
const store = new SqliteStorage({ filename: join(dir, 'corpus.db') });
const corpus = new Corpus({ store, now: NOW });

const writing = Date.now();
for (let session = 0; session < SESSIONS; session += 1) {
  const turns = [];
  for (let ordinal = 0; ordinal < TURNS_PER_SESSION; ordinal += 1) {
    turns.push({ sessionId: `s${String(session)}`, ordinal, text: turn(session, ordinal) });
  }
  // Batched per session: the corpus appends a transcript in the shape a conversation arrives in, and one
  // turn per transaction would measure the transaction overhead rather than the read.
  await corpus.append(turns);
}
const writeMs = Date.now() - writing;

const memory = new CortexMemory({
  llm,
  now: NOW,
  gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
  maxPromptChars: ROOM,
  corpus,
  // The vector channel is deliberately off: an embedding call per turn would put a network stub in the
  // middle of both arms and the ratio would measure that instead.
  index: { store: new MemoryEmbeddingCacheStore() },
});

const question = 'When will the invoice for the bicycle repair be settled?';

// Warm the two code paths so the first arm does not pay for JIT and the second arm's numbers do not inherit
// a colder machine. One throwaway question at a tenth of the size would not be comparable, so the warm-up is
// the same size as the measurement -- it costs one extra read and one extra assembly.
await memory.askStored(question);
await memory.answerSessions(question, await corpus.sessions());

/**
 * A read that is genuinely slower, so the gate can be shown to fire.
 *
 * Not a multiplied number: the arm really runs the scan `SLOW_READS` times, and the timing is the measurement
 * of that. A gate nobody has watched fail is a gate that may be comparing nothing, and inflating a variable
 * would leave the artifact carrying a figure no code produced.
 */
const FAULT = process.env['CORTEX_CORPUS_READ_CENSUS_FAULT'];
const SLOW_READS = FAULT === 'slow-read' ? 25 : 1;

/**
 * The fastest of {@link REPS} runs, and the last value the run produced.
 *
 * `REPS` rather than one: see the header on why an ordering between two single samples is not a measurement.
 * The value is returned so a repeated run can hand its result to the next measurement — `read` produces the
 * session array the assembly is timed over, and re-reading it three times must still leave one array behind.
 */
const REPS = 3;
async function fastest(fn) {
  let best = Number.POSITIVE_INFINITY;
  let value;
  for (let attempt = 0; attempt < REPS; attempt += 1) {
    const started = process.hrtime.bigint();
    value = await fn();
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsed < best) best = elapsed;
  }
  return { ms: best, value };
}

const read = await fastest(async () => {
  let sessions = await corpus.sessions();
  for (let attempt = 1; attempt < SLOW_READS; attempt += 1) sessions = await corpus.sessions();
  return sessions;
});
const readMs = read.ms;
const readSessions = read.value;

const assembleMs = (await fastest(() => memory.answerSessions(question, readSessions))).ms;

const storedMs = (await fastest(() => memory.askStored(question))).ms;

const turns = await corpus.size();
const ratio = readMs / assembleMs;
await store.close();
rmSync(dir, { recursive: true, force: true });

const census = {
  $comment:
    'Written by tools/corpus-read-census.mjs. A corpus of 10^5 turns in a real SQLite file, then three ' +
    'timings: the read (`corpus.sessions()`), the assembly (`answerSessions` over the same array with a stub ' +
    'reader at the registered 48k room), and the two together through `askStored()`. Each is the fastest of ' +
    `${String(REPS)} runs, because load only adds time and the gate compares two of them. The ratio is the ` +
    'registered falsifiable clause: above 2.0 the read-amplification design does not hold and `askStored` is ' +
    'withdrawn in favour of `remember` alone.',
  dataset: `${String(turns)} turns, ${String(SESSIONS)} sessions x ${String(TURNS_PER_SESSION)}, one SQLite file`,
  room: ROOM,
  fault: FAULT ?? null,
  readMs: round(readMs),
  assembleMs: round(assembleMs),
  storedMs: round(storedMs),
  writeMs,
  ratio: round(ratio),
  reading:
    'read / assemble. One number, because the clause is one comparison: does the transcript scan cost more ' +
    'than twice the work the answer path was already doing over the same turns?',
};

function round(value) {
  return Math.round(value * 100) / 100;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(census, null, 2)}\n`);

// The clause, in the tool rather than in a reader. `answerSessions` is the comparison rather than a
// hand-built prompt: it is the work `askStored` delegates to, so the difference between the two timings is
// the read and nothing else.
if (census.ratio > 2) {
  console.error(
    `FAILED: the transcript read cost ${String(census.ratio)}x the answer path's own work over the same ` +
      `${String(turns)} turns (read ${String(census.readMs)}ms, assemble ${String(census.assembleMs)}ms). ` +
      'The registered clause says the read-amplification design does not hold above 2.0x -- drop `askStored` ' +
      'and keep `remember`, and record the reading in the plan.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `corpus read census ok -- ${String(turns)} turns; read ${String(census.readMs)}ms, assemble ` +
      `${String(census.assembleMs)}ms, stored ${String(census.storedMs)}ms; ratio ${String(census.ratio)}x ` +
      `(clause: <= 2.0x)`,
  );
}

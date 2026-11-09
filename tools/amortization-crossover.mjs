#!/usr/bin/env node
/**
 * Where a two-tier memory architecture's ingestion pays for itself -- and why the answer on
 * LongMemEval is "it does not".
 *
 * Zep's ~4,400 prompt tokens per question is the cheapest published reading on the board and this
 * arm reads 9,201. The difference is real and it is not free. Graphiti runs a model call per
 * episode to infer `valid_at`/`invalid_at` before it can answer anything, so its read path is cheap
 * because its write path was expensive. That trade needs a denominator to be judged, and the
 * denominator is **how many questions one haystack is asked**: a product that ingests a customer's
 * history once and answers a thousand questions over it amortises the write path over 1,000 reads;
 * a benchmark where every question carries its own haystack charges it 500 times and collects once.
 *
 * So the useful quantity is not the gap in tokens. It is the **ratio at which the gap closes**.
 * Every vendor publishes the first number; none publishes the second, and the second is the one
 * that says whether an architecture is cheaper for a product or only for a benchmark.
 */

/**
 * @param {object} input
 * @param {number} input.oursPerQuestion        prompt tokens this arm spends for one question
 * @param {number} input.theirsPerQuestion      the competitor's published or measured read cost
 * @param {number} input.theirsIngestPerHaystack prompt tokens the competitor must spend before the
 *                                              first question can be answered
 */
export function crossover({ oursPerQuestion, theirsPerQuestion, theirsIngestPerHaystack }) {
  requireNonNegative('oursPerQuestion', oursPerQuestion);
  requireNonNegative('theirsPerQuestion', theirsPerQuestion);
  requireNonNegative('theirsIngestPerHaystack', theirsIngestPerHaystack);

  const savingPerQuestion = oursPerQuestion - theirsPerQuestion;

  // A competitor that is not cheaper per read has no gap to close, so no number of questions
  // repays anything. This is not a degenerate input -- it is the state of the board for several
  // rows, and reporting a large crossover there would invent an incentive to adopt them.
  if (savingPerQuestion <= 0) {
    return {
      savingPerQuestion,
      questionsToRepay: 0,
      verdict: 'never',
      reason: 'the competitor is not cheaper per question, so there is nothing to amortise',
    };
  }

  return {
    savingPerQuestion,
    questionsToRepay: Math.ceil(theirsIngestPerHaystack / savingPerQuestion),
    verdict: 'repays',
    reason: 'one haystack must be asked this many questions before the ingestion is repaid',
  };
}

/**
 * The competitor's ingestion bill for one haystack, from the shape of the corpus rather than from a
 * guess: `sessions` extraction calls, each carrying one session plus its prompt overhead.
 *
 * Every term is a measurement or a named configuration, not a fitted coefficient, so a reader can
 * disagree with one of them instead of with the result.
 *
 * @param {object} input
 * @param {number} input.sessions             sessions per question in the corpus
 * @param {number} input.tokensPerSession     mean tokens in one session
 * @param {number} input.callsPerSession      extraction calls per session (Graphiti: one per episode)
 * @param {number} input.promptOverhead       instruction tokens carried by every extraction call
 * @param {number} input.outputTokensPerCall  extracted entities and edges written back per call
 */
export function ingestPerHaystack({
  sessions,
  tokensPerSession,
  callsPerSession,
  promptOverhead,
  outputTokensPerCall,
}) {
  requireNonNegative('sessions', sessions);
  requireNonNegative('tokensPerSession', tokensPerSession);
  requireNonNegative('promptOverhead', promptOverhead);
  requireNonNegative('outputTokensPerCall', outputTokensPerCall);
  requirePositive('callsPerSession', callsPerSession);

  const calls = sessions * callsPerSession;
  return calls * (tokensPerSession + promptOverhead + outputTokensPerCall);
}

function requireNonNegative(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number >= 0, got ${String(value)}`);
  }
}

function requirePositive(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number > 0, got ${String(value)}`);
  }
}

function flag(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const raw = argv[index + 1];
  if (raw === undefined) throw new Error(`--${name} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${raw}`);
  return value;
}

function main(argv) {
  // The arm's own reading is the one number here that came from this repository's runner:
  // 9,201 is `C5` (`42533236864`), four-repetition mean, on the adopted per-route allocation.
  const ours = flag(argv, 'ours', 9201);
  const theirsRead = flag(argv, 'theirs-read', 4400);
  // LongMemEval's shape, measured: 47 sessions per question and ~115k haystack tokens, i.e. 2,447
  // tokens per session. The extraction overhead is a configuration of Graphiti's `add_episode()`,
  // not a published constant, so it is a flag rather than a buried number.
  const sessions = flag(argv, 'sessions', 47);
  const tokensPerSession = flag(argv, 'tokens-per-session', 2447);
  const callsPerSession = flag(argv, 'calls-per-session', 1);
  const promptOverhead = flag(argv, 'prompt-overhead', 500);
  const outputTokensPerCall = flag(argv, 'output-per-call', 800);

  const ingest = ingestPerHaystack({
    sessions,
    tokensPerSession,
    callsPerSession,
    promptOverhead,
    outputTokensPerCall,
  });
  const point = crossover({
    oursPerQuestion: ours,
    theirsPerQuestion: theirsRead,
    theirsIngestPerHaystack: ingest,
  });

  const n = (value) => value.toLocaleString('en-US');
  process.stdout.write(
    [
      `ours             ${n(ours)} prompt tokens / question`,
      `theirs (read)    ${n(theirsRead)} prompt tokens / question`,
      `theirs (ingest)  ${n(ingest)} prompt tokens / haystack`,
      `                 ${n(sessions)} sessions x ${n(callsPerSession)} call(s) x ` +
        `(${n(tokensPerSession)} + ${n(promptOverhead)} in + ${n(outputTokensPerCall)} out)`,
      '',
      `one haystack must be asked ${n(point.questionsToRepay)} questions before the competitor's ` +
        `ingestion is repaid`,
      `LongMemEval asks each haystack 1 question.`,
      '',
    ].join('\n'),
  );

  return point.verdict === 'repays' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}

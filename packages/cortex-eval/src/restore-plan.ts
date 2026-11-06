/**
 * The restore counterfactual's one path: reinstate a question's gold evidence and ask again.
 *
 * ## What this is for
 *
 * §13.267 registered a per-question paired intervention: take a question whose answer was wrong
 * while some of its gold turns were missing from the window, put those turns back in front of
 * **the same reader**, and ask again. The classification it produces -- `recoverable` when the
 * answer flips to correct, `residual` when it does not -- is the only thing that separates "the
 * selector dropped evidence that would have helped" from "the reader could not use it", and
 * §13.274 is the run that finally asks it.
 *
 * `/workspace` evidence for why the gap needed a module rather than a flag: `gold-room.py` shows
 * every one of the 32 partial-`MR` questions has its missing gold *inside* the ranking and *inside*
 * the character budget at `topK=512` (31 offered, 31 fit, 0 out of room). So the failure is not
 * room and not the pool -- it is the order the selector chose. Restoring is what tells us whether
 * a better order would have been worth anything.
 *
 * ## Why the injection point is the reader, and not the product
 *
 * Three placements were available and two of them are wrong here:
 *
 * 1. **A product option** (`restoreTurns` on `CortexMemoryOptions`) would put a test instrument on
 *    the product's public surface, and the value varies per question while the arm builds one
 *    instance per worker and reuses it -- so the option would have to be mutable, which is a
 *    product API shaped by a benchmark.
 * 2. **A prompt-level hook** inside `prompt.ts` would have to be threaded through three builders
 *    that already carry a dozen conditional options each, and it would change the bytes the
 *    product produces for every other run.
 * 3. **The reader** is already the product's designed seam: `LLM` is an injected interface with
 *    exactly two methods, the product never inspects it, and a decorator around it changes one
 *    call's prompt and nothing else. The product does not know the experiment exists -- which is
 *    also why the restore cannot accidentally become a shipped behaviour.
 *
 * The decorator is where `llmUsage` is already counted, so the extra characters are charged to the
 * run that spent them, and every measurement below is taken from the same string the provider was
 * sent.
 *
 * ## Identity: the `QUESTION:` line, not a substring
 *
 * A decorator sees a prompt and has to decide which question it belongs to. Substring matching is
 * the obvious rule and it is the wrong one -- a question is a sentence, sentences contain other
 * sentences, and a plan whose entries are "what did I buy at the store" and "buy at the store"
 * would restore the wrong evidence into one of them without any symptom.
 *
 * The product writes the question on its own labelled line (`QUESTION: <question>`), a literal
 * from `prompt.ts` rather than a format this module invents, so the identity is an **equality test
 * on that line's content**. Escape hatches were considered and refused: a prompt whose question
 * line does not match any entry is recorded as unmatched rather than guessed at, because a silent
 * non-restore and a successful restore that changed nothing are the same bytes in the outcome and
 * must not be the same bytes in the record.
 *
 * There is one exception and it is not a loosening of that rule. `prompt.ts` truncates the question
 * line when the evidence budget leaves it no room, so on exactly the runs whose windows are full --
 * the population this instrument exists for -- the line is a strict **prefix** of the question. A
 * truncated prefix is accepted when it is long enough to be text rather than a coincidence and when
 * it identifies exactly one entry; two candidates is the ambiguity the equality rule exists to make
 * impossible, and it is reported rather than resolved by picking one.
 *
 * ## Why the block goes above the question
 *
 * The insertion point is the `QUESTION:` line: the block lands at the end of the evidence section
 * and immediately before the ask, which is where evidence is already written. Appending after the
 * question would put reference material after the instruction that says "answer", and a reader
 * that treats the last thing it read as the task would be reading a different experiment.
 *
 * ## What this module refuses to decide
 *
 * It does not choose the population (`tools/restore-population.py` does, before any call), it does
 * not grade (`judgeScorer` does, the arm's own instrument), and it does not interpret. It parses a
 * plan, inserts a block, and records what it inserted. §13.267.3's gates are read off the record.
 */

import type { LLM, CompleteOptions, JsonSchema } from '@agentix-e/cortex-core';
import type { BenchmarkDataset } from './types.js';

/**
 * One question's intervention: the gold turns that were missing from the window.
 *
 * `turns` holds the **undelivered** gold turns only. Restoring one that had already been delivered
 * would double the evidence and, worse, would make gate 4 -- "the prompt grew by the restored text
 * and nothing else" -- pass while measuring something else. `tools/restore-population.py` computes
 * the difference from `goldOverlap.goldTurns` and `goldOverlap.goldDelivered`, which are aligned
 * lists of the same length, so the subtraction is well defined rather than textual.
 *
 * `recordedOutcome` is the source run's verdict on this question, carried so the analysis cannot
 * read the failure and control populations off the wrong side. It is a **record of what the source
 * artifact said**, not an expectation about this run: the run's job is to disagree with it.
 */
type RestoreEntry = {
  readonly questionId: string;
  readonly question: string;
  readonly turns: readonly string[];
  readonly recordedOutcome: 'correct' | 'incorrect';
};

/** The population, as a file, with the run it was derived from. */
type RestorePlan = {
  /** Where the entries came from -- a run id, or the artifact path the workflow downloaded. */
  readonly source: string;
  readonly entries: readonly RestoreEntry[];
};

/**
 * The banner the block opens with.
 *
 * It names the block's status rather than its provenance: the reader is told this is evidence of
 * the same kind as the rest, because the counterfactual's claim is about the *content* having been
 * missing and not about it arriving late. A banner that said "restored for a counterfactual" would
 * be asking the model to reason about the experiment.
 */
const RESTORE_BANNER = 'ADDITIONAL EVIDENCE:';

/** The product's own label for the question line. `prompt.ts` writes it; this module reads it. */
const QUESTION_MARKER = '\nQUESTION: ';

/** Why a plan was refused. Thrown as one sentence naming the offending entry. */
function refuse(reason: string): never {
  throw new Error(`restore plan refused: ${reason}`);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate a plan, refusing anything this module would have to guess about.
 *
 * Module-local rather than exported: its only caller is `readRestorePlanFromEnv` below, and a public
 * parser would be a second way into the same validation -- one that a caller could reach without the
 * environment read that names the file. The tests reach it through the exported reader, which is the
 * path a run takes.
 *
 * Every branch here corresponds to a way the plan can be wrong that produces a **plausible run**:
 * a duplicate id would restore one question's evidence into another's prompt; an empty `turns`
 * list would run the whole intervention with nothing in it and report a clean null result; a
 * missing `recordedOutcome` would let the analysis read the control population off the failure
 * side, which is the one error that inverts the conclusion. None of them throws on its own.
 */
function parseRestorePlan(value: unknown): RestorePlan {
  if (!isRecordLike(value)) refuse('the plan is not an object');
  const source = value['source'];
  if (typeof source !== 'string' || source.trim() === '') {
    refuse('`source` must be a non-empty string naming the artifact the population came from');
  }
  const rawEntries = value['entries'];
  if (!Array.isArray(rawEntries)) refuse('`entries` must be an array');
  if (rawEntries.length === 0)
    refuse('`entries` is empty, so the intervention would measure nothing');

  const entries: RestoreEntry[] = [];
  const seenIds = new Set<string>();
  const seenQuestions = new Set<string>();
  for (const [index, raw] of rawEntries.entries()) {
    if (!isRecordLike(raw)) refuse(`entries[${index}] is not an object`);
    const questionId = raw['questionId'];
    const question = raw['question'];
    const turns = raw['turns'];
    const recordedOutcome = raw['recordedOutcome'];
    if (typeof questionId !== 'string' || questionId === '') {
      refuse(`entries[${index}].questionId must be a non-empty string`);
    }
    if (typeof question !== 'string' || question === '') {
      refuse(`entries[${index}].question must be a non-empty string`);
    }
    if (!Array.isArray(turns) || turns.length === 0) {
      refuse(
        `entries[${index}] (${questionId}) has no turns to restore, so the intervention would ` +
          'change nothing while reporting that it ran',
      );
    }
    for (const [turnIndex, turn] of turns.entries()) {
      if (typeof turn !== 'string' || turn === '') {
        refuse(`entries[${index}].turns[${turnIndex}] must be a non-empty string`);
      }
    }
    if (recordedOutcome !== 'correct' && recordedOutcome !== 'incorrect') {
      refuse(
        `entries[${index}] (${questionId}) must say whether the source run was \`correct\` or ` +
          '`incorrect`; the analysis reads the control and failure populations off this field',
      );
    }
    // Duplicates are refused rather than merged. Two entries for one id would restore the union of
    // two lists into one prompt, which is neither of the interventions either entry names.
    if (seenIds.has(questionId)) refuse(`duplicate questionId ${JSON.stringify(questionId)}`);
    // Two ids with one question text is the identity ambiguity this module exists to make
    // impossible: the decorator matches on the question line, so two entries would match the same
    // prompt and the block would be inserted twice.
    if (seenQuestions.has(question)) {
      refuse(
        `two entries share the question text of ${questionId}; the decorator matches on the ` +
          'question line, so one prompt would receive both blocks',
      );
    }
    seenIds.add(questionId);
    seenQuestions.add(question);
    entries.push({ questionId, question, turns: [...turns], recordedOutcome });
  }

  return { source, entries };
}

/**
 * The text prepended above the question line for one entry.
 *
 * One turn per paragraph with a `- ` bullet, because the product's own evidence blocks render
 * turns as list items (`prompt.ts`) and a restored block that rendered differently would be a
 * second format the reader has to reconcile.
 *
 * The leading single newline is exact rather than cosmetic: the insertion point is the `\n` that
 * opens the question line, so the character before it is already a newline and one more produces
 * the blank line that separates blocks. Two would produce a paragraph of whitespace, and zero would
 * run the banner on from the last evidence turn -- the first is a stray blank line the reader has
 * to ignore, the second merges two blocks into one.
 */
export function restoreBlock(entry: Pick<RestoreEntry, 'turns'>): string {
  const lines = entry.turns.map((turn) => `- ${turn}`);
  return `\n${RESTORE_BANNER}\n${lines.join('\n')}\n`;
}

/** What one decorated call did, in the terms §13.267.3's fourth gate is written in. */
export type RestoreCall = {
  /** The entry this prompt belonged to, or `null` when no question line matched an entry. */
  readonly questionId: string | null;
  /** `complete` or `completeStructured`; the two are separate counters for the reason above. */
  readonly channel: 'complete' | 'structured';
  /** Length of the prompt the product built. */
  readonly beforeChars: number;
  /** Length of the prompt the provider was sent. */
  readonly afterChars: number;
};

/** The decorated reader, plus the ledger of what it did. */
type RestoringReader = {
  readonly llm: LLM;
  /** Every call, in order. Read by the analysis, never by the product. */
  readonly calls: RestoreCall[];
  /** How many calls carried no entry. Non-zero is an instrument defect, not a finding. */
  unmatchedCalls(): number;
};

/**
 * The question-line content of a prompt, or `null` when the product wrote no question line.
 *
 * The **last** marker wins: the composite and abstention contracts quote the question inside their
 * own instruction blocks, and the ask is the last one written. Taking the first would match an
 * instruction that happens to begin with the marker, and the failure would be invisible -- the
 * block would be inserted in the middle of an instruction.
 */
function questionLine(prompt: string): string | null {
  const at = prompt.lastIndexOf(QUESTION_MARKER);
  if (at < 0) return null;
  const start = at + QUESTION_MARKER.length;
  const end = prompt.indexOf('\n', start);
  return (end < 0 ? prompt.slice(start) : prompt.slice(start, end)).trim();
}

/**
 * Insert the block for `entry` immediately above the ask.
 *
 * `insertAt` is recomputed from the prompt rather than passed in, so the two functions cannot
 * disagree about which `QUESTION:` line is the ask.
 */
function inject(prompt: string, block: string): string {
  const at = prompt.lastIndexOf(QUESTION_MARKER);
  // `questionLine` returned non-null, so the marker exists. Indexing defensively rather than
  // asserting keeps this a pure function of its argument under `noUncheckedIndexedAccess`.
  if (at < 0) return prompt;
  return prompt.slice(0, at) + block + prompt.slice(at);
}

/**
 * How much of a question line has to survive truncation before a prefix match is allowed.
 *
 * The product truncates the question line when the evidence budget leaves it no room
 * (`prompt.ts`'s `truncateCodePointSafe` around the same literal), and a truncated line is a strict
 * prefix of the question rather than a different string -- so an equality-only rule would report
 * "unmatched" on exactly the runs whose windows are full, which is the population this instrument
 * exists for. A prefix is accepted only when it is unique among the plan's questions and long enough
 * that uniqueness is a fact about the text rather than about the plan's size.
 */
const MIN_PREFIX_MATCH = 24;

/** The plan entry a question line identifies, by equality or by a unique truncated prefix. */
function matchEntry(entries: readonly RestoreEntry[], line: string): RestoreEntry | undefined {
  const exact = entries.find((entry) => entry.question === line);
  if (exact !== undefined) return exact;
  if (line.length < MIN_PREFIX_MATCH) return undefined;
  const prefixed = entries.filter((entry) => entry.question.startsWith(line));
  // Two candidates is the ambiguity the exact rule exists to make impossible, and it is not resolved
  // by picking one: the block would land in the wrong prompt and the ledger would say it landed.
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * Decorate a reader so that every prompt for a planned question carries that question's missing
 * gold turns, and record what was inserted.
 *
 * The ledger is the instrument, and it is a **parameter** because a run may hold more than one
 * reader: `readerByRoute` names a second client for the routes that carry thinking, and a per-reader
 * ledger would produce two records that have to be concatenated by a caller who could forget. One
 * ledger handed to every decorator is one record of one run.
 *
 * `beforeChars` and `afterChars` are lengths of the exact strings handed across the seam, so gate 4
 * -- "the prompt grew by the restored text and nothing else" -- is a subtraction a reader can check
 * rather than a claim the harness makes about itself.
 */
export function restoringReader(
  inner: LLM,
  plan: RestorePlan,
  ledger: RestoreCall[] = [],
): RestoringReader {
  const calls = ledger;

  const decorate = (
    prompt: string,
    channel: RestoreCall['channel'],
  ): { prompt: string; matched: RestoreEntry | null } => {
    const line = questionLine(prompt);
    const matched = line === null ? undefined : matchEntry(plan.entries, line);
    if (matched === undefined) {
      calls.push({
        questionId: null,
        channel,
        beforeChars: prompt.length,
        afterChars: prompt.length,
      });
      return { prompt, matched: null };
    }
    const next = inject(prompt, restoreBlock(matched));
    calls.push({
      questionId: matched.questionId,
      channel,
      beforeChars: prompt.length,
      afterChars: next.length,
    });
    return { prompt: next, matched };
  };

  const llm: LLM = {
    complete: (prompt: string, options?: CompleteOptions): Promise<string> =>
      inner.complete(decorate(prompt, 'complete').prompt, options),
    completeStructured: <T>(
      prompt: string,
      schema: JsonSchema,
      options?: CompleteOptions,
    ): Promise<T> =>
      inner.completeStructured<T>(decorate(prompt, 'structured').prompt, schema, options),
  };

  return {
    llm,
    calls,
    unmatchedCalls: () =>
      calls.reduce((total, call) => total + (call.questionId === null ? 1 : 0), 0),
  };
}

/**
 * The variable that turns a run into the restore counterfactual.
 *
 * Named here rather than spelled in the entry point for the reason `env-toggle.ts` gives: `bench/**`
 * is outside the coverage boundary, so a string literal there is a string no test can reach.
 */
const RESTORE_PLAN_VARIABLE = 'CORTEX_RESTORE_PLAN';

/**
 * Read the plan named by the environment, or `null` when the run is not a counterfactual.
 *
 * `read` is a parameter rather than an import so this decision is testable without a filesystem.
 * The two failure modes are separated deliberately: an **absent** variable is the ordinary run and
 * answers `null`, while a **present but empty** one is a dispatch that meant to restore and named
 * nothing -- which, if it were read as absent, would produce a five-hundred-question arm that
 * silently answered the wrong question at full price.
 */
export function readRestorePlanFromEnv(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
): RestorePlan | null {
  const path = env[RESTORE_PLAN_VARIABLE];
  if (path === undefined) return null;
  if (path.trim() === '') {
    refuse(`${RESTORE_PLAN_VARIABLE} is set but empty; unset it for an ordinary run`);
  }
  return parseRestorePlan(JSON.parse(read(path.trim())) as unknown);
}

/**
 * The dataset restricted to the plan's questions, in the dataset's own order.
 *
 * The run is over twenty-two questions, not five hundred, and this is the function that makes the
 * two runs comparable rather than merely cheaper: the relevance index is built per question, so a
 * question's pool is the top-`k` of its own context and filtering the dataset cannot move it. What
 * would move it is passing a different subset to the index than to the arm, which is why both are
 * derived from this one return value.
 *
 * A plan entry the dataset does not hold is refused. The two ways that happens are a stale plan and
 * a dataset whose file moved, and both produce a run of nineteen questions that calls itself
 * twenty-two -- a number nobody downstream can correct.
 */
export function restrictDatasetToPlan(
  dataset: BenchmarkDataset,
  plan: RestorePlan,
): BenchmarkDataset {
  const byId = new Map(dataset.questions.map((question) => [question.id, question]));
  for (const entry of plan.entries) {
    if (!byId.has(entry.questionId)) {
      refuse(
        `the dataset has no question ${JSON.stringify(entry.questionId)}; the plan was built ` +
          'against a different file or a different sample',
      );
    }
  }
  const planned = new Set(plan.entries.map((entry) => entry.questionId));
  return {
    name: dataset.name,
    questions: dataset.questions.filter((question) => planned.has(question.id)),
  };
}

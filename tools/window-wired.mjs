#!/usr/bin/env node
/**
 * Price the time-window reorder **by running the product**, not by reimplementing it.
 *
 * ## Why this exists beside `window-reach.mjs`
 *
 * `window-reach.mjs` prices the mechanism from the artifact with its own rules: it parses stamps,
 * resolves windows through `resolveTimeRange`, and counts which questions split their delivered list. That
 * is a good instrument for deciding whether a dispatch is worth paying for, and it is the wrong instrument
 * for asking what the **product** will do, because two of its steps are approximations of the real ones:
 *
 * 1. "the window splits the delivered list" is not "the delivery is reordered". If the turns the window
 *    admits are **already** at the front -- which is the common case for a recent period -- the promotion
 *    is a no-op and the prompt is byte-identical. §13.153.4 measured the gap: 19 TR questions resolve a
 *    window and 9 of them actually move, and the difference is the difference between a population and a
 *    mechanism's reach;
 * 2. the delivered set is decided by the budget, and whether the reorder changes that set is a property of
 *    the code (`buildPrompt` promotes `carried`, never `turns`). Only the code can answer it.
 *
 * So this tool replays each question through `CortexMemory` twice -- readers absent, readers supplied --
 * with a stub LLM that never runs, and compares the two deliveries. It makes **zero model calls**, and the
 * only thing it inherits from the artifact is the question text, the turn list and the reference date.
 *
 * ## What it replays, and what it therefore cannot price
 *
 * `QuestionRecord.turns` is the **delivery**: the turns the prompt carried, after the budget. Replaying
 * them is exactly right for this mechanism, whose whole claim is that it permutes the delivery. It is
 * therefore **not** an instrument for the region axis -- a mechanism that changed *which* region is
 * delivered cannot be replayed from a delivery, because the artifact holds only the region the control
 * chose. `expand-resolution.mjs` is that instrument.
 *
 * ## The reference date, and why the substitution is printed
 *
 * A qualifier resolves against the date the question was asked, and `QuestionRecord.questionDate` only
 * exists on artifacts written after §13.152.2. On an older artifact this tool substitutes the last date in
 * the delivered span, which is **not** the question date: the haystack can end months before the question
 * was asked, so the substituted window is displaced and the count is a lower bound. The substitution rate
 * is printed rather than hidden, because a reader who does not know the reference was invented cannot tell
 * an approximate window from an exact one (§13.152.2).
 *
 * ## The three counts, and why they are three
 *
 * - **fired**: the resolver returned a window. This is the population the mechanism was administered to.
 * - **moved**: the delivered list came back in a different order. Fired-but-inert is a real outcome and
 *   the one a mechanism can overstate a reach with.
 * - **converted / sold**: among the moved questions, how many the control answered wrong and how many it
 *   answered right. A run that buys four and sells four has had two effects and a delta of zero, and only
 *   the split can say so (§13.152.4 criterion 6).
 *
 * ## Exit codes
 *
 * `2` for a malformed invocation -- every one of those refusals replaces a plausible number with one wrong
 * in a direction nobody would notice. `1` for a well-formed artifact that answers nothing here (no question
 * resolves a window), which is a different fix from a different command. `0` otherwise.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EVAL_ENTRY = new URL('../packages/cortex-eval/dist/index.js', import.meta.url);
const MEMORY_ENTRY = new URL('../packages/cortex-memory/dist/index.js', import.meta.url);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function unsupported(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { control: undefined, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--control') {
      const value = argv[++index];
      if (value === undefined) fail('--control needs a path');
      if (options.control !== undefined) fail('--control was given twice');
      options.control = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: window-wired.mjs --control <report.json> [--json]\n' +
          '\n' +
          'Replays each question of a benchmark artifact through the product twice -- the window reorder\n' +
          'absent and supplied -- and reports how many questions the mechanism was administered to, how\n' +
          'many deliveries it actually reordered, and how those split between questions the control got\n' +
          'wrong (converted) and right (sold). No model is called.\n',
      );
      process.exit(0);
    } else {
      fail(`unrecognised argument ${JSON.stringify(arg)}`);
    }
  }
  if (options.control === undefined) fail('--control is required');
  return options;
}

function readArtifact(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${path} is not JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${path} is not an object`);
  }
  const questions = parsed.questions;
  if (!Array.isArray(questions)) {
    fail(`${path} has no questions array, so there is nothing to replay`);
  }
  if (questions.length === 0) {
    unsupported('the artifact holds no questions');
  }
  return questions;
}

/** A turn's text, or a refusal -- a skipped turn would silently shrink every delivery this tool compares. */
function turnText(turn, questionId) {
  if (typeof turn === 'string') return turn;
  if (turn !== null && typeof turn === 'object' && typeof turn.text === 'string') return turn.text;
  fail(`question ${JSON.stringify(questionId)} has a turn that is neither text nor {text}`);
}

/**
 * A reader that answers locally.
 *
 * The product consults it on routes that need one, and this tool needs the **delivery**, not the answer:
 * `#recordEvidence` runs before the consult, so a constant is enough. The point of the stub is that no
 * request leaves the process, which is what makes this instrument free to run on every artifact -- the
 * alternative, a real reader, would make a mechanism priced at 9 questions cost a full dispatch.
 */
function stubLlm(answer = 'window-wired stub') {
  return {
    complete: async () => answer,
    completeStructured: async () => {
      throw new Error('window-wired.mjs asks for no structured output');
    },
  };
}

function readDate(content, readTurnStamp) {
  return readTurnStamp(content)?.date;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const questions = readArtifact(options.control);

  const ids = new Set();
  for (const question of questions) {
    if (typeof question.questionId !== 'string' || question.questionId === '') {
      fail('a question record has no questionId, so the two arms cannot be paired');
    }
    if (ids.has(question.questionId)) fail(`duplicate questionId ${JSON.stringify(question.questionId)}`);
    ids.add(question.questionId);
    if (typeof question.question !== 'string' || question.question === '') {
      fail(`question ${JSON.stringify(question.questionId)} has no question text`);
    }
    if (!Array.isArray(question.turns)) {
      fail(`question ${JSON.stringify(question.questionId)} has no turns array`);
    }
  }

  return { options, questions };
}

const { options, questions } = main();

const evalPackage = await import(pathToFileURL(EVAL_ENTRY.pathname).href);
const { CortexMemory } = await import(pathToFileURL(MEMORY_ENTRY.pathname).href);
const { readTurnStamp, resolveTimeRange, EXTENDED_ENGINE_OPTIONS, classifyTemporalQuestion } = evalPackage;

const readers = {
  dateOf: (content) => readDate(content, readTurnStamp),
  windowOf: (question, questionDate) =>
    questionDate === undefined
      ? undefined
      : (resolveTimeRange(question, questionDate, EXTENDED_ENGINE_OPTIONS) ?? undefined),
};

function system(withWindow) {
  return new CortexMemory({
    llm: stubLlm(),
    now: 0,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...(withWindow ? { windowOrdering: readers } : {}),
  });
}

const rows = [];
let substituted = 0;
for (const question of questions) {
  const turns = question.turns.map((turn) => turnText(turn, question.questionId));
  const spanDates = turns
    .map((turn) => readDate(turn, readTurnStamp))
    .filter((date) => date !== undefined)
    .sort();
  // The real question date when the artifact carries one, otherwise the last date in the delivery --
  // counted as a substitution so the reading cannot be mistaken for exact (§13.152.2).
  const stated = typeof question.questionDate === 'string' ? question.questionDate : undefined;
  const reference = stated ?? spanDates.at(-1);
  if (stated === undefined) substituted += 1;

  const control = system(false);
  const treated = system(true);
  // The temporal route is the only one the harness hands a date to; every other capability is asked the
  // same way it is asked in a run, with no date, and therefore cannot resolve a window.
  const temporal = question.capability === 'TR';
  if (temporal) {
    await control.answerTemporal(question.question, turns, reference);
    await treated.answerTemporal(question.question, turns, reference);
  } else {
    await control.answer(question.question, turns);
    await treated.answer(question.question, turns);
  }
  const before = control.lastRetrievedContext() ?? [];
  const after = treated.lastRetrievedContext() ?? [];
  const window = temporal && reference !== undefined
    ? resolveTimeRange(question.question, reference, EXTENDED_ENGINE_OPTIONS)
    : null;

  rows.push({
    id: question.questionId,
    capability: question.capability,
    kind: classifyTemporalQuestion(question.question),
    correct: question.correct === true,
    fired: window !== null,
    moved: before.join('\u0000') !== after.join('\u0000'),
    // The criterion-2 check, on the product rather than on a reimplementation of it.
    sameMultiset: [...before].sort().join('\u0000') === [...after].sort().join('\u0000'),
    delivered: before.length,
    promoted: after.findIndex((turn) => {
      if (window === null) return false;
      const date = readDate(turn, readTurnStamp);
      return date !== undefined && (date < window.start || date > window.end);
    }),
  });
}

const byCapability = {};
const total = { questions: 0, fired: 0, moved: 0, converted: 0, sold: 0, broken: 0 };
for (const row of rows) {
  const bucket = (byCapability[row.capability] ??= {
    questions: 0,
    fired: 0,
    moved: 0,
    converted: 0,
    sold: 0,
    broken: 0,
  });
  for (const target of [bucket, total]) {
    target.questions += 1;
    if (row.fired) target.fired += 1;
    if (row.moved) {
      target.moved += 1;
      if (row.correct) target.sold += 1;
      else target.converted += 1;
    }
    if (!row.sameMultiset) target.broken += 1;
  }
}

if (total.fired === 0) {
  unsupported(
    'no question in this artifact resolves a window, so it cannot price the mechanism -- either the\n' +
      'corpus carries no period references or the reference dates were unreadable',
  );
}

const promoted = rows.filter((row) => row.moved && row.promoted > 0);
const summary = {
  control: options.control,
  questions: total.questions,
  referenceSubstituted: substituted,
  byCapability,
  total,
  promotedTurns: {
    mean: promoted.length === 0 ? 0 : promoted.reduce((sum, row) => sum + row.promoted, 0) / promoted.length,
    min: promoted.length === 0 ? 0 : Math.min(...promoted.map((row) => row.promoted)),
    max: promoted.length === 0 ? 0 : Math.max(...promoted.map((row) => row.promoted)),
  },
  broken: rows.filter((row) => !row.sameMultiset).map((row) => row.id),
  moved: rows.filter((row) => row.moved).map((row) => ({
    id: row.id,
    capability: row.capability,
    kind: row.kind,
    correct: row.correct,
    delivered: row.delivered,
    promoted: row.promoted,
  })),
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const pct = (part, whole) => (whole === 0 ? '0.0%' : `${((100 * part) / whole).toFixed(1)}%`);
  process.stdout.write(
    `window reorder, priced by running the product (no request leaves the process)\n` +
      `control: ${options.control}\n` +
      `reference date substituted on ${substituted} of ${total.questions} questions ` +
      `(${pct(substituted, total.questions)}) -- a lower bound when it is not zero\n\n`,
  );
  process.stdout.write(
    `${'capability'.padEnd(11)}${'questions'.padStart(10)}${'fired'.padStart(8)}${'moved'.padStart(8)}` +
      `${'converted'.padStart(11)}${'sold'.padStart(7)}${'broken'.padStart(8)}\n`,
  );
  for (const [capability, row] of Object.entries(byCapability).sort()) {
    process.stdout.write(
      `${capability.padEnd(11)}${String(row.questions).padStart(10)}${String(row.fired).padStart(8)}` +
        `${String(row.moved).padStart(8)}${String(row.converted).padStart(11)}${String(row.sold).padStart(7)}` +
        `${String(row.broken).padStart(8)}\n`,
    );
  }
  process.stdout.write(
    `${'roster'.padEnd(11)}${String(total.questions).padStart(10)}${String(total.fired).padStart(8)}` +
      `${String(total.moved).padStart(8)}${String(total.converted).padStart(11)}${String(total.sold).padStart(7)}` +
      `${String(total.broken).padStart(8)}\n\n`,
  );
  process.stdout.write(
    `administered ${pct(total.fired, total.questions)} of the roster; delivery reordered on ` +
      `${total.moved} (${pct(total.moved, total.questions)})\n` +
      `of the reordered: ${total.converted} wrong in the control, ${total.sold} already correct\n` +
      `delivered multiset changed on ${total.broken} questions -- criterion 2 is a property of the code, ` +
      `so a non-zero here is a defect rather than a result\n`,
  );
}

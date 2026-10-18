/**
 * Raw model text to `Answer`.
 *
 * `Answer = string | null`, where `null` is an abstention. The distinction that
 * carries every metric: an empty string is an *answer* — a blank, wrong one —
 * and not an abstention. `computeMetrics` scores abstentions separately, so
 * collapsing the two moves accuracy, abstention rate and abstention-aware
 * accuracy at once, in the same direction, without any test failing.
 */
import type { Answer } from '@agentix-e/cortex-eval';

/**
 * The single literal naming an abstention.
 *
 * `prompt.ts` injects it and this module reads it. One literal, imported by
 * both, because two literals that must agree is the exact shape of the
 * consolidation-clock defect recorded in `AUDIT-CONSOLIDATION-CLOCK.md`.
 */
export const ABSTAIN_TOKEN = 'INSUFFICIENT_EVIDENCE';

/**
 * The reader of the two-step contract's headings.
 *
 * ## Why the parser owns it rather than the prompt
 *
 * `prompt.ts` imports `ABSTAIN_TOKEN` from here, so a reader imported from
 * `prompt.ts` would close a cycle. The heading is a **reader** rule in any case --
 * the prompt writes "Step 1" because that is how a two-step instruction is written,
 * and this is the pattern that recognises one. That the two agree is pinned by
 * `parse-stepped.test.ts`, which builds a real `enumerated` multi-session prompt,
 * reads its headings out of the prompt text, and drives this parser with a response
 * that echoes them. The guard is the coupling, which is §13.36's rule applied to a
 * pair that cannot share a literal.
 *
 * ## Why a heading and not a length
 *
 * A length rule would rewrite prose answers, and the numbers of every archived run
 * were produced with prose answers intact. A heading rule fires only on a response
 * that writes the contract out: measured at **0 of the 1,000** questions in runs
 * `38595325261` and `38828538851`, and 118 of run `38953157688`'s 121 multi-session
 * questions. So this cannot change a number that has been published, and it repairs
 * the ask that produced the shape it recognises.
 *
 * A **line that opens** with the heading, not a mention anywhere: "I followed Step 1
 * of the method and the answer is 7" is an answer, and splitting on the mention would
 * delete it.
 */
const ENUMERATION_STEP_HEADING = /^\s*step\s*\d+\s*[\u2014:-]/i;

/** `Answer: X` or `Answer - X`, the label shapes models emit unprompted. */
const LABEL_PREFIX = /^[A-Za-z ]{0,20}[:-]\s*/;

/**
 * Turn raw output into an `Answer`.
 *
 * Abstention is recognised only where it constitutes a *decision*: the whole
 * response, or the last non-empty line of a chatty response. A token appearing
 * mid-sentence is evidence about wording, not a decision, so
 * `"the user worded it insufficiently"` stays an answer.
 */
export function parseAnswer(raw: string): Answer {
  const trimmed = raw.trim();

  // An empty completion is an empty answer, not a refusal. Emitting `null` here
  // would let a provider that returned nothing be scored as a correct
  // abstention on every ABS question.
  if (trimmed.length === 0) return '';

  if (isAbstention(trimmed)) return null;

  // The abstention rule is read first and deliberately: 29 of run `38953157688`'s
  // responses write the Step 1 list and then the sentinel, and if the heading rule
  // ran first those 29 would be scored as answers. The decline is a decision about
  // the whole response, so it outranks any reading of the response's parts.
  return stripWrappingQuotes(collapseWhitespaceEdges(afterLastStepHeading(trimmed) ?? trimmed));
}

/**
 * The text after the LAST step heading, or `undefined` when there is none.
 *
 * The last one, because the contract's headings are a sequence and the answer is
 * what follows the final step. `undefined` rather than the input, so the caller
 * decides what "no heading" means and a reader of the call site can see that the
 * unchanged path is explicit.
 *
 * A heading with nothing after it (the model stopped after writing it) returns the
 * empty string, which is an *answer* in this package -- a blank, wrong one -- and not
 * an abstention. Falling back to the whole transcript there would score the
 * transcript, which is the defect this exists to remove.
 *
 * ## §13.60: an answer may share the heading's line, and the `+ 1` assumed it never did
 *
 * The slice used to start after the heading **line**, so that a model that copies the
 * instruction and answers below it is scored on the answer. The `+ 1` is the newline that
 * ends the heading line -- and when the heading line is the last line there is no such
 * newline, so the slice began past the end of the text and every answer written *beside*
 * the heading was read as blank.
 *
 * That shape was called unobserved when the rule was written ("118 put the answer on its
 * own line after the last heading, and 0 put it on the heading line itself"), so the blank
 * reading was a conservative choice rather than an error. It has now been observed: **8**
 * records of run `39035438120` and **18** of run `39076055833`. The second run's closing
 * line asks the model to "reply with the Step 2 number alone", and ten of those eighteen
 * wrote it exactly there. The reader then discarded it.
 *
 * So the rule is: if anything follows the heading line, the answer begins after that line
 * (the echo case, unchanged); otherwise it begins after the heading marker, where the only
 * content left is what the model wrote. Neither branch can see the transcript.
 */
function afterLastStepHeading(text: string): string | undefined {
  const lines = text.split('\n');
  let start: number | undefined;
  let offset = 0;
  for (const line of lines) {
    const heading = ENUMERATION_STEP_HEADING.exec(line);
    if (heading) {
      const afterLine = offset + line.length + 1;
      start = text.slice(afterLine).trim().length > 0 ? afterLine : offset + heading[0].length;
    }
    offset += line.length + 1;
  }
  // The leading whitespace of the slice is the newline that ended the heading line, or the
  // space that separated the marker from the answer, and `collapseWhitespaceEdges`
  // deliberately trims only spaces and tabs at the front (a leading newline cannot occur on
  // any other path, because `parseAnswer` trims the whole response first). Removed here so
  // the answer does not begin with a line break.
  return start === undefined ? undefined : text.slice(start).replace(/^[ \t\n]+/, '');
}

/**
 * True when the text is a decision to abstain rather than text containing the
 * token.
 *
 * The decision is read from the **last non-empty line**, and only from there.
 * That single rule covers every shape without a special case: a bare token, a
 * chatty preamble followed by the token, and a label-prefixed token all end
 * with it, while a token mentioned mid-sentence does not.
 *
 * An earlier version had two separate rules — a trailing-label check and a
 * "leading label on a single-line response" check — and both reduced to this
 * one: for a single-line response the last line *is* the whole text, so the
 * second rule could never decide anything the first had not. Two rules that
 * always agree are one rule with a redundant copy, which is why there is one.
 *
 * The caller guarantees `text` is non-empty, so `find` always returns a line
 * here and the `?? text` fallback is unreachable. It is written as a fallback
 * rather than a branch because manufacturing an unreachable arm to satisfy a
 * type is how a real branch gets a test that asserts nothing.
 */
export function isAbstention(text: string): boolean {
  const lines = text.split('\n').reverse();

  // Only the first non-blank line encountered from the end can decide. A token
  // on an earlier line is a mention, not a decision, so the scan stops at the
  // first line that carries anything at all.
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return equalsToken(stripDecoration(line));
  }

  // No line carries anything, so there is no decision to read. `parseAnswer`
  // returns before reaching here for blank input, which is why this is exported
  // as a predicate in its own right: called directly it answers the question
  // "does this text decide to abstain?" for every input, blank included, and
  // the blank case is asserted in `parse.test.ts` instead of being an
  // unreachable arm inside a private helper.
  return false;
}

function equalsToken(text: string): boolean {
  return text.trim().toUpperCase() === ABSTAIN_TOKEN;
}

function stripLabel(text: string): string {
  return text.replace(LABEL_PREFIX, '');
}

/**
 * Wrappers a model puts *around* its answer rather than *in* it.
 *
 * Each entry is a symmetric pair, and only a pair counts: `*Paris*` is emphasis on
 * one word, while `*` alone is a bullet or a footnote marker and stripping it would
 * turn a list item into an answer. That is the same distinction `stripWrappingQuotes`
 * makes for the answer path, and it is why the pair list is data rather than a
 * character class.
 */
const MIRROR_WRAPPERS: readonly (readonly [string, string])[] = [
  ['**', '**'],
  ['__', '__'],
  ['*', '*'],
  ['_', '_'],
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
];

/**
 * Strip one symmetric wrapper, if the text carries one.
 *
 * The two-character wrappers are tried before the one-character ones, and the order
 * matters for exactly one input shape: `**X**` also starts and ends with `*`, so a
 * single-character pass first would leave `*X*`, which the next round would then
 * strip. Composing to the same result either way is fine; what is not fine is a
 * wrapper list whose longest-first order is an accident, so it is stated here.
 */
function stripWrapper(text: string): string {
  for (const [open, close] of MIRROR_WRAPPERS) {
    if (
      text.length >= open.length + close.length &&
      text.startsWith(open) &&
      text.endsWith(close)
    ) {
      return text.slice(open.length, text.length - close.length);
    }
  }
  return text;
}

/**
 * A deciding line reduced to its content: labels and wrappers are presentation.
 *
 * ## Why this is a fixpoint rather than the one `stripLabel` it replaced
 *
 * `isAbstention`'s contract is that the **last non-blank line** decides. A model that
 * writes a reasoning trace and then emphasises its conclusion produces a deciding line
 * of `**INSUFFICIENT_EVIDENCE**`, which is a decision by that contract and was read as
 * an answer by the implementation -- so a decline was scored as a wrong answer. Run
 * `38487229554` records five such lines, all on the temporal route, and the temporal
 * block is the one that asks the model to *show its work*, which is why the shape
 * appears there first: markdown emphasis on the final line is a consequence of being
 * asked for a trace.
 *
 * Labels and wrappers also nest both ways round -- `Answer: **TOKEN**` and
 * `**Answer: TOKEN**` are the same decision -- so one ordered pass cannot cover both.
 * Peeling to a fixpoint covers every nesting without enumerating the orders, and the
 * loop terminates by construction because each round either shortens the text or ends
 * it.
 *
 * ## What it deliberately does not do
 *
 * It does not look inside the line for the token. `INSUFFICIENT_EVIDENCE was the wrong
 * call here` stays an answer, because a token inside prose is a mention and the whole
 * predicate rests on that distinction. Only decoration **around the whole line** is
 * removed, which is what separates presentation from content.
 */
function stripDecoration(text: string): string {
  let out = text.trim();
  for (;;) {
    const next = stripWrapper(stripLabel(stripWrapper(out))).trim();
    if (next.length >= out.length) return out;
    out = next;
  }
}

/** Trim only the outer edges; interior newlines are part of a multi-line answer. */
function collapseWhitespaceEdges(text: string): string {
  return text.replace(/^[ \t]+/, '').replace(/[ \t\n]+$/, '');
}

/** A symmetric pair of quotes around the whole answer is delivery, not content. */
function stripWrappingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    const paired =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '\u201c' && last === '\u201d');
    if (paired) return text.slice(1, -1);
  }
  return text;
}

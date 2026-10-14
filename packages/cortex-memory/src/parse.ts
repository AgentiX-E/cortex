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

  return stripWrappingQuotes(collapseWhitespaceEdges(trimmed));
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

/**
 * The statement a later turn replaces, marked where the reader meets it.
 *
 * ## The failure, and why the block that already exists is not the same mechanism
 *
 * `conflict.ts` prints a side block between the evidence and the question: two statements, in order,
 * with a conditional line saying which is the later value. Every `KU` twin question that fails in all
 * four repetitions of run `42355323615` fails **while that block is available**, and the block was
 * priced on its own: reading the fourth arm of the three-cell split, marking alone moves the twin
 * questions by **-4.75** — four repetitions, all negative, monotone deepening (-1 / -4 / -6 / -8).
 *
 * The reading that explains it is in the block's own docblock: run `42754985453` priced the third
 * sentence, the one that named the *earlier* value as the answer to a "before" question, and it cost
 * three conversions on questions that ask for the **current** value. A block placed after the evidence
 * is read after the reader has already formed its answer, and a block that names both statements tells
 * the reader they are both candidates. Either way the reader is being asked to re-decide at a point
 * where it has already decided.
 *
 * This mechanism moves the mark instead. It does not add a section, does not restate a statement, and
 * does not say which value to answer: it appends one bracketed clause to the turn whose own words state
 * a value the evidence later replaces, inside that turn's rendering, so the reader meets it at the
 * sentence it is about rather than 23,084 characters later. The judgement is untouched —
 * {@link supersededTurns} reads `conflict.ts`'s statement selection and adds nothing to it — and the
 * whole mechanism is a string appended to one turn.
 *
 * ## Why the mark does not name the value it is replaced by
 *
 * Because that would be the side block again, one turn closer. `renderConflicts` prints the later
 * statement's sentence and its date; a mark that printed them too would make this mechanism a
 * distribution of the block over the evidence and would inherit its reading rather than test its own.
 * The mark states one fact the reader can verify from the evidence it already has — *a later turn
 * states a different value* — and leaves the comparison where it belongs.
 *
 * ## Why `collapse` exists at all
 *
 * `mark` is the accuracy arm and it costs characters. `collapse` is the other direction on the same
 * axis: the turn is replaced by the mark and **the one sentence that states the replaced value**, so a
 * turn of 1,800 characters that states an old value contributes about 200. That is a cost mechanism
 * and its reading is a cost reading — it changes the delivered multiset by construction, because
 * shorter turns buy more of them, so a paired accuracy reading of `collapse` is confounded by the
 * window it re-opens. Say that on the artifact rather than discovering it in a review.
 *
 * Both arms are off by default. A default that changes a prompt makes every published artifact
 * unreproducible from the code, which is the rule stated once in `prompt.ts` and obeyed here.
 *
 * ## The two constants are the contract, not a style choice
 *
 * `SUPERSEDED_MARKER` and `SUPERSEDED_COLLAPSED` are exported because they are what the acceptance
 * clause is written against: with `mark` on, the delivered prompt must be longer than the same
 * prompt with it off by **exactly** `SUPERSEDED_MARKER.length` times the number of marked turns. A
 * glyph a run could configure would make the prompt's bytes a function of a string a run could typo,
 * and the delta would stop being arithmetic.
 */

import type { AdmittedTurn } from './admission.js';
import { conflictStatements, valueSignature } from './conflict.js';
import type { ConflictOptions } from './conflict.js';

/**
 * What the rendering does to a turn whose value a later turn replaces.
 *
 * `'off'` is the identity: the turn list is not copied, no mark is computed, and the prompt is the one
 * every archived run produced.
 */
export type SupersededRendering = 'off' | 'mark' | 'collapse';

/**
 * Appended to a marked turn's rendering, once per marked turn.
 *
 * A single line that opens with `\n` and contains no blank line, so the delta between a marked and an
 * unmarked prompt is this string's length times the number of marked turns and nothing else: the
 * evidence blocks are joined with `\n\n` by the renderer, and a mark containing `\n\n` would add a
 * delimiter the block count could not distinguish from a turn boundary.
 */
export const SUPERSEDED_MARKER = '\n[this states a value a later turn replaces]';

/**
 * Prepended to a collapsed turn's rendering.
 *
 * Shorter than the sentence it introduces, so a collapsed turn is always shorter than the mark alone —
 * a `collapse` arm that could deliver a longer turn than the turn it collapsed would be a cost
 * mechanism that costs.
 */
export const SUPERSEDED_COLLAPSED = '[replaced value] ';

/**
 * The turns a rendering may mark, and how.
 *
 * A map from turn id to the sentence that states the replaced value, rather than a set of ids: the
 * `mark` arm needs only the id, and the `collapse` arm needs the sentence, and one field that serves
 * both is one field that cannot disagree with itself about which turns are marked.
 *
 * An id rather than a position, and that is what makes the marks survive the budget. `buildPrompt` and
 * `fitToBudget` re-render subsets of the turns they are handed — a measurement render, a selected set, a
 * whole-turn prefix — and a position would be an index into a list that is not the one being rendered.
 * Every rendering path asks `contentFor` for one turn at a time, so the id is the only key that means
 * the same thing on all of them.
 */
export type SupersededMarks = {
  /** Which of the two renderings is applied. `'off'` is not expressible: it produces no marks at all. */
  readonly rendering: Exclude<SupersededRendering, 'off'>;
  /** Turn id to the sentence that states the replaced value. */
  readonly turns: ReadonlyMap<string, string>;
};

/** One turn to mark, and the sentence that put it on the list. */
export type SupersededTurn = {
  /** The turn's own id, so the rendering can find it again after the budget has chosen a subset. */
  readonly id: string;
  /** The turn's sentence that shares the most terms with the question, already clipped by `conflict.ts`. */
  readonly sentence: string;
};

/**
 * The turns whose statements a later statement in the same window replaces.
 *
 * ## Why this is derived from `conflict.ts` rather than computed beside it
 *
 * Because "which statements are about the question" is one question, and two answers to it would be
 * two populations: the side block would print a pair the mark did not mark, and a run with both on
 * would show the reader a block whose statements do not carry marks. `conflictStatements` already
 * keeps the **earliest and the latest** valued statement unconditionally (the endpoint rule, measured
 * on `ce6d2d27` where eight candidates tie at two terms and relevance ordering drops the earlier half
 * of the pair), and the last of them is the statement that makes the others replaced. So this reads the
 * selection and compares value signatures; it does not select.
 *
 * ## Why the last statement is the replacing one, and the test that would have to change
 *
 * The block is printed in **evidence order**, not relevance order, so the last entry is the latest
 * statement. That is the whole of the argument for "the latest value is the last one" — a window
 * assembled out of order would break it, and `prompt.ts`'s ordering stage only permutes *before* the
 * block is computed, so no route can hand this a permuted list.
 *
 * ## Why a shared signature is skipped rather than marked
 *
 * Two statements that state the same value are not a supersession, and marking them would be a claim
 * about the evidence the evidence does not make. `conflictStatements` already refuses a population in
 * which every statement agrees (`new Set(...).size < 2` returns `[]`), so on the pair this function
 * exists for the skip never fires on the endpoint — but it does fire on a middle statement that repeats
 * the latest value, and marking that one would tell the reader to distrust a statement that is still
 * true.
 */
export function supersededTurns(
  question: string,
  turns: readonly AdmittedTurn[],
  options: ConflictOptions = {},
): SupersededTurn[] {
  const statements = conflictStatements(question, turns, options);
  // `conflictStatements` returns fewer than two only when there is no pair to compare, which is also
  // the only case in which no statement is replaced.
  if (statements.length < 2) return [];
  const latest = statements[statements.length - 1]!;
  const current = valueSignature(latest.sentence).join('|');
  const replaced: SupersededTurn[] = [];
  for (const statement of statements.slice(0, -1)) {
    if (valueSignature(statement.sentence).join('|') === current) continue;
    replaced.push({ id: turns[statement.position]!.id, sentence: statement.sentence });
  }
  return replaced;
}

/**
 * The rendering of one turn, once the mark is applied.
 *
 * ## Why this is a function over text rather than a branch in the renderer
 *
 * Because it is the whole mechanism, and a mechanism that lives as one `if` inside a renderer can only
 * be tested through a prompt — and then the arm that does not mark is reachable only from a prompt that
 * happens to contain no marked turn, which is a test that passes for the wrong reason. Here the three
 * arms are all reachable from one call, and the renderer's own coverage is not asked to reach them a
 * second time.
 *
 * `text` is the turn as the renderer had already built it — capped, windowed, marked as cut, whatever
 * this route asked for — and the `collapse` arm **discards it on purpose**: collapsing means the reader
 * is shown the statement at issue instead of the turn it sits in, and keeping the capped text would
 * make the arm's cost a function of the cap it is supposed to replace.
 *
 * `'off'` returns its argument rather than the empty string, and that is not a defensive branch: it is
 * the statement that off is the identity, which is the property every byte-identity assertion in this
 * package is written against.
 */
export function renderSupersededInline(
  text: string,
  sentence: string,
  rendering: SupersededRendering,
): string {
  if (rendering === 'off') return text;
  if (rendering === 'collapse') return `${SUPERSEDED_COLLAPSED}${sentence}`;
  return `${text}${SUPERSEDED_MARKER}`;
}

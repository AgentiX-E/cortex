/**
 * Composition, as a seam rather than as a renderer.
 *
 * ## What this file does, and what it deliberately does not
 *
 * The loop decides *which* turns and in what order. The caller's renderer decides *how they are
 * printed*, and that second decision is where this campaign's numbers live: turn numbering, the
 * evidence header, the instruction block the contract selects, the room, the cut. This file
 * therefore does exactly two things: it normalises the selection (drop ids the corpus does not
 * hold, drop repeats), and it hands the result to the renderer it was given.
 *
 * ## Why the renderer is a parameter and not an import
 *
 * An earlier revision imported `cortex-memory`'s `buildPrompt` and `admitTurns` here. That made a
 * module whose own header says "the loop never renders them" depend on the renderer it says it
 * never calls, and it made "this arm prints through the registered renderer" a claim about a
 * package name rather than about an object. As a parameter the claim is structural: the caller
 * passes the *instance* the registered arm prints through, so the two arms share one renderer even
 * if a third one is added later. The rank-difference ordering that used to live here moved to
 * `cortex-memory`'s `renderInOrder`, because it is a statement about printed order -- that is, about
 * rendering, not about selection.
 *
 * ## Why duplicates are dropped here rather than at the renderer
 *
 * A repeated id would spend the room twice on the same words, and a selection that repeated itself
 * is a fact about the loop, not about printing. Dropping it before the renderer keeps the
 * renderer's contract simple: `ordered` is unique and in range, always.
 */
import type { RenderedPrompt, Renderer } from './types.js';

/**
 * The prompt, and the turns it carries.
 *
 * `ordered` is derived by walking `selected` rather than by filtering and sorting the corpus, so
 * "the order is the reader's" is a property of the code rather than a claim about a comparator. An
 * id outside `turns` has no text and is dropped; a non-integer id is the same case.
 *
 * The two options are written inline rather than as a named type because nothing outside names them:
 * a caller passes `{ renderer, config }` and the export census refuses a type whose only mention is
 * its own declaration.
 */
export function composeAgentPrompt<Config>(
  question: string,
  turns: readonly string[],
  selected: readonly number[],
  options: {
    /** The renderer the arm prints through. Pass the one the registered arm passes. */
    readonly renderer: Renderer<Config>;
    /** The renderer's own options. Opaque here. */
    readonly config: Config;
  },
): RenderedPrompt {
  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const id of selected) {
    // `Number.isInteger` rather than `>= 0` alone: `NaN` and `2.5` both compare false against a
    // range check, and a float id would index `turns` to `undefined` and reach the renderer as an
    // ordinal that names no turn.
    if (!Number.isInteger(id) || id < 0 || id >= turns.length) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return options.renderer({ question, turns, ordered, config: options.config });
}

/** The corpus ids a composed prompt actually carries, in printed order. */
export function carriedIds(rendered: RenderedPrompt): readonly number[] {
  return rendered.carried.map((turn) => turn.ordinal);
}

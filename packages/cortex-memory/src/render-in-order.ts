/**
 * Print a caller's chosen turns in the caller's order, through the shipped renderer.
 *
 * ## Why this is in `cortex-memory` and not in the package that selects
 *
 * `cortex-agent` selects turns and owns no renderer. It used to import this logic directly, which
 * made a package whose own header states "the loop never renders them" depend on the renderer it
 * says it never calls. The seam is now an interface on that side and this file on this side: the
 * selection crosses as `ordered: readonly number[]`, and everything about *how a turn is printed* --
 * admission, numbering, the contract's instruction block, the room, the cut -- stays in the package
 * that owns the prompt.
 *
 * ## Why the score is a rank difference rather than a relevance
 *
 * Because there is no relevance to report. The caller's evidence is an ordered set, and inventing a
 * magnitude for it -- the index's score at the time the turn was found -- would make the printed
 * order depend on which query happened to surface a turn, so a turn found by a weak query would
 * print after one found by a strong query even when the caller asked for them in the other order.
 * `ordered.length - rank` is strictly decreasing, so no two candidate scores tie, the arrival-order
 * tie-break never runs, and the printed order is the order the caller built.
 *
 * Identical text is the one case this cannot distinguish, and it is not a loss: two turns with the
 * same string are the same evidence in the prompt, and which ordinal carries it changes nothing a
 * model or a grader can see.
 *
 * ## Why admission runs with `threshold: 0`
 *
 * Admission is not a filter here -- the caller already selected, and a gate that cut on value would
 * be a second selector with no reading of its own. `now: 0` is a pinned clock rather than `Date.now()`:
 * the prompt must be a function of its inputs, or a replay composes different bytes.
 */
import { admitTurns, type AdmittedTurn } from './admission.js';
import {
  buildPrompt,
  type AssembledPrompt,
  type EvidenceAsk,
  type PromptContract,
} from './prompt.js';

export type RenderInOrderOptions = {
  /** The contract the arm runs. There is no default: a default here would be a second arm. */
  readonly contract: PromptContract;
  /** The route's room. Absent means the builder's own default. */
  readonly maxChars?: number | undefined;
  /** The route's ask, when the arm names one. */
  readonly ask?: EvidenceAsk | undefined;
  /** The reference point for the temporal contract. */
  readonly questionDate?: string | undefined;
};

/**
 * One call's worth of rendering: the question, the corpus, the chosen ids in the caller's order.
 *
 * `turns` must be the array the ids index. An id outside it is dropped rather than rendered, for
 * the same reason the selection drops it: an id the corpus does not hold has no text, and a prompt
 * that printed a placeholder would spend room on a turn no reader can cite.
 *
 * Not exported: it is the parameter of one function, and a caller that wants to name it can write
 * `Parameters<typeof renderInOrder>[0]`. The export census refuses a type whose only mention is its
 * own declaration, which is why `RenderInOrderOptions` -- named by the probe entry -- is the one
 * type on this module's surface.
 */
type RenderInOrderInput = {
  readonly question: string;
  readonly turns: readonly string[];
  readonly ordered: readonly number[];
  readonly config: RenderInOrderOptions;
};

export function renderInOrder(input: RenderInOrderInput): AssembledPrompt {
  const { question, turns, ordered, config } = input;
  const admitted = admitTurns(turns, { now: 0, threshold: 0 });
  const byOrdinal = new Map<number, AdmittedTurn>();
  for (const turn of admitted) byOrdinal.set(turn.ordinal, turn);

  // Built by walking the caller's order rather than by filtering and sorting the admitted set, and
  // that is the difference between "the order is the caller's" being a property of the code and
  // being a claim about a comparator. A repeated id is skipped so the prompt cannot carry one turn
  // twice, which would spend the room twice on the same words.
  const kept: AdmittedTurn[] = [];
  const seen = new Set<number>();
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const turn = byOrdinal.get(id);
    if (turn === undefined) continue;
    kept.push(turn);
  }

  // Keyed by text because that is what `relevanceFor` is handed, and written once per text: the
  // first occurrence is the highest-ranked one, so a later duplicate must not lower it.
  const scoreOf = new Map<string, number>();
  for (const [index, turn] of kept.entries()) {
    if (!scoreOf.has(turn.content)) scoreOf.set(turn.content, kept.length - index);
  }
  // The cast is the invariant, stated once: `buildPrompt` only asks about the turns it was handed,
  // and every one of those is in the map. A `?? 0` here would be a branch no input could take, and an
  // unreachable branch is a behaviour nobody has ever observed -- the campaign's rule is to delete it
  // rather than to carry a fallback that reads like a decision.
  const relevanceFor = (_question: string, turn: string): number => scoreOf.get(turn) as number;

  return buildPrompt(question, kept, config.contract, {
    relevanceFor,
    ...(config.maxChars === undefined ? {} : { maxChars: config.maxChars }),
    ...(config.ask === undefined ? {} : { ask: config.ask }),
    ...(config.questionDate === undefined ? {} : { questionDate: config.questionDate }),
  });
}

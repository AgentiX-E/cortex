/**
 * Composition: hand the reader's evidence to the renderer that every measurement used.
 *
 * ## Why this is the whole design and not a detail
 *
 * The loop decides *which* turns; `buildPrompt` decides *how they are printed*, and that second
 * decision is where this campaign's numbers live: turn numbering, the evidence header, the
 * instruction block the contract selects, the room, the cut. A multi-step mechanism that wrote its
 * own prompt could be better or worse than the registered arm and there would be no way to say
 * which -- every difference in the result would be attributable to the prompt as a whole, the
 * evidence selection included, and the two could never be separated again.
 *
 * So this file does exactly one thing that the loop does not: it converts the chosen ids into the
 * `relevanceFor` signal that `buildPrompt` already understands, so the evidence order is the
 * reader's order and everything downstream of the selection is byte-identical to a run with no
 * agent in it. §14.98.5's no-dispatch condition is the test of that claim: `maxSteps: 0`, composed
 * through here, must produce the same prompt as the registered assembly on the same corpus.
 *
 * ## Why the score is a rank difference rather than a relevance
 *
 * Because there is no relevance to report. The reader's evidence is an ordered set, and inventing a
 * magnitude for it -- the index's score at the time the turn was found -- would make the printed
 * order depend on which query happened to surface a turn, so a turn found by a weak query would
 * print after one found by a strong query even when the reader asked for them in the other order.
 * `selected.length - rank` is strictly decreasing, so no two candidate scores tie, the arrival-order
 * tie-break never runs, and the printed order is the order the reader built.
 *
 * Identical text is the one case this cannot distinguish, and it is not a loss: two turns with the
 * same string are the same evidence in the prompt, and which ordinal carries it changes nothing a
 * model or a grader can see.
 */
import type {
  AdmittedTurn,
  AssembledPrompt,
  EvidenceAsk,
  PromptContract,
} from '@agentix-e/cortex-memory';
import { admitTurns, buildPrompt } from '@agentix-e/cortex-memory';

export type ComposeOptions = {
  /** The contract the arm runs. There is no default: a default here would be a second arm. */
  readonly contract: PromptContract;
  /** The route's room. Absent means `buildPrompt`'s own default, which is not a cell anyone priced. */
  readonly maxChars?: number | undefined;
  /** The route's ask, when the arm names one. */
  readonly ask?: EvidenceAsk | undefined;
  /** The reference point for the temporal contract. */
  readonly questionDate?: string | undefined;
};

/**
 * The prompt, the turns it carries, and the ids they came from.
 *
 * `carried` from `buildPrompt` is the delivered set after the room's cut, and each entry keeps the
 * `ordinal` it was admitted with, which is its index in `turns`. That is what makes the delivered
 * set comparable to a gold set: no second bookkeeping.
 */
export function composeAgentPrompt(
  question: string,
  turns: readonly string[],
  selected: readonly number[],
  options: ComposeOptions,
): AssembledPrompt {
  // `threshold: 0` admits every turn the reader chose. Admission is not a filter here -- the loop
  // already selected, and a gate that cut on value would be a second selector with no reading of
  // its own. `now: 0` is a pinned clock rather than `Date.now()`: the prompt must be a function of
  // its inputs, or a replay composes different bytes.
  const admitted = admitTurns(turns, { now: 0, threshold: 0 });
  const byOrdinal = new Map<number, AdmittedTurn>();
  for (const turn of admitted) byOrdinal.set(turn.ordinal, turn);
  // Built by walking the reader's order rather than by filtering and sorting the admitted set, and
  // that is the difference between "the order is the reader's" being a property of the code and
  // being a claim about a comparator. A repeated id is skipped so the prompt cannot carry one turn
  // twice, which would spend the room twice on the same words.
  const kept: AdmittedTurn[] = [];
  const seen = new Set<number>();
  for (const id of selected) {
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

  return buildPrompt(question, kept, options.contract, {
    relevanceFor,
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    ...(options.ask === undefined ? {} : { ask: options.ask }),
    ...(options.questionDate === undefined ? {} : { questionDate: options.questionDate }),
  });
}

/** The corpus ids a composed prompt actually carries, in printed order. */
export function carriedIds(assembled: AssembledPrompt): readonly number[] {
  return assembled.carried.map((turn: AdmittedTurn) => turn.ordinal);
}

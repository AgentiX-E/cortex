/**
 * A frame and the facts read off it: the two layers that make a split auditable.
 *
 * ## The arrangement, and what each layer is for
 *
 * ```
 * Frame   the sentence the person said, verbatim, never rewritten
 *   └── Fact   a self-contained statement, typed, with a span back into the frame
 * ```
 *
 * `g05` is the case that taught this shape. The sentence is "Each had its own unique charm, **but**
 * I think my favourite was the Fairmont Orchid." The atom that came back is "The Fairmont Orchid was
 * my favorite." — a perfectly good fact and a lossy record, because the fact it replaced (the other
 * hotels were charming too) was the *point* of saying it. With a frame, the fact is recoverable
 * exactly; without one, the atom is all that survives and the reviewer's only recourse is to read the
 * card and say "neither of these is right".
 *
 * The frame is therefore not a nicety for provenance. It is the **value layer**: the thing handed to
 * a reader that needs to judge, and the thing an audit compares against. `DESIGN-KNOWLEDGE-MODEL.md`
 * §4.4 is the delivery rule that follows from it.
 *
 * ## Why the span is computed, not trusted
 *
 * A model that reports character offsets is wrong often enough that trusting them would put a span on
 * a fact that points at the wrong clause — worse than no span, because it looks checkable. `locate`
 * recomputes the span from the words the fact kept, so the answer is a function of the two strings and
 * is identical every time it is asked. The consequence is that the span is an **envelope**, not a
 * minimal explanation: it covers everything between the first and last word the fact borrowed, which
 * for a two-clause sentence is the whole sentence. That is honest — the fact *does* depend on the
 * whole sentence — and it is still enough to answer "which sentence is this from", which is the
 * question an audit asks.
 */

import type { BorrowedWord } from '../triage/grounding.js';
import { isFactType, isModality, isPolarity } from './taxonomy.js';
import type { FactType, Modality, Polarity } from './taxonomy.js';

/** A half-open character range, `[start, end)`, into one frame. */
export type Span = {
  readonly start: number;
  readonly end: number;
};

/** One thing a person said, kept exactly as said. */
export type KnowledgeFrame = {
  readonly id: string;
  readonly text: string;
  /** Who said it, when the caller knows. Absent means "the sole speaker", which is the usual case. */
  readonly speaker?: string;
  /** When it was said, epoch ms. Absent means "not recorded", which is not the same as zero. */
  readonly at?: number;
  readonly sessionId?: string;
};

/**
 * One statement, typed, bound to the frame it came from.
 *
 * `subject` and `predicate` are optional and are the **only** inputs to a `supersedes` derivation. A
 * fact without them can never supersede anything, which is the correct behaviour for a system that
 * refuses to guess: "the plan changed" and "the plan did not change" share no slot, so no derivation
 * is attempted rather than a wrong one.
 */
export type KnowledgeFact = {
  readonly id: string;
  readonly frameId: string;
  readonly text: string;
  readonly type: FactType;
  readonly polarity: Polarity;
  readonly modality: Modality;
  /** Where in the frame this fact's words come from. Computed by `locate`, not reported by a model. */
  readonly sourceSpan: Span;
  /**
   * Words the fact used that the frame did not contain, each with the context it came from.
   *
   * Empty for a fact that stays inside its sentence — which is most of them. Non-empty is the
   * self-containment case (`g13`'s "The project…"), and each entry is the receipt.
   */
  readonly references: readonly BorrowedWord[];
  readonly subject?: string;
  readonly predicate?: string;
  /** When the fact is true, epoch ms, when the sentence says. Absent means "the sentence did not say". */
  readonly at?: number;
};

/** Why a fact was refused. Each names the thing that was wrong, not the rule that noticed. */
export type FactProblem =
  | { readonly problem: 'blank'; readonly detail: string }
  | { readonly problem: 'unknown-type'; readonly detail: string }
  | { readonly problem: 'unknown-polarity'; readonly detail: string }
  | { readonly problem: 'unknown-modality'; readonly detail: string }
  | { readonly problem: 'frame-mismatch'; readonly detail: string }
  | { readonly problem: 'span-outside-frame'; readonly detail: string }
  | { readonly problem: 'span-empty'; readonly detail: string };

/** Letters, digits and inner apostrophes: one word, for span arithmetic. */
const WORD = /[A-Za-z0-9][A-Za-z0-9'’-]*/g;

/** Word occurrences of `text`, lowercase, with where each one is. */
function occurrences(text: string): { word: string; start: number; end: number }[] {
  const found: { word: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(WORD)) {
    found.push({
      word: match[0].toLowerCase().replace(/['’]s$/, ''),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/**
 * The smallest range of `frame` that contains every word the fact shares with it.
 *
 * The envelope is deliberate. A tighter span would require alignment, and an alignment that is wrong
 * by one word points at the wrong clause; an envelope that is too wide still answers the only question
 * a span has to answer — "which sentence is this from, and does it say that?".
 *
 * A fact whose words are all borrowed from context shares nothing with the frame, and gets the whole
 * frame. That is the honest answer: nothing in the frame is its evidence, and the frame is the
 * smallest unit that the export can point at.
 */
export function locate(atom: string, frameText: string): Span {
  const frameOccurrences = occurrences(frameText);

  // Short words are excluded as anchors, and this was found by a test rather than anticipated: with
  // them in, "I finished an online course" in a frame that later says "so I want to apply it" produced
  // an envelope reaching the second "I", because the pronoun is a word the two strings share. A span
  // that swallows the next clause is not a citation. Three characters keep "was" and "the" (which sit
  // inside the run they belong to) and exclude the pronouns that float everywhere.
  const longEnough = (word: string): boolean => word.length >= 3;
  const frameAnchors = new Set(
    frameOccurrences.filter((entry) => longEnough(entry.word)).map((entry) => entry.word),
  );

  let shared = new Set(
    occurrences(atom)
      .map((entry) => entry.word)
      .filter((word) => longEnough(word) && frameAnchors.has(word)),
  );
  // A fact made only of short words has no anchor, and refusing to point anywhere would be worse than
  // pointing at the whole frame: widening once is the honest answer, not an error.
  if (shared.size === 0) {
    const everyFrameWord = new Set(frameOccurrences.map((entry) => entry.word));
    shared = new Set(
      occurrences(atom)
        .map((entry) => entry.word)
        .filter((word) => everyFrameWord.has(word)),
    );
  }
  if (shared.size === 0) return { start: 0, end: frameText.length };

  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const entry of frameOccurrences) {
    if (!shared.has(entry.word)) continue;
    start = Math.min(start, entry.start);
    end = Math.max(end, entry.end);
  }
  return { start, end };
}

/** The smallest span covering all of `spans`. Throws on an empty list: there is nothing to cover. */
export function envelope(spans: readonly Span[]): Span {
  if (spans.length === 0) {
    throw new TypeError('envelope needs at least one span');
  }
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const span of spans) {
    start = Math.min(start, span.start);
    end = Math.max(end, span.end);
  }
  return { start, end };
}

/** Whether `inner` lies inside `outer`. Adjacency is not containment: an empty overlap is not a cover. */
export function covers(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Check a fact against the frame it claims. Returns the first problem, or `null`. */
export function checkFact(fact: KnowledgeFact, frame: KnowledgeFrame): FactProblem | null {
  if (fact.text.trim() === '') {
    return { problem: 'blank', detail: `fact ${JSON.stringify(fact.id)} has no text` };
  }
  // Three closed vocabularies are checked at runtime, not only in the type system, because a fact
  // arrives from JSON: a stored card, a replay of an old proposal, a hand-written fixture. TypeScript
  // stops none of those. An unknown `type` would otherwise be counted by `censusOf` under a key no
  // report renders, which is the quietest possible way to lose a fact's classification.
  if (!isFactType(fact.type)) {
    return {
      problem: 'unknown-type',
      detail: `fact ${JSON.stringify(fact.id)} has type ${JSON.stringify(fact.type)}`,
    };
  }
  if (!isPolarity(fact.polarity)) {
    return {
      problem: 'unknown-polarity',
      detail: `fact ${JSON.stringify(fact.id)} has polarity ${JSON.stringify(fact.polarity)}`,
    };
  }
  if (!isModality(fact.modality)) {
    return {
      problem: 'unknown-modality',
      detail: `fact ${JSON.stringify(fact.id)} has modality ${JSON.stringify(fact.modality)}`,
    };
  }
  if (fact.frameId !== frame.id) {
    return {
      problem: 'frame-mismatch',
      detail: `fact ${JSON.stringify(fact.id)} says frame ${JSON.stringify(fact.frameId)}, but was checked against ${JSON.stringify(frame.id)}`,
    };
  }
  const { start, end } = fact.sourceSpan;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return {
      problem: 'span-outside-frame',
      detail: `fact ${JSON.stringify(fact.id)} has span [${start}, ${end}), which is not a range`,
    };
  }
  if (start === end) {
    return {
      problem: 'span-empty',
      detail: `fact ${JSON.stringify(fact.id)} points at nothing: [${start}, ${end})`,
    };
  }
  if (end > frame.text.length) {
    return {
      problem: 'span-outside-frame',
      detail: `fact ${JSON.stringify(fact.id)} points at [${start}, ${end}) in a frame of ${frame.text.length} characters`,
    };
  }
  return null;
}

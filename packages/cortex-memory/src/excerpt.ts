/**
 * Where in a long turn the per-turn cap should spend its characters.
 *
 * ## The measurement this file starts from
 *
 * The registered arm caps one turn at **400 characters** on `multi-session` and `temporal`
 * (`CORTEX_MEMORY_MAX_TURN_CHARS`), and on the 200 × 2 pair of 2026-11-13 (`43424939177`, whose prompts
 * are byte-identical to `43401057514`'s) the cap is reached by **644 of the 10,381 items those two
 * routes deliver -- 6.2%** (`MR` 281/4,495 = 6.25%, `TR` 363/5,886 = 6.17%). So one item in sixteen of
 * the evidence on those routes is not the turn: it is the **first** 400 characters of it, and
 * `turnCutMarker` is `'none'` on that arm, so the reader is not told.
 *
 * **The number moved, and the reason is recorded rather than the number replaced.** The figure this
 * file was first written against was 2,569 of 23,609 (10.9%) with a share for each of five
 * capabilities, and it does not reproduce against either artifact. The tell was inside that table:
 * `IE`, `KU` and `ABS` carry **no cap** on this arm -- the reach is `multi-session,temporal` -- so a
 * share of *cut* items cannot exist for them, and what the earlier count measured there was simply
 * long turns. The defect is real, and it is smaller than claimed; so is the ceiling on what a window
 * can recover, which is why `MEASURE-TURN-WINDOW.md` §6 prices it as unknown rather than large.
 *
 * Two consequences are on the record. `a4996e51` is an `MR` question whose decisive turn was delivered
 * and then cut mid-sentence at `...I increase my work hours`, and the reader declined -- correctly, on
 * a prompt that had quietly lost its operand. And the cap's own block in `prompt.ts` states the cost
 * where it is chosen: *"a turn whose decisive fact sits deep in a long narrative loses it"*.
 *
 * ## What replaces the head
 *
 * Not a larger cap -- the room is already 48,460 characters and `MEASURE-WIDTH-PLAN.md` §7.3 prices a
 * bigger one at 6.8% of the bill per accuracy point. And not fewer turns -- `MEASURE-COST-FLOOR.md` §2
 * measures what that costs. The exchange here is **within** a turn: the same 400 characters, chosen
 * from around the part of the turn that answers the question instead of from the part that happens to
 * be first.
 *
 * That is a strictly smaller change than `planEvidenceRoom` (`width.ts`): the width plan decides **how
 * many** turns are funded, this decides **which characters** of a funded turn are printed. The two
 * compose, and the reading that separates them is a run that moves one field.
 *
 * ## Why the window is anchored rather than centred
 *
 * `LEAD_SHARE` of the budget is kept **before** the match and the remainder after it. Centring would
 * spend half the room on the turn's tail, and a fact's operand usually arrives before it in English
 * (*"the four festivals I attended were ..."*), while a count's remaining items arrive after. A quarter
 * forward, three quarters back is the shape both of those want, and it is a **decision rather than a
 * fitted value**: nothing in this repository has measured a better split, and a constant tuned on a
 * benchmark is a constant that encodes the benchmark.
 *
 * ## What it can remove, stated where it is chosen
 *
 * The window is chosen by a lexical match, and a turn whose decisive sentence shares no term with the
 * question keeps none of it -- the failure `width.ts` names in its own header, one level down. That is
 * the hypothesis, not a risk to be mitigated by loosening the cut until it does nothing: the negative
 * form is a dispatched reading, and `docs/MEASURE-TURN-WINDOW.md` pre-registers it.
 */

import { contentTerms, contentTokens, type ContentToken } from './relevance.js';

/** Which slice of a turn the cap keeps. `'head'` is every archived run's bytes. */
export type TurnWindow = 'head' | 'match';

/** The character an omitted span is replaced with, and the reason it is a single UTF-16 unit. */
export const ELISION = '…';

/**
 * The share of the budget kept before the match, when the text allows it.
 *
 * A quarter: at the 400-character cap that is 100 characters, which is a sentence's worth of the
 * context a pronoun needs. Larger spends the room on text before the answer; smaller cuts the subject
 * off the clause that carries it.
 */
const LEAD_SHARE = 0.25;

/**
 * The shortest cap this rule can spend: two markers and two characters of text.
 *
 * Below it the fallback is the plain head cut rather than an unmarked window, because a marker and one
 * character is not an excerpt -- it is a marker with nothing to excerpt, and it would spend the whole cap
 * saying that. Four is the smallest number at which the rule can honour both halves of its contract.
 */
const MIN_EXCERPT_CHARS = 4;

/** How far back a word boundary may be and still be worth taking, as a fraction of the cap. */
const WORD_BOUNDARY_FLOOR = 0.8;

/**
 * One character, tested for being whitespace.
 *
 * `\s` rather than `charCodeAt(...) <= 0x20` because a non-breaking space between two words is a
 * boundary for a reader and would not be one by code point. The same literal is in `prompt.ts`, and the
 * duplication is deliberate: `prompt.ts` imports this module, so sharing the constant would make the
 * dependency a cycle to save one character class.
 */
const WHITESPACE = /\s/;

/**
 * A turn's content, shortened to `maxChars`, keeping the part around the question's best match.
 *
 * The contract is one line: the result is **at most `maxChars`** UTF-16 units, and every cut it makes
 * is marked. Both halves are load-bearing. The first is what lets the caller keep its room arithmetic
 * (`maxTurnChars` is an upper bound, so a renderer that could exceed it would overrun a budget the
 * artifact reports as respected). The second is the defect this file exists for: a silent cut is a
 * prompt that disagrees with the coverage count that says the turn arrived.
 *
 * Falls back to a marked head in three cases, and each is a state rather than an error:
 *
 * - the question carries no content term (29 of the 500 abstention questions ask about a subject the
 *   evidence never names), so there is nothing to anchor on;
 * - no content term of the question occurs in this turn, so any window would be an arbitrary one;
 * - the cap is under four characters, which cannot hold a marker and a character.
 *
 * The fallback is **not** the previous bytes: it marks the cut. A caller that wants the previous bytes
 * asks for `'head'`, which is a different value of the field rather than an absence, and that is how a
 * run's configuration line can say which of the two it ran.
 */
export function excerptAround(text: string, question: string, maxChars: number): string {
  const limit = Math.floor(maxChars);
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit < MIN_EXCERPT_CHARS) return truncateCodePointSafe(text, limit);

  const asked = new Set(contentTerms(question));
  const hits = asked.size === 0 ? [] : contentTokens(text).filter((token) => asked.has(token.term));
  if (hits.length === 0) return markedHead(text, limit);

  const span = snapToWords(text, bestSpan(hits, limit, text.length));
  const leading = span.start > 0 ? ELISION : '';
  const trailing = span.end < text.length ? ELISION : '';
  return `${leading}${text.slice(span.start, span.end).trim()}${trailing}`;
}

/** A half-open range of a turn's characters, and the match that chose it. */
type Span = {
  readonly start: number;
  readonly end: number;
  /** Offset of the anchored term, which both boundaries stop at. */
  readonly anchorAt: number;
};

/**
 * The window that covers the most distinct question terms, ties going to the earliest.
 *
 * Two pointers rather than a scan per candidate: candidate starts are non-decreasing because the hits
 * are sorted by offset, so the window's two edges only ever move forward and the whole choice is linear
 * in the number of hits. A per-candidate scan would be quadratic on the long turns this arm is full of
 * -- `MR`'s median delivered turn is 243 characters but its tail runs past 5,000 -- and the cost would
 * land in the prompt path of every question.
 *
 * Distinct terms rather than occurrences, for `lexicalRelevance`'s reason: a turn that repeats one word
 * of the question forty times is not about the question.
 */
function bestSpan(hits: readonly ContentToken[], limit: number, textLength: number): Span {
  // Both markers are reserved up front. A window that touches an end of the text then spends up to two
  // characters it could have used, which buys an invariant that holds by construction: rendered length
  // is at most `limit` whatever the text does.
  const body = limit - ELISION.length * 2;
  const lead = Math.floor(body * LEAD_SHARE);

  const counts = new Map<string, number>();
  let left = 0;
  let right = 0;
  let best: Span = { start: 0, end: Math.min(textLength, body), anchorAt: 0 };
  let bestScore = -1;

  for (const hit of hits) {
    const start = Math.max(0, hit.at - lead);
    // Clamped, so `end` is always a valid index: the marker decision reads `end < text.length`, and an
    // unclamped end would say "not at the end" for a window that ran past it.
    const end = Math.min(textLength, start + body);
    while (right < hits.length && (hits[right] as ContentToken).at < end) {
      const term = (hits[right] as ContentToken).term;
      counts.set(term, (counts.get(term) ?? 0) + 1);
      right += 1;
    }
    while (left < right && (hits[left] as ContentToken).at < start) {
      const term = (hits[left] as ContentToken).term;
      // The map holds exactly the terms between the two edges, so the entry exists: `right` added this
      // hit before `left` reached it, and a term is only dropped when its last copy leaves. The cast is
      // that invariant written down rather than a guess -- `?? 0` here would be a branch no input reaches,
      // and a defensive branch nothing can execute is a branch nothing can check.
      const remaining = (counts.get(term) as number) - 1;
      if (remaining === 0) counts.delete(term);
      else counts.set(term, remaining);
      left += 1;
    }
    if (counts.size > bestScore) {
      bestScore = counts.size;
      best = { start, end, anchorAt: hit.at };
    }
  }

  return best;
}

/**
 * The same range, moved inward to the nearest word boundaries it can reach.
 *
 * Both moves only ever shrink, so the budget holds. The lower bounds stop at the anchored term: a
 * boundary search that could walk past the match would print a window that does not contain the reason
 * it was chosen, and the block would look like a plausible excerpt of the wrong sentence.
 *
 * A word longer than the lead is the one case where a boundary stays inside a word, and it stays
 * deliberately -- the alternative is to drop the match.
 */
function snapToWords(text: string, span: Span): Span {
  const startStop = Math.min(span.anchorAt, span.end - 1);
  let start = span.start;
  while (start > 0 && start < startStop && !WHITESPACE.test(text[start - 1] as string)) start += 1;

  const endFloor = Math.min(span.end, Math.max(span.anchorAt + 1, start + 1));
  let end = span.end;
  while (end > endFloor && end < text.length && !WHITESPACE.test(text[end] as string)) end -= 1;

  return { start, end, anchorAt: span.anchorAt };
}

/**
 * The head of the turn, cut at a word boundary where one is reachable, and marked.
 *
 * `WORD_BOUNDARY_FLOOR` bounds the search for the same reason `cutWithMarker` in `prompt.ts` does: a
 * boundary hunt that ran to zero would turn a 400-character cap into a block of whatever prefix ends
 * before the turn's first long URL.
 */
function markedHead(text: string, limit: number): string {
  const head = truncateCodePointSafe(text, limit - 1);
  const floor = Math.ceil(head.length * WORD_BOUNDARY_FLOOR);
  let end = head.length;
  for (let index = end - 1; index >= floor; index -= 1) {
    if (WHITESPACE.test(text[index] as string)) {
      end = index;
      break;
    }
  }
  return `${head.slice(0, end).trimEnd()}${ELISION}`;
}

/**
 * Truncate to `maxChars` without splitting a surrogate pair.
 *
 * Slicing a four-byte character in half produces a lone surrogate, which is not valid UTF-16 and
 * corrupts the request body on serialisation. The reference pipeline solved this in
 * `sliceCodePointSafe`; reintroducing it here would be a regression against a bug that was already paid
 * for.
 *
 * Lives here rather than in `prompt.ts` because the window rule needs it for its own fallbacks, and
 * `prompt.ts` re-exports it so every existing importer keeps the path it had.
 */
export function truncateCodePointSafe(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const code = text.charCodeAt(maxChars - 1);
  const endsOnHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, endsOnHighSurrogate ? maxChars - 1 : maxChars);
}

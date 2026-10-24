/**
 * The connectives that license a relation, and the phrases that look like one and are not.
 *
 * ## Why a hand-written table rather than a parser
 *
 * A dependency parser would answer this better and would fail differently: it would produce a parse
 * for every sentence, including the ones where the connective is doing something else, and a wrong
 * parse is indistinguishable from a right one downstream. A table can only ever say "this token is
 * here", which is a fact, and the gate then decides what that fact licenses. The cost is recall —
 * implicit causality ("the seal failed; the pump ran dry") produces no edge — and that cost is
 * accepted deliberately, because an edge nobody can point at is an invention.
 *
 * ## The second table exists because the first one lied twice
 *
 * The first census counted 11 relational frames out of 20. Two were wrong:
 *
 * - `g10` — "I've been tracking my social media analytics **for a while** now": a duration, not the
 *   `while` that joins two clauses.
 * - `g32` — "I was **wondering if** you could help me": an embedded question, not a condition.
 *
 * Both would have manufactured an edge, and in `g32`'s case a *conditional* one, from a sentence that
 * states no condition. That is the same defect as the causal hallucination this module is built to
 * prevent, arriving through the front door: a matcher permissive about "if" is permissive about
 * causality one inference later. So the exclusions live here, next to the inclusions, and the tool
 * that produced the census carries the identical list (`tools/measure-atom-fidelity.py`) so the
 * reading and its exclusions cannot drift apart.
 *
 * ## Longest first, and why the order of the table matters less than it looks
 *
 * `so that` contains `so`; `even though` contains `though`; `now that` contains `that`. Overlaps are
 * resolved by position and length in `relationMarkers`, not by table order, because a resolution that
 * depended on object key order would change if someone alphabetised the file.
 */

import type { RelationKind } from './taxonomy.js';

/**
 * The token set, per class.
 *
 * Deliberately English-only. A table for another language is a table, not a change to this one: the
 * gate is "a token we know licenses a class", and a language whose connectives we do not know
 * produces no edges rather than guessed ones.
 */
export const MARKER_TOKENS: Readonly<Record<RelationKind, readonly string[]>> = {
  causal: [
    'because',
    'therefore',
    'thus',
    'hence',
    'so that',
    'so',
    'since',
    'due to',
    'as a result',
    'led to',
    'thanks to',
  ],
  temporal: [
    'after',
    'before',
    'when',
    'while',
    'until',
    'then',
    'once',
    'during',
    'now that',
    'anymore',
    'no longer',
    'used to',
  ],
  conditional: ['if', 'unless', 'otherwise', 'in case', 'as long as', 'provided that'],
  contrast: [
    'but',
    'although',
    'though',
    'however',
    'instead',
    'rather than',
    'yet',
    'whereas',
    'even though',
  ],
};

/**
 * Phrases that contain a marker token without being one. Removed before matching.
 *
 * Each entry names a substitution that has already produced a wrong edge or a wrong census row; the
 * list is not a guess about what might go wrong. Add to it when a reading shows one, not before.
 */
export const NOT_MARKERS: readonly string[] = [
  'for a while',
  'a while now',
  'a while',
  'wondering if',
  'wonder if',
  'know if',
  'check if',
  'see if',
  'ask if',
  'as if',
];

/** One connective found in a sentence, with where it is. */
export type RelationMarker = {
  readonly kind: RelationKind;
  readonly token: string;
  readonly start: number;
  readonly end: number;
};

const BOUNDARY_LEFT = String.raw`(?<![A-Za-z'])`;
const BOUNDARY_RIGHT = String.raw`(?![A-Za-z'])`;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function spansOf(text: string, phrase: string): { start: number; end: number }[] {
  const pattern = new RegExp(`${BOUNDARY_LEFT}${escapeForRegExp(phrase)}${BOUNDARY_RIGHT}`, 'gi');
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

/**
 * Every connective in `text`, longest-and-leftmost first, with the non-connectives removed.
 *
 * The result is sorted by position so a caller can render the sentence's spine in order. Two markers
 * of different classes at the same position cannot occur: the tables do not share a token across
 * classes, which is itself asserted by a test rather than assumed.
 */
export function relationMarkers(text: string): readonly RelationMarker[] {
  const blocked = NOT_MARKERS.flatMap((phrase) => spansOf(text, phrase));
  const candidates: RelationMarker[] = [];

  for (const kind of Object.keys(MARKER_TOKENS) as RelationKind[]) {
    for (const token of MARKER_TOKENS[kind]) {
      for (const span of spansOf(text, token)) {
        const overlapsBlocked = blocked.some(
          (block) => span.start < block.end && block.start < span.end,
        );
        if (overlapsBlocked) continue;
        candidates.push({ kind, token, start: span.start, end: span.end });
      }
    }
  }

  candidates.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.end !== right.end) return right.end - left.end;
    return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
  });

  const kept: RelationMarker[] = [];
  for (const candidate of candidates) {
    const overlapsKept = kept.some(
      (marker) => candidate.start < marker.end && marker.start < candidate.end,
    );
    if (!overlapsKept) kept.push(candidate);
  }
  return kept;
}

/** Whether `token` is a known connective of `kind`, for validating an edge a model claimed. */
export function isMarkerOf(token: string, kind: RelationKind): boolean {
  return MARKER_TOKENS[kind].includes(token.trim().toLowerCase());
}

/** The classes present in a sentence, deduplicated and in the table's order. */
export function kindsIn(text: string): readonly RelationKind[] {
  const found = new Set(relationMarkers(text).map((marker) => marker.kind));
  return (Object.keys(MARKER_TOKENS) as RelationKind[]).filter((kind) => found.has(kind));
}

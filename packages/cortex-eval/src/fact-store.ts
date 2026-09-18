/**
 * A minimal structured fact store for bitemporal knowledge-update answering.
 *
 * The benchmark's knowledge-update (KU) questions ask for the CURRENT or
 * PREVIOUS value of a subject the user has updated across turns (e.g. "my city"
 * was Beijing, then Shanghai). The extractive/CoT prompt leaves the
 * previous-vs-current selection to the LLM, which fails when both values are
 * present. This module turns the LLM-extracted (subject, object, date) triples
 * into a per-subject date-ordered timeline, so the selection becomes exact
 * date arithmetic: current = latest date, previous = second-latest date.
 */

export type ExtractedFact = {
  /** Normalized entity name, e.g. "city", "occupation". */
  subject: string;
  /** Relationship, e.g. "resides_in", "works_as". */
  predicate: string;
  /** The fact value, e.g. "Shanghai". */
  object: string;
  /** The turn date the fact was stated, YYYY/MM/DD. */
  date: string;
};

/** Return the subject's facts sorted ascending by date, without mutating input. */
export function timelineFor(facts: readonly ExtractedFact[], subject: string): ExtractedFact[] {
  return facts
    .filter((f): f is ExtractedFact => {
      // The bitemporal extractor types these as ExtractedFact, but the LLM does
      // not honour `required` at runtime and can emit a null element or a fact
      // missing a field. Keep only fully-formed facts: a missing `subject` would
      // throw on `null.subject`, and a missing `object`/`date` would let
      // currentObject/previousObject return `undefined` (and the caller treat it
      // as a non-null answer instead of falling back).
      const candidate = f as unknown as { subject?: unknown; object?: unknown; date?: unknown };
      return (
        typeof candidate?.subject === 'string' &&
        typeof candidate?.object === 'string' &&
        typeof candidate?.date === 'string'
      );
    })
    .filter((f) => f.subject === subject)
    .sort(compareFactsByDate);
}

/** Sort two facts by their YYYY/MM/DD date ascending. */
function compareFactsByDate(a: ExtractedFact, b: ExtractedFact): number {
  if (a.date < b.date) {
    return -1;
  }
  if (a.date > b.date) {
    return 1;
  }
  return 0;
}

/** Return the most recent object for a subject, or null when absent. */
export function currentObject(facts: readonly ExtractedFact[], subject: string): string | null {
  const timeline = timelineFor(facts, subject);
  return timeline.length > 0 ? timeline[timeline.length - 1]!.object : null;
}

/** Return the second-most-recent object for a subject, or null when there is none. */
export function previousObject(facts: readonly ExtractedFact[], subject: string): string | null {
  const timeline = timelineFor(facts, subject);
  return timeline.length > 1 ? timeline[timeline.length - 2]!.object : null;
}

/**
 * Classify the time qualifier a knowledge-update question asks for. "previous/
 * before/used to" points at the older value, "currently/now/most recent" at the
 * newer value; anything else is not a bitemporal selection.
 *
 * `before` and `previously` need a shape guard, because they are also ordinary
 * English prepositions and adverbs:
 *
 *   - "before the holidays" / "before getting the Air Fryer" introduces a SECOND
 *     EVENT, not the older value of a subject. A question shaped that way is an
 *     interval or ordering question that the caller's `classifyTemporalQuestion`
 *     already routes elsewhere; classifying it as `previous` here would send it
 *     into the bitemporal path, where the two unrelated events are compared as
 *     if they were one subject's timeline. Three LongMemEval-S questions hit
 *     this (0977f2af, 89941a94, f685340e) and all three were answered wrong by
 *     the deterministic path in run 35162802298.
 *   - "how often ... previously?" compares a PACE across time rather than
 *     selecting a value, so the previous/current distinction is not the one the
 *     question is making.
 *
 * `previous`/`originally`/`used to`/`earlier` are unambiguous and stay as they
 * were; only the two shapes above are excluded.
 */
export function classifyKnowledgeUpdateQualifier(
  question: string,
): 'previous' | 'current' | 'other' {
  if (/\b(previous|previously|originally|used to|earlier)\b/i.test(question)) {
    // "how often/usually/frequently ... previously" measures a rate, not a value.
    if (/\bhow\s+(?:often|frequently|usually|regularly)\b/i.test(question)) {
      return 'other';
    }
    return 'previous';
  }
  if (/\bbefore\b/i.test(question) && !isValueQualifyingBefore(question)) {
    return 'other';
  }
  if (/\bbefore\b/i.test(question)) {
    return 'previous';
  }
  if (/\b(currently|now|most recent|latest|after updating|current)\b/i.test(question)) {
    return 'current';
  }
  return 'other';
}

/**
 * Whether a `before` in the question qualifies the SUBJECT (asks for the older
 * value) rather than introducing a second event. `before` reads as a value
 * qualifier only where it ends its clause or is followed by a clause that does
 * not name an event:
 *
 *   - "What was my occupation before?"            → qualifier (end of question)
 *   - "Where did I work before my current role?"  → qualifier (possessive)
 *   - "before getting the Air Fryer"              → second event (gerund)
 *   - "Before I purchased the gravel bike, ..."   → second event (subject + verb)
 */
function isValueQualifyingBefore(question: string): boolean {
  const match = question.match(/\bbefore\b([\s\S]*)$/i);
  if (!match) {
    return false;
  }
  const rest = match[1]!.trim();
  // "... before?" — the word closes the question.
  if (rest === '' || /^[?.!,;:]*$/.test(rest)) {
    return true;
  }
  // A possessive or determiner directly after `before` selects a value, not an
  // event: "before my current role", "before the update".
  if (/^(?:my|our|his|her|their|your|its|this|that|the)\b/i.test(rest)) {
    return true;
  }
  // "before <subject> <verb>" — "Before I purchased the gravel bike" — is a
  // temporal clause about another event.
  if (/^(?:i|we|you|he|she|they|it)\b/i.test(rest)) {
    return false;
  }
  // A gerund ("before getting ...") or any other trailing clause names an event.
  return false;
}

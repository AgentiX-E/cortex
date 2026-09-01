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
  return facts.filter((f) => f.subject === subject).sort(compareFactsByDate);
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
 */
export function classifyKnowledgeUpdateQualifier(
  question: string,
): 'previous' | 'current' | 'other' {
  if (/\b(previous|before|previously|originally|used to|earlier)\b/i.test(question)) {
    return 'previous';
  }
  if (/\b(currently|now|most recent|latest|after updating|current)\b/i.test(question)) {
    return 'current';
  }
  return 'other';
}

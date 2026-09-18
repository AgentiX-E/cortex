import { describe, expect, it } from 'vitest';
import {
  classifyKnowledgeUpdateQualifier,
  currentObject,
  previousObject,
  timelineFor,
  type ExtractedFact,
} from '../fact-store.js';

const facts: ExtractedFact[] = [
  { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2022/01/10' },
  { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/06/20' },
  { subject: 'occupation', predicate: 'works_as', object: 'engineer', date: '2021/03/05' },
];

describe('timelineFor', () => {
  it('returns only the subject facts sorted ascending by date', () => {
    const tl = timelineFor(facts, 'city');
    expect(tl.map((f) => f.object)).toEqual(['Beijing', 'Shanghai']);
    expect(tl.map((f) => f.date)).toEqual(['2022/01/10', '2023/06/20']);
  });

  it('returns an empty timeline for an unknown subject', () => {
    expect(timelineFor(facts, 'color')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(facts);
    void timelineFor(facts, 'city');
    expect(JSON.stringify(facts)).toBe(before);
  });

  it('keeps same-date facts stable (comparator returns 0)', () => {
    const sameDay: ExtractedFact[] = [
      { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2023/01/08' },
      { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/01/08' },
    ];
    // Same date: the comparator returns 0 and the order is preserved.
    expect(timelineFor(sameDay, 'city').map((f) => f.object)).toEqual(['Beijing', 'Shanghai']);
  });

  it('sorts a descending input into ascending date order (comparator > branch)', () => {
    const descending: ExtractedFact[] = [
      { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/06/20' },
      { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2022/01/10' },
    ];
    expect(timelineFor(descending, 'city').map((f) => f.object)).toEqual(['Beijing', 'Shanghai']);
  });

  it('drops a null or malformed fact instead of crashing on its fields', () => {
    // The bitemporal extractor types these as ExtractedFact, but the LLM does
    // not honour `required` at runtime and can emit a null element or a fact
    // missing a field. The timeline must skip those instead of throwing on
    // `null.subject` or leaking `undefined` out of current/previousObject.
    const malformed = [
      { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2022/01/10' },
      null,
      { predicate: 'works_as', object: 'engineer', date: '2021/03/05' },
      { subject: 'city', predicate: 'resides_in', date: '2021/01/01' },
      { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/06/20' },
    ] as unknown as ExtractedFact[];
    expect(timelineFor(malformed, 'city').map((f) => f.object)).toEqual(['Beijing', 'Shanghai']);
    expect(currentObject(malformed, 'city')).toBe('Shanghai');
    expect(previousObject(malformed, 'city')).toBe('Beijing');
  });
});

describe('currentObject', () => {
  it('returns the most recent object for the subject', () => {
    expect(currentObject(facts, 'city')).toBe('Shanghai');
    expect(currentObject(facts, 'occupation')).toBe('engineer');
  });

  it('returns null when the subject has no facts', () => {
    expect(currentObject(facts, 'color')).toBeNull();
  });
});

describe('previousObject', () => {
  it('returns the second-most-recent object', () => {
    expect(previousObject(facts, 'city')).toBe('Beijing');
  });

  it('returns null when there is only one fact', () => {
    expect(previousObject(facts, 'occupation')).toBeNull();
  });

  it('returns null when the subject has no facts', () => {
    expect(previousObject(facts, 'color')).toBeNull();
  });
});

describe('classifyKnowledgeUpdateQualifier', () => {
  it('detects the previous/earlier qualifier', () => {
    expect(classifyKnowledgeUpdateQualifier('What was my previous city?')).toBe('previous');
    expect(classifyKnowledgeUpdateQualifier('What city did I used to live in?')).toBe('previous');
    expect(classifyKnowledgeUpdateQualifier('What was my occupation before?')).toBe('previous');
  });

  it('detects the current/latest qualifier', () => {
    expect(classifyKnowledgeUpdateQualifier('What is my current city?')).toBe('current');
    expect(classifyKnowledgeUpdateQualifier('What city do I live in now?')).toBe('current');
    expect(classifyKnowledgeUpdateQualifier('What is my most recent job?')).toBe('current');
  });

  it('returns other for non-qualified questions', () => {
    expect(classifyKnowledgeUpdateQualifier('What is my favorite color?')).toBe('other');
  });

  // The three questions below are the measured population of the
  // `before`-as-preposition bug: in each one "before" introduces a second event
  // ("before getting the Air Fryer") rather than qualifying the subject, so
  // there is no previous/current selection to make. Classifying them as
  // `previous` routed all three into the bitemporal path, which then compared
  // two unrelated events as if they were the same subject's timeline. All three
  // are wrong in run 35162802298, and all three were answered by the
  // deterministic path (empty `llmRaw`) rather than by the model.
  it('does not read "before <event>" as a previous-value qualifier', () => {
    expect(
      classifyKnowledgeUpdateQualifier(
        'What new kitchen gadget did I invest in before getting the Air Fryer?',
      ),
    ).toBe('other');
  });

  it('does not read "before I purchased <thing>" as a previous-value qualifier', () => {
    expect(
      classifyKnowledgeUpdateQualifier(
        'Before I purchased the gravel bike, do I have other bikes in addition to my mountain bike and my commuter bike?',
      ),
    ).toBe('other');
  });

  it('does not read a "How frequently ... previously?" pace comparison as a value qualifier', () => {
    expect(
      classifyKnowledgeUpdateQualifier(
        'How often do I play tennis with my friends at the local park previously? How often do I play now?',
      ),
    ).toBe('other');
  });

  it('still reads a sentence-final "before" as a previous-value qualifier', () => {
    // The preposition guard keys on what FOLLOWS the word, so the sentence-final
    // form -- the one that genuinely asks for the older value -- must be
    // unaffected. This is the no-regression pin for the fix above.
    expect(classifyKnowledgeUpdateQualifier('What was my occupation before?')).toBe('previous');
    expect(classifyKnowledgeUpdateQualifier('Where did I work before my current role?')).toBe(
      'previous',
    );
  });
});

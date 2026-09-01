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
});

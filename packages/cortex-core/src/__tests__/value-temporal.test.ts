import { describe, it, expect } from 'vitest';
import { createMemory } from '../domain/memory.js';
import { decideRetrieval, decideWrite, defaultValueFunction } from '../value/value.js';
import { currentValue, findContradictions, currentFacts } from '../temporal/bitemporal.js';
import type { Fact } from '../domain/fact.js';
import { isFactCurrentAt } from '../domain/fact.js';
import { resolveContradiction } from '../contradiction/resolve.js';

describe('value-driven decisions', () => {
  it('writes high-value memories above threshold', () => {
    const m = createMemory({ content: 'x', confidence: 1, sourceTrust: 1 });
    const d = decideWrite(m, defaultValueFunction, 0.5);
    expect(d.write).toBe(true);
  });

  it('rejects low-value memories below threshold', () => {
    const m = createMemory({ content: 'x', confidence: 0.1, sourceTrust: 0.1 });
    const d = decideWrite(m, defaultValueFunction, 0.9);
    expect(d.write).toBe(false);
  });

  it('abstains when no candidate is valuable enough', () => {
    const m = createMemory({ content: 'x', confidence: 0.1, sourceTrust: 0.1 });
    const d = decideRetrieval([m], defaultValueFunction, 0.5);
    expect(d.retrieve).toBe(false);
  });

  it('retrieves when a candidate is valuable enough', () => {
    const m = createMemory({ content: 'x', confidence: 1, sourceTrust: 1 });
    const d = decideRetrieval([m], defaultValueFunction, 0.5);
    expect(d.retrieve).toBe(true);
  });
});

describe('bitemporal facts', () => {
  const fact = (over: Partial<Fact>): Fact => ({
    id: 'f1',
    subject: 'user',
    predicate: 'job',
    object: 'engineer',
    validFrom: 0,
    validUntil: Infinity,
    systemFrom: 0,
    systemUntil: Infinity,
    source: 'user',
    sourceTrust: 1,
    confidence: 1,
    ...over,
  });

  it('finds the current value by confidence', () => {
    const current = currentValue(
      [
        fact({ id: 'a', object: 'engineer', confidence: 0.8 }),
        fact({ id: 'b', object: 'manager', confidence: 0.9 }),
      ],
      'user',
      'job',
      100,
    );
    expect(current?.object).toBe('manager');
  });

  it('detects contradictions on same subject/predicate', () => {
    const facts = [fact({ id: 'a', object: 'engineer' }), fact({ id: 'b', object: 'manager' })];
    expect(findContradictions(facts).length).toBe(1);
  });

  it('returns undefined when no current value exists', () => {
    const current = currentValue([fact({ subject: 'other' })], 'user', 'job', 100);
    expect(current).toBeUndefined();
  });

  it('filters to current facts only', () => {
    const expired = fact({ id: 'old', validUntil: 50 });
    const active = fact({ id: 'now', validFrom: 50 });
    const current = currentFacts([expired, active], 100);
    expect(current.map((f) => f.id)).toEqual(['now']);
  });

  it('handles finite valid and system intervals', () => {
    const f = fact({ validFrom: 10, validUntil: 20, systemFrom: 5, systemUntil: 15 });
    expect(isFactCurrentAt(f, 15, 10)).toBe(true);
    expect(isFactCurrentAt(f, 15, 20)).toBe(false);
    expect(isFactCurrentAt(f, 25, 10)).toBe(false);
  });
});

describe('contradiction resolution', () => {
  it('prefers the object with highest source-trust-weighted belief', () => {
    const facts: Fact[] = [
      {
        id: 'a',
        subject: 'u',
        predicate: 'city',
        object: 'NYC',
        validFrom: 0,
        validUntil: Infinity,
        systemFrom: 0,
        systemUntil: Infinity,
        source: 'user',
        sourceTrust: 0.9,
        confidence: 0.9,
      },
      {
        id: 'b',
        subject: 'u',
        predicate: 'city',
        object: 'LA',
        validFrom: 0,
        validUntil: Infinity,
        systemFrom: 0,
        systemUntil: Infinity,
        source: 'untrusted',
        sourceTrust: 0.1,
        confidence: 0.9,
      },
    ];
    const r = resolveContradiction(facts);
    expect(r.winner.object).toBe('NYC');
  });

  it('throws on empty fact list', () => {
    expect(() => resolveContradiction([])).toThrow();
  });

  it('returns the single fact unchanged', () => {
    const single: Fact = {
      id: 's',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 0.8,
      confidence: 0.9,
    };
    const r = resolveContradiction([single]);
    expect(r.winner.id).toBe('s');
    expect(r.belief).toBeCloseTo(0.9, 12);
  });
});

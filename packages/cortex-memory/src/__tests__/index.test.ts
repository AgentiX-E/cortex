/**
 * The package's public surface, asserted rather than assumed.
 *
 * Two jobs: make the barrel's re-exports count as covered (they are the API a
 * consumer sees), and fail loudly if a symbol is dropped during a refactor. The
 * design note behind every name here is in `docs/DESIGN-CORTEX-MEMORY.md`.
 */
import { describe, expect, it } from 'vitest';
import * as memory from '../index.js';

describe('cortex-memory package exports', () => {
  it('exposes the composition entry point', () => {
    expect(typeof memory.CortexMemory).toBe('function');
  });

  it('exposes the admission layer', () => {
    expect(typeof memory.admitTurns).toBe('function');
    expect(typeof memory.clockAwareValueFunction).toBe('function');
    expect(typeof memory.admissionOptionsFrom).toBe('function');
  });

  it('narrows a gate into admission options, copying only what is set', () => {
    // Behavioural rather than a `typeof` check, because the narrowing has four
    // outcomes and the barrel test only proved the name existed. The `sourceTrust`
    // field is new here, and adding it to a chain of conditional spreads produced
    // an uncovered branch site, which is how the missing coverage was found.
    const bare = memory.admissionOptionsFrom(7, {
      threshold: 0.25,
      retrievalThreshold: 0.5,
      sessionBudget: 4,
    });
    expect(bare).toEqual({ now: 7, threshold: 0.25 });
    // Absent, not `undefined`: a reader comparing the gate to the narrowed options
    // should see the same shape.
    expect('valueFunction' in bare).toBe(false);
    expect('sourceTrust' in bare).toBe(false);

    const valueFn = (): number => 0.5;
    const withBoth = memory.admissionOptionsFrom(7, {
      threshold: 0.25,
      retrievalThreshold: 0.5,
      sessionBudget: 4,
      valueFunction: valueFn,
      sourceTrust: 0.9,
    });
    expect(withBoth).toEqual({ now: 7, threshold: 0.25, valueFunction: valueFn, sourceTrust: 0.9 });

    // Each field independently, so neither `if` can be dropped without a failure.
    const trustOnly = memory.admissionOptionsFrom(7, {
      threshold: 0.25,
      retrievalThreshold: 0.5,
      sessionBudget: 4,
      sourceTrust: 0,
    });
    expect(trustOnly).toEqual({ now: 7, threshold: 0.25, sourceTrust: 0 });

    const valueOnly = memory.admissionOptionsFrom(7, {
      threshold: 0.25,
      retrievalThreshold: 0.5,
      sessionBudget: 4,
      valueFunction: valueFn,
    });
    expect(valueOnly).toEqual({ now: 7, threshold: 0.25, valueFunction: valueFn });

    // The fourth field, and the reason this test's premise is worth restating:
    // adding a field to a chain of conditional spreads silently produced an
    // uncovered branch site the first time, so each `if` gets its own case rather
    // than being covered incidentally by the "with everything" object above. A
    // field that narrows correctly when it is one of five and is dropped when it
    // is the only one would pass that shared case.
    const confidenceFor = (turn: string): number => turn.length / 100;
    const confidenceOnly = memory.admissionOptionsFrom(7, {
      threshold: 0.25,
      retrievalThreshold: 0.5,
      sessionBudget: 4,
      confidenceFor,
    });
    expect(confidenceOnly).toEqual({ now: 7, threshold: 0.25, confidenceFor });
  });

  it('carries confidenceFor end to end, so a gate setting reaches the admitted value', () => {
    // The same composition path as the `sourceTrust` test below, for the same
    // reason: narrowing correctly and then dropping the field before `admitTurns`
    // would leave every unit assertion in `retrieval-discrimination.test.ts`
    // passing -- they call `admitTurns` directly -- while the composed system still
    // ran the constant behaviour. That is the gap this closes.
    const gate = {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: 10,
      sourceTrust: 1,
      confidenceFor: (turn: string): number => Math.min(1, turn.length / 40),
    };
    const options = memory.admissionOptionsFrom(1700000000000, gate);
    const strong = `${'evidence '.repeat(5)}and it is unambiguous`;
    // The fixture asserts its own premise rather than assuming it. The first draft
    // used a 39-character string and expected saturation, so the assertion below
    // failed on `0.975` -- the test was wrong, not the code. Deriving the
    // expectation from the callback keeps the two from disagreeing again.
    expect(gate.confidenceFor(strong)).toBe(1);

    const admitted = memory.admitTurns(['short', strong], options);

    // Two different values at one arming: the variation reached admission through
    // the narrowing, which is what makes the retrieval gate discriminating.
    expect(admitted[0]?.confidence).toBeLessThan(admitted[1]!.confidence);
    expect(admitted[0]?.value).toBeCloseTo(admitted[0]!.confidence, 10);
    expect(admitted[1]?.value).toBe(1);
    expect(admitted[0]?.value).toBeLessThan(1);
  });

  it('carries sourceTrust end to end, so a gate setting reaches the admitted value', () => {
    // The composition path, not the unit: `CortexMemory` calls
    // `admissionOptionsFrom`, so a field that narrows correctly but is dropped
    // between there and `admitTurns` would still fail this.
    const gate = { threshold: 0, retrievalThreshold: 0, sessionBudget: 10, sourceTrust: 1 };
    const options = memory.admissionOptionsFrom(1700000000000, gate);
    const admitted = memory.admitTurns(['a turn'], options);

    expect(admitted[0]?.sourceTrust).toBe(1);
    expect(admitted[0]?.value).toBe(1);
  });

  it('exposes the session layer', () => {
    expect(typeof memory.admitSessions).toBe('function');
    expect(typeof memory.selectSessionBudget).toBe('function');
  });

  it('exposes prompt construction', () => {
    expect(typeof memory.buildPrompt).toBe('function');
    expect(typeof memory.buildSessionPrompt).toBe('function');
    expect(typeof memory.formatEvidence).toBe('function');
    expect(typeof memory.truncateCodePointSafe).toBe('function');
    expect(memory.DEFAULT_MAX_PROMPT_CHARS).toBeGreaterThan(0);
  });

  it('exposes answer parsing and the shared abstention token', () => {
    expect(typeof memory.parseAnswer).toBe('function');
    expect(typeof memory.isAbstention).toBe('function');
    expect(typeof memory.ABSTAIN_TOKEN).toBe('string');
  });

  it('constructs a working system from the public surface alone', async () => {
    // The whole point of a barrel test: a consumer must be able to build the
    // system with nothing but these exports.
    const system = new memory.CortexMemory({
      now: 0,
      llm: {
        complete: async () => 'ok',
        completeStructured: async <T>() => JSON.parse('{}') as T,
      },
      gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 10 },
    });

    expect(system.name).toBe('cortex-memory');
    expect(await system.answer('Q?', ['turn'])).toBe('ok');
  });
});

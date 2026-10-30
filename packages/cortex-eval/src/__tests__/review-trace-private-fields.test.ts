/**
 * The review-mechanism wrapper, measured against a system whose state is actually private.
 *
 * ## Why this file exists, and why no existing test caught it
 *
 * `run 40984213349` died on its first cortex-memory question with
 * `TypeError: Cannot read private member #lastRawOutput from an object whose class did not declare it`.
 * The chain is short and entirely inside the harness:
 *
 * 1. `traceReviewMechanisms` returns `Object.create(system)` -- an object whose **prototype is the
 *    instance**, so that `isSessionAware` still sees every member through `in`.
 * 2. `runBenchmark` resolves the raw-output accessor once, as `system.lastRawOutput.bind(system)`.
 * 3. `system` is the wrapper. The method is found on the prototype chain, the call binds `this` to the
 *    wrapper, and `#lastRawOutput` is installed on instances of `CortexMemory` -- not inherited. A derived
 *    object is not an instance for the purposes of a private name, so the read throws.
 *
 * Every existing arm test builds its system as a **plain object with arrow functions**
 * (`lastRawOutput: () => 'Lisbon'`). Against an arrow, `bind` is a no-op and the defect cannot appear, so
 * a suite of twenty such fakes reported the wrapper as correct. That is the shape of the miss worth
 * naming: a fake cannot be *less* capable than the real thing and still find a capability bug.
 *
 * ## What is asserted
 *
 * A real class with real `#private` fields is wrapped, and then every call path the harness uses is
 * exercised through the wrapper: the routing member (which the wrapper intercepts), and two accessors the
 * wrapper is supposed to leave alone but must not break. The last two are the ones that fail without a
 * fix, and they fail for any private member -- so the assertion is written against the mechanism rather
 * than against `#lastRawOutput` by name.
 */

import { describe, expect, it } from 'vitest';

import { traceReviewMechanisms } from '../bench-memory-arm.js';
import type { Answer } from '../types.js';

/**
 * A memory system that keeps its state where the wrapper cannot reach it.
 *
 * `recoveryCensus` is what makes `traceReviewMechanisms` wrap at all: without it the function returns the
 * system unchanged, which is why a system with no census cannot reproduce this defect.
 */
class PrivateStateSystem {
  readonly name = 'private-state';

  #lastRaw: string | null = null;
  #attempts = 0;
  #answered = 0;
  #calls = 0;

  answer(question: string): Answer {
    this.#attempts += 1;
    this.#answered += 1;
    this.#calls += 1;
    this.#lastRaw = `raw:${question}`;
    return `answer:${question}`;
  }

  lastRawOutput(): string | null {
    return this.#lastRaw;
  }

  recoveryCensus(): { attempted: number; answered: number } {
    return { attempted: this.#attempts, answered: this.#answered };
  }

  /** A plain data member, to check that non-function state is carried rather than dropped. */
  readonly callCount = (): number => this.#calls;
}

describe('the review-mechanism wrapper over a system with private state', () => {
  it('leaves an accessor that reads a private field callable through the wrapper', () => {
    const trace = new Map<string, { attempted: boolean; answered: boolean }>();
    const wrapped = traceReviewMechanisms(new PrivateStateSystem(), trace) as PrivateStateSystem;

    // This is the exact call `runBenchmark` makes: `system.lastRawOutput.bind(system)` then `()`.
    expect(() => wrapped.lastRawOutput()).not.toThrow();
    expect(wrapped.lastRawOutput()).toBeNull();
  });

  it('still intercepts the routing member and records the question it saw', async () => {
    const trace = new Map<string, { attempted: boolean; answered: boolean }>();
    const wrapped = traceReviewMechanisms(new PrivateStateSystem(), trace) as PrivateStateSystem;

    expect(await wrapped.answer('where did I put the key?')).toBe(
      'answer:where did I put the key?',
    );
    expect(trace.get('where did I put the key?')).toEqual({ attempted: true, answered: true });
  });

  it('reflects state written through the intercepting member', async () => {
    const trace = new Map<string, { attempted: boolean; answered: boolean }>();
    const system = new PrivateStateSystem();
    const wrapped = traceReviewMechanisms(system, trace) as PrivateStateSystem;

    await wrapped.answer('first');
    // Read through the wrapper, then through the original: one object, two views.
    expect(wrapped.lastRawOutput()).toBe('raw:first');
    expect(system.lastRawOutput()).toBe('raw:first');
  });

  it('keeps the private member reachable for a census that the wrapper calls into', async () => {
    const trace = new Map<string, { attempted: boolean; answered: boolean }>();
    const wrapped = traceReviewMechanisms(new PrivateStateSystem(), trace) as PrivateStateSystem;

    await wrapped.answer('second');
    expect(wrapped.recoveryCensus()).toEqual({ attempted: 1, answered: 1 });
  });

  it('is still the system it wraps, so structural checks keep passing', () => {
    const trace = new Map<string, { attempted: boolean; answered: boolean }>();
    const system = new PrivateStateSystem();
    const wrapped = traceReviewMechanisms(system, trace);

    expect(wrapped).not.toBe(system);
    expect(wrapped instanceof PrivateStateSystem).toBe(true);
    expect('recoveryCensus' in wrapped).toBe(true);
    expect('answer' in wrapped).toBe(true);
  });

  it('carries a non-function member that the source holds as a function value', () => {
    const trace = new Map<string, { attempted: boolean; answered: boolean }>();
    const system = new PrivateStateSystem();
    const wrapped = traceReviewMechanisms(system, trace) as PrivateStateSystem;

    // `callCount` closes over `this` in its own class field, so it is the arrow that must survive.
    expect(wrapped.callCount()).toBe(0);
  });
});

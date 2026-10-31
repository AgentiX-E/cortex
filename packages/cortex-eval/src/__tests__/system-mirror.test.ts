/**
 * The member delegation both wrappers stand on.
 *
 * Written as its own file when `mirrorMembers` moved out of `bench-memory-arm.ts`, because the path
 * it exists for -- a private field read through an accessor -- is exactly the path that goes
 * uncovered when a function is only reached through a caller that happens not to touch it. Run
 * `40984213349` died on question one for this reason, and the artifact it produced described a
 * system the run never used.
 */
import { describe, expect, it } from 'vitest';

import { mirrorMembers } from '../system-mirror.js';
import type { MemorySystem } from '../types.js';

/** A system shaped like the product: one private field behind an accessor, one plain method. */
class System {
  readonly name = 'probe';
  #secret = 'hidden';

  answer(): string {
    return `answered with ${this.#secret}`;
  }

  get lastRawOutput(): string {
    return this.#secret;
  }

  set lastRawOutput(value: string) {
    this.#secret = value;
  }
}

describe('mirroring a system', () => {
  it('calls a method with `this` set to the instance, so a private field is readable', () => {
    // The prototype chain alone sets `this` to the wrapper, and a wrapper derived from an instance
    // cannot read that instance's private names -- the crash the doc block records.
    expect(mirrorMembers(new System() as unknown as MemorySystem).answer('Where?', [])).toBe(
      'answered with hidden',
    );
  });

  it('re-defines an accessor so it reads and writes the instance', () => {
    const wrapper = mirrorMembers(new System() as unknown as MemorySystem) as unknown as System;

    expect(wrapper.lastRawOutput).toBe('hidden');
    wrapper.lastRawOutput = 'replaced';
    // The write reached the instance rather than landing on the wrapper as a plain property: the
    // next read through the wrapper sees it, which is only true if `set` was delegated.
    expect(wrapper.lastRawOutput).toBe('replaced');
  });

  it('leaves a non-function property readable through the chain', () => {
    // Reading `name` does not depend on `this`, so mirroring it would be a copy that could drift.
    expect((mirrorMembers(new System() as unknown as MemorySystem) as unknown as System).name).toBe(
      'probe',
    );
  });
});

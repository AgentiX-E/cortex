import { describe, expect, it } from 'vitest';

import { readArmPairing } from '../arm-pairing.js';

describe('readArmPairing', () => {
  it('treats unset and blank as the registered pairing', () => {
    // Not "unconfigured": every archived artifact was produced by the reference pair, so an absent
    // variable is a statement about the pass rather than a gap in it.
    expect(readArmPairing(undefined)).toBe('reference');
    expect(readArmPairing('')).toBe('reference');
    expect(readArmPairing('   ')).toBe('reference');
    expect(readArmPairing('reference')).toBe('reference');
  });

  it('reads the carry pairing, which is S12’s instrument', () => {
    expect(readArmPairing('carry')).toBe('carry');
  });

  it('reads the clock pairing, which is the boundary clock’s instrument', () => {
    // The one-flag pair generalised: `carry` was the first flag that needed it, not the only one. The
    // boundary clock has a pre-registered criterion (§131 §3) and, without this value, no dispatch that
    // could produce its reading -- the failure the semantic carry cost six rounds to.
    expect(readArmPairing('clock')).toBe('clock');
  });

  it('folds case and space, because the value is typed by hand into a dispatch', () => {
    expect(readArmPairing(' CARRY ')).toBe('carry');
    expect(readArmPairing('Reference')).toBe('reference');
    expect(readArmPairing(' Clock ')).toBe('clock');
  });

  it('refuses a pairing it cannot build, and names every one it can', () => {
    // The failure this prevents is a run that publishes a delta between two systems nobody
    // described; the message is where a dispatcher learns what the words are. Every branch is named,
    // because a message that lists two of three teaches the reader to invent the third.
    expect(() => readArmPairing('two-window')).toThrow(/does not name a pairing/);
    expect(() => readArmPairing('two-window')).toThrow(/`reference`/);
    expect(() => readArmPairing('two-window')).toThrow(/`carry`/);
    expect(() => readArmPairing('two-window')).toThrow(/`clock`/);
  });
});

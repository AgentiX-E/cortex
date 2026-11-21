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

  it('reads the resolution pairing, which `C7` was registered against and could not be dispatched to', () => {
    // `PREREGISTRATION-RESOLUTION-LAYERING.md` §2 wrote `F1`-`F5` against "one job, one corpus, both
    // sides" and the arm had no way to put two renderings in one job: `resolution` was read from
    // `armOptions` inside the constructor, so both sides rendered the same form. The criteria existed
    // for nine rounds with no instrument that could produce them.
    expect(readArmPairing('resolution')).toBe('resolution');
  });

  it('folds case and space, because the value is typed by hand into a dispatch', () => {
    expect(readArmPairing(' CARRY ')).toBe('carry');
    expect(readArmPairing('Reference')).toBe('reference');
    expect(readArmPairing(' Clock ')).toBe('clock');
    expect(readArmPairing(' Resolution ')).toBe('resolution');
  });

  it('refuses a pairing it cannot build, and names every one it can', () => {
    // The failure this prevents is a run that publishes a delta between two systems nobody
    // described; the message is where a dispatcher learns what the words are. Every branch is named,
    // because a message that lists three of four teaches the reader to invent the fourth.
    expect(() => readArmPairing('two-window')).toThrow(/does not name a pairing/);
    expect(() => readArmPairing('two-window')).toThrow(/`reference`/);
    expect(() => readArmPairing('two-window')).toThrow(/`carry`/);
    expect(() => readArmPairing('two-window')).toThrow(/`clock`/);
    expect(() => readArmPairing('two-window')).toThrow(/`resolution`/);
    // The count is asserted in prose as well as by enumeration: "The three are" survived a fourth
    // member once already in this campaign's sibling selector, and a message whose arithmetic
    // contradicts its own list is read as a list that lost a member.
    expect(() => readArmPairing('two-window')).toThrow(/The four are/);
  });
});

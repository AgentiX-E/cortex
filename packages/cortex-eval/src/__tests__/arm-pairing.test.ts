import { describe, expect, it } from 'vitest';

import { pairingViolation, readArmPairing, type PairingTreatment } from '../arm-pairing.js';

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

  it('reads the ask pairing, which the register has been reading across artifacts instead', () => {
    // `§13.291` adopted an instruction block and every reading of it since has compared two artifacts.
    // `45636994046` was the attempt to read a second one and it charged the ask with a rendering, which
    // `RETRACTIONS.md` 28 withdraws. The instrument that cannot make that mistake is a pair: one pass, one
    // corpus, one block between the sides.
    expect(readArmPairing('ask')).toBe('ask');
  });

  it('folds case and space, because the value is typed by hand into a dispatch', () => {
    expect(readArmPairing(' CARRY ')).toBe('carry');
    expect(readArmPairing('Reference')).toBe('reference');
    expect(readArmPairing(' Clock ')).toBe('clock');
    expect(readArmPairing(' Resolution ')).toBe('resolution');
    expect(readArmPairing(' ASK ')).toBe('ask');
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
    expect(() => readArmPairing('two-window')).toThrow(/`ask`/);
    // The count is asserted in prose as well as by enumeration: "The three are" survived a fourth
    // member once already in this campaign's sibling selector, and "The four are" survived a fifth one
    // this round -- the prose count is the sentence a reader trusts first, and it has now been wrong
    // twice. Asserted as a number so a sixth member has to edit this line rather than append a branch.
    expect(() => readArmPairing('two-window')).toThrow(/The five are/);
    expect(() => readArmPairing('two-window')).not.toThrow(/The four are/);
  });
});

/**
 * The four rungs of "this treatment cannot be this pairing".
 *
 * They were four `if (...) throw` blocks inside `run-ablation.ts`'s `main` for three rounds, which meant
 * none of them was exercised: the function opens a dataset and a worker pool before it can be called, so a
 * typo in a message or a condition that could never fire would have been found by a dispatch. The block
 * below is the reason the checks moved.
 */
describe('pairingViolation', () => {
  const base: PairingTreatment = {
    carry: true,
    clock: true,
    resolution: 'layered',
    ask: 'verbatim-acts',
  };

  it('has nothing to require of the registered pair', () => {
    // `reference` compares two constructions rather than one construction with a flag between them, so
    // there is no key to hold. Asserted over a treatment that satisfies nothing at all, because a branch
    // that returned a message here would refuse every archived configuration.
    expect(
      pairingViolation('reference', {
        carry: false,
        clock: false,
        resolution: 'raw',
        ask: 'route',
      }),
    ).toBeNull();
  });

  it('names the variable and the value a dispatcher has to set', () => {
    expect(pairingViolation('carry', { ...base, carry: false })).toContain(
      'CORTEX_MEMORY_SEMANTIC_CARRY=1',
    );
    expect(pairingViolation('clock', { ...base, clock: false })).toContain(
      'CORTEX_MEMORY_SESSION_CLOCK=on',
    );
    expect(pairingViolation('resolution', { ...base, resolution: 'raw' })).toContain(
      'CORTEX_MEMORY_RESOLUTION=layered',
    );
    expect(pairingViolation('ask', { ...base, ask: 'route' })).toContain('CORTEX_MEMORY_ASK');
  });

  it('says what the reading would be misread as, and the four are not the same misreading', () => {
    // The messages are the only place a dispatcher learns that a zero is not a finding. A message that said
    // "incoherent pairing" would cost a second dispatch to interpret, which is the whole expense the
    // refusal exists to avoid.
    //
    // The four are NOT one sentence with a variable substituted, and asserting that they are would have
    // made this test the thing that flattened a real distinction. Two say the artifact **publishes a null**
    // (`carry`, `ask`: the delta is zero and the accuracy is real); two say a quantity **reads zero**
    // (`clock`: the paired criterion's movement; `resolution`: `F1`'s mechanism census, which is why that
    // run is void rather than null). The wording is the difference between "we measured nothing" and "we
    // measured a zero", and both are failures a dispatcher has to be able to tell apart from a result.
    for (const pairing of ['carry', 'clock', 'resolution', 'ask'] as const) {
      const message = pairingViolation(pairing, {
        carry: false,
        clock: false,
        resolution: 'raw',
        ask: 'route',
      });
      expect({ pairing, saysWhatZeroMeans: /\b(null|zero)\b/.test(message ?? '') }).toEqual({
        pairing,
        saysWhatZeroMeans: true,
      });
    }
    // And the one that distinguishes itself: `resolution`'s wrong branch is caught by a mechanism census
    // before any accuracy is read, so its message names `F1` rather than a result.
    expect(
      pairingViolation('resolution', {
        carry: false,
        clock: false,
        resolution: 'raw',
        ask: 'route',
      }),
    ).toContain('F1');
  });

  it('requires exactly the one key its pairing splits, and nothing else', () => {
    // The Cartesian product, because the defect this catches is a condition that reads a SECOND key: a
    // `carry` rung that also demanded the clock would pass every single-axis test above and refuse three
    // quarters of the dispatches that ran. 4 x 16 = 64 readings, each compared as a whole object so a
    // failure prints which combination disagreed rather than which boolean did.
    const satisfactions: Record<string, (treatment: PairingTreatment) => boolean> = {
      carry: (treatment) => treatment.carry,
      clock: (treatment) => treatment.clock,
      resolution: (treatment) => treatment.resolution === 'layered',
      ask: (treatment) => treatment.ask !== 'route',
    };
    for (const [pairing, satisfied] of Object.entries(satisfactions)) {
      for (const carry of [true, false]) {
        for (const clock of [true, false]) {
          for (const resolution of ['raw', 'layered']) {
            for (const ask of ['route', 'verbatim-acts', 'verbatim-scope']) {
              const treatment = { carry, clock, resolution, ask };
              expect({
                pairing,
                ...treatment,
                refused: pairingViolation(pairing as 'carry', treatment) !== null,
              }).toEqual({ pairing, ...treatment, refused: !satisfied(treatment) });
            }
          }
        }
      }
    }
  });

  it('refuses `route` for the ask pairing and accepts every real block', () => {
    // The asymmetry worth its own test. The other three pairings split a switch whose default IS the
    // control, so "forgot it" and "asked for the control" are the same input. Here the control is the
    // ABSENCE of the option, so `route` is the one value that cannot be a treatment -- and `verbatim-acts`,
    // which IS the shipped block and therefore what the arm defaults to, is a perfectly good treatment:
    // `PREREG-TRUNCATION-SHORT-ROUTES.md`'s sibling question is exactly "what is the shipped ask worth
    // against the reference block".
    expect(pairingViolation('ask', { ...base, ask: 'route' })).not.toBeNull();
    for (const ask of ['verbatim', 'verbatim-acts', 'verbatim-clock', 'verbatim-scope']) {
      expect({ ask, refused: pairingViolation('ask', { ...base, ask }) !== null }).toEqual({
        ask,
        refused: false,
      });
    }
  });
});

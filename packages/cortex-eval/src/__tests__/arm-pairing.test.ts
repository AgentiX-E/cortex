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

  it('reads the units pairing, which `PREREG-TURN-FILL.md` was written against and could not dispatch to', () => {
    // The fifth key, and the one whose absence was recorded in a document rather than in a test: the
    // pre-registration's §1 said "the arm is the full 500 questions with both sides in one job", and no
    // pairing could put two evidence units in one job -- `relevanceUnits` was read from `armOptions` inside
    // the constructor, so both sides selected by the same unit. That is `resolution`'s nine-round defect
    // repeated on a different key, and this branch is what makes the sentence true.
    expect(readArmPairing('units')).toBe('units');
  });

  it('folds case and space, because the value is typed by hand into a dispatch', () => {
    expect(readArmPairing(' CARRY ')).toBe('carry');
    expect(readArmPairing('Reference')).toBe('reference');
    expect(readArmPairing(' Clock ')).toBe('clock');
    expect(readArmPairing(' Resolution ')).toBe('resolution');
    expect(readArmPairing(' ASK ')).toBe('ask');
    expect(readArmPairing(' UNITS ')).toBe('units');
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
    expect(() => readArmPairing('two-window')).toThrow(/`units`/);
    // The count is asserted in prose as well as by enumeration: "The three are" survived a fourth
    // member once already in this campaign's sibling selector, "The four are" survived a fifth one three
    // rounds ago, and "The five are" would have survived this sixth one -- the prose count is the sentence
    // a reader trusts first, and it has now been wrong three times. Asserted as a number so a seventh
    // member has to edit this line rather than append a branch.
    expect(() => readArmPairing('two-window')).toThrow(/The six are/);
    expect(() => readArmPairing('two-window')).not.toThrow(/The five are/);
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
    units: 'turn-fill',
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
        units: 'turn',
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
    expect(pairingViolation('units', { ...base, units: 'turn' })).toContain(
      'CORTEX_MEMORY_RELEVANCE_UNITS',
    );
  });

  it('says what the reading would be misread as, and the five are not the same misreading', () => {
    // The messages are the only place a dispatcher learns that a zero is not a finding. A message that said
    // "incoherent pairing" would cost a second dispatch to interpret, which is the whole expense the
    // refusal exists to avoid.
    //
    // The five are NOT one sentence with a variable substituted, and asserting that they are would have
    // made this test the thing that flattened a real distinction. Three say the artifact **publishes a null**
    // (`carry`, `ask`, `units`: the delta is zero and the accuracy is real); two say a quantity **reads zero**
    // (`clock`: the paired criterion's movement; `resolution`: `F1`'s mechanism census, which is why that
    // run is void rather than null). The wording is the difference between "we measured nothing" and "we
    // measured a zero", and both are failures a dispatcher has to be able to tell apart from a result.
    for (const pairing of ['carry', 'clock', 'resolution', 'ask', 'units'] as const) {
      const message = pairingViolation(pairing, {
        carry: false,
        clock: false,
        resolution: 'raw',
        ask: 'route',
        units: 'turn',
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
        units: 'turn',
      }),
    ).toContain('F1');
    // `units` names the pre-registration section whose falsification rule it protects (§5.1: "`promptChars`
    // unchanged on the named questions"), because that is what a reader of a zero delta needs next.
    expect(
      pairingViolation('units', {
        carry: false,
        clock: false,
        resolution: 'raw',
        ask: 'route',
        units: 'turn',
      }),
    ).toContain('PREREG-TURN-FILL.md');
  });

  it('requires exactly the one key its pairing splits, and nothing else', () => {
    // The Cartesian product, because the defect this catches is a condition that reads a SECOND key: a
    // `carry` rung that also demanded the clock would pass every single-axis test above and refuse three
    // quarters of the dispatches that ran. 5 x 48 = 240 readings, each compared as a whole object so a
    // failure prints which combination disagreed rather than which boolean did.
    const satisfactions: Record<string, (treatment: PairingTreatment) => boolean> = {
      carry: (treatment) => treatment.carry,
      clock: (treatment) => treatment.clock,
      resolution: (treatment) => treatment.resolution === 'layered',
      ask: (treatment) => treatment.ask !== 'route',
      // The control is a NAMED unit rather than an absent key, which is why this axis is not a boolean:
      // `turn` satisfies nothing and `turn-fill` satisfies everything, and a rung that demanded a third
      // state would be visible here as a combination that disagreed.
      units: (treatment) => treatment.units !== 'turn',
    };
    for (const [pairing, satisfied] of Object.entries(satisfactions)) {
      for (const carry of [true, false]) {
        for (const clock of [true, false]) {
          for (const resolution of ['raw', 'layered']) {
            for (const ask of ['route', 'verbatim-acts', 'verbatim-scope']) {
              for (const units of ['turn', 'turn-fill']) {
                const treatment = { carry, clock, resolution, ask, units };
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

  it('refuses `turn` for the units pairing and accepts every other unit', () => {
    // `ask`'s asymmetry one key down. `turn` is a real member of the product's union, so it is not an
    // invalid value -- it is an invalid TREATMENT, because it is the control. Every other unit is a
    // legitimate question: "what is `session` worth against `turn`" and "what is `session-fill` worth"
    // are both axes `PREREG-SESSION-TEXT-UNIT.md` and `RETRACTIONS.md` 28 have already asked in prose.
    expect(pairingViolation('units', { ...base, units: 'turn' })).not.toBeNull();
    for (const units of ['turn-fill', 'session', 'session-fill', 'anchor-window', 'session-text']) {
      expect({ units, refused: pairingViolation('units', { ...base, units }) !== null }).toEqual({
        units,
        refused: false,
      });
    }
  });
});

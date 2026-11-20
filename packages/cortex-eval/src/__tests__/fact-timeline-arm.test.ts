/**
 * The row that shipped, worked, and could not be measured.
 *
 * ## What was true before this file
 *
 * `factTimeline` landed in `cortex-memory` with an option, a renderer, a manual section, twelve tests and a
 * ledger row that moved from `instrument` to `product (gated)`. Every one of those is a real property of the
 * library, and none of them is a measurement: the arm had no field for it, `bench/run-ablation.ts` had no
 * spread for it, the workflow had no line for it and the dispatcher had no input for it. So the only artifact
 * this project can produce that mentions the timeline is a test in the product's own package.
 *
 * That is the fifth shape of one defect, and the list is worth stating because each instance was found by a
 * different accident:
 *
 * | mechanism | how it was found |
 * | --- | --- |
 * | `semanticCarry` | six rounds of "E6 is `unrun`" read as a scheduling problem |
 * | `lexicalWeighting` | the variable was read and the workflow never forwarded it |
 * | `sessionClock` | same shape, found while writing the previous one |
 * | `factTimeline` | the ledger row said `product` and no artifact could disagree |
 *
 * The wiring is therefore tested in **five places**, one per link §127.3 names, because a test that covers
 * the whole chain at once would pass on any one link being correct and a test that covers one link would pass
 * on four being absent.
 *
 * ## Why the arm-side link cannot be tested behaviourally
 *
 * `bench/**` is excluded from coverage as an entry point: `run-ablation.ts` is a script, and the four lines
 * that carry the treatment from parsed options into the product's constructor have no seam. The text
 * assertions below are the same compromise `semantic-carry-arm.test.ts` makes for the same reason, and they
 * are labelled as such rather than presented as behaviour.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { cortextMemoryArmOptions, toMemoryArmConfig } from '../bench-memory-arm.js';

import type { CortexMemoryArmOptions } from '../bench-memory-arm.js';

/** The arm switched on, which is the state every dispatch is in. */
const ARM_ON = { CORTEX_MEMORY: '1' } as const;

const WORKFLOW = readFileSync(
  new URL('../../../../.github/workflows/semantic-carry.yml', import.meta.url),
  'utf8',
);
const DISPATCHER = readFileSync(
  new URL('../../../../tools/dispatch-semantic-carry.py', import.meta.url),
  'utf8',
);
const ARM = readFileSync(
  new URL('../../../cortex-memory/bench/run-ablation.ts', import.meta.url),
  'utf8',
);
const PRODUCT_OPTIONS = readFileSync(
  new URL('../../../cortex-memory/src/types.ts', import.meta.url),
  'utf8',
);

describe('link 2: the arm can ask for the treatment', () => {
  it('reads its own variable, and an unset variable is every archived artifact`s state', () => {
    // Absent rather than `false`-by-default, for the reason `semanticCarry` states: every artifact published
    // before this round was produced with the switch unset, so an unset variable that enabled it would change
    // the meaning of numbers already in print rather than merely adding a field.
    expect(cortextMemoryArmOptions({ ...ARM_ON }).factTimeline).toBe(false);
  });

  it('turns it on for the strict string `1`, the same grammar as every toggle in the arm', () => {
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_FACT_TIMELINE: '1' }).factTimeline,
    ).toBe(true);
  });

  it('keeps presence from implying truth, so `0`, `no` and the empty string are all off', () => {
    // `readToggle`'s contract, asserted at THIS variable rather than assumed from its unit test: the variable
    // name is the part that can be misspelled, and a test of the reader passes with the wrong name wired in.
    for (const value of ['0', 'no', 'false', '']) {
      expect(
        cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_FACT_TIMELINE: value }).factTimeline,
        `CORTEX_MEMORY_FACT_TIMELINE=${JSON.stringify(value)} must be off`,
      ).toBe(false);
    }
  });

  it('is independent of the carry at the parsing layer, because the refusal belongs one level up', () => {
    // The renderer gates on `semanticCarry`, so the tempting implementation is to fold the two into one
    // variable. That would make "the carry does nothing" and "the carry's rendering does nothing" the same
    // dispatch -- the collapse this campaign spent six rounds undoing for `semanticCarry` itself. The arm
    // parses them independently and `run-ablation.ts` refuses the combination, which is where the refusal can
    // name both variables in one message.
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_FACT_TIMELINE: '1' }).semanticCarry,
    ).toBe(false);
    expect(
      cortextMemoryArmOptions({
        ...ARM_ON,
        CORTEX_MEMORY_FACT_TIMELINE: '1',
        CORTEX_MEMORY_SEMANTIC_CARRY: '1',
      }),
    ).toMatchObject({ factTimeline: true, semanticCarry: true });
  });

  it('projects the control on a disabled arm even when the variable names the treatment', () => {
    // A disabled arm renders no prompt, so no interval was written. Projecting `true` would put a treatment on
    // the record of a run that answered nothing -- and this projection is easier to get wrong than most,
    // because the option is independent of `semanticCarry` in the product's type.
    const disabled = cortextMemoryArmOptions({ CORTEX_MEMORY_FACT_TIMELINE: '1' });
    expect(disabled.enabled).toBe(false);
    expect(disabled.factTimeline).toBe(false);
  });
});

describe('link 3: the artifact says whether it was asked for', () => {
  it('records the value on both sides of the switch', () => {
    // Always present, `false` included, for the reason `conflicts` and `semanticCarry` are: a field written
    // only under treatment makes "ran the control" and "predates the field" the same bytes.
    expect(toMemoryArmConfig({ ...cortextMemoryArmOptions({ ...ARM_ON }) }).factTimeline).toBe(
      false,
    );
    expect(
      toMemoryArmConfig({
        ...cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_FACT_TIMELINE: '1' }),
      }).factTimeline,
    ).toBe(true);
  });

  it('projects a hand-built option object with no field as the control', () => {
    // The absent case is the one a loose comparison gets wrong: `factTimeline` is optional on the options type,
    // so a caller that builds the object by hand leaves it `undefined`, and a projection written as
    // `!== false` would read that as a claim of a treatment nobody administered.
    const handBuilt: CortexMemoryArmOptions = { ...cortextMemoryArmOptions({ ...ARM_ON }) };
    delete handBuilt.factTimeline;
    expect(toMemoryArmConfig(handBuilt).factTimeline).toBe(false);
  });

  it('classifies the field, so a future baseline re-record cannot meet it as an unknown', () => {
    // `arm-config-record.py` refuses an artifact carrying a field no class covers, which is how the shipped
    // `supersededRendering` and `indexEmbedding` would have failed their next `--record`. The classification
    // test parses `MemoryArmConfig` itself, so this assertion is a pointer rather than a second check.
    const classification = readFileSync(
      new URL('../../../../tools/arm-config-record.py', import.meta.url),
      'utf8',
    );
    expect(classification).toContain('"factTimeline": (');
  });
});

describe('link 4: the options reach the product constructor', () => {
  it('spreads inside the pair rather than beside it', () => {
    // Inside, because the product's renderer returns an empty list unless the carry is on: a `factTimeline`
    // on the control side would be an option the product silently ignores, and the artifact recording it
    // would describe a treatment that could not have been administered.
    expect(ARM).toContain(
      '...(carry && armOptions.factTimeline === true ? { factTimeline: true } : {})',
    );
  });

  it('refuses a timeline dispatch with no carry, before the first call', () => {
    // One message naming both variables, because the alternative is two dispatch-fix-rerun cycles: the
    // pairing rule would let this through (its condition is about `pairing`, not about this switch) and the
    // run would publish `delta = 0` with `factTimeline: true` on the artifact.
    expect(ARM).toContain('armOptions.factTimeline === true && armOptions.semanticCarry !== true');
    const refusal = ARM.indexOf(
      'armOptions.factTimeline === true && armOptions.semanticCarry !== true',
    );
    const pairing = ARM.indexOf("pairing === 'carry' && armOptions.semanticCarry !== true");
    expect(refusal).toBeGreaterThan(-1);
    expect(pairing).toBeGreaterThan(-1);
    // Ordered: the more specific refusal first, so a dispatch missing both variables is told about both.
    expect(refusal).toBeLessThan(pairing);
  });

  it('names the same identifier the product option type declares', () => {
    // The two halves of one wire. A rename on either side leaves both files compiling -- the product's option
    // is optional and the arm's spread is unchecked -- while the constructor ignores the property.
    expect(PRODUCT_OPTIONS).toMatch(/factTimeline\?: boolean;/);
    expect(ARM).toContain('factTimeline: true');
  });

  it('echoes the requested value on the line the run prints', () => {
    // The question an operator asks a scrollback is "did my dispatch turn it on", and the answer must be the
    // same number the artifact records -- the requested value, not the conjunction, so a refused dispatch is
    // visible as a refusal rather than as nobody having asked.
    expect(ARM).toContain('factTimeline=${armOptions.factTimeline === true}');
    expect(ARM).toContain('factTimeline: armOptions.factTimeline === true');
  });
});

describe('link 5: the dispatch can carry it', () => {
  it('declares an input of its own, rather than deriving it from `pairing`', () => {
    // A value of `pairing` would have made the carry's instrument and the carry's rendering one dispatch --
    // and the two sides of a timeline pair are BOTH carrying, differing by whether the served fact is dated.
    expect(WORKFLOW).toMatch(/^ {6}fact_timeline:$/m);
    expect(WORKFLOW).toContain('CORTEX_MEMORY_FACT_TIMELINE: ${{ inputs.fact_timeline }}');
  });

  it('defaults to the state every archived artifact was produced under', () => {
    const block = WORKFLOW.slice(
      WORKFLOW.indexOf('fact_timeline:'),
      WORKFLOW.indexOf('capability:'),
    );
    expect(block).toContain("default: '0'");
  });

  it('is sent by the dispatcher, so the workflow default is never the thing that decided', () => {
    // The dispatch-inputs gate checks this from both sides, and this assertion is the reading of the same
    // fact from this file's side: a workflow input with no `INPUTS` entry reaches nothing and the run
    // completes on a default the dispatch record does not mention.
    expect(DISPATCHER).toContain('"fact_timeline": "0"');
  });
});

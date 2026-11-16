/**
 * The marker had a product and no arm.
 *
 * ## What was missing, and why the round that built the mechanism did not notice
 *
 * §18 built `supersededRendering` in the product: sixteen unit tests, an assembly test that goes
 * `remember → askStored`, and a documented acceptance clause (`off` is byte-identical, `mark` differs
 * by exactly the marker's length times the number of marked turns). All of it green, none of it
 * **reachable from a dispatch**. The chain a treatment has to travel is
 *
 *     workflow env → cortex-eval reader → CortexMemoryArmOptions → run-ablation constructor
 *                  → CortexMemory → prompt bytes → artifact
 *
 * and the round built the last three links and neither of the first three. So `S`-rows that price the
 * mechanism could not be dispatched at all, and the honest status of the mechanism was not "unpriced"
 * but "unpriceable" -- the same defect `semantic-carry-arm.test.ts` records for E6, one axis over.
 *
 * ## Why the artifact field is a string and not a boolean
 *
 * Two treatments, and they spend the prompt in opposite directions: `mark` **appends** a clause inside
 * the turn and is therefore charged against the evidence budget, while `collapse` **replaces** the
 * replaced value with a shorter form and is not. A boolean would have to name one of them, and the
 * reading is the comparison between them -- so the field carries the name, and the printer prints it
 * on every run, `off` included, exactly as it prints `semanticCarry=false` on every control.
 */
import { describe, expect, it } from 'vitest';

import { exactMatchScorer } from '../metrics.js';
import {
  cortextMemoryArmOptions,
  runCortexMemoryArm,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';
import { formatAblationReport } from '../report.js';

import type { CortexMemoryArmOptions } from '../bench-memory-arm.js';
import type { MemoryArmConfig } from '../report.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';

/** The arm switched on, which is the state every dispatch to `benchmark-cortex-memory.yml` is in. */
const ARM_ON = { CORTEX_MEMORY: '1' } as const;

/** The identity configuration, so a report can be built without naming a single mechanism. */
const GATE: MemoryArmConfig = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: 64,
  supersededRendering: 'off',
};

function rendering(options: CortexMemoryArmOptions): string | undefined {
  return toMemoryArmConfig(options).supersededRendering;
}

/**
 * A two-question A/B whose feature config carries one rendering.
 *
 * A real `runCortexMemoryArm` rather than a hand-built report: the printer reads a dozen aggregates, and
 * a fixture invented here would be a second description of that record that drifts from the first.
 */
async function runWith(rendering: string) {
  const dataset: BenchmarkDataset = {
    name: 'fixture',
    questions: [
      {
        id: 'q0',
        capability: 'KU',
        question: 'Where does she work?',
        expected: 'one',
        context: [],
      },
      { id: 'q1', capability: 'KU', question: 'Where did she work?', expected: 'one', context: [] },
    ],
  };
  const system = (name: string): MemorySystem => ({ name, answer: () => 'one' });
  const result = await runCortexMemoryArm(
    dataset,
    system('reference-pipeline'),
    system('cortex-memory'),
    {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE, supersededRendering: rendering },
    },
  );
  return result.report;
}

describe('the arm can be dispatched to administer the marker', () => {
  it('reads its own variable, and an unset variable is the shipped rendering', () => {
    // The default is load-bearing rather than tidy: `off` is what every archived artifact was produced
    // under, so a default that enabled the marker would retroactively change the meaning of every
    // published prompt digest while looking like a new field.
    expect(cortextMemoryArmOptions({ ...ARM_ON }).supersededRendering).toBe('off');
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: 'off' }).supersededRendering,
    ).toBe('off');
    // A blank variable is the same state, which is what GitHub substitutes for an unset repository
    // variable -- so the workflow's literal fallback and this reader agree on one value rather than two.
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: '  ' }).supersededRendering,
    ).toBe('off');
  });

  it('accepts both treatments by name, because they are different experiments', () => {
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: 'mark' }).supersededRendering,
    ).toBe('mark');
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: 'collapse' })
        .supersededRendering,
    ).toBe('collapse');
  });

  it('rejects a name the product cannot apply instead of defaulting to the control', () => {
    // The failure this refusal prevents has a measured size: the side block's four repetitions read
    // -1 / -4 / -6 / -8 questions. A dispatch that asked for the marker and silently rendered the
    // control would publish that number as the marker's price, which is the one conclusion this
    // experiment exists to reach and the one a silent default would invert.
    for (const bad of ['marker', 'MARK', 'collapse ', 'true', '1', 'on']) {
      // `collapse ` is trimmed to a legal value and must NOT throw -- it is in the loop as a control
      // for the trimming rule rather than as a rejected name.
      if (bad === 'collapse ') continue;
      expect(() => cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: bad })).toThrow(
        /CORTEX_MEMORY_SUPERSEDED must be one of/,
      );
    }
    // Whitespace around a legal name is a shell artefact rather than a different rendering, so it is
    // read as the name: a variable written by hand with a trailing newline is not a typo.
    expect(
      cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: ' collapse\n' })
        .supersededRendering,
    ).toBe('collapse');
  });

  it('records the rendering on a disabled arm as off, not as the variable', () => {
    // A disabled arm renders no prompt, so no turn was marked. Reading the variable here would put a
    // treatment on the record of a run that never assembled one -- the claim-nobody-can-check defect
    // the `featureConfig` block exists to close.
    const disabled = cortextMemoryArmOptions({ CORTEX_MEMORY_SUPERSEDED: 'mark' });
    expect(disabled.enabled).toBe(false);
    expect(disabled.supersededRendering).toBe('off');
    expect(rendering(disabled)).toBe('off');
  });
});

describe('the artifact says which rendering ran, on every run', () => {
  it('projects the value, so "ran the control" and "predates the field" are different bytes', () => {
    expect(rendering(cortextMemoryArmOptions({ ...ARM_ON }))).toBe('off');
    expect(
      rendering(cortextMemoryArmOptions({ ...ARM_ON, CORTEX_MEMORY_SUPERSEDED: 'mark' })),
    ).toBe('mark');
  });

  it('defaults an option object built by hand to off rather than to undefined', () => {
    // Several callers build this object directly -- tests, and any future entry point -- and
    // `supersededRendering` is optional on the type, so a projection written as
    // `options.supersededRendering` would leave the field absent and a reader would take the absence
    // for `off`. Defaulting states the same thing as a value, which is what makes it checkable.
    const handBuilt: CortexMemoryArmOptions = { ...cortextMemoryArmOptions({ ...ARM_ON }) };
    delete handBuilt.supersededRendering;
    expect(rendering(handBuilt)).toBe('off');
    // And the key is present rather than merely equal, which is the property the field exists for.
    expect('supersededRendering' in toMemoryArmConfig(handBuilt)).toBe(true);
  });

  it('prints the value on the line a human reads, for every rendering including off', async () => {
    const report = await runWith('mark');
    const printed = formatAblationReport(report);
    expect(printed).toContain('superseded=mark');
    // A value rather than a boolean: an artifact that spelled `superseded=true` would leave `mark` and
    // `collapse` indistinguishable on the line, and the reading is the comparison between them.
    expect(printed).not.toContain('superseded=true');

    // `off` is printed rather than omitted, for the reason every always-present field here is: the
    // control ran, and that is information a reader has to be able to see on the same line.
    expect(formatAblationReport(await runWith('off'))).toContain('superseded=off');
    expect(formatAblationReport(await runWith('collapse'))).toContain('superseded=collapse');
  });
});

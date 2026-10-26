/**
 * The aggregation critique, measured through the entry point every run uses.
 *
 * ## Why this file exists
 *
 * `enableAggregationCritique` was declared, consumed, documented, unit-tested, and **never run on the graded
 * path**. `natural-language-memory.test.ts` exercised it eight times with the option set directly on the system;
 * nothing in `runner.ts` forwarded it, so no benchmark could turn it on, and the doc comment's own precondition —
 * "nothing is enabled on the graded path until its own ablation is green" — could not be satisfied because the
 * ablation could not be dispatched.
 *
 * That is the same defect shape this repository has caught three times: an orphan export, an inert
 * `retrievalThreshold`, a B7 toggle read into a local whose only consumers sat inside a branch. The tests below
 * are written so that the next occurrence fails here rather than in an artifact nobody can attribute.
 *
 * ## What the observable is
 *
 * The extra model call. The pass asks the model to critique the first ledger and then re-asks the aggregation
 * prompt with the critique folded in, so an enumeration question costs one more request when it is on. Counting
 * requests is stronger than asserting a config field: a forwarded option that the system never reads would still
 * set the field, and that is exactly the failure being guarded against.
 *
 * The fixture is a multi-session enumeration question with two facts in one session. It must not match
 * `classifyAggregationKind`'s derivation patterns ("percentage", "average", "how much more", ...), or the system
 * routes to the operand prompt, which has no ledger to critique and correctly skips the pass.
 */
import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { runNaturalLanguageBenchmark } from '../runner.js';
import { classifyAggregationKind } from '../natural-language-memory.js';
import { parseCritiqueMode } from '../bench-arm-options.js';
import { HashEmbedding } from '../embedding.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

const QUESTION = 'How many musical instruments do I play in total?';

const instances: LongMemEvalInstance[] = [
  {
    question_id: 'q_mr_enumeration',
    question_type: 'multi-session',
    question: QUESTION,
    answer: 'two',
    haystack_dates: ['2023/03/01 (Wed) 10:00', '2023/03/08 (Wed) 10:00'],
    haystack_sessions: [
      [{ role: 'user', content: 'I have been learning the cello since January.' }],
      [{ role: 'user', content: 'I also picked up the clarinet last month.' }],
    ],
  },
];

/**
 * A model that records every prompt it is sent.
 *
 * The reply is a plausible ledger followed by the answer, because the critique pass reads the first response as a
 * ledger: a reply of just "two" would still trigger the call (the pass does not parse before asking for the
 * critique) but would make the fixture assert less than the real path does.
 */
function recordingLlm(prompts: string[]): LLM {
  return {
    async complete(prompt: string) {
      prompts.push(prompt);
      return '1. cello\n2. clarinet\nAnswer: two';
    },
    async completeStructured() {
      return {} as never;
    },
  } as LLM;
}

async function run(options: {
  enableAggregationCritique?: boolean;
  aggregationCritiqueMode?: 'recall' | 'per-item';
}) {
  const prompts: string[] = [];
  const { report } = await runNaturalLanguageBenchmark(
    instances,
    new HashEmbedding(64),
    recordingLlm(prompts),
    { runs: 1, ...options },
  );
  return { report, prompts };
}

describe('the aggregation critique is reachable from the benchmark entry point', () => {
  it('routes the fixture to an enumeration, which is the only kind the pass applies to', () => {
    // Guards the fixture rather than the feature. A question that matched a derivation pattern would take the
    // operand prompt, skip the critique by design, and make every assertion below pass for the wrong reason.
    expect(classifyAggregationKind(QUESTION)).toBe('enumeration');
  });

  it('records the switch in the artifact for both states', async () => {
    // Both states, because an artifact that omits the key cannot be told apart from one written before the key
    // existed -- the distinction §20 records for the reranking switch.
    const off = await run({});
    const on = await run({ enableAggregationCritique: true });
    expect(off.report.featureConfig?.aggregationCritique).toBe(false);
    expect(on.report.featureConfig?.aggregationCritique).toBe(true);
  });

  it('spends exactly two extra model calls when the pass is on', async () => {
    // Two, not one: the pass is a critique **and** a re-ask with the critique folded in. Measured rather than
    // assumed — the first version of this test asserted one and read 4 against 3.
    //
    // The count is the observable that a forwarded-but-unread option would not produce. A config field alone
    // would still be set by a runner that forwards an option the system ignores, which is precisely the B7
    // defect this file's header names.
    const off = await run({});
    const on = await run({ enableAggregationCritique: true });
    expect(on.prompts.length).toBe(off.prompts.length + 2);
  });

  it('asks the critique to audit membership rather than to restate the instructions', async () => {
    // The pass is only worth its call if it attacks the decision. The system's own documentation says the failure
    // it targets is which items enter the list, so the critique prompt has to be about membership.
    const { prompts } = await run({ enableAggregationCritique: true });
    const critique = prompts.find((prompt) => /membership|missed|exclude/i.test(prompt));
    expect(critique).toBeDefined();
    // And the re-ask carries the critique, so the second call is conditioned on the first rather than a repeat.
    const reask = prompts.filter((prompt) => /critique|audit|revise/i.test(prompt));
    expect(reask.length).toBeGreaterThan(0);
  });

  it('leaves the run unchanged when the option is absent', async () => {
    // Absence is the shipped configuration, so both spellings of "off" must be one program.
    const absent = await run({});
    const explicitOff = await run({ enableAggregationCritique: false });
    expect(explicitOff.prompts.length).toBe(absent.prompts.length);
    expect(explicitOff.report.featureConfig?.aggregationCritique).toBe(
      absent.report.featureConfig?.aggregationCritique,
    );
  });
});

/**
 * The per-item critique: judgement instead of enumeration.
 *
 * *Judging != Enumerating* (2608.01000) reports two things that together decide this design. Asking a model to
 * produce a complete list suffers silent omission — a few items and the list looks done. Asking it about items
 * **one at a time** confirms them at about 90%. The recall critique asks the first kind of question; this arm asks
 * the second.
 *
 * What makes the difference testable rather than stylistic is that per-item output has **decidable coverage**: the
 * context is numbered and one verdict per number is required, so a caller can count verdicts against markers. "I
 * found nothing missing" cannot be checked that way.
 */
describe('the per-item critique', () => {
  async function perItemPrompts(): Promise<string[]> {
    const prompts: string[] = [];
    await runNaturalLanguageBenchmark(
      instances,
      new HashEmbedding(64),
      {
        async complete(prompt: string) {
          prompts.push(prompt);
          return '1: COUNT\n2: COUNT\nMISSED: none\nEXTRA: none';
        },
        async completeStructured() {
          return {} as never;
        },
      } as LLM,
      { runs: 1, enableAggregationCritique: true, aggregationCritiqueMode: 'per-item' },
    );
    return prompts;
  }

  it('numbers every context line and states how many there are', async () => {
    const prompts = await perItemPrompts();
    const critique = prompts.find((prompt) => prompt.includes('numbered lines'));
    expect(critique).toBeDefined();
    const markers = [...critique!.matchAll(/^\[(\d+)\] /gm)].map((match) => Number(match[1]));
    // Numbering is contiguous from 1, so a missing marker is a visible gap rather than a silent shortfall.
    expect(markers).toEqual(markers.map((_, index) => index + 1));
    expect(markers.length).toBeGreaterThan(0);
    // And the stated count is the number of markers actually present.
    expect(critique).toContain(`split into ${markers.length} numbered lines`);
  });

  it('requires one verdict per line rather than a list of what is missing', async () => {
    const critique = (await perItemPrompts()).find((prompt) => prompt.includes('numbered lines'))!;
    expect(critique).toContain('<number>: COUNT');
    expect(critique).toContain('<number>: NOT-COUNT');
    expect(critique).toContain('<number>: DUP-OF <number>');
    expect(critique).toContain('You must emit a verdict for every numbered line');
    expect(critique).toContain('Do not skip any');
    // The prohibition is the point: the failure being repaired is recall, so recall must be forbidden.
    expect(critique).toContain('Do not list items from memory');
  });

  it('derives the summary from the verdicts rather than from memory', async () => {
    const critique = (await perItemPrompts()).find((prompt) => prompt.includes('numbered lines'))!;
    expect(critique).toContain('derive the summary FROM THE VERDICTS YOU JUST WROTE');
    expect(critique).toContain('MISSED:');
    expect(critique).toContain('EXTRA:');
  });

  it('turns an exchange into two verdicts instead of one merged entry', async () => {
    // The measured MR failure is a merged entry: returning an item and picking up its replacement counted as one.
    // A verdict per line makes both lines COUNT, which is what the revision then acts on.
    const critique = (await perItemPrompts()).find((prompt) => prompt.includes('numbered lines'))!;
    expect(critique).toContain('An "exchange" is TWO items');
    expect(critique).toMatch(/both are COUNT/);
  });

  it('is structurally different from the recall prompt, not a rewording of it', async () => {
    // If the two prompts differed only in emphasis the experiment would measure wording. The recall prompt asks
    // for a list of problems; this one forbids that and demands a verdict table.
    const recall = await run({ enableAggregationCritique: true });
    const recallCritique = recall.prompts.find((prompt) => prompt.includes('auditing a draft'))!;
    const perItem = (await perItemPrompts()).find((prompt) => prompt.includes('numbered lines'))!;
    expect(recallCritique).toContain('Report each problem you find');
    expect(perItem).not.toContain('Report each problem you find');
    expect(recallCritique).not.toContain('<number>: COUNT');
  });

  it('is a no-op when it reports nothing to add', async () => {
    // A revision that re-asks the identical question with "nothing was wrong" appended doubles the cost for no
    // change in answer. The no-op path is what keeps the pass affordable.
    const prompts: string[] = [];
    await runNaturalLanguageBenchmark(
      instances,
      new HashEmbedding(64),
      {
        async complete(prompt: string) {
          prompts.push(prompt);
          return /numbered lines/.test(prompt)
            ? 'Nothing to add'
            : '1. cello\n2. clarinet\nAnswer: two';
        },
        async completeStructured() {
          return {} as never;
        },
      } as LLM,
      { runs: 1, enableAggregationCritique: true, aggregationCritiqueMode: 'per-item' },
    );
    // The critique ran once and the revision did not. Counting the calls is the wrong assertion here -- this path
    // also spends a query-expansion call before answering -- so the assertion is on the revision prompt itself,
    // which is the thing a no-op must not produce.
    expect(prompts.filter((prompt) => prompt.includes('auditing a draft item list')).length).toBe(
      1,
    );
    expect(
      prompts.filter((prompt) => prompt.includes('An audit of your previous attempt')).length,
    ).toBe(0);
  });

  it('records which critique ran, for both states', async () => {
    const off = await run({});
    const recall = await run({ enableAggregationCritique: true });
    const perItem = await run({
      enableAggregationCritique: true,
      aggregationCritiqueMode: 'per-item',
    });
    expect(off.report.featureConfig?.aggregationCritiquePerItem).toBe(false);
    expect(recall.report.featureConfig?.aggregationCritiquePerItem).toBe(false);
    expect(perItem.report.featureConfig?.aggregationCritiquePerItem).toBe(true);
  });

  it('parses the mode strictly, so a typo cannot run the wrong prompt', () => {
    expect(parseCritiqueMode(undefined)).toBeUndefined();
    expect(parseCritiqueMode('')).toBeUndefined();
    expect(parseCritiqueMode('recall')).toBe('recall');
    expect(parseCritiqueMode('per-item')).toBe('per-item');
    // Present but unrecognised is an error, not a default: a run whose artifact says `per-item` while the prompt
    // was `recall` is the defect this refusal prevents.
    expect(() => parseCritiqueMode('per_item')).toThrow(/must be 'recall' or 'per-item'/);
  });
});

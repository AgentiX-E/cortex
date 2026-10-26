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

async function run(options: { enableAggregationCritique?: boolean }) {
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

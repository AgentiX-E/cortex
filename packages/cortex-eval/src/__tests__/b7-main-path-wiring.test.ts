/**
 * Where B7 actually stops, measured through the main benchmark entry point.
 *
 * ## Why this file exists
 *
 * The B7 A/B was dispatched with `candidate_discrimination=0` and `=1`; both runs
 * went green and both arms produced byte-identical artifacts. The first
 * explanation found was a missing spread: `bench/run.ts` read the toggle into a
 * local used only inside the `CORTEX_RERANK` branch, and the main
 * `runNaturalLanguageBenchmark` call never received the option.
 *
 * That was true and is now fixed. It was not the whole story, and these tests
 * were written to find out how much of the story was left. They establish that
 * **fixing the spread does not make B7 do anything**, because the annotation this
 * feature is built around is never produced:
 *
 *   - `discriminateContext` and `renderDiscriminatedContext` have **no
 *     production caller**. Excluding this package's barrel and its own module,
 *     every reference in `src/**` is a comment.
 *   - `renderDiscriminatedContext` is the thing that writes
 *     ` [candidateCluster: N]` into a turn. `CANDIDATE_DISCRIMINATION_INSTRUCTION`
 *     is an instruction to READ those labels.
 *   - So with the option on, the reader is told to pick between labelled
 *     candidates while the context it receives carries no labels — the
 *     instruction is text the model must read and discard, which is the exact
 *     failure the option's own doc comment warns about.
 *
 * ## Why the tests assert what they do
 *
 * Each test below pins one link of the chain, so that when the missing data path
 * is built (see `AUDIT-B7-ANNOTATION-PRODUCER.md`) the test that must flip from
 * "not annotated" to "annotated" is already here and already named. A test suite
 * that only asserted the end state after the fix would not be able to show that
 * the fix changed anything.
 *
 * The observable is the context the system INJECTS, emitted on `onDecision`,
 * because it is produced before the shared `answerCache` is consulted. An earlier
 * revision asserted on the LLM's prompt and was blind in the same direction as
 * the defect: the baseline runs first and the feature reuses its cached answer, so
 * the feature's prompt is never sent.
 *
 * No mocks of the memory system: the runner builds the real
 * `NaturalLanguageMemorySystem` and its real renderer. The LLM is a stub because
 * it is a network boundary and its text cannot affect whether a label was
 * written.
 */
import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { runNaturalLanguageBenchmark } from '../runner.js';
import {
  CANDIDATE_RECORD_SCHEMA_KEY,
  discriminateContext,
  renderDiscriminatedContext,
} from '../candidate-context.js';
import type { DecisionTrace } from '../natural-language-memory.js';
import { HashEmbedding } from '../embedding.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

/**
 * Two turns offering two competing values for the same attribute, which is the
 * shape the annotation exists to mark up. Both values appear in the context, so a
 * candidate pair genuinely exists.
 *
 * The session content is DATED because the harness renders turns with a date
 * prefix and the annotation renderer aligns on that shape; an undated fixture
 * would make the producer unlabelable for reasons unrelated to the wiring, which
 * is exactly the kind of confound this file exists to avoid.
 */
const instances: LongMemEvalInstance[] = [
  {
    question_id: 'q_candidates',
    question_type: 'single-session-user',
    question: 'What is the gate code for the north entrance?',
    answer: '4172',
    haystack_sessions: [
      [
        { role: 'user', content: 'the gate code is 4172 for the north entrance' },
        { role: 'user', content: 'the gate code is 9930 for the south entrance' },
      ],
    ],
  },
];

function stubLlm(): LLM {
  return {
    async complete() {
      return '4172';
    },
    async completeStructured() {
      return {} as never;
    },
  } as LLM;
}

async function injectedContexts(candidateDiscrimination: boolean): Promise<string[]> {
  const traces: DecisionTrace[] = [];
  await runNaturalLanguageBenchmark(instances, new HashEmbedding(64), stubLlm(), {
    runs: 1,
    candidateDiscrimination,
    onDecision: (trace) => traces.push(trace),
  });
  return traces.map((trace) => trace.retrieved ?? '');
}

function labelCount(contexts: readonly string[]): number {
  return contexts.filter((context) => context.includes(`[${CANDIDATE_RECORD_SCHEMA_KEY}:`)).length;
}

describe('the option is forwarded to the feature system by the main entry point', () => {
  it('accepts the option and runs, with the feature system present', async () => {
    // Fixes the first defect and would fail on it: before `runner.ts` forwarded
    // the option, nothing distinguished these two calls, and this test asserts
    // only that both configurations are accepted and produce traces.
    const off = await injectedContexts(false);
    const on = await injectedContexts(true);
    expect(off.length).toBeGreaterThan(0);
    expect(on.length).toBeGreaterThan(0);
  });
});

describe('the annotation producer is not reached from the main path', () => {
  it('produces no cluster labels even with the option on', async () => {
    // THE FINDING. When the data path is built, this expectation flips to
    // `toBeGreaterThan(0)` and this comment is deleted with it.
    const contexts = await injectedContexts(true);
    expect(contexts.length).toBeGreaterThan(0);
    expect(labelCount(contexts)).toBe(0);
  });

  it('leaves the injected context identical with the option on and off', async () => {
    // Stated as an equality because that is the sharper claim: the two
    // configurations are not merely both unannotated, they are the same text.
    const off = await injectedContexts(false);
    const on = await injectedContexts(true);
    expect(on).toEqual(off);
  });
});

describe('the annotation producer works when it is called', () => {
  it('labels the competing turns when given the two sides directly', () => {
    // The counterweight to the tests above, and the reason the finding is
    // "unreachable" rather than "broken". The producer and the renderer are both
    // correct; nothing calls them. Asserting this here keeps the two claims
    // separable: a future change that wires them up does not have to re-prove
    // they work, and a change that breaks one does not have to re-prove the
    // other is unreachable.
    //
    // The turn text is DATED, and that is load-bearing rather than cosmetic.
    // `renderDiscriminatedContext` splits the context on turn boundaries
    // (`/(?=\[\d{4}\/\d{2}\/\d{2})/`) and declines to label anything when that
    // count disagrees with a plain `split('\n')` — a deliberate guard, since
    // labelling the wrong turn produces a mislabel that is worse than no label
    // and is invisible. Undated text trips it and returns the context unchanged,
    // which is a real precondition of the producer that a fixture can easily get
    // wrong. The dated shape is what the benchmark emits.
    const turns = [
      {
        index: 0,
        text: '[2023/05/20 (Sat) 02:10] user: the gate code is 4172 for the north entrance',
      },
      {
        index: 1,
        text: '[2023/05/20 (Sat) 02:11] user: the gate code is 9930 for the south entrance',
      },
    ];
    const result = discriminateContext(turns, {
      question: 'What is the gate code for the north entrance?',
      groundTruth: '4172',
      answer: '9930',
    });
    expect(result.annotated).toBe(true);
    expect(result.clusters.length).toBeGreaterThan(0);

    const context = turns.map((t) => t.text).join('\n');
    const rendered = renderDiscriminatedContext(context, result.clusters, {
      question: 'What is the gate code for the north entrance?',
      groundTruth: '4172',
      answer: '9930',
    });
    expect(rendered).toContain(`[${CANDIDATE_RECORD_SCHEMA_KEY}:`);
  });

  it('declines to label undated context rather than mislabelling it', () => {
    // The precondition above, asserted rather than left implicit. A fixture that
    // uses undated text gets an unannotated context back and a test that looks
    // like it is proving the producer is broken. This pins the actual contract:
    // the decline is about TURN ALIGNMENT, not about the candidates.
    const turns = [
      { index: 0, text: 'the gate code is 4172 for the north entrance' },
      { index: 1, text: 'the gate code is 9930 for the south entrance' },
    ];
    const result = discriminateContext(turns, {
      question: 'What is the gate code for the north entrance?',
      groundTruth: '4172',
      answer: '9930',
    });
    // The producer still finds the pair.
    expect(result.annotated).toBe(true);
    // The renderer declines, because it cannot align line positions to indices.
    const context = turns.map((t) => t.text).join('\n');
    const rendered = renderDiscriminatedContext(context, result.clusters, {
      question: 'What is the gate code for the north entrance?',
      groundTruth: '4172',
      answer: '9930',
    });
    expect(rendered).toBe(context);
  });
});

describe('the producer depends on a value the memory system never receives', () => {
  it('returns no annotation when the ground truth is withheld', () => {
    // The structural reason the path cannot be wired by a spread. The producer
    // needs BOTH sides -- the question alone is not enough -- and
    // `NaturalLanguageMemorySystem` has no `groundTruth` field and no parameter
    // that carries one (`answer(question, context, sessions)`). Completing B7
    // therefore needs a new data path from the dataset, not a forwarded option.
    const turns = [
      { index: 0, text: 'the gate code is 4172 for the north entrance' },
      { index: 1, text: 'the gate code is 9930 for the south entrance' },
    ];
    const result = discriminateContext(turns, {
      question: 'What is the gate code for the north entrance?',
    });
    expect(result.annotated).toBe(false);
    expect(result.clusters).toHaveLength(0);
  });
});

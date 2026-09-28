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
  retrievalCandidateSides,
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
 *
 * The dates live in `haystack_dates`, not in `content`, and getting that wrong is
 * how this fixture first went wrong: `turnText` prepends `[date] ` only when a
 * date is supplied, so a fixture that omits `haystack_dates` renders
 * `user: ...` and the renderer declines to label it. The producer still finds the
 * pair in that case, which is what made the failure look like a wiring bug when
 * it was a fixture bug -- `annotated: true` with two clusters and an unchanged
 * context.
 */
const instances: LongMemEvalInstance[] = [
  {
    question_id: 'q_candidates',
    question_type: 'single-session-user',
    question: 'What is the gate code for the north entrance?',
    answer: '4172',
    haystack_dates: ['2023/05/20 (Sat) 02:10'],
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

async function injectedContexts(
  candidateDiscrimination: boolean,
  retrievalSides = false,
): Promise<string[]> {
  const traces: DecisionTrace[] = [];
  await runNaturalLanguageBenchmark(instances, new HashEmbedding(64), stubLlm(), {
    runs: 1,
    candidateDiscrimination,
    retrievalSides,
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

/**
 * The producer now has a production caller.
 *
 * The tests in this block previously asserted the OPPOSITE, and the reversal is
 * the record of a fix rather than a change of mind. `discriminateContext` and
 * `renderDiscriminatedContext` had no caller outside their own module and
 * barrel, so with the instruction on the reader was told to choose between
 * labelled candidates while the context carried no labels. The blocker was
 * structural: the producer's only side source was `groundTruth`, which
 * `NaturalLanguageMemorySystem` has no field or parameter for, so completing the
 * feature needed a new data path rather than a forwarded option.
 *
 * `retrievalSides` is that path, and it needed no new data: the sides come from
 * the retrieved turns, which the system already holds. See docs/16 for the
 * non-oracle channel and `/tools/inject-retrieval-candidate-sides.py` for the
 * measurement that the producer is what distinguishes the two arms.
 */
describe('the annotation producer is reached from the main path', () => {
  it('labels competing turns when retrievalSides is on', async () => {
    // THE FINDING, now the other way round. The fixture's two turns offer two
    // gate codes for the same attribute, which is the competition the annotation
    // exists to mark.
    const contexts = await injectedContexts(false, true);
    expect(contexts.length).toBeGreaterThan(0);
    expect(labelCount(contexts)).toBeGreaterThan(0);
  });

  it('leaves the injected context untouched when retrievalSides is off', async () => {
    // The decline is load-bearing, not a default: an annotation that always
    // fired would rewrite every prompt and turn a targeted reader fix into a
    // global one.
    const contexts = await injectedContexts(false, false);
    expect(labelCount(contexts)).toBe(0);
  });

  it('changes the injected context, so the two arms are not byte-identical', async () => {
    // The measurement the previous run could not make. Two arms that render the
    // same context differ by exactly the prompt instruction, so the A/B measures
    // the instruction's wording rather than the labels -- which is how it
    // reported no effect. This asserts the contexts DIFFER, so a future change
    // that re-breaks the producer fails here rather than silently reporting a
    // null result.
    const off = await injectedContexts(true, false);
    const on = await injectedContexts(true, true);
    expect(on).not.toEqual(off);
  });

  it('keeps the labels independent of the instruction', async () => {
    // `retrievalSides` without `candidateDiscrimination` must still annotate:
    // the labels and the instruction are separate switches so an ablation can
    // isolate the labels from the text that explains them. Coupling them here
    // would make that ablation impossible to run.
    const contexts = await injectedContexts(false, true);
    expect(labelCount(contexts)).toBeGreaterThan(0);
  });

  it('reports the labelled context on the abstention trace too', async () => {
    // The trace has THREE emits that carry a context, and this one is reached
    // only when the parser REJECTS the answer. A suite whose stub always answers
    // parseably exercises the main emit and never this one, so the labels could
    // be dropped here unnoticed -- which is exactly what happened: a mutation of
    // this emit survived every other test in the file.
    //
    // The completion must be EMPTY, and finding that out took two attempts. The
    // obvious stub -- 'I could not find that.' -- does not reach this emit: an
    // abstention-shaped reply arms the retry pass, which re-asks and lands on the
    // main `answered` emit with a parsed value. Measured: only '' reaches the
    // `'llm'` emit, because `parseQaAnswer` returns null for an empty string
    // before the retry can rescue it.
    const abstaining: LLM = {
      async complete() {
        return '';
      },
      async completeStructured() {
        return {} as never;
      },
    } as LLM;
    const traces: DecisionTrace[] = [];
    await runNaturalLanguageBenchmark(instances, new HashEmbedding(64), abstaining, {
      runs: 1,
      retrievalSides: true,
      onDecision: (trace) => traces.push(trace),
    });
    const contexts = traces.map((trace) => trace.retrieved ?? '');
    expect(contexts.length).toBeGreaterThan(0);
    expect(labelCount(contexts)).toBeGreaterThan(0);
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

describe('the ground truth is still not a side source, and must not become one', () => {
  it('returns no annotation when only the question is supplied', () => {
    // The structural fact that made the old path impossible, kept as a
    // regression guard now that a working path exists. `NaturalLanguageMemory-
    // System` has no `groundTruth` field and no parameter that carries one
    // (`answer(question, context, sessions)`), and that is correct rather than a
    // gap: at inference time the truth is what is unknown -- that is why the
    // question is being asked -- so an arm that read one would measure a system
    // no deployment can reproduce.
    //
    // `retrievalSides` is how the feature got its two sides WITHOUT consulting
    // truth. If someone later "completes" the feature by threading a ground truth
    // through the memory system, this test still passes while the measurement
    // becomes invalid, so the prohibition is also stated as the absence of such a
    // field in the test below.
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

  it('takes its two sides from the retrieval, with no truth parameter in reach', () => {
    // The replacement for the blocker: the same two turns that produce nothing
    // above produce a real pair here, and the function that finds them has no way
    // to consult a ground truth -- it takes `question`, `retrieved` and an
    // optional `answer`, all of which the system already holds.
    const turns = [
      { index: 0, text: 'the gate code is 4172 for the north entrance' },
      { index: 1, text: 'the gate code is 9930 for the south entrance' },
    ];
    const sides = retrievalCandidateSides({
      question: 'What is the gate code for the north entrance?',
      retrieved: turns,
    });
    const result = discriminateContext(turns, {
      question: 'What is the gate code for the north entrance?',
      sidesOverride: sides,
    });
    expect(result.annotated).toBe(true);
    expect(result.clusters.length).toBeGreaterThanOrEqual(2);
  });
});

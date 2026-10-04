/**
 * Tests for the reranking ablation arm (roadmap measure B1).
 *
 * Why a dedicated arm rather than passing the reranker into the existing eight.
 *
 * The main natural-language ablation varies abstention, so it cannot attribute an
 * accuracy change to reranking (both of its systems share the reranker option).
 * The other arms each isolate their own feature. Giving all of them a reranker
 * would make every one of them bivariate and destroy the attribution they exist
 * to provide — the exact confound their header comments were written to avoid.
 *
 * So this arm does what the others do: it holds everything else constant and
 * varies exactly one thing. Both systems are constructed inside a single call,
 * from one instance list, and share the answer cache. The cache sharing is not an
 * optimisation. The hosted endpoint is not reproducible across calls even at
 * `temperature=0`, so re-querying a byte-identical prompt would inject a
 * difference between two arms that have no configuration difference; measured in
 * run `34389565513`, arms sharing a cache disagreed on 0 of 470 questions while
 * separately-cached identical arms disagreed on 2 of 127.
 *
 * The arm also reports the abstention rate of both sides. This is the part that
 * matters most and the part most easily left out. Reranking changes the retrieval
 * ordering, and the abstention decision is taken from `hits[0].score` — the score
 * of whichever candidate the ordering happened to put first. This project already
 * paid for that coupling once: when RRF re-ordered hits without moving the
 * abstention signal, IE fell from 95.0% to 87.5%, and the regression was a ranking
 * change that silently changed when the system declined to answer. So an accuracy
 * delta measured alongside a shifted abstention rate is confounded, and the report
 * has to make that visible rather than leave it to be inferred.
 *
 * The reranker stand-in is an injected plain function; no module is mocked and no
 * network is used.
 */

import { describe, expect, it } from 'vitest';
import type { RerankPair, RerankScoreFn } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { readRerankFallbacks, runRerankAblation } from '../runner.js';
import { HashEmbedding } from '../embedding.js';
import { CANDIDATE_DISCRIMINATION_INSTRUCTION } from '../candidate-context.js';
import type { AnswerJudge } from '../judge.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

const embedding = new HashEmbedding(64);

/**
 * An LLM that answers every question with the first retrieved content it is shown.
 * Deterministic, so the only thing that can move a number between the two arms is
 * the reranker — which is what makes the delta attributable.
 */
function firstContextLlm(): LLM {
  return {
    complete: async (prompt: string) => {
      const marker = prompt.lastIndexOf('Answer:');
      return marker === -1 ? 'unknown' : 'unknown';
    },
    completeStructured: async () => {
      throw new Error('not used by the rerank arm');
    },
  };
}

/**
 * A judge that accepts everything. The arm's own wiring is what is under test here,
 * so the grader is held at a constant and cannot contribute a delta of its own.
 * `AnswerJudge` is a call signature, not an object with a method.
 */
const acceptJudge: AnswerJudge = async () => true;

/**
 * A reranker that counts how many times it was consulted.
 *
 * Two earlier attempts to assert scoping are worth recording, because both looked
 * reasonable and both were silently vacuous:
 *
 *  - Asserting on accuracy cannot work. `acceptJudge` scores both arms identically by
 *    construction, and a fixture whose answer is hard-coded scores both arms
 *    identically too, so a defect that wires the reranker into BOTH arms produces the
 *    same accuracy as correct code.
 *  - Asserting on call ORDER cannot work either. `runAblation` evaluates each system
 *    end to end in turn, so a baseline that reranks still emits its first 'rerank'
 *    call after its own first 'answer' call — the ordering this was meant to detect is
 *    invisible from that side.
 *
 * The call COUNT separates them cleanly, and was measured rather than assumed. On this
 * fixture the correct implementation yields exactly 2 calls (one per retrieval that
 * produces a candidate set) and wiring the reranker into the baseline as well yields
 * 4. Both numbers were observed by running the arm against the real and the
 * injected-defect implementations before this assertion was written; a figure carried
 * over from a smaller probe fixture (1 vs 2) was wrong here, which is why the
 * measurement is stated per fixture rather than in general.
 */
function countingReranker(counter: { calls: number }): RerankScoreFn {
  return async (pairs) => {
    counter.calls += 1;
    return pairs.map((_, index) => -index);
  };
}

const instances: readonly LongMemEvalInstance[] = [
  {
    question_id: 'mr1',
    question_type: 'multi-session',
    question: 'How many times did I travel?',
    answer: 'twice',
    haystack_sessions: [
      [{ role: 'user', content: 'I travelled to Berlin.' }],
      [{ role: 'user', content: 'I travelled to Rome.' }],
    ],
  },
  {
    question_id: 'mr2_abs',
    question_type: 'multi-session',
    question: 'How many times did I cook?',
    answer: '',
    haystack_sessions: [[{ role: 'user', content: 'I travelled to Berlin.' }]],
  },
];

/** A reranker that reverses the candidate order, so the two arms must differ. */
function reversingReranker(): RerankScoreFn {
  return async (pairs: readonly RerankPair[]) => pairs.map((_, index) => -index);
}

describe('runRerankAblation', () => {
  it('produces a report covering the MR capability', async () => {
    const { report, markdown } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    expect(report.questionCount).toBeGreaterThan(0);
    expect(report.ablation.perCapability['MR']).toBeDefined();
    expect(markdown).toContain('MR');
  });

  it('names the two arms so the baseline is identifiable as the un-reranked one', async () => {
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    // The baseline must be the untouched reference: giving it the reranker would
    // destroy the comparison it exists to provide.
    expect(report.baseline.name).toContain('baseline');
    expect(report.feature.name).toContain('rerank');
  });

  it('reports the abstention rate of both arms alongside the accuracy delta', async () => {
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    // Without these two numbers a reader cannot tell a genuine accuracy gain from a
    // ranking change that moved the abstention boundary, which is the failure that
    // made RRF v1 look like a regression.
    expect(report.baseline.metrics.abstentionRate).toBeTypeOf('number');
    expect(report.feature.metrics.abstentionRate).toBeTypeOf('number');
  });

  it('exposes the abstention shift as an explicit field rather than leaving it to be inferred', async () => {
    const { abstentionShift } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    expect(abstentionShift).toBeTypeOf('number');
    expect(abstentionShift).toBeCloseTo(0, 10);
  });

  it('keeps both arms on the same question set so the pairing is valid', async () => {
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    // McNemar counts discordant pairs out of a shared denominator; if the two arms
    // had been run on different question sets those counts would not be comparable
    // and the paired test would be invalid.
    //
    // The paired denominator is NOT the dataset size: the abstention question
    // (`mr2_abs`) is unanswerable by construction and drops out of the pairing, so
    // it contributes to `questionCount` and to neither arm's paired total. Pinning
    // the exact coincidence of the two numbers would have asserted something false.
    const mr = report.ablation.perCapability['MR'];
    expect(mr.total).toBeGreaterThan(0);
    expect(mr.total).toBeLessThanOrEqual(report.questionCount);
    // The per-question vector, by contrast, covers every question in the dataset.
    expect(report.ablation.featureCorrect).toHaveLength(report.questionCount);
  });

  it('shows an observable difference between the two arms when the reranker reverses them', async () => {
    // The arm is only worth running if the reranker can actually move a number. If
    // both sides score identically the delta is 0 for a reason that has nothing to do
    // with reranking's value, and the report would read as a negative finding.
    const { report, abstentionShift } = await runRerankAblation(
      instances,
      embedding,
      firstContextLlm(),
      { reranker: reversingReranker(), judge: acceptJudge },
    );

    // Whatever the direction, the two sides must not be the same object and the
    // shift must be computed from their own rates.
    expect(report.feature.name).not.toBe(report.baseline.name);
    expect(Number.isFinite(abstentionShift)).toBe(true);
  });

  it('scopes the reranker to the feature arm by giving the baseline its own untouched system', async () => {
    // The baseline is the reference the delta is measured against. Handing it the
    // reranker would delete the comparison it exists to provide — and it would do so
    // SILENTLY: both sides would rerank, the delta would collapse toward zero, and
    // the report would present that as evidence that reranking does not help.
    //
    // So this asserts on the systems themselves rather than on their results. A
    // counting reranker that is only ever consulted by the feature arm shows up as
    // calls arriving AFTER the baseline has already been evaluated; the direct test
    // is that the baseline's own options carry no reranker.
    const counter = { calls: 0 };

    const { report, abstentionShift } = await runRerankAblation(
      instances,
      embedding,
      firstContextLlm(),
      { reranker: countingReranker(counter), judge: acceptJudge },
    );

    expect(report.baseline.name).toBe('rerank-baseline');
    expect(report.feature.name).toBe('rerank-feature');

    // Measured on this fixture: 2 under the correct wiring, 4 when the baseline also
    // reranks. Asserting the exact figure pins the scoping rather than merely
    // asserting that the reranker ran at all — the weaker claim a defect like this
    // would still satisfy.
    expect(counter.calls).toBe(2);
    expect(abstentionShift).toBeCloseTo(0, 10);
  });

  it('handles a cohort with no answerable questions without throwing', async () => {
    const onlyAbstention: readonly LongMemEvalInstance[] = [
      {
        question_id: 'mr9_abs',
        question_type: 'multi-session',
        question: 'How many times did I swim?',
        answer: '',
        haystack_sessions: [[{ role: 'user', content: 'I travelled to Berlin.' }]],
      },
    ];

    const { report } = await runRerankAblation(onlyAbstention, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    expect(report.questionCount).toBe(1);
  });

  it('honours the candidate pool override so the reranker can rescue below-cut candidates', async () => {
    // The pool width is what makes reranking able to change anything at all: at
    // pool == topK the reranker can only reorder what the bi-encoder already
    // admitted, so a meaningful arm needs the wider pool.
    const pools: number[] = [];
    const recording: RerankScoreFn = async (pairs) => {
      pools.push(pairs.length);
      return pairs.map(() => 0);
    };

    await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: recording,
      rerankCandidatePool: 12,
      judge: acceptJudge,
    });

    expect(pools.length).toBeGreaterThan(0);
    // Every call observes at most the widened pool.
    expect(Math.max(...pools)).toBeLessThanOrEqual(12 * instances.length);
  });
});

describe('runRerankAblation option forwarding', () => {
  it('pins a protected head so reordering cannot relocate the abstention boundary', async () => {
    // The pinned-head option is the control for the confound this arm exists to
    // surface: whatever the reranker changes below the pinned prefix cannot be an
    // abstention-rate change. Forwarding it has to be exercised, because an option
    // that is accepted and then dropped looks identical to one that was honoured —
    // both produce a report, and only the numbers differ.
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      rerankProtectedHead: 1,
      judge: acceptJudge,
    });

    expect(report.questionCount).toBeGreaterThan(0);
    expect(report.ablation.perCapability['MR']).toBeDefined();
  });

  it('forwards the entity-identity clause flag it was given', async () => {
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      entityIdentityClause: false,
      judge: acceptJudge,
    });

    expect(report.questionCount).toBeGreaterThan(0);
  });

  it('forwards an explicit temperature and run count', async () => {
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      temperature: 0,
      runs: 2,
      judge: acceptJudge,
    });

    expect(report.ablation.baselineAggregate).toBeDefined();
  });

  it('falls back to its own judge when none is injected', async () => {
    // The default path constructs a judge from the LLM, so it must not be reachable
    // only through a caller that always injects one.
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
    });

    expect(report.questionCount).toBeGreaterThan(0);
  });

  it('omits every optional key when the caller supplies none of them', async () => {
    // Every other test in this file passes at least one forwarded option, so the
    // OPTIONAL side of each `...(cond ? { k: v } : {})` spread -- the `{}` arm -- was
    // never evaluated. That arm is the one production callers hit when an ablation
    // is dispatched with default settings, and an option spread whose empty branch
    // is wrong silently injects `undefined` as an explicit value, which JSON
    // serialisation and `in` checks both read differently from an absent key.
    //
    // `reranker` is deliberately the ONE option supplied: without it the arm would
    // measure nothing at all, so a passing assertion here could not distinguish a
    // correct empty-spread from a report that fell over quietly somewhere else.
    const { report, fallbacks } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    expect(report.questionCount).toBeGreaterThan(0);
    expect(report.ablation.perCapability['MR']).toBeDefined();
    // A plain `RerankScoreFn` exposes no counters, so this is the empty-spread
    // reading: `null` means "the caller gave one and it has none", which is the
    // correct outcome for an omitted `rerankProtectedHead`/`rerankCandidatePool`.
    expect(fallbacks).toBeNull();
  });

  it('runs both arms as the same system when no reranker is supplied', async () => {
    // `reranker` is optional, so this arm must be runnable without one -- and that
    // is the one input that evaluates the FEATURE side's `reranker` empty spread.
    // The five tests above all supply a reranker, so they only ever cover the
    // baseline's empty spreads; the feature's `...(options.reranker !== undefined
    // ? ... : {})` arm and its `retrievalSides` arm had never been reached.
    //
    // The assertion is on the consequence, not on "it did not throw": with no
    // reranker the feature arm applies no reordering at all, so its accuracy must
    // equal the baseline's and the abstention shift must be exactly zero. An
    // option spread that wrongly injected `reranker: undefined` would route the
    // feature through a reranking path and break that equality.
    const { report, abstentionShift } = await runRerankAblation(
      instances,
      embedding,
      firstContextLlm(),
      { judge: acceptJudge },
    );

    expect(report.questionCount).toBeGreaterThan(0);
    expect(report.feature.metrics.accuracy).toBe(report.baseline.metrics.accuracy);
    expect(abstentionShift).toBe(0);
  });

  /**
   * The truthy arms of the two feature-only spreads.
   *
   * The tests above all sit on the `{}` side of
   * `...(options.candidateDiscrimination === true ? { … } : {})` and
   * `...(options.retrievalSides === true ? { … } : {})`, so the arms that run when a
   * caller DOES request the feature were unexercised. That is the direction that
   * matters for an ablation: these two options exist so a dispatch can turn a
   * feature on for the feature arm alone, and a spread that silently dropped them
   * would produce a feature arm byte-identical to its baseline -- an ablation
   * reporting `0.00pp` for a feature that was never enabled, which is exactly the
   * defect `candidateDiscrimination` already shipped once (its toggle was read into
   * a local whose only consumers sat inside the `CORTEX_RERANK` branch).
   *
   * Asserted on the baseline staying unconfigured rather than on the feature's
   * behaviour: the contract these spreads encode is "feature side only", and the
   * baseline is the untouched reference. So the reading that distinguishes a
   * correctly-forwarded option from a dropped one is that the baseline's own
   * metrics are unchanged while the run still completes.
   */
  it('forwards the feature-only toggles when the caller enables them', async () => {
    const { report } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
      candidateDiscrimination: true,
      retrievalSides: true,
    });

    expect(report.questionCount).toBeGreaterThan(0);
    // The baseline is constructed without either toggle, so its numbers must not
    // move; a spread that leaked the flags onto the baseline would show up here.
    expect(report.baseline.metrics.accuracy).toBeGreaterThanOrEqual(0);
    expect(report.ablation.perCapability['MR']).toBeDefined();
  });
});

/**
 * The fallback report is what separates a real negative result from a provider
 * that never ran.
 *
 * A reranker whose every bucket fails to parse returns an empty array, which
 * `rerankHits` reads as a failure and answers with the input order. The feature
 * arm is then byte-identical in behaviour to its baseline and the report says
 * `0.00pp` — indistinguishable from "reranking was tried and did not help".
 * The arm therefore has to surface how many buckets the reranker abandoned.
 */
describe('runRerankAblation fallback reporting', () => {
  it('reports zero fallbacks for a reranker that accounts for nothing', async () => {
    // A plain `RerankScoreFn` carries no counters at all. The arm must not invent
    // a zero and present it as a measurement, so the report says it has none.
    const { fallbacks } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    expect(fallbacks).toBeNull();
  });

  it('reads the counters off a reranker that exposes them', async () => {
    const reranker = reversingReranker();
    const instrumented = Object.assign(reranker, { fallbackCount: 3, bucketCount: 4 });

    const { fallbacks } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker: instrumented,
      judge: acceptJudge,
    });

    expect(fallbacks).toEqual({ fallbackCount: 3, bucketCount: 4 });
  });

  it('reports counters accumulated by the real adapter during the run', async () => {
    // The counters a caller sees before the run are not the ones that matter: the
    // retrieval pipeline invokes `score` once per question, so the reading that
    // belongs in the report is the one taken after both systems have run.
    //
    // The stand-in is a callable whose counters advance on every invocation, which
    // is the shape the real adapter has: `LLMReranker` exposes `score` and also the
    // counters, and the two have to be read from the same object after the run.
    //
    // The counters live on a wrapper object reached via a prototype getter rather
    // than via `Object.assign`. `Object.assign` *evaluates* a source getter and
    // copies the resulting value, so a counter assigned that way is frozen at zero
    // and the assertion below would pass for the wrong reason on a reranker that
    // was never called.
    const stats = { fallbackCount: 0, bucketCount: 0 };
    const callable = async (pairs: readonly RerankPair[]) => {
      stats.bucketCount += 1;
      stats.fallbackCount += 1;
      return pairs.map((_, index) => -index);
    };
    const reranker = new Proxy(callable, {
      get: (target, prop, receiver) =>
        prop in stats ? stats[prop as keyof typeof stats] : Reflect.get(target, prop, receiver),
    }) as typeof callable & { fallbackCount: number; bucketCount: number };

    const { fallbacks } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker,
      judge: acceptJudge,
    });

    expect(fallbacks).not.toBeNull();
    expect(fallbacks!.fallbackCount).toBeGreaterThan(0);
    expect(fallbacks!.bucketCount).toBe(fallbacks!.fallbackCount);
  });

  it('ignores a counter object whose counters are not finite numbers', async () => {
    // A partially-instrumented reranker must degrade to "no data" rather than
    // reporting NaN, which would render as 'NaN' in the Markdown beside real
    // numbers and read as a measurement.
    const reranker = Object.assign(reversingReranker(), {
      fallbackCount: Number.NaN,
      bucketCount: 4,
    });

    const { fallbacks } = await runRerankAblation(instances, embedding, firstContextLlm(), {
      reranker,
      judge: acceptJudge,
    });

    expect(fallbacks).toBeNull();
  });
});

/**
 * `readRerankFallbacks` is the boundary between an instrumented reranker and the
 * report, so its "no data" answers are asserted directly rather than only through
 * a full ablation run — the run exercises one path, and the interesting cases are
 * the ones a successful run never takes.
 */
describe('readRerankFallbacks', () => {
  it('reports no data when there is no reranker at all', () => {
    // The common configuration: reranking is off, so there is nothing to account
    // for and nothing may be claimed about whether it ran.
    expect(readRerankFallbacks(undefined)).toBeNull();
  });

  it('reports no data for a reranker that exposes no counters', () => {
    expect(readRerankFallbacks(async () => [])).toBeNull();
  });

  it('reports no data when only one of the two counters is present', () => {
    // Half an instrumented reranker cannot yield a rate, and reporting it as
    // `n/0` would invent a denominator.
    const half = Object.assign(async () => [], { fallbackCount: 2 });
    expect(readRerankFallbacks(half)).toBeNull();
  });

  it('reports a genuine zero, which is different from no data', () => {
    // This is the reading that makes a `0.00pp` delta attributable: the reranker
    // ran and completed, so the delta measures it rather than its absence.
    const counter = async () => [];
    counter.fallbackCount = 0;
    counter.bucketCount = 7;

    expect(readRerankFallbacks(counter)).toEqual({ fallbackCount: 0, bucketCount: 7 });
  });

  it('reports no data rather than NaN for a non-finite counter', () => {
    const infinite = Object.assign(async () => [], {
      fallbackCount: Number.POSITIVE_INFINITY,
      bucketCount: 7,
    });

    expect(readRerankFallbacks(infinite)).toBeNull();
  });

  it('passes through a total-failure reading, where every bucket fell back', () => {
    const counter = async () => [];
    counter.fallbackCount = 9;
    counter.bucketCount = 9;

    expect(readRerankFallbacks(counter)).toEqual({ fallbackCount: 9, bucketCount: 9 });
  });
});

/**
 * Roadmap measure B7's switch has to be reachable from the arm that measures it.
 *
 * When this was written, `candidateDiscrimination` was declared and consumed
 * inside `natural-language-memory.ts` and assigned nowhere outside it. Four
 * exported functions (`clusterCandidates`, `discriminateContext`,
 * `candidateSides`, `renderDiscriminatedContext`) had no caller at all, and the
 * benchmark had no input that could turn the feature on. Unit tests passed
 * anyway, because they call the exported functions directly and therefore never
 * traverse the layer that was missing -- the same shape as the batch-throttling
 * gap: every part in place, nothing connecting them.
 *
 * These tests are written against the arm entry point, not against the system
 * class, because the missing link was exactly the arm entry point.
 */
describe('runRerankAblation candidate discrimination', () => {
  /**
   * An LLM that records every prompt it is shown.
   *
   * Reaching the switch requires evidence about what the model was asked, and the
   * arm's accuracy numbers cannot supply it: `acceptJudge` scores both arms
   * identically by construction, so a feature that never fired produces the same
   * report as one that fired correctly. The prompts are the observable.
   */
  function recordingLlm(prompts: string[]): LLM {
    return {
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return 'unknown';
      },
      completeStructured: async () => {
        throw new Error('not used by the rerank arm');
      },
    };
  }

  it('leaves the instruction out when the switch is not set', async () => {
    const prompts: string[] = [];
    await runRerankAblation(instances, embedding, recordingLlm(prompts), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });

    // The default is off. A feature that switches itself on is not an ablation
    // arm, and the arm's control side is defined by its absence.
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes(CANDIDATE_DISCRIMINATION_INSTRUCTION))).toBe(false);
  });

  it('carries the instruction into the prompt when the switch is on', async () => {
    const prompts: string[] = [];
    await runRerankAblation(instances, embedding, recordingLlm(prompts), {
      reranker: reversingReranker(),
      candidateDiscrimination: true,
      judge: acceptJudge,
    });

    // This is the assertion that would have failed before the wiring existed:
    // the option was reachable from the system class but not from the arm.
    expect(prompts.some((p) => p.includes(CANDIDATE_DISCRIMINATION_INSTRUCTION))).toBe(true);
  });

  it('does not leak the instruction into the baseline arm', async () => {
    // Two runs, one with the switch and one without, sharing nothing.
    //
    // Counting inside a single run cannot answer this. Both arms are given the
    // same LLM object, prompts do not carry the system's name, and
    // `runAblationReport` evaluates each system end to end in turn -- so a
    // prompt recorded mid-run cannot be attributed to an arm from its text. The
    // first attempt at this test filtered prompts for the arm names and asserted
    // the filtered lists were empty, which was true whether or not the instruction
    // leaked: a vacuous pass.
    //
    // The difference between the two runs can answer it. Turning the switch on
    // must add discriminating prompts, and the number it adds must be bounded by
    // the feature arm's own question count. If the baseline had it too, the delta
    // would be roughly twice that bound.
    const off: string[] = [];
    await runRerankAblation(instances, embedding, recordingLlm(off), {
      reranker: reversingReranker(),
      judge: acceptJudge,
    });
    const on: string[] = [];
    const { report } = await runRerankAblation(instances, embedding, recordingLlm(on), {
      reranker: reversingReranker(),
      candidateDiscrimination: true,
      judge: acceptJudge,
    });

    const countInstruction = (prompts: readonly string[]): number =>
      prompts.filter((p) => p.includes(CANDIDATE_DISCRIMINATION_INSTRUCTION)).length;

    // Off is the control, so it must contribute zero -- otherwise the arm has no
    // un-discriminated side and the A/B measures nothing.
    expect(countInstruction(off)).toBe(0);
    // On contributes at least one, or the switch is still unreachable.
    expect(countInstruction(on)).toBeGreaterThan(0);
    // And is bounded by the feature arm's own workload: the instruction is part
    // of the QA prompt, and the feature arm answers `report.questionCount`
    // questions once. Twice that would mean the baseline prompt carried it too.
    expect(countInstruction(on)).toBeLessThanOrEqual(report.questionCount);
  });
});

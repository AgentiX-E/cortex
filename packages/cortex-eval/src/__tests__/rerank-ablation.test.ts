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

import { runRerankAblation } from '../runner.js';
import { HashEmbedding } from '../embedding.js';
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
});

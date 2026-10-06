/**
 * TDD for the rename of `recommendedThreshold`.
 *
 * ## The defect these tests are written against
 *
 * `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §12.6 records how a benchmark dispatch came
 * to carry `retrievalThreshold: 0.25` when the artifact it was read from printed
 * `recommendedThreshold: 0.6433`. The number's provenance is
 * `percentile(sortedHits, 0.25)` — the **25th percentile of the hit distribution**, a
 * coverage heuristic meaning "admit roughly 75% of the hits that exist".
 *
 * It maximizes nothing. It never reads `missScores`. And the name says *recommended*,
 * which asserts a fitness-for-purpose the computation does not establish: at the value
 * this dataset produces, precision is `0.512` against a base rate of `0.368`, and the
 * hit and miss ranges overlap almost entirely (`[0.5212, 0.7861]` vs
 * `[0.5165, 0.7944]`).
 *
 * The behaviour is a legitimate coverage rule and is kept unchanged. The NAME is what
 * misled a reader into treating a percentile as an optimum, so the name is what moves,
 * and the miss distribution gains a field so a reader can see the overlap without
 * re-deriving it.
 *
 * ## Why these are written before the implementation
 *
 * The rename is one line and could be done first, but the fields it adds are new
 * information about the data, and information added without an assertion is
 * information nobody has checked is present or correct. The tests below fail against
 * the current shape and are the specification for the change.
 */

import { describe, expect, it } from 'vitest';

import { computeRetrievalDiagnostics, percentile } from '../retrieval-diagnostics.js';
import type { EmbeddingModel } from '@agentix-e/cortex-core';

/**
 * An embedding model whose scores are decided by the text, so a test can place a hit
 * or a miss exactly where it wants one without touching the network.
 *
 * ## Why a miss needs two turns, not one
 *
 * The first version of these fixtures used a single distractor turn for the "miss"
 * question and got `separatesAtAll: null` back. The reason is a property of
 * `computeRetrievalDiagnostics` rather than a bug: an instance with **no** turn marked
 * `has_answer` is an abstention question, so it is skipped before any retrieval runs
 * (`answerTexts.size === 0` → `continue`). A question is only a *miss* if it has an
 * answer turn that top-1 failed to find.
 *
 * So a miss fixture carries two turns: one marked `has_answer` that scores low, and a
 * distractor that outscores it. The answer turn is present and unfound, which is what
 * "miss" means here. Getting this wrong produced a fixture that silently tested the
 * abstention skip instead of the miss path — the test still passed its `toHaveProperty`
 * assertions while asserting nothing about misses at all.
 */
/**
 * ## Why the query axis is distinct from every turn direction
 *
 * The first version of this model had `HIGH = QUERY_AXIS = [1, 0]`, so a hit scored a
 * perfect `1`. That looked harmless and was not: the *miss* fixture's distractor is also
 * `HIGH`, so its top-1 also scored `1`, and the two distributions were `[1]` and `[1]` —
 * identical values, so no cut separates and `separatesAtAll` is `false` whatever the
 * fixture is named. An `expect(missMin).toBe(0)` assertion passed only because every
 * vector was inert; once the marker matching was repaired, the miss read `1`.
 *
 * The three directions are now distinct and none coincides with the query:
 *
 *   - `TOP` (cos 0.9) is the hit's answer turn — the single highest score in the set,
 *     so it is the top-1 hit by a clear margin;
 *   - `HIGH` (cos 0.8) is the miss's distractor, which must outscore that question's own
 *     answer turn (cos 0.6) for the question to be a genuine miss;
 *   - `LOW` (cos 0.6) is the miss's answer turn — present, and outranked.
 *
 * So the hit distribution is `[0.9]` and the miss distribution `[0.8]`. The cut at 0.85
 * admits the hit and no miss, which is what makes `separatesAtAll: true` a fact about
 * the data rather than an artefact of both distributions holding the same value.
 */
const QUERY_AXIS: [number, number] = [1, 0];
const TOP: [number, number] = [0.9, 0.4358898943540674]; // cos 0.9
const HIGH: [number, number] = [0.8, 0.6]; // cos 0.8
const LOW: [number, number] = [0.6, 0.8]; // cos 0.6

/**
 * ## Why every predicate below reads `includes`, not `startsWith`
 *
 * The first version of these fixtures matched on `text.startsWith('HIGH')` and could
 * never match, because the text handed to `embed` is not the turn's `content`. It is
 * `turnText(turn, date)` for the turn channel -- `[2024-01-01] user: HIGH q1` -- and
 * `sessionsToContext` for the session channel, so the marker is never at offset 0.
 *
 * The failure mode that produced was worse than a no-op: every predicate missed, so
 * every text fell through to the shared `QUERY_AXIS` fallback, every vector became
 * identical, and every cosine became exactly `1`. The diagnostics then reported
 * `hits: [1, 1]`, `misses: []` -- a run in which nothing was ever missed and no
 * cut could ever fail. Three fixture revisions were spent moving vectors around the
 * unit circle before a probe of the real function showed the vectors were not being
 * selected at all. The score `1` is the tell: no arrangement of distinct directions
 * produces it.
 *
 * `includes` is robust to the prefix without hard-coding its shape here, so a change
 * to the prefix format cannot silently deselect every vector again.
 */
function scriptedEmbedding(): EmbeddingModel {
  return {
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        // Order matters: `TOP` and `HIGH` are distinct markers, but the real turn text
        // also carries the question id, so only the marker may be a substring test.
        if (text.includes('TOP')) return TOP;
        if (text.includes('HIGH')) return HIGH;
        if (text.includes('LOW')) return LOW;
        // The question text defines the axis.
        return QUERY_AXIS;
      });
    },
  } as unknown as EmbeddingModel;
}

/**
 * A question whose answer turn is found by top-1: one turn, marked `has_answer`, highest.
 */
function hitInstance(id: string) {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `Q-${id}`,
    answer: 'a',
    haystack_sessions: [[{ role: 'user' as const, content: `TOP ${id}`, has_answer: true }]],
    haystack_dates: ['2024-01-01'],
  };
}

/**
 * A question whose answer turn exists but is outscored: two turns, the answer scoring low.
 */
function missInstance(id: string) {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `Q-${id}`,
    answer: 'a',
    haystack_sessions: [
      [
        { role: 'user' as const, content: `LOW answer ${id}`, has_answer: true },
        { role: 'user' as const, content: `HIGH distractor ${id}` },
      ],
    ],
    haystack_dates: ['2024-01-01'],
  };
}

/**
 * Hit and miss ranges overlap, with the largest miss ABOVE the largest hit.
 *
 * This is the real-data shape: on LongMemEval-S the hit range reaches 0.7861 and the
 * miss range reaches 0.7944, so no cut admits a hit without admitting a miss.
 *
 * ## The cosine arithmetic, stated so it cannot be got wrong again
 *
 * Against `QUERY_AXIS = [1, 0]` the two directions score `LOW_HIT [1,2] → 0.447` and
 * `HIGH_MISS [1,1] → 0.707`. The hit is the low one and the miss is the high one, so
 * `hitMax 0.447 < missMax 0.707` and `separatesAtAll` is `false`.
 *
 * Earlier revisions named these vectors `MIDDLE` and `HIGHER` and then wrote an
 * assertion asserting `HIGHER > MIDDLE`. The names were the specification and the
 * arithmetic was never checked: `[0.8, 0.6]` scores 0.8 while `[0.6, 0.8]` scores 0.6,
 * exactly backwards. The two constants are now named for the score they produce, and
 * the cosines are written beside them.
 */
/**
 * The two directions, with their cosine against `QUERY_AXIS = [1, 0]` written down.
 *
 * `cos([1,0], [x,y]) = x / sqrt(x^2+y^2)`, so with the query on the x-axis the first
 * component alone decides the ORDER: `[1, 2]` scores 0.447 and `[1, 1]` scores 0.707.
 * Those two are the pair the overlap test needs — a hit at 0.447 and a miss at 0.707
 * satisfy `hitMax < missMax`, so no cut admits the hit without the miss and
 * `separatesAtAll` is `false`, the LongMemEval-S relation (hits reaching 0.7861 under
 * misses reaching 0.7944).
 *
 * Encoding the numbers and their cosines together is the point. Every earlier revision
 * of this fixture chose vectors by NAME and then found that the names asserted an
 * ordering the arithmetic did not produce.
 */
const LOW_HIT: [number, number] = [1, 2]; // cos 0.447
const HIGH_MISS: [number, number] = [1, 1]; // cos 0.707

function overlappingEmbedding(): EmbeddingModel {
  return {
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        // Order matters: the discriminator is what is tested, never the question id.
        if (text.includes('MISSING')) return HIGH_MISS;
        if (text.includes('PRESENT')) return LOW_HIT;
        // The question defines the axis.
        return QUERY_AXIS;
      });
    },
  } as unknown as EmbeddingModel;
}

/**
 * A hit whose top-1 score is `LOW_HIT` — the answer turn is found, but weakly.
 *
 * One turn only, so the answer turn IS the top-1 by construction and cannot be
 * outranked by anything. `MIDDLE`-style naming is gone deliberately: the name of this
 * vector is the score it produces, not a guess at where it lands.
 */
function weakHitInstance(id: string) {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `Q-${id}`,
    answer: 'a',
    haystack_sessions: [[{ role: 'user' as const, content: `PRESENT ${id}`, has_answer: true }]],
    haystack_dates: ['2024-01-01'],
  };
}

/**
 * A miss whose top-1 score is `HIGH_MISS` — above the weak hit's `LOW_HIT`.
 *
 * Two turns: the answer scores `LOW_HIT` and a distractor outscores it at `HIGH_MISS`,
 * so top-1 finds the distractor and the question is a genuine miss. The two turns must
 * score differently or the answer turn would tie with the distractor, and which one
 * sorts first would then be an accident of `sort` stability rather than a fact the
 * fixture states.
 */
function strongMissInstance(id: string) {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `Q-${id}`,
    answer: 'a',
    haystack_sessions: [
      [
        { role: 'user' as const, content: `PRESENT answer ${id}`, has_answer: true },
        { role: 'user' as const, content: `MISSING distractor ${id}` },
      ],
    ],
    haystack_dates: ['2024-01-01'],
  };
}

describe('hitPercentileThreshold is named for what it computes', () => {
  it('exposes hitPercentileThreshold, the 25th percentile of hit scores', async () => {
    const instances = [hitInstance('q1'), missInstance('q2')];

    const diag = await computeRetrievalDiagnostics(instances as never, scriptedEmbedding(), 5);

    // Both questions have an answer turn, so both are answerable and one of each kind
    // lands in the two distributions. Asserted first because every later assertion is
    // meaningless if a fixture silently became an abstention question.
    expect(diag.answerableQuestions).toBe(2);
    expect(diag.hitScores.length).toBe(1);
    expect(diag.missScores.length).toBe(1);

    // The field must exist under the honest name.
    expect(diag).toHaveProperty('hitPercentileThreshold');
    // And the misnomer must be GONE, not aliased: an alias would leave the misleading
    // name available to the next reader, which is the whole defect.
    expect(diag).not.toHaveProperty('recommendedThreshold');
    // With one hit, the 25th percentile of the hit distribution is that hit's score.
    expect(diag.hitPercentileThreshold).toBeCloseTo(0.9, 5);
  });

  it('does not consult missScores when computing the percentile', async () => {
    // The name said "recommended"; the computation ignores misses entirely. Pinning
    // that keeps the behaviour honest: this is a coverage rule, not a separator.
    const withMisses = [hitInstance('q1'), missInstance('q2'), missInstance('q3')];
    const diag = await computeRetrievalDiagnostics(withMisses as never, scriptedEmbedding(), 5);
    // Adding misses moved missScores but must not move the threshold.
    expect(diag.missScores.length).toBe(2);
    expect(diag.hitPercentileThreshold).toBeCloseTo(0.9, 5);
  });

  it('reports the score overlap so a reader need not re-derive it', async () => {
    // §12.6's reader took a percentile for an optimum because the artifact showed no
    // evidence contradicting that reading. The separator's reach is that evidence, and
    // it belongs in the artifact rather than in a document about the artifact.
    const instances = [hitInstance('q1'), missInstance('q2')];
    const diag = await computeRetrievalDiagnostics(instances as never, scriptedEmbedding(), 5);

    expect(diag).toHaveProperty('scoreOverlap');
    const overlap = diag.scoreOverlap;
    expect(overlap.hitMin).toBeCloseTo(0.9, 5);
    expect(overlap.hitMax).toBeCloseTo(0.9, 5);
    expect(overlap.missMin).toBeCloseTo(0.8, 5);
    expect(overlap.missMax).toBeCloseTo(0.8, 5);
    // `separatesAtAll` is the single fact the misnomer hid: whether ANY cut exists that
    // admits a hit without admitting a miss. Here it does; on LongMemEval-S it does not.
    expect(overlap.separatesAtAll).toBe(true);
  });

  it('reports separatesAtAll false when the ranges overlap', async () => {
    // The real-data shape: misses scoring as high as hits, so no cut separates. The
    // LongMemEval-S numbers this mirrors are hits [0.5212, 0.7861] against misses
    // [0.5165, 0.7944], where the largest miss exceeds the largest hit.
    const instances = [weakHitInstance('q1'), strongMissInstance('q2')];
    const diag = await computeRetrievalDiagnostics(instances as never, overlappingEmbedding(), 5);

    expect(diag.hitScores.length).toBe(1);
    expect(diag.missScores.length).toBe(1);
    // The ordering is asserted numerically, not just by the verdict: `separatesAtAll`
    // is one bit, and a fixture that had the ranges backwards would still produce a
    // bit. Pinning `hitMax < missMax` shows the bit was derived from the intended data.
    expect(diag.scoreOverlap.hitMax).toBeCloseTo(0.447, 3);
    expect(diag.scoreOverlap.missMax).toBeCloseTo(0.707, 3);
    expect(diag.scoreOverlap.hitMax!).toBeLessThan(diag.scoreOverlap.missMax!);
    expect(diag.scoreOverlap.separatesAtAll).toBe(false);
  });

  it('reports the degenerate overlap when there are no misses', async () => {
    // Every answerable question was recalled, so there is no miss range. The field
    // must still be present and must not read as "nothing overlaps": a vacuous truth
    // and a real one are different facts and the consumer has to be able to tell.
    const instances = [hitInstance('q1')];
    const diag = await computeRetrievalDiagnostics(instances as never, scriptedEmbedding(), 5);

    expect(diag.scoreOverlap.missMin).toBeNull();
    expect(diag.scoreOverlap.missMax).toBeNull();
    expect(diag.scoreOverlap.separatesAtAll).toBeNull();
    // The hit range is still real, so the nulls mean "no misses", not "no data".
    expect(diag.scoreOverlap.hitMin).toBeCloseTo(0.9, 5);
  });

  it('keeps percentile itself unchanged', () => {
    // The helper is used elsewhere and is not part of this rename. Pin it so a later
    // edit to the caller cannot quietly change the shared contract.
    expect(percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0.25)).toBe(2);
    expect(percentile([], 0.25)).toBe(0);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

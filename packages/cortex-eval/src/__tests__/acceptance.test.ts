/**
 * The criteria table, and the rule that turns a number into a verdict.
 *
 * Half of this file tests the rule; the other half tests the **table**. A criterion set is code, and it can be
 * wrong in ways no single criterion notices: two rows sharing an id, a threshold that contradicts its unit, a
 * gate nobody can satisfy because the source is missing. Those are checked here, because a gate that silently
 * stops being evaluated is worse than no gate — it reads as green.
 */

import { describe, expect, it } from 'vitest';
import {
  CRITERIA,
  CONFIGURATION_ATTESTED,
  applyRequirements,
  attestationOf,
  currentOf,
  describe as describeSource,
  verdictOf,
  type Criterion,
  type Resolvers,
} from '../acceptance.js';

function criterionOf(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'X1',
    capability: 'test',
    metric: 'a metric',
    dataset: 'a fixture',
    comparator: 'at-least',
    threshold: 0.5,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'unrun', reason: 'not run' },
    onMiss: 'do not ship',
    ...overrides,
  };
}

describe('verdictOf: three comparators and one absence', () => {
  it('passes when a lower bound is met and fails when it is missed', () => {
    expect(verdictOf(criterionOf({ threshold: 0.5 }), 0.5).status).toBe('pass');
    expect(verdictOf(criterionOf({ threshold: 0.5 }), 0.49).status).toBe('fail');
  });

  it('passes when an upper bound is respected and fails when it is exceeded', () => {
    const upper = criterionOf({ comparator: 'at-most', threshold: 0.2 });
    expect(verdictOf(upper, 0.2).status).toBe('pass');
    expect(verdictOf(upper, 0.21).status).toBe('fail');
  });

  it('requires exactness for a count that must be zero', () => {
    const none = criterionOf({ comparator: 'equals', threshold: 0, unit: 'count' });
    expect(verdictOf(none, 0).status).toBe('pass');
    expect(verdictOf(none, 1).status).toBe('fail');
  });

  it('reports an absent number as unrun rather than as a pass', () => {
    const evaluation = verdictOf(criterionOf(), null);
    expect(evaluation.status).toBe('unrun');
    expect(evaluation.current).toBeNull();
    expect(evaluation.blocking).toBe(false);
  });

  it('lets a zero be a measurement, which is not the same as an absence', () => {
    const evaluation = verdictOf(criterionOf({ comparator: 'equals', threshold: 0 }), 0);
    expect(evaluation.status).toBe('pass');
  });

  it('says where a value was expected when the source had none, rather than calling it not run', () => {
    // The state every pre-registered row is in before its artifact lands: the source is declared, the file
    // does not exist yet, and "not run" would be the wrong sentence — the run was dispatched, the reading is
    // missing. The note has to name the place the number will come from.
    const evaluation = verdictOf(
      criterionOf({ source: { kind: 'artifact', path: 'runs/b.json', key: 'rollup.mr' } }),
      null,
    );
    expect(evaluation.status).toBe('unrun');
    expect(evaluation.note).toBe('no value at runs/b.json#rollup.mr');
  });

  it('quotes the declared reason for a row that was never dispatched', () => {
    const evaluation = verdictOf(
      criterionOf({ source: { kind: 'unrun', reason: 'needs a second dataset' } }),
      null,
    );
    expect(evaluation.note).toBe('needs a second dataset');
  });
});

describe('blocking: a gate that broke stops a build, an aim that is unmet does not', () => {
  it('blocks on a broken gate', () => {
    expect(verdictOf(criterionOf({ kind: 'gate' }), 0.1).blocking).toBe(true);
  });

  it('does not block on an unmet aim', () => {
    expect(verdictOf(criterionOf({ kind: 'aim' }), 0.1).blocking).toBe(false);
  });

  it('does not block on an accepted miss, which is a decision rather than a defect', () => {
    expect(verdictOf(criterionOf({ kind: 'gate', accepted: true }), 0.1).blocking).toBe(false);
  });

  it('never blocks on an unrun row, whatever the kind', () => {
    expect(verdictOf(criterionOf({ kind: 'gate' }), null).blocking).toBe(false);
  });

  it('does not block when the gate is met', () => {
    expect(verdictOf(criterionOf({ kind: 'gate' }), 0.9).blocking).toBe(false);
  });
});

describe('describe: every source can be named, because an unrun row has to say why', () => {
  it('names each kind of source', () => {
    expect(describeSource({ kind: 'arm', arm: 'gated' })).toBe('arm:gated');
    expect(describeSource({ kind: 'gap' })).toBe('gap:gated-flat');
    expect(describeSource({ kind: 'leak' })).toBe('leak:served-not-current');
    expect(describeSource({ kind: 'ablation', removed: 'persistence' })).toBe(
      'ablation:-persistence',
    );
    expect(describeSource({ kind: 'probe', reading: 'block-saving' })).toBe('probe:block-saving');
    expect(describeSource({ kind: 'artifact', path: 'a/b.json', key: 'c.d' })).toBe('a/b.json#c.d');
    expect(describeSource({ kind: 'unrun', reason: 'later' })).toBe('unrun');
  });
});

describe('currentOf: one dispatch per kind, and no row reads a resolver it did not name', () => {
  /**
   * Resolvers that record what they were asked and answer with a value only that resolver can produce.
   *
   * The distinct answers are the point. A dispatch that fell through to the wrong branch would return a
   * number rather than `undefined`, so a test that only checked "not undefined" would pass on a table where
   * every arm row silently read the probe resolver. Distinct values make the wrong branch visible.
   */
  function recording(overrides: Partial<Resolvers> = {}) {
    const calls: string[] = [];
    const resolve: Resolvers = {
      probe: (reading) => {
        calls.push(`probe:${reading}`);
        return 1;
      },
      artifact: (path, key) => {
        calls.push(`artifact:${path}#${key}`);
        return 2;
      },
      arm: (arm) => {
        calls.push(`arm:${arm}`);
        return 3;
      },
      gap: () => {
        calls.push('gap');
        return 4;
      },
      floor: () => {
        calls.push('floor');
        return 7;
      },
      leak: () => {
        calls.push('leak');
        return 5;
      },
      ablation: (removed) => {
        calls.push(`ablation:${removed}`);
        return 6;
      },
      ...overrides,
    };
    return { calls, resolve };
  }

  it('passes the declared argument to the resolver that kind names', () => {
    const cases: ReadonlyArray<[Criterion['source'], string, number]> = [
      [{ kind: 'probe', reading: 'block-saving' }, 'probe:block-saving', 1],
      [{ kind: 'artifact', path: 'a/b.json', key: 'c.d' }, 'artifact:a/b.json#c.d', 2],
      [{ kind: 'arm', arm: 'annotated' }, 'arm:annotated', 3],
      [{ kind: 'gap' }, 'gap', 4],
      [{ kind: 'floor' }, 'floor', 7],
      [{ kind: 'leak' }, 'leak', 5],
      [{ kind: 'ablation', removed: 'persistence' }, 'ablation:persistence', 6],
    ];
    for (const [source, expectedCall, expectedValue] of cases) {
      const { calls, resolve } = recording();
      expect(currentOf(criterionOf({ source }), resolve)).toBe(expectedValue);
      expect(calls).toEqual([expectedCall]);
    }
  });

  it('keeps the artifact path and key apart, because one is not a prefix of the other', () => {
    const { calls, resolve } = recording();
    currentOf(criterionOf({ source: { kind: 'artifact', path: 'x/y.json', key: 'z' } }), resolve);
    // A concatenated lookup would have produced `x/y.jsonz` and silently missed the file.
    expect(calls).toEqual(['artifact:x/y.json#z']);
  });

  it('calls nothing for an unrun row', () => {
    const { calls, resolve } = recording();
    expect(currentOf(criterionOf(), resolve)).toBeUndefined();
    // The property that matters: an unrun row cannot pick up a value from a neighbouring resolver.
    expect(calls).toEqual([]);
  });

  it('propagates an absent resolver answer as absent rather than as zero', () => {
    const { resolve } = recording({
      probe: () => undefined,
      artifact: () => undefined,
      ablation: () => undefined,
    });
    expect(
      currentOf(criterionOf({ source: { kind: 'probe', reading: 'block-saving' } }), resolve),
    ).toBe(undefined);
    expect(
      currentOf(criterionOf({ source: { kind: 'artifact', path: 'p', key: 'k' } }), resolve),
    ).toBe(undefined);
    expect(currentOf(criterionOf({ source: { kind: 'ablation', removed: 'r' } }), resolve)).toBe(
      undefined,
    );
  });

  it('lets a zero survive the dispatch, which is a reading and not an absence', () => {
    const { resolve } = recording({ gap: () => 0 });
    expect(currentOf(criterionOf({ source: { kind: 'gap' } }), resolve)).toBe(0);
  });

  it('returns absent for a source kind this build does not know', () => {
    // Reachable from a persisted artifact written by a newer build. Throwing would turn a forward-compatible
    // read into a crash; answering with a number would invent a measurement.
    const unknown = { kind: 'from-the-future' } as unknown as Criterion['source'];
    const { calls, resolve } = recording();
    expect(currentOf(criterionOf({ source: unknown }), resolve)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('routes every row in the table to the resolver its own source names', () => {
    const { resolve } = recording();
    const expected: Record<Criterion['source']['kind'], number | undefined> = {
      probe: 1,
      artifact: 2,
      arm: 3,
      gap: 4,
      floor: 7,
      leak: 5,
      ablation: 6,
      unrun: undefined,
    };
    for (const row of CRITERIA) {
      expect(currentOf(row, resolve), `row ${row.id} reads ${describeSource(row.source)}`).toBe(
        expected[row.source.kind],
      );
    }
  });
});

describe('the table is well formed', () => {
  it('has a unique id per row', () => {
    const ids = CRITERIA.map((criterion) => criterion.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every row a rule for what to do when it is missed', () => {
    // The revert rule is the part that makes a threshold binding. A row without one is a wish and would pass
    // review by looking like the others.
    for (const criterion of CRITERIA) {
      expect(criterion.onMiss.length, criterion.id).toBeGreaterThan(20);
    }
  });

  it('keeps the threshold inside the range its unit implies', () => {
    for (const criterion of CRITERIA) {
      if (criterion.unit === 'ratio') {
        expect(criterion.threshold, criterion.id).toBeGreaterThanOrEqual(0);
        expect(criterion.threshold, criterion.id).toBeLessThanOrEqual(1);
      }
      if (criterion.unit === 'points') {
        expect(Math.abs(criterion.threshold), criterion.id).toBeLessThanOrEqual(1);
      }
    }
  });

  it('marks a gate as something already reached, so a fail is a regression', () => {
    // Not a tautology: a row can be switched from `gate` to `aim` to silence it, and this asserts the switch
    // has not been used on the rows that are green today.
    const green = CRITERIA.filter((criterion) => criterion.kind === 'gate');
    expect(green.length).toBeGreaterThan(5);
  });

  it('reads the four category rows from the attested ledger, not from the stale summary', () => {
    // `S1` was moved off `summary.json` and the other four were left on it, so the page printed a
    // multi-session deficit of 13.3 points where the arm's own artifact reads 1.1. The clauses are the
    // repair: a row that reads the ledger without attesting it can drift back onto another configuration
    // exactly the way it drifted onto another *dispatch*.
    const denominators: Record<string, string> = {
      S2: '72 questions',
      S3: '121 questions',
      S4: '127 questions',
      S5: '30 questions',
    };
    for (const id of ['S2', 'S3', 'S4', 'S5']) {
      const row = CRITERIA.find((criterion) => criterion.id === id);
      expect(row?.source.kind).toBe('artifact');
      if (row?.source.kind !== 'artifact') throw new Error(`${id} has no artifact source`);
      expect(row.source.path).toBe('cortex-docs/evidence/longmemeval/categories.json');
      expect(row.source.key?.startsWith('categories.')).toBe(true);
      expect(row.source.attest?.map((clause) => clause.key)).toEqual([
        'accuracySource',
        'runs',
        'arm',
        'pooled.denominator',
      ]);
      // The denominator a row divides by and the denominator it names have to be the same number: `S2`
      // said "78 questions" while dividing by 72, which is a correct percentage of the wrong population.
      expect(row.dataset).toContain(denominators[id]);
    }
  });

  it('gives the benchmark rows a competitor figure with a grade', () => {
    const benchmark = CRITERIA.find((criterion) => criterion.id === 'S1');
    expect(benchmark?.competitors?.length).toBeGreaterThan(3);
    for (const peer of benchmark?.competitors ?? []) {
      expect(['A', 'B', 'C']).toContain(peer.grade);
      // A grade without a recipe is an opinion. The recipe is what lets a reader dispute the grade.
      expect(peer.recipe.length).toBeGreaterThan(20);
    }
  });

  it('records at least one grade-C figure, and does not use it as a target', () => {
    // The point of the grade is that vendor numbers exist and may not be quoted as a gap. If every competitor
    // were grade A, this test would be vacuous rather than protective.
    const graded = CRITERIA.flatMap((criterion) => criterion.competitors ?? []);
    expect(graded.some((peer) => peer.grade === 'C')).toBe(true);
    expect(graded.some((peer) => peer.grade === 'A')).toBe(true);
  });

  it('wires the cost row to the ledger, with the division named in the row itself', () => {
    // The 2026-10 board is the first that prints context length beside accuracy, and it says this arm bills
    // more tokens than Zep (4.4K) and Mem0 (6.8K) at a lower score. A `gate` here would be a number the
    // project has already reached, and it has reached none, so the row is an aim by construction.
    //
    // It was `unrun` while the arithmetic was undecided: one token count, three defensible divisions,
    // 4.14x apart. `tools/cost-ledger.py` now names one and writes it to evidence, so the row reads the
    // file rather than carrying a hand-typed figure -- and the metric text states the division that was
    // named, because a row whose prose and whose file disagree is the same defect one layer down.
    const cost = CRITERIA.find((criterion) => criterion.id === 'C1');
    expect(cost).toBeDefined();
    expect(cost?.capability).toBe('cost');
    expect(cost?.kind).toBe('aim');
    expect(cost?.comparator).toBe('at-most');
    expect(cost?.threshold).toBe(6000);
    expect(cost?.source).toEqual({
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/cost.json',
      key: 'readings.perQuestionPerRun',
    });
    // The denominator, the unit of repetition and the treatment of retries, all in the row.
    expect(cost?.metric).toContain('one question');
    expect(cost?.metric).toContain('one repetition');
    expect(cost?.metric).toContain('retries');
    // The key has to be the per-question reading and not the per-call one: they are 3.5% apart on the
    // artifact, which is inside the noise of every other row here and therefore exactly the kind of
    // difference a wrong key would hide.
    expect(cost?.source.kind === 'artifact' && cost.source.key).not.toBe('readings.perCall');
    expect((cost?.competitors ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('reads the cost row as a measured miss and a pass, without either of them blocking a build', () => {
    const cost = CRITERIA.find((criterion) => criterion.id === 'C1') as Criterion;
    // The value the ledger produced on `42310779222`: 24,209,976 prompt tokens over 500 questions and
    // four repetitions. An aim that misses is the work, not a regression.
    const missed = verdictOf(cost, 12_104.988);
    expect(missed.status).toBe('fail');
    expect(missed.blocking).toBe(false);
    expect(verdictOf(cost, 5_000).status).toBe('pass');
    // And `null` is the value of a criterion with no reading: the file is in the sibling repository, so
    // a checkout without it reports the row as unrun rather than as met.
    expect(verdictOf(cost, null).status).toBe('unrun');
    expect(verdictOf(cost, null).note).toBe(
      'no value at cortex-docs/evidence/longmemeval/cost.json#readings.perQuestionPerRun',
    );
  });

  it('names the rows with no source at all, and there are fewer of them than rows', () => {
    // `unrun` used to be an exported convenience for this. It was deleted rather than kept: only this test
    // called it, the checker filters on `verdict.status` because a source can now be `stale` as well, and an
    // export whose only caller is a test is an orphan export by this project's own census rule.
    const missing = CRITERIA.filter((criterion) => criterion.source.kind === 'unrun');
    expect(missing.length).toBeLessThan(CRITERIA.length);

    // The exact list, because "some rows are unrun" is a statement that cannot regress. Naming them means a
    // row quietly losing its source is a failure here rather than a row that stops appearing in a report.
    //   D1 -- no artifact: the A3 extraction-fidelity verdict lives in a review page, not in evidence/.
    //   P1 -- never measured: the portability ratio has a design and no run, and the second provider
    //         answers 1.41 questions per minute, so a 500-question dispatch is five times the budget.
    // M1 left this list in round 60: it now reads `cortex-docs/evidence/longmemeval/reader-ladder.json`,
    // generated by `tools/reader-ladder.py` from the pair the round registered. The row is still not a
    // claim until that file exists in the checkout — where it does not, the checker prints `unrun` and
    // the document's marker check skips it, which is the behaviour this list is protecting.
    expect(missing.map((criterion) => criterion.id)).toEqual(['D1', 'P1']);
    for (const criterion of missing) {
      if (criterion.source.kind !== 'unrun') throw new Error('unreachable: filtered on the kind');
      // A reason of one word is the same as no reason; these strings are what a reader is left with.
      expect(criterion.source.reason.length).toBeGreaterThan(60);
    }
  });

  it('keeps a row for every mechanism this repository shipped, including the null results', () => {
    // A null result with no row is a null result that gets quietly re-litigated every few months.
    const ids = new Set(CRITERIA.map((criterion) => criterion.id));
    for (const id of ['K1', 'K2', 'T1', 'T2', 'T3', 'T4', 'G1', 'G2', 'C1']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(CRITERIA.find((criterion) => criterion.id === 'R1')?.accepted).toBe(true);
  });

  it('keeps a published figure above this arm, so the table cannot be read as a frontier claim', () => {
    // §1.22 of the competitor analysis: the top of this benchmark moved twice in two weeks, and the first
    // version of consequence 1 ("the gap to close is 85.8%, not 96.2%") was true of the rows that existed
    // when it was written. A table that only holds figures below this arm's own would let a reader conclude
    // the frontier had been reached, so the guard is that at least one vendor figure sits above 95% -- and
    // it is a C, which is exactly what stops it being quoted as a gap.
    const peers = CRITERIA.find((criterion) => criterion.id === 'S1')?.competitors ?? [];
    expect(Math.max(...peers.map((peer) => peer.value))).toBeGreaterThan(0.95);
    expect(peers.some((peer) => peer.grade === 'C' && peer.value > 0.95)).toBe(true);
    // And the like-for-like row, in this arm's reader class, must be present with its own grade: the 90.2
    // and the 98.4 are the same memory, and only the pair together says what the reader is worth.
    const recallium = peers.filter((peer) => peer.name.startsWith('Recallium'));
    expect(recallium).toHaveLength(2);
    expect(recallium.some((peer) => peer.grade === 'B')).toBe(true);
    expect(
      Math.max(...recallium.map((peer) => peer.value)) -
        Math.min(...recallium.map((peer) => peer.value)),
    ).toBeGreaterThan(0.05);
  });

  it('carries the same competitor twice when two parties measured it, and never as one number', () => {
    // Supermemory publishes 97% on LongMemEval-S with a GPT-4o reader; an independent comparison measures
    // the same system at 81.6% with the same reader on the same 500 questions. A table that kept one of the
    // two would be readable as an agreement, and the 15.4-point difference is larger than this project's
    // whole distance to grade A — so "which figures may be quoted as a gap" is decided here rather than in
    // a paragraph. Deleting either row must fail this test, not silently simplify the table.
    const peers = CRITERIA.find((criterion) => criterion.id === 'S1')?.competitors ?? [];
    const supermemory = peers.filter((peer) => peer.name.startsWith('Supermemory'));
    expect(supermemory).toHaveLength(2);
    const independent = supermemory.find((peer) => peer.grade === 'A');
    const selfReported = supermemory.find((peer) => peer.grade === 'C');
    expect(independent?.value).toBeCloseTo(0.816, 3);
    expect(selfReported?.value).toBeCloseTo(0.97, 3);
    expect((selfReported?.value ?? 0) - (independent?.value ?? 0)).toBeGreaterThan(0.1);
    // Both rows must say where the number came from. A grade without a recipe cannot be disputed.
    for (const peer of supermemory) {
      expect(peer.recipe.length).toBeGreaterThan(100);
    }
  });
});

describe('the configuration an evidence file names, checked against the registration record', () => {
  /**
   * `S1`'s third attestation clause used to be `shipping.arm == route-room`, and the note beside it claimed a
   * label could not resolve to an older file. Section 13.336 adopted a six-route room map, the label was still
   * spelled `route-room`, and it resolved to the map it replaced — so the clause passed while five rows read a
   * configuration that had stopped shipping. The repair is a fingerprint of the configuration itself, and the
   * comparison spans two repository roots, which is why it is a list here and a check in the CLI.
   */
  it('names the two files that carry a configuration and a key for each', () => {
    expect(CONFIGURATION_ATTESTED.length).toBe(2);
    const keys = CONFIGURATION_ATTESTED.map((entry) => entry.key).sort();
    expect(keys).toEqual(['configurationFingerprint', 'shipping.configurationFingerprint']);
    for (const entry of CONFIGURATION_ATTESTED) {
      expect(entry.path.startsWith('cortex-docs/evidence/')).toBe(true);
    }
  });

  it('covers every row whose source is one of those files', () => {
    // The reverse direction: a row reading a configuration-carrying file that is not on the list is a row
    // whose number nothing checks the identity of, which is the state all five rows were in for a round.
    const covered = new Set(CONFIGURATION_ATTESTED.map((entry) => entry.path));
    for (const criterion of CRITERIA) {
      if (criterion.source.kind !== 'artifact') continue;
      if (criterion.source.path.includes('/longmemeval/') === false) continue;
      // `cost.json`, `room-cut.json`, `summary.json` and the unrun rows carry no configuration field; the
      // property under test is that every file which *does* carry one is listed, and that is asserted from
      // the files below rather than inferred here.
      expect(typeof criterion.source.path).toBe('string');
    }
    for (const path of [
      'cortex-docs/evidence/longmemeval/frontier.json',
      'cortex-docs/evidence/longmemeval/categories.json',
    ]) {
      expect(covered.has(path)).toBe(true);
    }
  });
});

describe('the reranking rows, written before the run that fills them', () => {
  const s6 = CRITERIA.find((criterion) => criterion.id === 'S6');
  const s7 = CRITERIA.find((criterion) => criterion.id === 'S7');

  it('gates the instrument and aims at the paired gain, which are two different numbers', () => {
    // The instrument row is a gate because a discarded reply is not a small effect — it is an unreadable
    // run. The gain row is an aim because the number does not exist yet. Collapsing the two into one row
    // would make either the gate block on an unmeasured aim or the aim inherit a threshold of zero.
    expect(s6?.kind).toBe('gate');
    expect(s6?.comparator).toBe('at-most');
    expect(s6?.threshold).toBe(0);
    expect(s6?.unit).toBe('count');
    expect(s7?.kind).toBe('aim');
    expect(s7?.comparator).toBe('at-least');
    expect(s7?.threshold).toBe(3);
    expect(s7?.unit).toBe('count');
  });

  it('reads both rows out of one artifact, so a run cannot fill one and not the other', () => {
    const first = s6?.source;
    const second = s7?.source;
    expect(first?.kind).toBe('artifact');
    expect(second?.kind).toBe('artifact');
    if (first?.kind !== 'artifact' || second?.kind !== 'artifact') return;
    expect(first.path).toBe(second.path);
    expect(first.key).not.toBe(second.key);
  });

  it('points at a file rather than at the word unrun, so the row starts reporting when the run lands', () => {
    // `{ kind: 'unrun' }` is a row that can never become live without an edit, and an edit is exactly the
    // moment somebody re-derives the threshold. An artifact path that does not exist yet resolves to `unrun`
    // today and to a number tomorrow, with no change to this file.
    for (const criterion of [s6, s7]) {
      expect(criterion?.source.kind, criterion?.id).toBe('artifact');
    }
  });

  it('says a discarded reply is an assembly failure rather than a null result', () => {
    // The whole reason the census exists: `rerankHits` degrades to the retrieved order, so an endpoint
    // answering 401 five hundred times and a cross-encoder that agreed every time produce the same accuracy.
    expect(s6?.onMiss).toContain('assembly failure');
    expect(s6?.onMiss).toContain('401');
    expect(s7?.onMiss).toContain('delete the stage');
  });

  it('grades the only published price of this stage as C, because it is another corpus', () => {
    const peer = s7?.competitors?.[0];
    expect(peer?.grade).toBe('C');
    expect(peer?.recipe).toContain('3.92');
    // The grade is doing work: a C figure may motivate the increment and may price the mechanism, and it may
    // not become the threshold. The threshold is 3 questions on our own 121, not 3.92 points on theirs.
    expect(peer?.value).not.toBe(s7?.threshold);
  });
});

describe('attestationOf: a reading has to say it is about this system', () => {
  const artifactCriterion = (
    attest?: Criterion['source'] extends never ? never : unknown,
  ): Criterion =>
    criterionOf({
      source: {
        kind: 'artifact',
        path: 'evidence/x.json',
        key: 'shipping.accuracy',
        ...(attest === undefined ? {} : { attest: attest as never }),
      },
    });

  it('returns null when every clause holds, which is the only case that yields a number', () => {
    const criterion = artifactCriterion([
      { key: 'shipping.accuracySource', equals: 'repetition-mean' },
      { key: 'shipping.runs', equals: 4 },
    ]);
    const resolve = {
      artifactRaw: (path: string, key: string) =>
        path === 'evidence/x.json'
          ? { 'shipping.accuracySource': 'repetition-mean', 'shipping.runs': 4 }[key]
          : undefined,
    } as unknown as Resolvers;
    expect(attestationOf(criterion, resolve)).toBeNull();
  });

  it('names the clause that failed and both values, so the note is actionable', () => {
    const criterion = artifactCriterion([{ key: 'shipping.runs', equals: 4 }]);
    const resolve = {
      artifactRaw: () => 2,
    } as unknown as Resolvers;
    const note = attestationOf(criterion, resolve);
    expect(note).toContain('shipping.runs');
    expect(note).toContain('2');
    expect(note).toContain('4');
  });

  it('reads a missing field as a mismatch rather than as a pass', () => {
    // `undefined` is what a renamed key looks like, and a renamed key must not silently satisfy a clause.
    const criterion = artifactCriterion([{ key: 'shipping.arm', equals: 'route-room' }]);
    const resolve = { artifactRaw: () => undefined } as unknown as Resolvers;
    expect(attestationOf(criterion, resolve)).toContain('null');
  });

  it('is stale, not a pass, when no raw reader is configured to check against', () => {
    const criterion = artifactCriterion([{ key: 'shipping.runs', equals: 4 }]);
    const resolve = { artifactRaw: undefined } as unknown as Resolvers;
    expect(attestationOf(criterion, resolve)).toContain('no raw reader');
  });

  it('does not attest a source that says nothing about itself, or one that is not an artifact', () => {
    const resolve = { artifactRaw: () => 'anything' } as unknown as Resolvers;
    expect(attestationOf(artifactCriterion(), resolve)).toBeNull();
    expect(attestationOf(artifactCriterion([]), resolve)).toBeNull();
    expect(attestationOf(criterionOf({ source: { kind: 'gap' } }), resolve)).toBeNull();
  });

  it('keeps the stale note out of `blocking`, whatever the criterion kind is', () => {
    // A stale reading of a gate is not a regression. Blocking would force a red build for a file that is a
    // perfectly good record of an older configuration, which teaches people to delete rows.
    const stale = verdictOf(criterionOf({ kind: 'gate', threshold: 0.9 }), 0.92, 'a reason');
    expect(stale.status).toBe('stale');
    expect(stale.blocking).toBe(false);
    expect(stale.current).toBe(0.92);
    expect(stale.note).toBe('a reason');
  });

  it('reports stale even when the value is absent, because the two are different repairs', () => {
    const stale = verdictOf(criterionOf(), null, 'a reason');
    expect(stale.status).toBe('stale');
    const missing = verdictOf(criterionOf(), null);
    expect(missing.status).toBe('unrun');
  });
});

/**
 * `S11`: the product with no ranking configured.
 *
 * The arm's `DEFAULT_RELEVANCE_SIGNAL` is `none`, which is also what a caller who installs the package and
 * configures nothing runs: no table, no index, the budget spends arrival order. Three arms therefore exist
 * (`none`, `self-index`, `retrieval-anchored`) and two of them had a registered reading while the default —
 * the one nobody has to choose — did not. A default that is never scored is a delivery shape the project
 * cannot describe, and this row is that description.
 *
 * The tests below are about the **row**, not about the number: the number arrives with a dispatch. What has
 * to be right before that dispatch is that the row names the arm it measures, that its threshold is derived
 * from a figure this repository already registered rather than chosen, and that missing it has a stated
 * consequence.
 */
describe('S11: the no-ranking arm, priced against a tolerance rather than a round number', () => {
  function row(): Criterion {
    const found = CRITERIA.filter((criterion) => criterion.id === 'S11');
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it('names `relevanceSignal: none` in the dataset, so the row says which of the three arms it is', () => {
    // Without this clause the row is "the product scores X", which is true of all three arms. The arm is the
    // measurement here: `none`, `self-index` and `retrieval-anchored` differ by who builds the ranking.
    expect(row().dataset).toContain('relevanceSignal: none');
    expect(row().capability).toMatch(/no ranking|none/);
  });

  it('is an aim rather than a gate, because it is expected to be missed on the way to a decision', () => {
    // The reading is the *price* of ranking. If it lands below the threshold the finding is that ranking is
    // required for delivery, which is a fact to act on and not a regression to fix; blocking a build on it
    // would make the honest answer red.
    expect(row().kind).toBe('aim');
    expect(row().comparator).toBe('at-least');
    expect(verdictOf(row(), 0.5).blocking).toBe(false);
  });

  it('derives its threshold from S1 and S9, so the three rows cannot drift apart', () => {
    const s1 = CRITERIA.find((criterion) => criterion.id === 'S1');
    const s9 = CRITERIA.find((criterion) => criterion.id === 'S9');
    if (s1 === undefined || s9 === undefined)
      throw new Error('S1 and S9 are the rows this one is priced against');
    // `S9` already registered how much ranking may be given up: −15 questions over 500, which is 3.0 points.
    // `S11` asks the harder question — what if there is no ranking at all — and reuses that tolerance rather
    // than inventing one. A bare-install reading inside S1's own 3.0-point tolerance would say ranking is not
    // a delivery requirement; below it, S9's 3.0 points are the price of *which* ranking, not of having one.
    const tolerance = Math.abs(s9.threshold) / 500;
    expect(row().threshold).toBeCloseTo(s1.threshold - tolerance, 10);
    expect(row().unit).toBe(s1.unit);
  });

  it('reads a file that no run has written yet, so it reports unrun rather than a guessed value', () => {
    // Equality rather than field-by-field on purpose: when the first dispatch lands, an `attest` clause has
    // to be added here (a path is not an identity — `S1` read a live file describing a retired configuration
    // for three rounds). That edit fails this test, which is the point: it cannot be skipped quietly.
    expect(row().source).toEqual({
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/no-ranking.json',
      key: 'overall.accuracy',
    });
    expect(currentOf(row(), { artifact: () => undefined } as unknown as Resolvers)).toBeUndefined();
  });

  it('states the consequence of a miss as a delivery change, because that is what it decides', () => {
    // A row whose `onMiss` says "investigate" has no consequence. This one decides whether the Quick Start
    // may ship a bare construction: if ranking is worth more than S9's tolerance, the documented minimal
    // configuration is the one that passes `index`.
    expect(row().onMiss).toContain('Quick Start');
    expect(row().onMiss).toContain('`index`');
  });
});

/**
 * `S12` and `S13`: the semantic layer's own reading, and the clause that stops it passing vacuously.
 *
 * E6 is the last of the eight semantic-layer exit criteria and it has been `unrun` for six rounds. Its registered
 * form is `deltaQuestions >= -5`, and the number it will most likely produce is `0` -- because the registered
 * population answers each question from its own corpus, so no window carries another question's record, so the
 * layer reaches nothing there. `0 >= -5` is a pass. A pass that means "the treatment did not run" is worse than
 * no row at all, which is why the row declares its precondition and why the matrix has a state for it.
 */
describe('S12 and S13: a paired reading of the semantic layer, with its reach declared', () => {
  function row(id: 'S12' | 'S13'): Criterion {
    const found = CRITERIA.filter((criterion) => criterion.id === id);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it('prices the treatment with the convention S10 already registered', () => {
    expect(row('S12').threshold).toBe(-5);
    expect(row('S12').comparator).toBe('at-least');
    expect(row('S12').unit).toBe('count');
    // An aim, because a miss is a finding about the product's positioning rather than a regression: `onMiss`
    // says the layer enters `RETRACTIONS`, which is a decision to take, not a build to fix.
    expect(row('S12').kind).toBe('aim');
  });

  it('names the switch in its dataset, because "the product scores X" is true of both arms', () => {
    expect(row('S12').dataset).toContain('CORTEX_MEMORY_SEMANTIC_CARRY');
    expect(row('S13').dataset).toContain('semanticCarry: true');
  });

  it('declares the reach as a precondition, and the reach is a row in this matrix', () => {
    expect(row('S12').requires).toEqual(['S13']);
    // The registry integrity check `applyRequirements` performs, asserted here as well so a rename of the
    // reach row fails in the suite rather than in the gate.
    expect(CRITERIA.some((criterion) => criterion.id === 'S13')).toBe(true);
  });

  it('cannot pass while its precondition has not, even though its number would', () => {
    // The whole reason `void` exists. `0` satisfies `>= -5`, so `verdictOf` alone says `pass` -- and that pass
    // would be a statement about a mechanism that never ran.
    const s12 = row('S12');
    expect(verdictOf(s12, 0).status).toBe('pass');
    const judged = applyRequirements([
      { criterion: s12, evaluation: verdictOf(s12, 0) },
      { criterion: row('S13'), evaluation: verdictOf(row('S13'), 0) },
    ]);
    expect(judged[0]!.evaluation.status).toBe('void');
    expect(judged[0]!.evaluation.blocking).toBe(false);
    expect(judged[0]!.evaluation.note).toContain('S13');
  });

  it('reads as a pass once the reach is there, so the clause is a condition and not a veto', () => {
    // The control the previous test needs: a rule that made every dependent row `void` unconditionally would
    // pass it. Rows are matched by id out of the returned list rather than by position, so a reordering of the
    // matrix cannot turn this into a test of something else.
    const judged = applyRequirements([
      { criterion: row('S13'), evaluation: verdictOf(row('S13'), 4) },
      { criterion: row('S12'), evaluation: verdictOf(row('S12'), -2) },
    ]);
    const byId = new Map(judged.map((entry) => [entry.evaluation.id, entry.evaluation]));
    expect(byId.get('S13')!.status).toBe('pass');
    expect(byId.get('S12')!.status).toBe('pass');
  });

  it('names every unmet precondition, so a chain is one grep and not a recursion', () => {
    // A row with two preconditions is `void` once, not twice, and the note has to say which two -- otherwise a
    // reader who fixed the first would find the row still void and no reason on the page.
    const dependent = { ...criterionOf(), id: 'S97', requires: ['S13', 'S12'] } as Criterion;
    // The dependent row is listed **first**, and that ordering is half the assertion: `S12` is a vacuous pass
    // on its own number and becomes `void` only because `S13` is not a pass. A single pass over the input
    // statuses would judge this row against `S12`'s `pass` and let it through -- so the list order decides
    // whether the rule is a rule or a coincidence of registry order.
    const judged = applyRequirements([
      { criterion: dependent, evaluation: verdictOf(dependent, 1) },
      { criterion: row('S12'), evaluation: verdictOf(row('S12'), 0) },
      { criterion: row('S13'), evaluation: verdictOf(row('S13'), 0) },
    ]);
    const byId = new Map(judged.map((entry) => [entry.evaluation.id, entry.evaluation]));
    expect(byId.get('S97')!.status).toBe('void');
    expect(byId.get('S97')!.note).toContain('S13, S12');
    expect(byId.get('S97')!.note).toContain('are not a pass');
  });

  it('refuses a precondition that names no row, rather than making a row void forever', () => {
    // A typo in `requires` leaves a note a reader cannot act on, and a note nobody can act on is ignored. The
    // registry is data, and data that names a row which is not there is a defect in the file.
    const orphan = { ...criterionOf(), id: 'S99', requires: ['S98'] } as Criterion;
    expect(() =>
      applyRequirements([{ criterion: orphan, evaluation: verdictOf(orphan, 1) }]),
    ).toThrow(/S98/);
  });

  it('is unrun on both rows today, because no run has written the file either reads', () => {
    expect(
      currentOf(row('S12'), { artifact: () => undefined } as unknown as Resolvers),
    ).toBeUndefined();
    expect(
      currentOf(row('S13'), { artifact: () => undefined } as unknown as Resolvers),
    ).toBeUndefined();
  });
});

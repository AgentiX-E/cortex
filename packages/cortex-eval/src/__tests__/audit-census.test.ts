/**
 * The membership audit has to be able to report what it did, on every path the arm can take.
 *
 * ## The defect these tests are written from
 *
 * `CortexMemory.lastReview()` has existed since §13.94 and returns the first pass, the final pass and whether
 * they differ. **Nothing in this package ever read it.** So a run with `reviewPass: 'audit'` carried a
 * mechanism, spent a call per answered multi-session question, and produced an artifact in which the only
 * evidence it had run was a call count roughly nine per cent higher than the control's -- which is
 * indistinguishable from a run that was slower for an unrelated reason.
 *
 * That is the same shape the campaign has now found four times: a producer field with no reader (§13.181), a
 * check with no caller (§13.220), a statement whose correctness depends on somebody remembering to consult it
 * (§13.235.3). The repair is not a document; it is a reader, and these tests are that reader's contract.
 *
 * ## Why the pool case is here and not in `pool-census.test.ts`
 *
 * It belongs there by subject and here by cause. §13.259 found that the positional wrappers around `feature`
 * are **never called** under a pool -- `runAblationRun` answers through `pool.featureFor(worker)` -- so the
 * audit trace would have been empty on exactly the four-worker runs the mechanism is measured on, and the
 * artifact would have said the pass reached no question. Both traces now ride on the per-worker object; the
 * test that says so lives beside the mechanism it protects.
 */
import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { createAblationPool } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';

import type { MemoryArmConfig } from '../report.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

const GATE: MemoryArmConfig = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
};

/**
 * A system that carries the audit, counts it per **instance**, and moves every answer.
 *
 * Per instance rather than shared, because that is what the product's counter is and a shared object would
 * pass under the pool defect by accident -- the very mistake `pool-census.test.ts` documents.
 */
class AuditingSystem implements MemorySystem {
  readonly name: string;
  #audits = { attempted: 0, changed: 0 };

  constructor(name: string) {
    this.name = name;
  }

  async answer(): Promise<Answer> {
    this.#audits.attempted += 1;
    this.#audits.changed += 1;
    return 'one';
  }

  auditCensus(): { attempted: number; changed: number } {
    return { ...this.#audits };
  }
}

/** A system that carries no audit at all, which must stay distinguishable from one that ran and agreed. */
function bareSystem(name: string): MemorySystem {
  return { name, answer: () => 'one' };
}

function dataset(questions: number): BenchmarkDataset {
  return {
    name: 'fixture',
    questions: Array.from({ length: questions }, (_, index) => ({
      id: `q${index}`,
      capability: 'MR',
      question: `Question ${index}?`,
      expected: 'one',
      context: [],
    })),
  };
}

describe('the audit census reaches the artifact', () => {
  it('publishes the tally on the serial path', async () => {
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      new AuditingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.audit).toEqual({ attempted: 6, changed: 6 });
  });

  it('writes the per-question pair, so a reader can join it to the gold', async () => {
    // The tally says how often the review disagreed; only the roster can say whether that helped. Without
    // this field the artifact would carry a rate with no population behind it.
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new AuditingSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.questions!.map((record) => record.auditConsultations)).toEqual([1, 1]);
    expect(result.report.questions!.map((record) => record.auditChanges)).toEqual([1, 1]);
  });

  it('sums the roster to the tally, which is the identity a boolean column cannot satisfy', async () => {
    // §13.262. The roster records the **first** repetition and the tally counts all of them, so a boolean
    // column says `true` for 118 of 500 rows while the tally says 469 -- `42054107910`'s exact disagreement,
    // and its factor was the repetition count. As counts the two are the same number by construction, and
    // this is the assertion that fails on the flag version at any `runs > 1`.
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      new AuditingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    const roster = result.report.questions!;
    const consultations = roster.reduce((sum, record) => sum + (record.auditConsultations ?? 0), 0);
    const changes = roster.reduce((sum, record) => sum + (record.auditChanges ?? 0), 0);

    expect(result.report.audit).toEqual({ attempted: 6, changed: 6 });
    expect(consultations).toBe(6);
    expect(changes).toBe(6);
  });

  it('sums the tally over every worker rather than reading worker 0', async () => {
    // Nine questions, two passes, three workers: eighteen consultations. Under the defect this reads six,
    // and six is exactly the number a reader would check against nothing.
    const pool = createAblationPool({
      workers: 3,
      first: { baseline: bareSystem('reference-pipeline'), feature: new AuditingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new AuditingSystem(`f${worker}`),
    });

    const result = await runCortexMemoryArm(
      dataset(9),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
        pool,
      },
    );

    expect(result.report.audit).toEqual({ attempted: 18, changed: 18 });
  });

  it('traces the pool’s questions, which is where the positional wrapper is never called', async () => {
    // §13.259. If the audit wrapper stays on the positional `feature`, this map is empty on every pooled run
    // and the mechanism reports "reached no question" while having consulted on all of them.
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new AuditingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new AuditingSystem(`f${worker}`),
    });

    const result = await runCortexMemoryArm(
      dataset(4),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
        pool,
      },
    );

    expect(result.report.questions!.every((record) => record.auditConsultations === 1)).toBe(true);
  });

  it('omits the field entirely when the system carries no audit', async () => {
    // The absence rule: `attempted: 0` on a `bare` build would make "this build has no audit" and "the audit
    // agreed with every answer" produce the same artifact.
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      bareSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.audit).toBeUndefined();
    expect('audit' in result.report).toBe(false);
    expect(result.report.questions![0]!.auditConsultations).toBeUndefined();
  });

  it('reads a null census as absence, which is what a bare product build now reports', async () => {
    // §13.268. The sibling test above uses a system with **no accessor**, and the product never has that
    // shape: `CortexMemory` always carries `auditCensus`. So the sibling passed while the live artifact
    // published `audit: { attempted: 0, changed: 0 }` on a `bare` run -- `42161343457`, whose arm audit
    // failed for it. The fixture has to have the product's shape, or it tests a system nobody ships.
    const absent: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => null,
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(2), bareSystem('reference-pipeline'), absent, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
    });

    expect('audit' in result.report).toBe(false);
    expect(result.report.questions![0]!.auditConsultations).toBeUndefined();
    expect(result.report.questions![0]!.auditChanges).toBeUndefined();
  });

  it('renders the tally pass under its own heading, with the refusals it alone can report', async () => {
    // §13.362. `refused` is optional on the census because the audit has no such state: a second
    // consultation that could not read the ledger is a fact about the tally pass, and printing a zero
    // for it under `audit` would be a measurement of a branch that pass cannot enter.
    const tallying: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => ({ attempted: 4, changed: 1, refused: 2 }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      tallying,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.audit).toEqual({ attempted: 4, changed: 1, refused: 2 });
    expect(result.markdown).toContain('## Second consultation (`reviewPass: tally`)');
    expect(result.markdown).not.toContain('## Membership audit');
    expect(result.markdown).toContain('| 4 | 1 | 25.0% | 2 | 50.0% |');
    // The refusal is explained where it is printed, because a reader who does not know what a refused
    // ledger is cannot tell the mechanism failing from the mechanism never running.
    expect(result.markdown).toContain('A **refused** ledger is one where a line carried no tag');
  });

  it('names the specification pass rather than the tally pass under the same heading shape', async () => {
    // The heading used to be keyed off `refused === undefined`, which was right while `tally` was the only
    // pass that could refuse and became a mislabel the moment `spec` arrived: a specification run would
    // have published its census under the arithmetic pass's name.
    const specifying: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => ({ attempted: 6, changed: 2, refused: 3 }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      specifying,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE, reviewPass: 'spec' },
      },
    );

    expect(result.markdown).toContain('## Second consultation (`reviewPass: spec`)');
    expect(result.markdown).not.toContain('`reviewPass: tally`');
    expect(result.markdown).toContain('| 6 | 2 | 33.3% | 3 | 50.0% |');
    // The explanation follows the pass, because a refused plan and a refused ledger are different objects.
    expect(result.markdown).toContain('it asks for a PLAN rather than a list');
    expect(result.markdown).toContain('A **refused** plan is one the parser');
  });

  it('says n/a rather than 0/0 when a tally run consulted nothing', async () => {
    // A pass configured but never reached is a measurement of zero, and 0/0 is not a share. The two
    // `n/a` arms exist for exactly this state, and without a test they would be the only branches in
    // this table nothing enters -- which the per-file ratchet reports as a fall.
    const silent: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => ({ attempted: 0, changed: 0, refused: 0 }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(2), bareSystem('reference-pipeline'), silent, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
    });

    expect(result.markdown).toContain('| 0 | 0 | n/a | 0 | n/a |');
  });

  it('treats a malformed refusal count as an absent instrument', async () => {
    // The rule the two counters already follow: the only producer is a counter incremented by one, so a
    // negative or fractional value can only mean the field is not the count it claims to be.
    const malformed: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => ({ attempted: 4, changed: 1, refused: 1.5 }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      malformed,
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.report.audit).toBeUndefined();
  });

  it('reads a throwing accessor as an absent instrument rather than a failed run', async () => {
    // The rule the sibling readers already follow: a system whose census throws is a system that cannot
    // report, which is not the same as a run that measured zero.
    const broken: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => {
        throw new Error('no census');
      },
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(2), bareSystem('reference-pipeline'), broken, {
      runs: 1,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
    });

    expect(result.report.audit).toBeUndefined();
  });

  it('renders the section beside the two retry passes, and says what it cannot say', async () => {
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new AuditingSystem('cortex-memory'),
      {
        runs: 1,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.markdown).toContain('## Membership audit (`reviewPass: audit`)');
    expect(result.markdown).toContain('| 2 | 2 | 100.0% |');
    // The limitation is in the document, not in a comment beside it.
    expect(result.markdown).toContain('Whether a move was an\nimprovement is not in this table');
  });
});

/**
 * §13.365's authorization arithmetic, which the `spec` pass records before any veto acts on it.
 *
 * The four numbers are the veto's whole input — *the first answer's own token is among the rows the plan
 * selected* — and they are recorded on the run **before** the dispatch that prices them, because a relation
 * nobody persisted cannot be measured afterwards. That is not a hypothesis: `support` was computed on every
 * call in this pass and dropped, which is why the arm would have had to be paid for twice.
 *
 * What these tests protect is therefore not a score. It is the three ways a recorded arithmetic can lie:
 * a per-question column that does not sum to the tally, a pooled run that publishes worker 0's share, and a
 * total whose own identity (`supportHits <= selected <= ledgerRows`) disagrees with itself.
 */
class SpecSystem implements MemorySystem {
  readonly name: string;
  #attempted = 0;
  #authorization = {
    evaluated: 0,
    authorized: 0,
    selected: 0,
    supportHits: 0,
    ledgerRows: 0,
    tokens: 0,
  };

  constructor(
    name: string,
    readonly perAnswer = { authorized: 1, selected: 3, supportHits: 2, ledgerRows: 4, tokens: 1 },
  ) {
    this.name = name;
  }

  async answer(): Promise<Answer> {
    this.#attempted += 1;
    this.#authorization.evaluated += 1;
    this.#authorization.authorized += this.perAnswer.authorized;
    this.#authorization.selected += this.perAnswer.selected;
    this.#authorization.supportHits += this.perAnswer.supportHits;
    this.#authorization.ledgerRows += this.perAnswer.ledgerRows;
    this.#authorization.tokens += this.perAnswer.tokens;
    return 'one';
  }

  auditCensus(): {
    attempted: number;
    changed: number;
    refused: number;
    authorization: {
      evaluated: number;
      authorized: number;
      selected: number;
      supportHits: number;
      ledgerRows: number;
      tokens: number;
    };
  } {
    // One attempt that changed nothing: the pass offered a substitution and kept it, which is the state that
    // keeps `evaluated + refused = attempted` true while `changed` stays out of the identity.
    return {
      attempted: this.#attempted,
      changed: 0,
      refused: 0,
      authorization: { ...this.#authorization },
    };
  }
}

/** The same system with the pair a defect would produce: more supporting rows than selected ones. */
function inconsistentSystem(name: string): MemorySystem {
  return new SpecSystem(name, {
    authorized: 0,
    selected: 1,
    supportHits: 2,
    ledgerRows: 4,
    tokens: 1,
  });
}

/** A system whose audit census predates the authorization field, which is every non-`spec` pass. */
function unauthorizingSystem(name: string): MemorySystem {
  let attempted = 0;
  return {
    name,
    answer: async () => {
      attempted += 1;
      return 'one';
    },
    auditCensus: () => ({ attempted, changed: 0 }),
  } as MemorySystem;
}

describe('the specification authorization reaches the artifact', () => {
  const options = { scorer: exactMatchScorer, generatedAt: '1970-01-01T00:00:00.000Z' } as const;

  it('publishes the arithmetic beside the audit tally', async () => {
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      new SpecSystem('cortex-memory'),
      { ...options, runs: 2, memoryArmConfig: { ...GATE } },
    );

    expect(result.report.audit).toEqual({
      attempted: 6,
      changed: 0,
      refused: 0,
      authorization: {
        evaluated: 6,
        authorized: 6,
        selected: 18,
        supportHits: 12,
        ledgerRows: 24,
        tokens: 6,
      },
    });
  });

  it('writes the four per-question columns, so the population `V3` names can be read off the roster', async () => {
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new SpecSystem('cortex-memory'),
      { ...options, runs: 1, memoryArmConfig: { ...GATE } },
    );

    const roster = result.report.questions!;
    expect(roster.map((record) => record.specEvaluations)).toEqual([1, 1]);
    expect(roster.map((record) => record.specAuthorizations)).toEqual([1, 1]);
    expect(roster.map((record) => record.specSelected)).toEqual([3, 3]);
    expect(roster.map((record) => record.specSupportHits)).toEqual([2, 2]);
  });

  it('sums the roster to the run-level block, which is the identity a verdict would break', async () => {
    // §13.262's rule applied to the new columns: a question is asked `runs` times, so a boolean column would
    // say `true` for every row while the tally counts every repetition, and the two would disagree by exactly
    // the repetition count.
    const result = await runCortexMemoryArm(
      dataset(4),
      bareSystem('reference-pipeline'),
      new SpecSystem('cortex-memory'),
      { ...options, runs: 3, memoryArmConfig: { ...GATE } },
    );

    const roster = result.report.questions!;
    const sum = (pick: (record: (typeof roster)[number]) => number | undefined): number =>
      roster.reduce((total, record) => total + (pick(record) ?? 0), 0);

    expect(sum((record) => record.specEvaluations)).toBe(
      result.report.audit!.authorization!.evaluated,
    );
    expect(sum((record) => record.specAuthorizations)).toBe(
      result.report.audit!.authorization!.authorized,
    );
    expect(sum((record) => record.specSelected)).toBe(result.report.audit!.authorization!.selected);
    expect(sum((record) => record.specSupportHits)).toBe(
      result.report.audit!.authorization!.supportHits,
    );
  });

  it('sums the arithmetic over every worker rather than reading worker 0', async () => {
    const pool = createAblationPool({
      workers: 3,
      first: { baseline: bareSystem('reference-pipeline'), feature: new SpecSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new SpecSystem(`f${worker}`),
    });

    const result = await runCortexMemoryArm(
      dataset(9),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      { ...options, runs: 2, memoryArmConfig: { ...GATE }, pool },
    );

    // 18 substitutions offered over three workers. Worker 0 alone would read 6, which is the number a reader
    // would check against nothing.
    expect(result.report.audit!.authorization).toEqual({
      evaluated: 18,
      authorized: 18,
      selected: 54,
      supportHits: 36,
      ledgerRows: 72,
      tokens: 18,
    });
  });

  it('drops the block when one instance does not report it, because a partial sum reads like a measurement', async () => {
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new SpecSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      // Worker 1's census has no authorization: the mix is the truncated sum in its subtler form.
      featureFor: (worker) => (worker === 0 ? new SpecSystem('f0') : unauthorizingSystem('f1')),
    });

    const result = await runCortexMemoryArm(
      dataset(4),
      bareSystem('reference-pipeline'),
      pool.featureInstances()[0]!,
      { ...options, runs: 1, memoryArmConfig: { ...GATE }, pool },
    );

    expect(result.report.audit).toBeDefined();
    expect(result.report.audit!.authorization).toBeUndefined();
  });

  it('refuses to publish a total that violates its own identity', async () => {
    // `supportHits <= selected` is true inside one instance by construction, so a total that breaks it can
    // only be a defect in this fold -- and a census that cannot state its own population should not state a
    // number.
    const result = await runCortexMemoryArm(
      dataset(3),
      bareSystem('reference-pipeline'),
      inconsistentSystem('cortex-memory'),
      { ...options, runs: 1, memoryArmConfig: { ...GATE } },
    );

    expect(result.report.audit!.attempted).toBe(3);
    expect(result.report.audit!.authorization).toBeUndefined();
  });

  it('renders the authorization section with its own denominators', async () => {
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      new SpecSystem('cortex-memory'),
      { ...options, runs: 1, memoryArmConfig: { ...GATE } },
    );

    expect(result.markdown).toContain('## Authorization (`reviewPass: spec`, §13.365)');
    // Two substitutions, two authorizations, three rows selected each, two of them supporting, four rows in
    // the ledger, one numeral in the answer.
    expect(result.markdown).toContain('| 2 | 2 | 100.0% | 6 | 4 | 8 | 2 |');
    // The sentence that stops a reader treating the table as a mechanism that ran.
    expect(result.markdown).toContain('Nothing acts on that verdict in this build');
  });

  it('says n/a rather than 0/0 for a specification run that offered no substitution', async () => {
    const silent: MemorySystem = {
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: () => ({
        attempted: 0,
        changed: 0,
        refused: 0,
        authorization: {
          evaluated: 0,
          authorized: 0,
          selected: 0,
          supportHits: 0,
          ledgerRows: 0,
          tokens: 0,
        },
      }),
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(1), bareSystem('reference-pipeline'), silent, {
      ...options,
      runs: 1,
      memoryArmConfig: { ...GATE },
    });

    expect(result.markdown).toContain('| 0 | 0 | n/a | 0 | 0 | 0 | 0 |');
  });

  it('omits the block entirely under a pass that has no plan', async () => {
    // The absence rule, one field down: `authorized: 0` on an audit run would make "this pass cannot authorize"
    // and "the veto refused every substitution" produce the same artifact.
    const result = await runCortexMemoryArm(
      dataset(2),
      bareSystem('reference-pipeline'),
      unauthorizingSystem('cortex-memory'),
      { ...options, runs: 1, memoryArmConfig: { ...GATE } },
    );

    expect('authorization' in result.report.audit!).toBe(false);
    expect(result.report.questions![0]!.specEvaluations).toBeUndefined();
  });
});

/**
 * The four ways the authorization payload can arrive wrong, each of which must read as absence.
 *
 * `auditOf` refuses a malformed payload rather than coercing it, and the reason is the same one every reader in
 * this file gives: a numerator that arrived without its denominator would let a reader divide by a number nobody
 * measured. These cases are here rather than beside the valid ones because they are the ones no real artifact
 * produces -- which is exactly why they would otherwise be the only branches nothing enters, and this repository
 * reports an unreachable branch as a defect rather than as dead weight.
 */
describe('a malformed authorization payload', () => {
  const options = {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: { ...GATE },
  } as const;

  const withCensus = (census: () => unknown): MemorySystem =>
    ({
      name: 'cortex-memory',
      answer: () => 'one',
      auditCensus: census,
    }) as unknown as MemorySystem;

  it('refuses an authorization that is not a record', async () => {
    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      withCensus(() => ({ attempted: 1, changed: 0, refused: 0, authorization: null })),
      { ...options },
    );

    // The whole census goes, not just the field: a payload whose parts disagree with their container is the
    // total-without-its-parts shape, and `attempted` beside it would be a number from the same broken object.
    expect(result.report.audit).toBeUndefined();
  });

  it('refuses a count that is not a non-negative integer', async () => {
    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      withCensus(() => ({
        attempted: 1,
        changed: 0,
        refused: 0,
        authorization: {
          evaluated: 1,
          authorized: 0,
          selected: 2,
          supportHits: 1,
          ledgerRows: 2,
          tokens: 0.5,
        },
      })),
      { ...options },
    );

    expect(result.report.audit).toBeUndefined();
  });

  it('keeps a well-formed payload and drops nothing else', async () => {
    // The control for the two above: the same shape with integers present is published, so the refusals are
    // about the defect and not about the field.
    const result = await runCortexMemoryArm(
      dataset(1),
      bareSystem('reference-pipeline'),
      withCensus(() => ({
        attempted: 1,
        changed: 0,
        refused: 0,
        authorization: {
          evaluated: 1,
          authorized: 0,
          selected: 2,
          supportHits: 1,
          ledgerRows: 2,
          tokens: 1,
        },
      })),
      { ...options },
    );

    expect(result.report.audit!.authorization).toEqual({
      evaluated: 1,
      authorized: 0,
      selected: 2,
      supportHits: 1,
      ledgerRows: 2,
      tokens: 1,
    });
  });

  it('merges a repetition that carries the field with one that does not, as absence', async () => {
    // The per-question delta is taken around every answer, so a system that reports the field on one
    // consultation and not on the next produces an entry with it beside an entry without. The merge drops the
    // group rather than summing half of it, and this is the only shape that reaches that branch: a census that
    // stops reporting is a build that changed under the run, not a veto that refused everything.
    let answers = 0;
    const flaky: MemorySystem = {
      name: 'cortex-memory',
      answer: async () => {
        answers += 1;
        return 'one';
      },
      auditCensus: () =>
        answers === 1
          ? {
              attempted: answers,
              changed: 0,
              refused: 0,
              authorization: {
                evaluated: 1,
                authorized: 1,
                selected: 2,
                supportHits: 2,
                ledgerRows: 3,
                tokens: 1,
              },
            }
          : { attempted: answers, changed: 0, refused: 0 },
    } as unknown as MemorySystem;

    const result = await runCortexMemoryArm(dataset(1), bareSystem('reference-pipeline'), flaky, {
      ...options,
      runs: 2,
    });

    // The consultation count survives; the four authorization columns do not, because one of the two
    // repetitions could not report them.
    expect(result.report.questions![0]!.auditConsultations).toBe(2);
    expect(result.report.questions![0]!.specEvaluations).toBeUndefined();
    expect(result.report.audit!.authorization).toBeUndefined();
  });
});

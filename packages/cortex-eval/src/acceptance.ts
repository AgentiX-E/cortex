/**
 * Every acceptance criterion the project claims, as data, with the number computed rather than quoted.
 *
 * ## The problem this solves
 *
 * Acceptance criteria used to live in eight `PREREG-*.md` files and four measurement reports, written in
 * prose, each with its own numbers. That arrangement fails in two ways that are both silent:
 *
 * - **A number in a document drifts from the code that produces it.** Nothing notices, because no build step
 *   reads the document.
 * - **A criterion with no current value cannot fail.** "MR should reach 85%" is a wish until something
 *   compares 69.6% against 85% and exits non-zero.
 *
 * So a criterion is a record: an id, a capability, a metric with a direction, a threshold, a **source** the
 * checker evaluates, a competitor figure with its comparability grade, and the rule for reverting if the
 * threshold is missed. `tools/acceptance-check.mjs` evaluates every row, prints a table, and fails the build
 * on a regression.
 *
 * ## Why the source is declared rather than the value
 *
 * A hard-coded `current: 0.75` is a second copy of a measurement, and two copies of one number is exactly how
 * a repository ends up disagreeing with itself. Each row instead says **where** the number comes from, and the
 * checker computes it at run time. A row whose source cannot be evaluated is `unrun` — not `pass`, and not a
 * number somebody remembered.
 *
 * ## The comparability grade, and why it is part of the criterion
 *
 * The memory-benchmark literature is full of numbers that cannot be compared: one system reports four
 * different LoCoMo scores depending on judge, reader and subset, and vendor self-reports diverge from
 * independent runs by 18–24 points. So every competitor figure carries a grade:
 *
 * | Grade | What it means |
 * | --- | --- |
 * | `A` | same dataset, same judge, same reader, same metric — the only grade that may be used to claim a gap |
 * | `B` | same dataset and metric, different reader or judge, or a proxy metric such as session hit rate |
 * | `C` | different dataset, different subset, or a vendor figure with no published recipe |
 *
 * A `C` number may motivate work. It may not appear in a claim of the form "we are behind X".
 */

/**
 * How comparable a competitor figure is to ours.
 *
 * Hand-attached while the figure is a citation. The moment a run exists, the grade stops being a judgement and
 * becomes a computation: `comparability()` in `competitor.ts` takes the two run configurations and returns it.
 * The two types are deliberately separate rather than aliased — one describes a citation, the other a run — and
 * `docs/PLAN-COMPETITOR-HARNESS.md` is the plan for replacing the first with the second.
 */
export type Grade = 'A' | 'B' | 'C';

/** Which direction passes. `equals` is for counts that must be exact, such as "no leakage". */
export type Comparator = 'at-least' | 'at-most' | 'equals';

/** How the number is written, so a gap in points is not printed as a percentage of nothing. */
export type Unit = 'ratio' | 'points' | 'count';

/**
 * Whether a criterion is a **gate** or an **aim**.
 *
 * A gate is a number the project has already reached; falling below it is a regression and blocks. An aim is
 * a number it has not reached; missing it is the work, and blocking on it would mean the build can never be
 * green while the project is honest about its position. Both are reported, and the difference is the reason
 * the table can be trusted rather than maximised.
 */
export type Kind = 'gate' | 'aim';

/**
 * Where a criterion's current value comes from.
 *
 * Every variant is evaluated by the checker; none of them is a number typed into this file.
 */
export type Source =
  /** One arm of the controlled contradiction set, evaluated on the spot. */
  | { readonly kind: 'arm'; readonly arm: 'flat' | 'annotated' | 'gated' }
  /** How far the ledger arm is ahead of the same ranking without it, in accuracy points. */
  | { readonly kind: 'gap' }
  /** Facts served although the ledger had retired them, summed over the set. Must be zero. */
  | { readonly kind: 'leak' }
  /** The gap between the `gated` arm and the same set with one mechanism removed. */
  | { readonly kind: 'ablation'; readonly removed: string }
  /** A reading the knowledge probe produces from a review page. */
  | {
      readonly kind: 'probe';
      readonly reading:
        'strict-accepted' | 'unresolved-markers' | 'block-tokens' | 'naive-tokens' | 'block-saving';
    }
  /**
   * A number a runner wrote to a file, addressed by dotted path.
   *
   * Relative to the workspace root, not to this package: the evidence for a benchmark run lives beside the
   * documents that discuss it, because a number and the paragraph that qualifies it have to travel together.
   */
  | { readonly kind: 'artifact'; readonly path: string; readonly key: string }
  /** No run exists. Reported as `unrun`, never as a pass. */
  | { readonly kind: 'unrun'; readonly reason: string };

/** One competitor figure, with the grade that decides what may be claimed with it. */
export type Competitor = {
  readonly name: string;
  readonly value: number;
  readonly grade: Grade;
  /** The recipe, so a reader can check the grade rather than take it. */
  readonly recipe: string;
};

export type Criterion = {
  readonly id: string;
  /** The capability, in the form a reader would search for. */
  readonly capability: string;
  readonly metric: string;
  /** What the number is measured on. Free text, because datasets have names not identifiers. */
  readonly dataset: string;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly unit: Unit;
  readonly kind: Kind;
  /**
   * A known miss the project has decided not to fix, with the reason in `onMiss`.
   *
   * Reported, never hidden — and never counted as a build failure, because a criterion that is deliberately
   * unmet and a criterion that broke are different states and collapsing them teaches people to delete rows.
   */
  readonly accepted?: boolean;
  readonly source: Source;
  readonly competitors?: readonly Competitor[];
  /**
   * What happens when the threshold is missed.
   *
   * A criterion without this is a wish: the revert rule is the part that makes the measurement binding, and
   * it is written before the run for the same reason the threshold is.
   */
  readonly onMiss: string;
};

/**
 * The criteria.
 *
 * Grouped by capability, and the order inside a group is the order the work happened — which is also the
 * order in which a failure is cheapest to diagnose.
 */
export const CRITERIA: readonly Criterion[] = [
  // ---- the relation gate (step 28) ---------------------------------------------------------------
  {
    id: 'G1',
    capability: 'relation-preserving split',
    metric: 'share of reviewed pairs the strict gate accepts',
    dataset: 'the 20 pairs the reviewer judged (A3 round 1)',
    comparator: 'at-least',
    threshold: 0.7,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'probe', reading: 'strict-accepted' },
    onMiss:
      'A gate that refuses most proposals is a gate the product cannot ship. Revert to `policy: record` for the shipping path and re-derive the v6 prompt before re-testing; do not lower the threshold.',
  },
  {
    id: 'G2',
    capability: 'relation-preserving split',
    metric: 'unresolved markers the gate reports',
    dataset: 'the same 20 pairs',
    comparator: 'equals',
    threshold: 5,
    unit: 'count',
    kind: 'gate',
    source: { kind: 'probe', reading: 'unresolved-markers' },
    onMiss:
      'A different count means either the marker table or the census changed without the other. Diff the two tables before touching either — the two implementations are supposed to share one list.',
  },
  {
    id: 'G3',
    capability: 'relation-preserving split',
    metric: 'token saving of the grouped block against self-contained blocks',
    dataset: 'g00, the reviewed pair with an explicit causal marker',
    comparator: 'at-least',
    threshold: 0.3,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'probe', reading: 'block-saving' },
    onMiss:
      'The grouping argument is quantitative, so a saving below 30% means the grouping stopped paying. Measure `naive-tokens` beside it and revert the frame-once rendering if the ratio moved.',
  },

  // ---- the assumption ledger (step 29) -----------------------------------------------------------
  {
    id: 'K0',
    capability: 'assumption ledger',
    metric: 'accuracy of the ledger arm on the controlled set',
    dataset: 'controlled contradiction set, 17 cases',
    comparator: 'equals',
    threshold: 1,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'arm', arm: 'gated' },
    onMiss:
      'Every case in the set is one the design claims to answer. Missing one means either the mechanism regressed or a case was added without a mechanism behind it; the per-family table says which.',
  },
  {
    id: 'K1',
    capability: 'assumption ledger',
    metric: 'accuracy points the ledger arm gains over the same ranking without it',
    dataset: 'controlled contradiction set, 17 cases',
    comparator: 'at-least',
    threshold: 0.4,
    unit: 'points',
    kind: 'gate',
    source: { kind: 'gap' },
    onMiss:
      'If the ledger does not beat the flat ranking on a set built to contain the failures it addresses, the mechanism is not doing what it claims. Read the per-family breakdown before changing anything: an even gap across families means the baseline moved, not the mechanism.',
  },
  {
    id: 'K2',
    capability: 'assumption ledger',
    metric: 'accuracy with the persistence mechanism removed',
    dataset: 'the same 17 cases',
    comparator: 'at-most',
    threshold: 0.65,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'ablation', removed: 'persistence' },
    onMiss:
      'Removing retirement should be expensive. If it is cheap, the fixture stopped containing retired facts and the reading is about the fixture.',
  },
  {
    id: 'K3',
    capability: 'assumption ledger',
    metric: 'facts served although the ledger retired them, summed over the set',
    dataset: 'the same 17 cases, gated arm',
    comparator: 'equals',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: { kind: 'leak' },
    onMiss:
      'Any leak is a defect in `assemble` rather than a threshold too tight. The exclusion is supposed to happen before ranking, so a leak means a path bypassed it.',
  },

  // ---- temporality and the plan lifecycle (step 30) ----------------------------------------------
  {
    id: 'T1',
    capability: 'settled fact versus plan',
    metric: 'accuracy with the futurity axis not read',
    dataset: 'the same 17 cases',
    comparator: 'at-most',
    threshold: 0.9,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'ablation', removed: 'temporality' },
    onMiss:
      'The axis is supposed to cost accuracy when removed, on two families at once. A null means the fixture no longer contains a commitment that competes with a fact.',
  },
  {
    id: 'T2',
    capability: 'settled fact versus plan',
    metric: 'accuracy with the immutability protection removed',
    dataset: 'the same 17 cases',
    comparator: 'at-most',
    threshold: 0.95,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'ablation', removed: 'immutability' },
    onMiss:
      'With the protection off, a later trip retires an earlier one. If that costs nothing, the settled-event case stopped being built.',
  },
  {
    id: 'T3',
    capability: 'settled fact versus plan',
    metric: 'accuracy with declared fulfilment not applied',
    dataset: 'the same 17 cases',
    comparator: 'at-most',
    threshold: 0.95,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'ablation', removed: 'fulfil' },
    onMiss:
      'A plan that is never marked fulfilled answers no question about what happened. A null here means the case whose only evidence is the declaration was dropped.',
  },
  {
    id: 'T4',
    capability: 'settled fact versus plan',
    metric: 'accuracy with the lapse transition removed, which must not move',
    dataset: 'the same 17 cases',
    comparator: 'equals',
    threshold: 1,
    unit: 'ratio',
    kind: 'gate',
    source: { kind: 'ablation', removed: 'lapse' },
    onMiss:
      'This row is a recorded structural null: supersession separates two plans on one slot before `lapse` is consulted. A move means the two mechanisms started overlapping differently — investigate before accepting the improvement.',
  },

  // ---- the date frame and the reader (earlier steps, still binding) ------------------------------
  {
    id: 'D1',
    capability: 'extraction fidelity',
    metric: 'share of atoms that are verbatim runs of their frame',
    dataset: 'A3 round 2 (20 pairs, prompt v4)',
    comparator: 'at-most',
    threshold: 0.45,
    unit: 'ratio',
    kind: 'aim',
    source: {
      kind: 'unrun',
      reason: 'the distillation reading needs an A3 run; see docs/MEASURE-DISTILLATION.md',
    },
    onMiss:
      'Above 45% the proposer is cutting sentences rather than extracting facts, which is the complaint that started this line of work.',
  },
  {
    id: 'R1',
    capability: 'abstention recovery',
    metric: 'net correct answers gained by the recovery pass',
    dataset: 'LongMemEval-S, 500 questions, DeepSeek reader',
    comparator: 'at-least',
    threshold: 1,
    unit: 'count',
    kind: 'aim',
    accepted: true,
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/recovery.json',
      key: 'recovery.net',
    },
    onMiss:
      'Measured at 404 against 405: the pass converts one refusal and costs two. Keep `reviewPass: none` as the default; the criterion stays here so a future run cannot quietly re-enable it.',
  },
  {
    id: 'S1',
    capability: 'end-to-end memory',
    metric: 'overall LongMemEval-S accuracy, official judge',
    dataset: 'LongMemEval-S, 500 questions',
    comparator: 'at-least',
    threshold: 0.85,
    unit: 'ratio',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/summary.json',
      key: 'overall.accuracy',
    },
    competitors: [
      {
        name: 'memoricai',
        value: 0.858,
        grade: 'A',
        recipe:
          'LongMemEval-S, 500 questions, official prompts, gpt-4o-2024-08-06 as reader and judge (~11k-token contexts)',
      },
      {
        name: 'Supermemory',
        value: 0.816,
        grade: 'A',
        recipe: 'the published GPT-4o-reader configuration, per the same independent comparison',
      },
      {
        name: 'Zep',
        value: 0.712,
        grade: 'A',
        recipe: 'as reported in Zep\u2019s own LongMemEval paper, GPT-4o reader',
      },
      {
        name: 'full-context GPT-4o',
        value: 0.602,
        grade: 'A',
        recipe: 'the paper baseline: the whole history in the window',
      },
      {
        name: 'Hindsight (vendor)',
        value: 0.946,
        grade: 'C',
        recipe:
          'vendor-reported; reader, judge and preprocessing not published in a form that can be reproduced',
      },
      {
        name: 'Graphonomous (QA proxy)',
        value: 0.926,
        grade: 'C',
        recipe:
          'keyword-recall proxy rather than the official judge, on an oracle split — not the same metric',
      },
    ],
    onMiss:
      'The gap is concentrated in multi-session and temporal reasoning, so a miss on the total is answered by those two rows rather than by re-running with a different reader.',
  },
  {
    id: 'S2',
    capability: 'knowledge update',
    metric: 'LongMemEval-S knowledge-update category',
    dataset: 'LongMemEval-S, 78 questions',
    comparator: 'at-least',
    threshold: 0.85,
    unit: 'ratio',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/summary.json',
      key: 'categories.knowledge-update.accuracy',
    },
    onMiss:
      'Already above threshold at 86.8%. A regression here after a ledger change means the ledger is retiring a fact the judge wanted named.',
  },
  {
    id: 'S3',
    capability: 'multi-session reasoning',
    metric: 'LongMemEval-S multi-session category',
    dataset: 'LongMemEval-S, 133 questions',
    comparator: 'at-least',
    threshold: 0.85,
    unit: 'ratio',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/summary.json',
      key: 'categories.multi-session.accuracy',
    },
    onMiss:
      'At 69.6% this is the largest deficit. The failure census attributes most of it to retrieval rather than reading, so the answer is the second-hop retrieval work, not a bigger context.',
  },
  {
    id: 'S4',
    capability: 'temporal reasoning',
    metric: 'LongMemEval-S temporal-reasoning category',
    dataset: 'LongMemEval-S, 133 questions',
    comparator: 'at-least',
    threshold: 0.85,
    unit: 'ratio',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/summary.json',
      key: 'categories.temporal-reasoning.accuracy',
    },
    onMiss:
      // The first version of this line said the date-frame pre-registration predicted the recovery.
      // `PREREG-DATE-FRAME.md` §0 withdrew it: the temporal prompt has carried the published anchor
      // ("The question was asked on …") and the per-turn date since the contract existed, so the
      // frame is not a treatment this route can receive. What is left is the failure shape —
      // 21 of TR's 33 misses are abstentions over evidence that was delivered — and the recovery
      // pass, which reaches `multi-session` only.
      'At 74.0%, and the frame is already installed, so it cannot be the lever: 21 of the 33 misses are abstentions over delivered evidence, and `reviewPass: recover` does not reach this route.',
  },
  {
    id: 'S5',
    capability: 'abstention',
    metric: 'LongMemEval-S abstention subset',
    dataset: 'LongMemEval-S, 30 false-premise questions',
    comparator: 'at-least',
    threshold: 0.8,
    unit: 'ratio',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/summary.json',
      key: 'abstention.accuracy',
    },
    onMiss:
      'Thirty questions is a wide interval, so a single run decides nothing. The row stays because the denominator is fixed and the direction is not.',
  },
];

/** What the checker found for one criterion. Filled in by the runner, never by hand. */
export type Evaluation = {
  readonly id: string;
  readonly current: number | null;
  readonly status: 'pass' | 'fail' | 'unrun';
  /**
   * Whether this miss should stop a build.
   *
   * False for an aim and for an accepted miss, true for a gate that broke. The rule lives here rather than in
   * the checker so that the judgement is reviewable beside the criterion it applies to.
   */
  readonly blocking: boolean;
  /** Why it is unrun, when it is. Empty otherwise. */
  readonly note: string;
};

/**
 * How to obtain each kind of reading.
 *
 * Passed in rather than imported so that one evaluation path serves every caller: the gate has a JSON reader
 * and a probe runner, a document checker has whatever it needs, and neither reimplements the lookup. A second
 * lookup would be a second definition of "what does K1 measure", which is the defect this whole file exists
 * to prevent.
 */
export type Resolvers = {
  readonly probe: (reading: string) => number | undefined;
  readonly artifact: (path: string, key: string) => number | undefined;
  readonly arm: (arm: 'flat' | 'annotated' | 'gated') => number;
  readonly gap: () => number;
  readonly leak: () => number;
  readonly ablation: (removed: string) => number | undefined;
};

/** The current value of one criterion, or `undefined` when the resolver cannot supply one. */
export function currentOf(criterion: Criterion, resolve: Resolvers): number | undefined {
  const { source } = criterion;
  switch (source.kind) {
    case 'unrun':
      return undefined;
    case 'probe':
      return resolve.probe(source.reading);
    case 'arm':
      return resolve.arm(source.arm);
    case 'gap':
      return resolve.gap();
    case 'leak':
      return resolve.leak();
    case 'ablation':
      return resolve.ablation(source.removed);
    case 'artifact':
      return resolve.artifact(source.path, source.key);
    default:
      return undefined;
  }
}

/** Compare one value against one criterion. Extracted so the rule exists once. */
export function verdictOf(criterion: Criterion, current: number | null): Evaluation {
  if (current === null) {
    return {
      id: criterion.id,
      current: null,
      status: 'unrun',
      // An unrun aim is not a regression; an unrun gate is a lost measurement, and `--strict-unrun` is how a
      // release decides it cares.
      blocking: false,
      note: reasonOf(criterion),
    };
  }
  const pass =
    criterion.comparator === 'at-least'
      ? current >= criterion.threshold
      : criterion.comparator === 'at-most'
        ? current <= criterion.threshold
        : current === criterion.threshold;
  return {
    id: criterion.id,
    current,
    status: pass ? 'pass' : 'fail',
    blocking: !pass && criterion.kind === 'gate' && criterion.accepted !== true,
    note: '',
  };
}

function reasonOf(criterion: Criterion): string {
  const { source } = criterion;
  return source.kind === 'unrun' ? source.reason : `no value at ${describe(source)}`;
}

/** A short human description of a source, used in the table and in notes. */
export function describe(source: Source): string {
  switch (source.kind) {
    case 'arm':
      return `arm:${source.arm}`;
    case 'gap':
      return 'gap:gated-flat';
    case 'leak':
      return 'leak:served-not-current';
    case 'ablation':
      return `ablation:-${source.removed}`;
    case 'probe':
      return `probe:${source.reading}`;
    case 'artifact':
      return `${source.path}#${source.key}`;
    case 'unrun':
      return 'unrun';
  }
}

/** The criteria that currently have no value, so the gap is a list rather than an impression. */
export function unrun(criteria: readonly Criterion[] = CRITERIA): readonly Criterion[] {
  return criteria.filter((criterion) => criterion.source.kind === 'unrun');
}

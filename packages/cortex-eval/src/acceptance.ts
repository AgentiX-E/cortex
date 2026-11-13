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
  | { readonly kind: 'arm'; readonly arm: 'no-memory' | 'flat' | 'annotated' | 'gated' }
  /** How far the ledger arm is ahead of the same ranking without it, in accuracy points. */
  | { readonly kind: 'gap' }
  /**
   * What an append-only store is worth against no store at all, in accuracy points.
   *
   * The one reading on this fixture that can be **negative**, and the sign is the whole point: a store that
   * keeps superseded evidence can score below a deployment that never remembered anything, because a reader
   * with nothing declines and a reader with the wrong thing answers. TEPA (`arXiv:2608.07429`) measured
   * exactly that, append-only `0.210` against no memory `0.309`.
   */
  | { readonly kind: 'floor' }
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
  | {
      readonly kind: 'artifact';
      readonly path: string;
      readonly key: string;
      /**
       * What the artifact has to say about itself for the number to describe the system as it is now.
       *
       * A path is not an identity. `S1` read `summary.json#overall.accuracy` for three rounds and printed
       * **83.45%** while the arm it names measured **90.85%** on the same 500 questions: the file was a real
       * measurement of a configuration that no longer existed, and nothing in it said so. An attestation is
       * the field that says so — each entry names a path the artifact must carry and the value it must hold,
       * and a miss is reported as **stale**, which is neither a pass nor a fail.
       */
      readonly attest?: readonly { readonly key: string; readonly equals: string | number }[];
    }
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
 * Where the four category rows read from, and what the file has to say about itself.
 *
 * They used to read `summary.json`, which is four *independent dispatches* of a configuration that no
 * longer ships. `S1` was moved off that file three rounds ago with an attestation; `S2`-`S5` were left
 * on it, so the matrix printed `MR 71.7%` and `TR 78.3%` while the arm the project ships read **83.9%**
 * and **96.1%** on the same 500 questions -- the same defect `S1` had, four rows over, and it had already
 * been written down as "the distance between the two is one script".
 *
 * `tools/capability-ledger.py` is that script. Its file carries the run id, and the four clauses below are
 * what makes the rows about *this* system rather than about whichever artifact was read last: the mean
 * rather than one repetition, four repetitions rather than two, the shipping configuration label, and the
 * 500-question denominator that the per-category counts are taken from.
 */
const CATEGORY_LEDGER = 'cortex-docs/evidence/longmemeval/categories.json';

/**
 * The evidence files that name the configuration they were measured on, and have to name the registered one.
 *
 * ## Why this is a list and not a clause on a row
 *
 * `S1`'s third attestation clause was `shipping.arm == route-room`, and the note beside it made a claim that
 * turned out to be false: a label "cannot silently resolve to an older file". §13.336 adopted a six-route room
 * map; the label was still spelled `route-room` and still resolved, to the map it replaced. A label is a name,
 * and a name outlives its meaning -- which is the same defect as `S1` reading `summary.json` for three rounds,
 * one indirection further out.
 *
 * So the thing compared is the configuration, by fingerprint, against `tools/arm-config-baseline.json`, which
 * `arm-config-record.py --record` writes from the artifact that adopted it. That comparison spans two
 * repositories' roots and one file in each, which `attestationOf` cannot do with an in-file clause; it is
 * therefore a check of its own in `tools/acceptance-check.mjs`, and it fails the build rather than marking a
 * row, because an evidence file describing another configuration is not a reading of this one at all.
 *
 * The list is here rather than in the checker for the reason every other list is: this file is the single
 * statement of what the project claims, and a second copy in a script is a second statement.
 */
export const CONFIGURATION_ATTESTED: readonly { readonly path: string; readonly key: string }[] = [
  {
    path: 'cortex-docs/evidence/longmemeval/frontier.json',
    key: 'shipping.configurationFingerprint',
  },
  { path: 'cortex-docs/evidence/longmemeval/categories.json', key: 'configurationFingerprint' },
];

const CATEGORY_ATTEST = [
  { key: 'accuracySource', equals: 'repetition-mean' },
  { key: 'runs', equals: 4 },
  { key: 'arm', equals: 'route-room' },
  { key: 'pooled.denominator', equals: 500 },
] as const;

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

  // ---- cost ownership (round 87) ------------------------------------------------------------------
  //
  // These two read a census written by `tools/embedding-reuse-census.mjs`, which asks three questions of one
  // `CortexMemory` over a fixed four-turn corpus twice -- once with the embedding store and once with
  // `reuse: false`. They are gates rather than aims because both properties were reached the round the store
  // landed, and because the failure they prevent is a **silent** one: an index that re-embeds its corpus per
  // question produces exactly the same answers as one that does not, so no accuracy row can see the defect.
  {
    id: 'C5',
    capability: 'embedding cost',
    metric: 'texts embedded by the second question over an unchanged corpus',
    dataset: 'synthetic: 4 turns, 3 questions, `tools/embedding-reuse-census.mjs`',
    comparator: 'equals',
    threshold: 1,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/embedding-reuse/census.json',
      key: 'secondQuestionEmbedTexts',
    },
    competitors: [
      {
        name: 'Mem0',
        value: 6787,
        grade: 'B',
        recipe:
          'mean tokens of retrieved context per query on LongMemEval (mem0, `memory-benchmarks`); a token ' +
          'count where ours is a text count, so the two are not the same unit and the figure is context for ' +
          'the axis rather than a row we may claim a gap against.',
      },
    ],
    onMiss:
      'A second question that embeds more than its own query means the store did not reach the index. Check ' +
      'that `CortexMemory` still passes `store` into `SearchIndexOptions` and that `reuse` was not turned off ' +
      'in the arm under test; do not relax this to "fewer than the corpus".',
  },
  {
    id: 'C6',
    capability: 'embedding cost',
    metric: 'prompts identical between the store and `reuse: false`',
    dataset: 'the same three questions, both arms',
    comparator: 'equals',
    threshold: 1,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/embedding-reuse/census.json',
      key: 'identicalPrompts',
    },
    onMiss:
      'A cache that changes the prompt has changed the ranking, which makes it a defect rather than a result. ' +
      'Revert the store before reading any accuracy from the run: the two arms are no longer one variable ' +
      'apart.',
  },
  {
    id: 'C7',
    capability: 'verifiable erasure',
    metric: 'occurrences of an erased sentence across every table of both stores',
    dataset: 'synthetic: 2 sentences, 5 surfaces, `tools/erasure-census.mjs`',
    comparator: 'equals',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/erasure/census.json',
      key: 'residualOccurrences',
    },
    competitors: [
      {
        name: 'AfterDeleteBench, exact source deletion',
        value: 0.68,
        grade: 'C',
        recipe:
          'a recovery *rate* over 200 synthetic secrets with a fixed-weight reader, hierarchical memory: 0.680 ' +
          'in-distribution and 0.640 held-out, against 0 of 200 for never-exposed controls (arXiv:2610.31366). ' +
          'A behavioural rate where ours is a deterministic occurrence count, so this is the direction and the ' +
          'magnitude of the failure mode rather than a number we may subtract from',
      },
      {
        name: 'MemCut, LLM-guided deletion of ten extra turns',
        value: 0.39,
        grade: 'C',
        recipe:
          'residual recovery after deleting ten additional turns from twenty retrieval candidates: 39-76% ' +
          'across five memory designs and four LLMs (arXiv:2610.21405). The low end is quoted because it is ' +
          'the best case their baselines reached; ours counts surviving copies instead of asking a reader',
      },
    ],
    onMiss:
      'A surviving occurrence means a copy outlived the delete, and the copies that leak are the derived ones, ' +
      'not the row: a card keeps the wording, the turn it came from and the turns around it; a release record ' +
      'keeps the wording and its digest. Repair the erasure, never the threshold -- relaxing this to "no ' +
      'verbatim copy in the facts table" measures the one copy that was never in doubt.',
  },
  {
    id: 'C8',
    capability: 'verifiable erasure',
    metric: 'read paths that still return an erased sentence',
    dataset: 'the same session: private evidence, shared evidence, the export, the release log',
    comparator: 'equals',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/erasure/census.json',
      key: 'leakingReadPaths',
    },
    competitors: [
      {
        name: 'AfterDeleteBench, provenance-aware closure',
        value: 0,
        grade: 'B',
        recipe:
          'the one defence that eliminated recovery in every tested cell: retire the source *and every ' +
          'descendant traced to it* (arXiv:2610.31366). It is a behavioural audit rather than a read-path ' +
          'enumeration, so the grade is B and the claim is "the same mechanism reaches zero", not "we match a ' +
          'published number"',
      },
    ],
    onMiss:
      'A leaking read path is the specific failure AfterDeleteBench measures: the store says the row is gone and ' +
      'a surface still answers with it. Each of the four is a different copy -- the shared one is the one a ' +
      'colleague read, the card is the one the owner exports -- so check which one answered before touching ' +
      'anything, and do not treat an empty private scope as evidence that the shared scope is clean.',
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

  // ---- the comparison the fixture never had a floor for -------------------------------------------
  //
  // Every arm on the controlled set was compared to another arm, so the set could price a mechanism and
  // could never price *memory itself*. TEPA (`arXiv:2608.07429`) is the paper that makes that a defect
  // rather than an omission: during full reversal, append-only and last-write-wins both score `0.210`
  // while **no memory at all** scores `0.309`, because a reader with nothing declines and a reader handed
  // the superseded value answers. A store below the floor is not a weak store; it is a store that makes
  // the product worse than not having one, and nothing on this page could have shown that.
  //
  // The arm is the product with an empty candidate list, not a second implementation of "answer from
  // nothing" -- `resolve` passes `ranked: []` down the same `assemble` call every other arm uses, so a
  // difference between the floor and an arm is a difference the product would also show.
  {
    id: 'V1',
    capability: 'memory pollution',
    metric: 'accuracy points an append-only store is worth against no store at all',
    dataset: 'controlled contradiction set, 17 cases, `flat` minus `no-memory`',
    comparator: 'at-least',
    threshold: 0,
    unit: 'points',
    kind: 'gate',
    source: { kind: 'floor' },
    competitors: [
      {
        name: 'TEPA, append-only against no memory',
        value: -0.099,
        grade: 'B',
        recipe:
          'the paper\u2019s controlled hidden-regime drift, 50 seeds, full-reversal phase: append-only 0.210, last-write-wins 0.210, no memory 0.309, so the difference is \u22120.099. Same shape as this row and the same unit -- two accuracies subtracted -- measured on its own synthetic drift rather than on this fixture, which is why it is a B and not an A',
      },
    ],
    onMiss:
      'The reading is the sign, and a negative one is a finding rather than a broken fixture. It means the loses column outgrew the gains column: the store still answers questions whose gold is a fact, but it answers questions whose gold is "unknown" with a superseded fact, and the second is what memory pollution *is*. At zero the store is worth exactly nothing on a set built to contain contradictions, which is the honest description of an append-only design and the reason revocation is a mechanism rather than a tidy-up. The repair for a negative reading is revocation, never deletion: TEPA keeps revoked precedents in an archive for audit, and a store that forgets to fix a score is a store that cannot answer a dated question -- `h-city-as-of-january` and `c-city-as-of-march` are in this same set and both need the superseded fact to still exist.',
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
    threshold: 0.91,
    unit: 'ratio',
    // A gate, and the promotion is the point of this row rather than a detail of it. The threshold was 85%
    // against a **83.45%** reading and could never be green; the reading then moved to 90.85% and the row was
    // not re-read, because an `aim` that is met is easy to leave as an `aim` — it still prints `pass` and
    // still blocks nothing. A criterion that cannot fail after it has been reached is the row this matrix was
    // built to prevent, so the row changes class in the same edit that re-hangs it.
    //
    // The threshold is 91.0%, and it is derived rather than rounded. It was derived against a shipping arm
    // reading **91.95%** and a four-repetition standard error of **0.43 points** (`noiseFloor`, measured from
    // `ablation.featureCorrectByRun`, not assumed): 2.2 standard errors below the reading, and 1.15 points
    // above the arm that reading replaced (90.85%).
    //
    // Round 57 moved the reading to **91.05%** without touching the threshold, and the margin is now 0.05
    // points. That is the honest consequence of §13.336 and it is recorded rather than repaired: the room map
    // that ships reads 0.90 points below the map it replaced, which is inside the 0.90-point span three draws
    // of the predecessor configuration produced (91.95 / 91.65 / 91.05), so no capability changed — and the
    // bill fell 24.2%, which is the axis the adoption was for. Lowering the threshold to restore the margin
    // would be indistinguishable from lowering the bar to stay green, which this file refuses everywhere else;
    // leaving it means the next dispatch that reads below 91.0 is reported as a regression whether or not one
    // occurred, and that is a fact about the population's resolution rather than about this row.
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/frontier.json',
      key: 'shipping.accuracy',
      // Three clauses, and each one closes a way the number could be about something else. The source is
      // `repetition-mean` because `feature.metrics` is one repetition and read 90.20% where the mean read
      // 90.85%; `runs: 4` because a two-repetition arm's mean carries twice the standard error; and the arm
      // name because "the shipping arm" is a label the tool resolves to an artifact, so a label that stops
      // existing becomes `stale` instead of silently reading an older file.
      //
      // The third clause was not enough, and §13.336 is the measurement: the label kept existing and kept
      // resolving, to the room map the adoption replaced. A fourth check covers it — the configuration
      // fingerprint, compared against `tools/arm-config-baseline.json` by `tools/acceptance-check.mjs` and
      // listed in `CONFIGURATION_ATTESTED` below — because a name can outlive its meaning and a hash cannot.
      attest: [
        { key: 'shipping.accuracySource', equals: 'repetition-mean' },
        { key: 'shipping.runs', equals: 4 },
        { key: 'shipping.arm', equals: 'route-room' },
      ],
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
        recipe:
          'the published GPT-4o-reader configuration, measured by a third party on the same 500 questions rather than reported by the vendor — the grade-C Supermemory row below is the same system reporting itself, 15.4 points higher',
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
        // The row that decides what S1's threshold means. An oracle run is handed the gold evidence and asked
        // only to read it, so its score is the ceiling for a GPT-4o-class reader on this benchmark. Cortex sits
        // 1.6 points under it, which is why raising the reader is a separate question from improving retrieval:
        // no retrieval change can move a score past the reader that reads it.
        name: 'oracle context, GPT-4o',
        value: 0.824,
        grade: 'B',
        recipe:
          'one oracle configuration: the answer evidence handed over, GPT-4o reading it. **Not a ceiling** — see onMiss',
      },
      {
        // The row that retired "oracle is the reader ceiling". A raw-RAG pipeline — timestamps, chunking,
        // dense retrieval, reranking, no extraction and no rewriting — reads 87.53 with a GPT-4o-mini reader,
        // which is 5.1 points *above* the oracle figure. So 82.4 was a configuration, not a bound, and the
        // inference "we are 1.6 under the ceiling so retrieval is nearly done" does not survive it.
        //
        // It also matters for a second reason: this pipeline is the shape Cortex already has. No LLM
        // extraction at ingest, no fact rewriting, raw turns plus dates, hybrid retrieval, a reranking stage.
        // A same-shaped system reaching 87.53 is the strongest evidence available that the distance from
        // 80.80 is mostly the reader rather than the architecture.
        name: 'Raw-RAG (naive, GPT-4o-mini)',
        value: 0.8753,
        grade: 'B',
        recipe:
          'arXiv:2610.30755: timestamps, chunking, dense retrieval and reranking over raw turns, no extraction, no rewriting — 87.53 against the strongest agentic memory system at 87.40',
      },
      {
        // The one row measured with a DeepSeek reader, which is the reader this arm uses. StateMem reports
        // 0.656 on LongMemEval with DeepSeek and 0.580 with Qwen, against Mem0 at 0.594 and full history
        // lower still. It is the only published DeepSeek-reader reading on this benchmark, so it is the only
        // (weak) anchor for what 80.80 means: 15.2 points above it, on a different corpus version and judge.
        name: 'StateMem (DeepSeek reader)',
        value: 0.656,
        grade: 'B',
        recipe:
          'arXiv:2608.19652: state-tracking memory, DeepSeek reader — 0.656; the only published DeepSeek-reader figure on this benchmark',
      },
      {
        // The controlled half of Mastra's own reader ablation: same memory system at 84.23% (GPT-4o) and 94.87%
        // (GPT-5-mini). Both are vendor-reported, so neither is grade A, but the *difference* between them is a
        // single-variable experiment on the reader and it is larger than this project's entire gap.
        name: 'Mastra OM, GPT-4o',
        value: 0.8423,
        grade: 'B',
        recipe: 'vendor research page: observational memory, GPT-4o reader, GPT-4o judge',
      },
      {
        name: 'Mem0 OSS, reproduced',
        value: 0.324,
        grade: 'B',
        recipe:
          'benchd.ai, six systems on 500 questions: open-source Mem0 at 32.4% against a 57.6% no-memory baseline — a reproduction of a vendor 94.4%, which configures LLM extraction this run does not',
      },
      {
        name: 'no-memory baseline',
        value: 0.576,
        grade: 'B',
        recipe:
          'benchd.ai: the whole history in the window with no memory system — the bar a memory system has to clear before any leaderboard comparison is interesting',
      },
      {
        name: 'Hindsight (vendor)',
        value: 0.946,
        grade: 'C',
        recipe:
          'vendor-reported; reader, judge and preprocessing not published in a form that can be reproduced',
      },
      {
        name: 'Mastra OM, GPT-5-mini',
        value: 0.9487,
        grade: 'C',
        recipe:
          'vendor research page, strongest reader — the same memory system as the GPT-4o row above, differing only in the model that reads it, which is what makes the 10.6-point gap an experiment on the reader',
      },
      {
        // The row that shows what a vendor's own number is worth, and it is the sharpest single piece of
        // evidence in this table. Supermemory appears TWICE above and here: 0.816 as the GPT-4o-reader
        // configuration measured by an independent comparison (grade A), and 0.970 as the vendor's own
        // report on the same benchmark, same 500 questions, same GPT-4o reader (grade C). Same system, same
        // model, same dataset, **15.4 points apart**. Nothing about the difference is disclosed as a
        // mechanism: the vendor publishes category scores and a run count, the independent comparison
        // publishes a configuration. That gap is larger than this project's entire distance to grade A, so
        // a campaign that quotes vendor figures as targets is aiming at a number nobody can reproduce --
        // which is why §13.220 made the artifact's own configuration part of what the job checks.
        name: 'Supermemory (self-reported, GPT-4o)',
        value: 0.97,
        grade: 'C',
        recipe:
          'vendor comparison page, LongMemEval-S 500 questions, GPT-4o answering: 97% overall with per-category 97/100/95/100/95/96. The SAME system reads 81.6% in the independent comparison two rows up, so this figure prices the reporting difference rather than the memory',
      },
      {
        name: 'agentmemory V4',
        value: 0.962,
        grade: 'C',
        recipe:
          'single deterministic run, Claude Opus 4.6 reader, GPT-4o judge seed 42, six-signal retrieval — the second-highest figure in this table, and the least comparable: one run, no repetitions, no configuration record',
      },
      {
        // Highest published S-number that states its setting. Included because the previous table's top
        // row (agentmemory V4) is a single deterministic run, and a claim to "highest published" needs the
        // runner-up that is stated in a form a reader can argue with.
        name: 'Agent Zero Memory (Zero Labs)',
        value: 0.956,
        grade: 'C',
        recipe:
          'arXiv, August 2026: gpt-5.5 answering, 92.2 to 95.6 across eight answer models, 500 questions; the setting is not stated and the judge model is not named',
      },
      {
        // The managed-platform number, and the reason the OSS row reads 32.4: the 94.4 configures an LLM
        // extraction pass and a top-200 retrieval budget that the open-source package does not.
        name: 'Mem0 managed platform, GPT-5',
        value: 0.944,
        grade: 'C',
        recipe:
          'vendor memory-benchmarks repository, April 2026 algorithm: 472 of 500 at a top-200 retrieval budget, GPT-5 as answer model AND as judge — self-reported, and the OSS package reproduced at 32.4 two rows up',
      },
      {
        name: 'Graphonomous (QA proxy)',
        value: 0.926,
        grade: 'C',
        recipe:
          'keyword-recall proxy rather than the official judge, on an oracle split — not the same metric',
      },
      {
        // The highest published figure on this benchmark, and the row that ended "the gap to close is 85.8%".
        // Vendor-reported with a stronger reader than any grade-A row, so it may motivate and may not be
        // quoted as a gap: the same vendor publishes 90.2 for the same memory with a GPT-4o reader, which is
        // the row below and the only published figure in this arm's reader class.
        name: 'Recallium (Claude Opus 5.5 reader)',
        value: 0.984,
        grade: 'C',
        recipe:
          'vendor benchmark page, 2026-10-17: 500 questions, Claude Opus 5.5 reader, official GPT-4o grading prompts, 3.8 results handed to the reader per question; six of six disclosure conditions stated. Self-reported and not reproduced',
      },
      {
        // The closest like-for-like row in the table: same dataset, same official judge, a GPT-4o-class
        // reader, and a disclosed depth. It is grade B rather than A only because this arm's judge is its own,
        // which is why "level with Recallium" is the most this row can license.
        name: 'Recallium (GPT-4o reader)',
        value: 0.902,
        grade: 'B',
        recipe:
          'the same vendor run with the official LongMemEval reader script and GPT-4o, official grading prompts, 3.8 results per question — same memory as the row above, differing only in the model that reads it',
      },
      {
        name: 'ContextStream (Claude Opus 5.5 reader)',
        value: 0.968,
        grade: 'C',
        recipe:
          'vendor benchmark page, 2026-10-27: 484 of 500 through the production API, Claude Opus 5.5 reader, official pinned GPT-4o judge, Wilson 95% CI [94.9, 98.0]; the held-out half of the suite reads 96.0% (239/249)',
      },
    ],
    onMiss:
      'Below 91.0% means the shipping configuration gave back the +1.10 points this round certified, and the ' +
      'first thing to read is the ladder rather than the total: `route-room` is ahead of `registered` by ' +
      '0.50 points for `ask: verbatim-acts` and 0.60 for the route room, each measured as its own single-' +
      'variable step, and the two add up to the 1.10 the combined pair reads. A total that drops while both ' +
      'steps hold is a dispatch problem; a total that drops because one step stopped paying is a mechanism ' +
      'that regressed, and the ladder names which. **Do not raise the reader to answer this row** — the ' +
      'reader axis is priced by `M1`, and changing it here would make the number incomparable with every ' +
      'reading in this file. ' +
      'The history matters for the same reason the attestation exists: this row read **83.45%** for three ' +
      'rounds off `summary.json`, which is four *independent dispatches* of a configuration that no longer ' +
      'ships, while the arm it names measured 90.85% on the same 500 questions. The 7.4-point error was not ' +
      'a wrong number — it was a correct number about a different system, which is why the repair is an ' +
      'attestation on the source and not an edit to the figure. ' +
      '**A retracted reading is recorded here rather than deleted**: an earlier version called the 82.4% ' +
      'oracle a reader ceiling and inferred that a seat 1.6 points under it meant retrieval had little left ' +
      'to buy. arXiv:2610.30755 retired that inference — a naive raw-RAG pipeline reads 87.53 with a ' +
      'GPT-4o-mini reader, above the oracle. So 82.4 was a configuration and not a bound.',
  },
  {
    id: 'S2',
    capability: 'knowledge update',
    metric: 'LongMemEval-S knowledge-update category',
    // The denominator is the local regrouping, and the published split is 78. Renaming the dataset to the
    // number the file actually divides by is the whole of this edit's point: a row that says 78 and divides
    // by 72 is a row whose percentage is right and whose population is wrong.
    dataset: 'LongMemEval-S, 72 questions (local regrouping; the published split is 78)',
    comparator: 'at-least',
    threshold: 0.85,
    unit: 'ratio',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: CATEGORY_LEDGER,
      key: 'categories.KU.mean',
      attest: CATEGORY_ATTEST,
    },
    onMiss:
      'Reads 88.5% off the shipping arm, up from the 87.2% the stale file reported. A regression here after a ' +
      'ledger change means the ledger is retiring a fact the judge wanted named -- and the exact interval is ' +
      '**[77.6, 94.1] on 72 questions**, so only a fall of more than about ten points is distinguishable from ' +
      'this population at all. A reading inside that band is a dispatch, not a regression: the first thing to ' +
      'check is that `categories.json` still names the arm and the run, because a stale file is the failure ' +
      'mode this row was re-hung to end.',
  },
  {
    id: 'S3',
    capability: 'multi-session reasoning',
    metric: 'LongMemEval-S multi-session category',
    dataset: 'LongMemEval-S, 121 questions (local regrouping; the published split is 133)',
    comparator: 'at-least',
    threshold: 0.85,
    unit: 'ratio',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: CATEGORY_LEDGER,
      key: 'categories.MR.mean',
      attest: CATEGORY_ATTEST,
    },
    onMiss:
      // The prose that used to be here said "at 69.6% this is the largest deficit" and named retrieval as
      // the cause. Both halves were readings of the dead configuration. The corrected reading is 83.9%, and
      // the correction changes the *kind* of the question: the remaining gap is 1.1 points, and this
      // population's own resolution floor is **9.4 points** at 80% power (Miller, arXiv:2411.00640). So the
      // row cannot be evidence of a deficit, and a threshold 1.1 points above a 121-question reading is
      // decoration in the sense `S1`'s 85% was decoration against 83.45%. The row stays because the number is
      // real and the direction is not: what is measurable on multi-session is a **paired** gain, which is
      // `S8`, and that is why `S8` was registered as a count rather than a ratio.
      "Reads 83.9% on 121 questions, and the 1.1-point gap to the threshold is **inside this population's " +
      'own resolution floor of 9.4 points**, so a miss here is not evidence of a deficit and a pass would not ' +
      'be evidence of a gain. The measurable form of this target is `S8`, which counts paired conversions ' +
      'instead of differencing two ratios: 121 questions cannot see a one-point move, and no number of ' +
      "repetitions changes that, because repetitions divide the reader's noise and not the question sample. " +
      'What a reading here can still do is catch a **large** regression, which is why the row is kept.',
  },
  {
    id: 'S4',
    capability: 'temporal reasoning',
    metric: 'LongMemEval-S temporal-reasoning category',
    dataset: 'LongMemEval-S, 127 questions (local regrouping; the published split is 133)',
    comparator: 'at-least',
    threshold: 0.94,
    unit: 'ratio',
    // Promoted from `aim` to `gate` in the round that re-hung it, for the reason `S1` gives: an aim that is
    // met and left as an aim prints `pass` while blocking nothing. The threshold is derived, not rounded --
    // the arm reads **96.06%**, the four repetitions are 120/122/125/121 of 127, their standard deviation is
    // 2.08 points and the standard error of the mean is 1.04, so 94.0 is **1.98 standard errors** below the
    // measured value. A red gate therefore means a real loss of at least the size of the whole old aim's
    // remaining gap, and the old aim's 85% is now unreachable-by-regression rather than a target.
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: CATEGORY_LEDGER,
      key: 'categories.TR.mean',
      attest: CATEGORY_ATTEST,
    },
    onMiss:
      // The first version of this line said the date-frame pre-registration predicted the recovery.
      // `PREREG-DATE-FRAME.md` §0 withdrew it: the temporal prompt has carried the published anchor
      // ("The question was asked on …") and the per-turn date since the contract existed, so the
      // frame is not a treatment this route can receive. The second version priced the remaining gap as
      // "21 of TR's 33 misses are abstentions" -- a census of a configuration that no longer ships. On the
      // arm this row now reads, temporal reasoning misses **5 of 127**, so the recovery pass has 5 questions
      // of room in total and cannot be the lever at all: a pass that converts 5 would be at the exact
      // ceiling, and `R1` measured the pass at net -1.
      'Red means temporal reasoning gave back more than two standard errors of its own four repetitions. ' +
      'Nothing small can move this row: the exact interval is **[91.1, 98.7] on 127 questions** and 5 ' +
      'questions are wrong in an average repetition, so the remaining headroom is smaller than the interval ' +
      'and the only defensible next step here is to keep it, not to optimise it. The lever this row used to ' +
      'name -- the recovery pass -- had 5 questions of room, and `R1` measured that pass at net -1.',
  },
  {
    id: 'S5',
    capability: 'abstention',
    metric: 'LongMemEval-S abstention subset',
    dataset: 'LongMemEval-S, 30 questions (the false-premise subset; no regrouping here)',
    comparator: 'at-least',
    threshold: 0.8,
    unit: 'ratio',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: CATEGORY_LEDGER,
      key: 'categories.ABS.mean',
      attest: CATEGORY_ATTEST,
    },
    onMiss:
      'Thirty questions is a wide interval -- the exact one at 30 of 30 is **[88.4, 100]** -- so a single run ' +
      'decides nothing and a gate at 80% is a gate against a **collapse**, not against drift. That is the ' +
      'honest reading of a fixed 30-question subset: 0.8 is 6 questions of slack, and the row blocks only the ' +
      'failure that loses a fifth of the subset at once. The difference from the stale file is that this row ' +
      'used to read 96.7% off a configuration that no longer ships, which made 0.8 look like a threshold with ' +
      'room above it; it has 0 wrong answers and no room at all.',
  },

  // ---- the one RAW-RAG stage this arm did not have (§13.115) --------------------------------------
  {
    id: 'S6',
    capability: 'reranking',
    metric: 'questions whose rerank reply was discarded, falling back to the retrieved order',
    dataset: 'LongMemEval-S, 500 questions, one rerank invocation per question',
    comparator: 'at-most',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/rerank-stage.json',
      key: 'census.fallbacks',
    },
    onMiss:
      'This is an invariant rather than a reading, so there is no partial pass: `rerankHits` degrades to the retrieved order on a thrown request, a short reply or a non-finite score, which means an endpoint answering 401 five hundred times and a cross-encoder that agreed every time produce the **same accuracy**. A single fallback therefore makes the paired run unreadable — it is an assembly failure, not a null result — and the answer is to fix the call (credential, model name, declared bounds) and re-dispatch, never to read the delta. The census in the artifact carries `calls` beside it so that a stage which never ran (`calls: 0`) cannot be mistaken for a clean one.',
  },
  {
    id: 'S7',
    capability: 'reranking',
    metric:
      'multi-session correct answers gained by the cross-encoder over the same 128-wide pool without it',
    dataset:
      'LongMemEval-S, 121 multi-session questions, treatment and control paired in one invocation',
    comparator: 'at-least',
    threshold: 3,
    unit: 'count',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/rerank-stage.json',
      key: 'delta.multiSession',
    },
    competitors: [
      {
        name: 'RAW-RAG (their set, reranker on)',
        value: 0.4832,
        grade: 'C',
        recipe:
          'their own 20,000-sample set, k = 15, 256/32-token windows, their reader — a different corpus, which is why the grade is C and the figure prices the mechanism rather than our gap. Their single-variable ablation with Holm correction puts the same pipeline at 44.40 with the reranker removed, so the stage is worth 3.92 points to the pipeline that has it; removing reranking costs them more than any mechanism they added (atomic facts −19.62 and summaries −5.81 are additions that hurt)',
      },
    ],
    onMiss:
      'Two ways to miss, and they are different findings. If `changed > 0` and the multi-session category moves by 3 or fewer, **delete the stage**: a mechanism the strongest published pipeline needs and this arm does not is either a difference in the corpus or a difference in what it is reranking, and both are results rather than reasons to keep it. If `changed = 0` with `fallbacks = 0`, the cross-encoder agreed with the fusion on all 500 questions, which settles the reranking question negatively for this corpus at this pool width — also a result, and also a reason to stop paying for it. The row is not reachable by overall accuracy: a stage that buys 3 questions in one category and loses 3 in another has moved the order without improving the answer, so no capability may fall by more than 2 within the same pair.',
  },

  // ---- the product's own retrieval (§13.380) -------------------------------------------------------
  //
  // `self-index` is the first signal in this campaign where the ranking is built by the **product**. Every
  // other one is a callback `cortex-eval` fills before the run, so the arm has been measuring what the
  // harness can rank, not what the product can. `SearchIndex` has had unit tests and `C5`/`C6` since round 87
  // and no reading on a real corpus, which is exactly the shape of claim this matrix exists to refuse: a
  // capability with evidence only on a fixture is a capability nobody has measured.
  //
  // The row is a **parity** claim and not an improvement claim, on purpose. The harness's index is a dense
  // bi-encoder over the same turns with the same width; the product's is postings over `contentTerms` fused
  // with the same vectors by reciprocal rank, plus two channels instead of one. Which of those wins on 500
  // real questions is not knowable in advance, and a row that promised a win would be a hypothesis with a
  // threshold attached.

  // ---- the instruction the reference pipeline actually runs (§13.123) ------------------------------
  {
    id: 'S8',
    capability: 'multi-session reasoning',
    metric:
      "multi-session correct answers gained by the reference pipeline's aggregation contract, migrated whole, over the registered ask it replaced",
    dataset:
      'LongMemEval-S, 121 multi-session questions, treatment and control on byte-identical windows because flat and temporal are unchanged',
    comparator: 'at-least',
    threshold: 9,
    unit: 'count',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/silent-ask.json',
      key: 'delta.multiSession',
    },
    competitors: [
      {
        name: 'reference pipeline, multi-session (same model, same dataset, smaller window)',
        value: 0.8678,
        grade: 'B',
        recipe:
          'the `reference-pipeline` arm inside every cortex-memory artifact: same DeepSeek reader, same 500 questions, same judge, and a SMALLER window. Its multi-session builder (`buildAggregationQaPrompt`) enumerates in writing under a fixed `item | verb | session date` schema and ends on an `Answer:` cue; this arm has asked for the list since section 13.34 but under a different schema, a different Step 2 and no reply terminator. Section 13.246 corrects the earlier reading, which quoted `conInstruction` — the single-session skeleton — and concluded the reference was silent. That description is historical: section 13.248 adopted `ask=verbatim`, which IS this builder text line for line, so from run `41860773768` onward the two arms differ in the evidence and in the *order* of the prompt, not in its wording. Section 13.278 records the stale-premise defect this row caused, and section 13.279 measures the order',
      },
      {
        name: 'Raw-RAG (naive), overall',
        value: 0.875,
        grade: 'B',
        recipe:
          'arXiv:2610.30755 — timestamps, chunking, dense retrieval and reranking over raw turns, no extraction, no rewriting. The same paper reports 87.53 against the strongest agentic memory system at 87.40, which is what makes a naive pipeline a meaningful bar rather than a straw one',
      },
      {
        name: 'MemCog, multi-session',
        value: 0.925,
        grade: 'C',
        recipe:
          'arXiv:2605.28046 Table 2, MemCog (full) multi-session 92.48 -- the highest published multi-session figure, reached by agentic multi-step retrieval (2-3 ReAct steps per query, capped at 6 tool calls) rather than by a prompt. Grade C because the reader and judge are not reported in a form this arm can reproduce, and because that table copies its baseline rows from two other papers while measuring only its own row, so its 95.80 overall is not a paired difference against the 85.71 it prints for Mastra (whose own report is 94.87); it is here as the ceiling the next phase aims at, not as a comparison',
      },
    ],
    onMiss:
      "Section 13.246 corrects what this row is aiming at. The stage was registered as *the reference pipeline's ask*, and the dispatch that measured it (`silent`) administered an ask the reference does not use: `conInstruction` is the single-SESSION skeleton, and the multi-session path calls `buildAggregationQaPrompt`, which enumerates in writing. So a miss here retires *silence*, not the reference's contract, and `silent`'s -26 is re-read as the price of removing the written list. The corrected target is `ask=verbatim`, the aggregation builder migrated whole, with its own predictions in §13.246.6; the assembly check below still applies unchanged. Given a clean pair on `verbatim` — which `41860773768` supplied at +1.8 questions, and section 13.248.4 reads as exhausting the wording — the axis it leaves is the assembly: section 13.279 dispatches the reference order with the same block, and gate 5 (prompt digests on the 379 questions outside the route) is what stops a movement there being read as a leak. Beyond that the evidence axis stands: — section 13.243.2's partial-coverage band reads 48.7% where the full band reads 89.0%, and the reference never produces that band because it retrieves sessions and truncates per session. If MR does not move and declines rise, the reference's decline licence is the mechanism rather than its enumeration.",
  },

  // ---- the product's own retrieval (§13.380) -------------------------------------------------------
  //
  // `self-index` is the first signal in this campaign where the ranking is built by the **product**. Every
  // other one is a callback `cortex-eval` fills before the run, so the arm has been measuring what the
  // harness can rank, not what the product can. `SearchIndex` has had unit tests and `C5`/`C6` since round 87
  // and no reading on a real corpus, which is exactly the shape of claim this matrix exists to refuse: a
  // capability with evidence only on a fixture is a capability nobody has measured.
  //
  // The row is a **parity** claim and not an improvement claim, on purpose. The harness's index is a dense
  // bi-encoder over the same turns at the same width; the product's is postings over `contentTerms` fused
  // with those vectors by reciprocal rank, plus two channels instead of one. Which of those wins on 500 real
  // questions is not knowable in advance, and a row that promised a win would be a hypothesis with a
  // threshold attached.
  {
    id: 'S9',
    capability: 'self-index retrieval',
    metric:
      "correct answers the product's own index delivers against the adopted harness index, paired by question",
    dataset:
      'LongMemEval-S, 500 questions, one dispatch per signal, the per-question mean of four repetitions compared across the two',
    comparator: 'at-least',
    threshold: -15,
    unit: 'count',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/self-index.json',
      key: 'paired.deltaQuestions',
    },
    competitors: [
      {
        name: 'Mem0 (graph, published)',
        value: 0.6824,
        grade: 'C',
        recipe:
          'mean of four published LongMemEval-S readings in their own harness (68.24, 68.44, 66.88, 68.24); ' +
          'a different reader and a different judge, so the figure locates the axis rather than our gap. What ' +
          'it does establish is that a system whose retrieval is **its own** is scored end to end there, ' +
          'while this campaign has so far scored only what a harness hands the product',
      },
    ],
    onMiss:
      "Below −15 questions the product's own ranking is worse than the harness's by more than the arm's own " +
      'noise floor (1.6–2.2pp, §13.118.5), and the finding is a **defect in the stack** rather than a reason ' +
      'to retire the signal: the two channels are the same vectors plus a lexical one, so a loss that large ' +
      'means the fusion or the postings are mis-weighted, and the repair is `rrfK`, `k` or the lexical ' +
      "channel's term list rather than the switch. Above the threshold, adopt the signal only if " +
      '`selfIndex.embedTexts` per question is at or below the corpus size — a product that pays twice for ' +
      'one corpus has bought nothing with a tie.',
  },

  // §14.143's window. Non-inferiority rather than a win, because the mechanism spends the **same**
  // characters: it can move accuracy only by printing a better sentence, and a row that promised a gain
  // would be a hypothesis with a threshold attached. The negative form is the number that matters --
  // below −5 questions (one point on 500) the window costs more than the head it replaced, and the
  // family closes the way `C6`'s did.
  {
    id: 'S10',
    capability: 'turn window',
    metric:
      'correct answers at `turnWindow=match` against the registered configuration, paired by question, at the same cap and the same bill',
    dataset:
      'LongMemEval-S, 500 questions, four repetitions per side, one dispatch each, the per-question mean compared across the two',
    comparator: 'at-least',
    threshold: -5,
    unit: 'count',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/turn-window.json',
      key: 'paired.deltaQuestions',
    },
    competitors: [
      {
        name: 'Mem0 (published)',
        value: 94.4,
        grade: 'C',
        recipe:
          'vendor figure at ~6.8K context tokens per question, produced by single-pass **extraction** rather than by ' +
          'rendering turns; the axis this row sits on is therefore not theirs to win -- what it locates is that a ' +
          'system can beat a verbatim window by choosing what text it prints, and that the cheapest version of that ' +
          'choice is a window inside a turn rather than an extraction call per turn',
      },
    ],
    onMiss:
      'Below −5 questions the window loses more than it recovers, and the reading is a falsification of the lexical ' +
      'anchor rather than of windows in general: the mechanism that would survive it is one that ranks **sentences** ' +
      'rather than placing a span around a match (the `dispatch2` artefact in `MEASURE-READING-STAGE.md` §203 is the ' +
      'published shape, at +4.0pp on the same capability). Above the threshold it earns its place beside ' +
      '`turnCutMarker`, and the pair is read together: a window that starts mid-turn is a cut the reader cannot see, ' +
      'which is the `a4996e51` defect with a different offset.',
  },

  // ---- the cost dimension, which had no row until the 2026-10 board printed a context column -------
  {
    id: 'C1',
    capability: 'cost',
    metric:
      'prompt tokens delivered to the reader for one question, one repetition, retries included',
    dataset:
      'LongMemEval-S, 500 questions, four repetitions, feature arm only, registered configuration',
    comparator: 'at-most',
    threshold: 6000,
    unit: 'count',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/cost.json',
      key: 'readings.perQuestionPerRun',
    },
    competitors: [
      {
        name: 'Zep',
        value: 4400,
        grade: 'C',
        recipe:
          'vendor figures as published 2026-10: 90.2% accuracy at about 4.4K context tokens per question (0.6x the 115K corpus). Run data and harness are not public, so the token figure is a claim rather than a reproduction — quoted because it is the cheapest published point on the board and therefore the bar any cost claim has to clear',
      },
      {
        name: 'Mem0 (managed)',
        value: 6800,
        grade: 'C',
        recipe:
          'vendor memory-benchmarks repository: 94.4% at a top-200 retrieval budget, about 6.8K tokens per question. Reader and judge are not stated at claim level and the open-source package measures about 32% on the same suite, so the token figure travels with a configuration this arm cannot rebuild',
      },
      {
        name: 'Maximem Synap',
        value: 7400,
        grade: 'C',
        recipe:
          'vendor page 2026-10-28: 95.6% (478 of 500) at about 7.4K memory tokens per question, Gemini 3.8 Flash reader, public per-question run data — the highest published accuracy at a published cost, and the row that makes 11.7K indefensible',
      },
      {
        name: 'Hindsight',
        value: 43600,
        grade: 'C',
        recipe:
          'vendor comparison page: about 43.6K tokens per retrieval against under 7K for Mem0, i.e. the accuracy leader near the top of this table buys its 94.6% with 5.9x the context. Included because it is the counter-example that stops this row being read as "accuracy costs nothing"',
      },
    ],
    onMiss:
      'Measured, not aimed at: the reading is 9,201 on the registered configuration, 1.53x the threshold and 2.09x Zep\u2019s published 4.4K. It read 12,137 for a round, because the file named the run of a room map that had stopped shipping -- see the sixth point below, which is the correction rather than a caveat. Four things must not be read off this miss. First, the number is generated by `tools/cost-ledger.py`, which names its division (per question per repetition, retries included) because the same artifact yields 11,690 per call and 48,420 per question across all four repetitions \u2014 a 4.14x spread from one token count and three defensible divisions, and a row that does not state one lets every reader pick a different deficit. Second, it is not a reason to shrink the window: the reading sits at the arm\u2019s own `maxPromptChars: 48000` (48,000 characters at 4.11 characters per token is 11,680, i.e. the delivery fills the window rather than selecting from it), and section 13.291 measured that delivering every gold turn \u2014 98 of 121 questions to 120 of 121 \u2014 moved accuracy by exactly zero. So the extra room is not what the missing points are made of, and the repair is the budget UNIT (characters, section 13.287.2: the same budget buys 2.62x more tokens when written in tokens) rather than the budget size, with any cap change verified by a run because \u201cthe tokens are wasted\u201d is a prediction and not yet a measurement. Third, it is not comparable to any competitor row above 6.8K unless the reader is the same, and none of them is: a stronger reader that also declines to be terse can spend more tokens and score lower, which is section 13.232\u2019s IE result in the other direction. Fourth, cache hits are not a discount on this row: 18,933,570 of the 24,209,976 prompt tokens were cache hits, which changes the bill and not the context the reader had to read. The row exists so that the next increment that changes the room has to say what it did to this number. Fifth, and this one was written after the row was read: `42373407439` shrank the window to 24,000 characters and the reading on it is **5,623 tokens per question**, so the threshold above is reachable -- at **-3.20 accuracy points**, which `A` refused. The fall is not spread: `MR -6.61` and `TR -4.72` against `ABS 0.00`, `IE -0.67`, `KU -1.39`, on a run where every capability lost about half its turns. So the sentence above -- that shrinking the window is not the repair -- was right about the whole window and wrong about the parts: a **per-route** room is close to free on the 252 questions whose answer lives in one turn and expensive on the 248 that count over turns. `docs/PROMPT-ROOM-IS-LOAD-BEARING.md` records the reading and §13.302 registers the arm; this row kept its 12,137 while the registered configuration had not moved, and a met cost row at a room the accuracy registration refuses is a boundary rather than a licence. Sixth, and this is the correction rather than a caveat: **the registered configuration moved and this row did not follow it.** Section 13.336 adopted the six-route room map, and `cortex-docs/evidence/longmemeval/cost.json` went on naming `42355323615`, which delivered 12,137 tokens per question under the map it replaced. The registered configuration bills **9,201** (`42533236864`, four repetitions, 18,401,041 prompt tokens over 2,076 calls), so the row was overstating the bill by **24.2%** for a round while being a correct record of a real run. That is §2.2\u2019s defect class one axis further: there four accuracy rows read a configuration that no longer shipped, here the bill did. The repair is not this paragraph -- `tools/cost-ledger.py --write` now refuses an artifact whose configuration fingerprint is not `tools/arm-config-baseline.json`\u2019s, so the file cannot outlive an adoption, and `tools/acceptance-check.mjs` fails the build when a committed evidence file names another configuration.',
  },

  // ---- the browser axis, which the plan called "maturity" and no row priced ------------------------
  //
  // Requirement 9 puts product maturity ahead of the SOTA chase, and until these two rows the only
  // statement of it was the number 24/24 inside three documents. A number in a document is not a
  // criterion: nothing recomputes it, so a suite that loses a check keeps reading 24/24 in prose while
  // the artifact beside it says 23. The artifacts already exist and are already regenerated in CI
  // (`guard:browser` compares committed against fresh), so these rows cost nothing and close the gap.
  //
  // Why `failed` rather than `passed`: a `passed: 24` threshold hard-codes the size of the suite, so the
  // next person to add a check either breaks a gate or edits a threshold, and both of those are
  // indistinguishable from lowering the bar. `failed: 0` is scale-free.
  {
    id: 'B1',
    capability: 'browser persistence',
    metric: 'checks that failed in the committed Chromium reading',
    dataset:
      'cortex-storage browser suite: 24 checks over 2,000 rows, OPFS and IndexedDB tiers, restart and reopen',
    comparator: 'equals',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex/packages/cortex-storage/test/browser/last-run.json',
      key: 'summary.failed',
    },
    onMiss:
      'A non-zero count means the committed reading describes a tree that no longer works in Chromium, so the browser claim in the whitepaper is false as of this commit. The repair is not to edit the number: re-run `pnpm test:browser`, commit the fresh reading, and if the failure is real fix the tier. `guard:browser` is the companion check — it answers "does the committed reading still match a fresh run", which is a different question from "did the fresh run pass", and a reading can be stale and green or fresh and red.',
  },
  {
    id: 'B2',
    capability: 'browser persistence',
    metric: 'checks that failed in the committed Firefox reading',
    dataset: 'the same suite on a second engine, so the tier is not a Chromium artifact',
    comparator: 'equals',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex/packages/cortex-storage/test/browser/last-run-firefox.json',
      key: 'summary.failed',
    },
    onMiss:
      'Same repair as B1. It is a separate row rather than a sum because the two engines fail for different reasons — Firefox has no `createSyncAccessHandle` on the main thread, so a tier that degrades silently on Chromium can be outright absent here — and a summed count would let one engine fail while the total looked plausible.',
  },

  // ---- cost, part two: the criterion section 13.297.7 said was registered and was not ---------------
  //
  // This row exists because a document claimed it did. `PREREGISTRATION` 13.297.7 states "the
  // adaptive-budget criterion is `C2`, and it is an aim with no reading" and that it "is registered as
  // an aim". It was not registered. A prose claim that a criterion exists is the failure mode the
  // matrix was built for, one level up: not a number drifting from its code, but a *criterion* existing
  // only in prose. Nothing would have caught it, because nothing reads a paragraph.
  //
  // `C1` prices the current window. This row prices the change to it, and it is two-sided on purpose:
  // the outside board's finding is that a system can buy accuracy by retrieving more, so a token cut
  // that costs accuracy is not a win. Both halves must hold, and the matrix holds one number, so the
  // number is the tokens and the accuracy half lives in `onMiss` as a precondition rather than a wish.
  {
    id: 'C2',
    capability: 'cost',
    metric:
      'median evidence tokens per question, as a fraction of the registered configuration, with overall accuracy held',
    dataset: 'LongMemEval-S, 500 questions, paired against the registered configuration',
    comparator: 'at-most',
    threshold: 0.7,
    unit: 'ratio',
    kind: 'aim',
    // The numerator arrived. `42373407439` is the same 500 questions, the same reader and the same
    // judge with one field moved -- `max_prompt_chars` 48,000 -> 24,000 -- and the median prompt
    // characters per question went `46,926 -> 22,830`, a ratio of **0.487**. The source moved from the
    // registered arm's self-ratio (1.0000 by construction, `paired: false`) to a file that names both
    // runs, so the number on this row is now a comparison rather than a denominator.
    //
    // It is a pass with a cost that another row refuses, and the row must not be read alone. The first
    // version of that cost sentence said **3.20 points** and named two capabilities, and both halves
    // were wrong for the same reason: the control it was read against (`42355323615`) moves `ask` as
    // well as the window, so the deltas belonged to the pair. Against the arm that differs in exactly
    // one field (`42310779222`), and on the population `report.ts` says to read
    // (`ablation.featureAggregate.avg`, not `feature.metrics`), the cut reads **-2.65 overall** and
    // **TR -4.53**; `IE -2.33` and `MR -2.27` sit inside the 2.5-point margin and only those two block. `room-cut.json` now carries both pairings and says which
    // question each answers; `tools/efficiency-frontier.mjs` refuses to certify a pair that differs in
    // more than one field, which is the check that makes the mistake unavailable rather than regrettable.
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/room-cut.json',
      key: 'ratio.ratio',
    },
    // No competitor row: this criterion's unit is a *fraction of our own window*, so an absolute token
    // figure from another system cannot be placed in it — 4,400 tokens is 48% of 9,201 and 0% of the
    // number a reader would think it was looking at. The absolute figures stay on `C1` where they print
    // as tokens, and the one comparison that matters here (ours against ours at two budgets) has no
    // external counterpart because no vendor publishes a paired budget ablation.
    onMiss:
      'Registered so that the next increment touching the budget has to state what it did to this number, not so that it can be met by cutting. The precondition is the first half of the sentence: overall accuracy at or above the registered configuration on the same 500 questions. A 30% cut that costs two questions is a miss, not a pass, and the honest reading of that outcome is section 13.291 — delivering every gold turn bought +0.00, so evidence *volume* is not what the missing points are made of, which makes a cut safe in principle and unmeasured in fact. ' +
      'The unit change section 13.293.2 asked for is done, in the sense that matters: `tools/evidence-budget.py` reads the per-question records (`promptChars` against `deliveredPromptChars`), measures the characters-to-tokens factor from the artifact instead of inferring it from the cap (4.06 on `42355323615`, against the 4.11 the cap implied), and reports the median evidence in tokens. What the row still lacks is the *numerator*: the artifact it reads is one arm at the registered configuration, so the ratio is 1.0000 by construction and the file records `paired: false`. A ratio of one is a denominator, not a result — it says the registered budget is 100% of itself and that the 0.70 bar is unmet, and it cannot say anything about a reduced arm until one is dispatched. Reading the two claims apart matters: this row moved from "no instrument" to "instrument, denominator, named arm", and it has not moved at all on the quantity it measures.',
  },

  // ---- the shipping decision, made by the same instrument that reads the arms ----------------------
  //
  // The frontier was a report and is now a gate. `C1`-`C3` price a *candidate*; nothing priced the
  // answer to "should the candidate replace what we ship", which is the only decision the frontier
  // exists to inform. Six arms have been read at full 500 with four or two repetitions and none of them
  // dominates the configuration on the order. Round 57 is what makes the count mean that: the reference
  // is now the registered configuration, and before the re-hang it was `42310779222`, which is not what
  // ships. So the row used to report dominance over an arm nobody was running, and the arm that *is*
  // running would have been counted as a candidate to adopt rather than as the thing on the box.
  //
  // The count, not the verdict list, because a gate reads a number. `summary.dominating` is computed by
  // `tools/efficiency-frontier.mjs` from the artifacts rather than typed here, and it is 0 only while
  // every measured arm is either worse on a blocking reading or incomparable.
  {
    id: 'C4',
    capability: 'cost',
    metric: 'measured arms that dominate the shipping configuration on the three-axis order',
    dataset:
      'every full-500 arm this project has read, compared against the registered configuration',
    comparator: 'equals',
    threshold: 0,
    unit: 'count',
    kind: 'gate',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/frontier.json',
      key: 'summary.dominating',
    },
    onMiss:
      'A non-zero count is not a measurement problem, it is a shipping problem: an arm that answers at least as well on every gated capability, reads less, and does not cost more has been built and is not the one on the box. The repair is to adopt it or to state in this row what it does not do that the shipping arm does. ' +
      'Two things this row cannot see, stated so it is not read as more than it is. It counts only arms this project has dispatched, so it says nothing about a competitor. And it inherits the pair rule: `tools/efficiency-frontier.mjs` forces `incomparable` when the two artifacts differ in more than one configuration field, so an arm that would dominate on a two-variable comparison is counted as zero here — the count is conservative, which is the direction a gate may err in.',
  },

  // ---- the third cost axis: what the saving costs to run -------------------------------------------
  //
  // `C1` prices the context and `C2` prices the cut, and both are silent on the only number a customer
  // pays. The two dispatches that produced `C2` produced the reading this row exists for, and it is not
  // the reading either of them could give: `42373407439` reads **6,077** context tokens per question
  // against **12,105** on `42310779222` — 0.502x — and **3,036 billed against 2,828**, 1.074x. Halving
  // the window broke the prefix cache (51.07% hits against 78.21%) and a hit is charged at 2% of a miss,
  // so the arm that reads half as much costs 7.4% more to run. `C2` reads that configuration as a met
  // budget with a named accuracy cost; this row says the money went up, and both sentences are true.
  {
    id: 'C3',
    capability: 'cost',
    metric:
      'billed prompt tokens per question at a reduced context budget, as a fraction of the registered configuration',
    dataset: 'LongMemEval-S, 500 questions, `42373407439` against `42310779222`',
    comparator: 'at-most',
    threshold: 1.0,
    unit: 'ratio',
    kind: 'aim',
    source: {
      kind: 'artifact',
      path: 'cortex-docs/evidence/longmemeval/frontier.json',
      key: 'summary.matched.billedTokenRatio',
    },
    onMiss:
      'The criterion is registered and the reading is **blocked**, which is the state this row is in rather than a value. The only reduced-budget arm that exists (`42373407439`, 6,077 context tokens per question) ran **two** repetitions against a control that ran **four**, and the cache-hit share is a function of the repetition count: one repetition misses, the rest hit. The two artifacts read 51.07% against 98.34%, and 51.07% is what "one miss, one hit, equal-sized prompts" produces. So the bill they imply is a measurement of `runs` wearing the name of a cost, and `tools/efficiency-frontier.mjs` excludes it (the library reports `billComparable: false`) rather than printing a column a reader would quote. ' +
      'Equal `runs` is necessary and **not sufficient**, and that is this round finding rather than a caveat. `42310779222` and `42355323615` both ran four repetitions over the same 24.2M prompt tokens and read **78.21%** and **98.34%** hits, which prices as a **0.156x bill on a 1.003x context**. The three-axis order as first written read that pair as `dominates`: a dominance claim manufactured entirely by the prefix cache, on two dispatches of one system. The bill therefore keeps its veto and loses its vote — a risen bill can refuse a context saving, and a fallen bill can never be the reason an arm is called better, because the only thing that would have to be true for it is a stable cache, which those two artifacts disprove. ' +
      'What unblocks the reading is one dispatch: `A3` (`docs/PLAN-COMPETITOR-ABLATION.md`) at **four repetitions**, which makes `C3` readable, makes `C2` sharp at a room the accuracy registration accepts, and gives the accuracy axis a paired partner at equal `runs`. Until then the honest statement is that this project does not know whether its cheaper-looking configuration is cheaper, and it knows exactly why it does not. ' +
      'One thing this row does not claim. It is not comparable to a competitor: no vendor publishes a cache-hit share, so `Zep 4.4K` is a context figure and stays on `C1` where it is one.',
  },

  // ---- two rows the product needs and the campaign has never measured ------------------------------
  //
  // Requirement 11 asks that a deployment on a third provider not stay silently worse; requirement 12
  // asks that the strong reader beat the weak one. Both are stated here as aims with a recipe rather
  // than left as properties the architecture is said to have. `M1` gained a generated reading in round
  // 60 (below); `P1` still has none, because the second provider answers 1.41 questions per minute and
  // a 500-question dispatch on it is five times the run budget. The outside evidence says what to expect: one vendor measured +10.64 points from a reader
  // swap on a fixed memory system, and a 12-system study found the swap moves the level and barely the
  // order. So a *negative* delta here is not variance — it is a prompt-contract defect.
  {
    id: 'M1',
    capability: 'reader strength',
    metric:
      'accuracy points gained by the reasoning reader over the non-reasoning one, paired, same configuration',
    dataset: 'LongMemEval-S, 500 questions, one dispatch, two arms, prompt bytes held',
    comparator: 'at-least',
    threshold: 0.03,
    unit: 'points',
    kind: 'aim',
    source: {
      kind: 'artifact',
      // Round 60: the pair is generated rather than narrated, because the row read prose for three
      // rounds while three different pairs existed in three different sections. `tools/reader-ladder.py`
      // takes the two artifacts and writes the four quantities below, and `tools/reader-ladder.py`'s own
      // refusals are what makes the file trustworthy: different populations, different repetition counts
      // and non-identical prompts are `SystemExit`, not warnings.
      path: 'cortex-docs/evidence/longmemeval/reader-ladder.json',
      key: 'reasoningGainPoints',
      // `reasoningGainPoints` is `reasoning - non-reasoning` with the reasoning side named in the file,
      // because `deltaPoints` is `treatment - control` and a row that read that directly would print a
      // negative gain every time the reasoning reader was the control.
      //
      // The three attestations are the admissibility conditions, not decoration. A pair whose prompts
      // differ on any question is not a reader comparison at all, and a pair drawn at two repetitions or
      // on 200 questions is a comparison of two instruments — each becomes `stale`, which the release gate
      // counts as missing rather than as a pass.
      attest: [
        { key: 'promptIdentity.differ', equals: 0 },
        { key: 'promptIdentity.missing', equals: 0 },
        { key: 'control.runs', equals: 4 },
        { key: 'control.questionCount', equals: 500 },
      ],
    },
    competitors: [
      {
        name: 'Mastra OM, reader ablation',
        value: 0.1064,
        grade: 'B',
        recipe:
          'the vendor\u2019s own single-variable pair: the same memory system at 84.23% with a `gpt-4o` reader and 94.87% with `gpt-5-mini`, judge held at `gpt-4o`',
      },
      {
        name: 'full-context GPT-4o, chain-of-note',
        value: 0.034,
        grade: 'A',
        recipe:
          'the benchmark paper\u2019s own ablation: 60.6 to 64.0 on the S variant, 87.0 to 92.4 on the oracle variant — a reading-side change on a fixed corpus, which is the same shape as this row',
      },
      {
        name: 'Agent Zero Memory, eight-backbone range (a bound, not a pair)',
        value: 0.034,
        grade: 'B',
        recipe:
          'arXiv:2608.29606 section 5.3: with the memory, retriever and control logic held fixed and only the backbone varied across eight model families, LongMemEval accuracy spans **3.4 points** while per-query cost spans about 30x. Recorded as a *range* and not as a pair, and that is the reading: the largest reader effect the strongest published system can find, on its own harness, is the same size as this row\u2019s threshold \u2014 so +3.0 here is at the top of the field\u2019s entire observed spread rather than comfortably inside it',
      },
    ],
    onMiss:
      'Three points is above this arm\u2019s measured noise floor (1.6–2.2) and far below the +10.64 the outside world reports, so a miss is a defect rather than a tight threshold. Two known causes, in the order they should be checked. First, the prompt contract: `AUDIT-READER-THINKING-REVERSES.md` found that the same knob measured −12 questions in section 13.197 and +23.50 in the pair above, on byte-identical prompts, which means the *routes* the thinking is enabled on decide the sign — a reasoning reader applied to extraction is a reasoning reader spending tokens on reformatting. Second, the decline licence: if the stronger reader declines less, `R1` reopens. A negative delta is not a reason to lower the threshold; it is a reason to read the per-category table before the aggregate.',
  },
  {
    id: 'P1',
    capability: 'provider portability',
    metric:
      'accuracy points lost against the reference provider, same reader class, same 500 questions',
    dataset: 'LongMemEval-S, one dispatch, two providers, prompt bytes held',
    comparator: 'at-most',
    threshold: 0.02,
    unit: 'points',
    kind: 'aim',
    source: {
      kind: 'unrun',
      reason:
        '`AUDIT-MODEL-PORTABILITY.md` section 7 has the ratio this needs — between-provider variance against within-provider variance — and states that it has never been measured. Until it is, portability is an architectural claim with a test design and no reading',
    },
    competitors: [
      // This field was empty for two rounds on the argument that every published portability claim in this
      // field is a vendor sentence ("works with any model") and a sentence is not a value. That argument
      // held until a paper published the pair: `arXiv:2610.05343` reports its own second-provider reading
      // on byte-identical packets, which is the same shape as this row and the same unit. The argument is
      // recorded rather than deleted, because the next person to look will make it again.
      {
        name: 'MemStrata, GLM 5.3 flash against its reference reader',
        value: -0.002,
        grade: 'B',
        recipe:
          'arXiv:2610.05343: on identical packets, `462` against `463` of 500 \u2014 one question, \u22120.2 points \u2014 with the paper\u2019s own non-inferiority bound of 3 points, and a second provider (`Muse Spark 1.3`) that did **not** show non-inferiority on 269 questions. Grade B because the packets are the paper\u2019s own and the reader class is not stated in a form this arm can rebuild',
      },
    ],
    onMiss:
      'The bar is now calibrated against two published readings rather than against a wish: one provider swap worth \u22120.2 points, and one that failed a 3-point non-inferiority bound on 269 questions. A miss above 2.0 is therefore not "variance" \u2014 it is the larger of the two published outcomes, which says the prompt contract is carrying a provider assumption somewhere. The row exists because "provider-agnostic" is a property of the interface and not of the score, and the gap between those two has been the whole subject of `AUDIT-MODEL-PORTABILITY.md`. Two mechanisms make a miss survivable without making it silent: the 12-probe capability set (no ground truth, 30–60 calls) classifies a new reader before it is used, and the one-way degradation guard downgrades on observable signals and never upgrades. A miss with both in place is a *known* degradation; a miss with neither is a deployment that is worse and cannot say so.',
  },
];

/** What the checker found for one criterion. Filled in by the runner, never by hand. */
export type Evaluation = {
  readonly id: string;
  readonly current: number | null;
  /**
   * Four states, and the fourth is the one this file learned last.
   *
   * `pass` and `fail` are computed and compared. `unrun` means the value could not be computed at all.
   * **`stale` means the value was computed, and the artifact it came from says it describes a different
   * system** — a different configuration, a different population, a different repetition count. It is not a
   * pass, because the number is about something else; it is not a fail, because nothing regressed; and it is
   * not `unrun`, because the run exists and its number is known. Collapsing it into any of the three is the
   * failure that produced an eight-and-a-half-point error in this matrix's own headline row.
   */
  readonly status: 'pass' | 'fail' | 'unrun' | 'stale';
  /**
   * Whether this miss should stop a build.
   *
   * False for an aim and for an accepted miss, true for a gate that broke. The rule lives here rather than in
   * the checker so that the judgement is reviewable beside the criterion it applies to.
   */
  readonly blocking: boolean;
  /** Why it is unrun or stale, when it is. Empty otherwise. */
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
  /**
   * Reads any value out of the same artifact, for attestations only.
   *
   * Separate from `artifact` rather than a widening of it: `artifact` is typed `number | undefined` because
   * every reading is a number, and a reader that also had to invent a value for a string would be a reader a
   * caller can get subtly wrong. Optional, and its absence is reported as `stale` rather than as a pass —
   * an unverifiable attestation is not a satisfied one.
   */
  readonly artifactRaw?: (path: string, key: string) => unknown;
  readonly arm: (arm: 'no-memory' | 'flat' | 'annotated' | 'gated') => number;
  readonly gap: () => number;
  readonly floor: () => number;
  readonly leak: () => number;
  readonly ablation: (removed: string) => number | undefined;
};

/**
 * Whether a reading's artifact still describes the system this build ships — `null` when it does.
 *
 * The rule is one comparison per clause and no interpretation: the artifact carries a field, the criterion
 * says what that field has to be, and a difference makes the *reading* stale rather than the artifact wrong.
 * A file can be a perfectly good record of a configuration three increments old, and the only defect is that
 * a criterion pointed at it.
 */
export function attestationOf(criterion: Criterion, resolve: Resolvers): string | null {
  const { source } = criterion;
  if (source.kind !== 'artifact') return null;
  const clauses = source.attest;
  if (clauses === undefined || clauses.length === 0) return null;
  const read = resolve.artifactRaw;
  if (read === undefined) {
    return `no raw reader is configured, so ${describe(source)} cannot be checked against its attestation`;
  }
  for (const clause of clauses) {
    const actual = read(source.path, clause.key);
    if (actual !== clause.equals) {
      return (
        `${source.path}#${clause.key} reads ${JSON.stringify(actual ?? null)} and the criterion needs ` +
        `${JSON.stringify(clause.equals)}: the artifact still records a measurement, but not of the ` +
        'configuration this row is about'
      );
    }
  }
  return null;
}

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
    case 'floor':
      return resolve.floor();
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
export function verdictOf(
  criterion: Criterion,
  current: number | null,
  stale: string | null = null,
): Evaluation {
  // Stale is checked first and swallows both branches, because a reading can be present *and* about the
  // wrong system. Returning it as a number would put a stale figure in the `current` column with no marker
  // beside it, which is exactly how 83.45% survived three rounds as the headline.
  if (stale !== null) {
    return { id: criterion.id, current, status: 'stale', blocking: false, note: stale };
  }
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
    case 'floor':
      return 'floor:flat-no-memory';
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

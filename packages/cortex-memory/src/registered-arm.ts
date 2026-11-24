/**
 * The arm the registration measured, as the product's own record of it.
 *
 * ## The defect this file exists for
 *
 * `tools/arm-config-baseline.json` records the configuration one 500-question dispatch applied
 * (`S16`, run `44017278305`, **91.25%**). `packages/cortex-eval` reads that configuration from the
 * environment the workflow sets, and `rooms.ts` pins **one** of its thirty-seven fields to this
 * file's neighbour. The other thirty-six had no product-side counterpart at all, so the product
 * could ship a different arm than the one it published a number for and nothing failed:
 *
 * | field | the registration | what a bare `assembleMemory` did |
 * | --- | --- | --- |
 * | `promptContract` | `evidence-blocks-unsourced` | `abstention` (`prompt.ts`'s own default) |
 * | `ask` | `verbatim-acts` | absent, i.e. each route's reference block |
 *
 * Two of the campaign's adopted levers — §12.5's contract and §13.291's ask — were therefore
 * **unreachable from the published composition root**: `AssembleOptions` had no field for either, so
 * a customer calling `assembleMemory({ llm })` got the reference rendering at the reference
 * instruction, which is not a cell any of `S15`/`S16` priced.
 *
 * That is the same class as `assemble-rooms.test.ts` records for the room table, one level wider:
 * the mechanism that keeps a *release* equal to a *measurement* existed for one field and not for the
 * rest. This file makes it the arm rather than a field.
 *
 * ## What is here and what is deliberately not
 *
 * {@link REGISTERED_ARM} holds the fields the **product** decides: an option, a default, or a
 * rendering the published entry chooses. {@link REGISTERED_ARM_ELSEWHERE} holds the other fourteen
 * with the class each belongs to and why it cannot be compared — the partition `arm-config-record.py`
 * already imposes on the artifact side, applied here so that a field added to the artifact without a
 * decision is a **red build** rather than a silently uncompared row.
 *
 * The four classes are that tool's, not new vocabulary: `derived` (a function of a projected field,
 * so comparing it would report a second violation for one defect), `census` (counted after the
 * questions were answered, so two runs of one configuration disagree there by design), `identity`
 * (resolved at run time from an environment the artifact cannot see), and `constant` (fixed by the
 * workflow or a module default, so there is no second copy to disagree with).
 *
 * ## Why a constant in the product rather than a file it reads
 *
 * `tools/` does not ship (`files: ["dist"]`). A release that could only learn which arm it is from a
 * path outside the package would make "what ships is what was measured" a property of the checkout.
 * The table is duplicated by necessity and kept equal by a gate — `registered-arm.test.ts` reads
 * `tools/arm-config-baseline.json` and fails on any disagreement **in either direction**, so a
 * re-recorded arm that forgot this file is red in CI rather than silently shipping.
 *
 * ## The discipline this table inherits from the room table
 *
 * Changing a value here is an **adoption**, not an edit: it needs a dispatch that priced the change
 * and a row in `docs/ACCEPTANCE-MATRIX.md`. `rooms.ts` carries the history of what happens when it is
 * treated as an edit — §13.345 widened one route and §13.347 reverted it after a 500-question
 * confirmation run read 90.15% against 91.20%.
 */
import type { EvidenceAsk, PromptContract } from './prompt.js';
import type { TurnCapRoute } from './types.js';
import { REGISTERED_ROOMS } from './rooms.js';

/**
 * The shipping arm, field for field as `tools/arm-config-baseline.json` spells it.
 *
 * Names are the artifact's, not the option's, and that is deliberate: the gate compares this object
 * against `memoryArmConfig` key by key, so a rename on either side is a compile-or-test failure
 * rather than a comparison that silently stops running. Where the product's spelling differs the
 * difference is stated in {@link REGISTERED_ARM_ELSEWHERE} or in {@link PROJECTED_ARM_FIELDS}, and
 * never absorbed by a synonym.
 */
export const REGISTERED_ARM = {
  /** §13.291/§13.318. `verbatim-acts` reaches `multi-session`, `flat`, `temporal` and `abstention`. */
  ask: 'verbatim-acts' as EvidenceAsk,
  /**
   * Which admission signal the value gate reads. `none` is the identity gate `assembleMemory` starts
   * from: admission keeps everything, so a difference between two runs is a difference in the
   * mechanisms above it rather than in a gate nobody named.
   */
  confidenceSignal: 'none',
  /** The `KU` conflict block (§11) is off in the registered arm and has no reading of its own yet. */
  conflicts: false,
  /**
   * §13.83/§13.84's role filter: user turns only, on the two routes below.
   *
   * ## Why these two are here, and the order they arrived in
   *
   * They were `REGISTERED_ARM_UNSHIPPED`'s last two rows, and they were the longest-lived ones: §13.84 adopted
   * `['user']` on `multi-session,temporal` with no capability regressed, every reading from `S16` onwards was
   * taken with the filter on, and the published entry point had no field for it. A caller assembling the
   * product therefore printed the assistant turns four screening runs paid to exclude — the same defect
   * `ask` and `promptContract` had, one mechanism over, and the one `assemble.ts`'s role block now closes.
   *
   * The order matters and is recorded because it is the order this table prescribes: the classifier and the
   * three fields were forwarded first (`assemble-role-filter-reach.test.ts` proves the filter reaches the
   * renderer through two different routes), the default was taken only where a classifier exists, and only
   * then did the rows move up. What makes the last step an adoption rather than an edit is that it changes the
   * bytes of every prompt whose corpus holds a non-user turn under a caller-supplied classifier — which is
   * why the default is conditional: a caller with no classifier has no role to read, and the product says so
   * in the census rather than guessing at a corpus format.
   *
   * ## Why `'all'` is not the opt-out
   *
   * The opt-out is `evidenceRolesRoutes: []` — a filter that reaches nowhere. A sentinel value would give this
   * field two meanings (`no filter` and `the role named all`), and the workflow's own input already spells the
   * unfiltered arm as *absence*, which is what every artifact before §13.84 records.
   */
  evidenceRoles: ['user'] as readonly string[],
  /** The two routes the filter stops at. §13.72's split, one mechanism over. */
  evidenceRolesRoutes: ['multi-session', 'temporal'] as readonly TurnCapRoute[],
  /** `S16`'s table: `multi-session` 48,460 characters, the other five 24,000. */
  maxPromptCharsByRoute: REGISTERED_ROOMS,
  /**
   * §13.67/§13.68's width, and the two routes it reaches. The rendering every reading from `S9` onwards
   * was taken under.
   *
   * ## Why these two are here rather than in the unshipped table
   *
   * They were the unshipped table's first two rows: the fields existed, the reach reached the renderer, and
   * a bare `assembleMemory` still rendered every turn whole because nothing defaulted either. That is not a
   * capability the product lacks -- it is the composition root assembling a cell no dispatch priced, which
   * is the defect this file exists for, arriving one field lower. `assemble.ts` now resolves the pair on the
   * room table's rule (nothing named -> the registration, one named -> that one, `minimal` -> neither), and
   * `registered-arm.test.ts`'s tripwire became the positive assertion that a bare call cuts where the
   * registration cuts.
   *
   * Their history is recorded because the value may move: `tools/turn-width.mjs` replays the allocator and
   * puts this dataset's coverage maximum at **600**, and the reading that decides whether the width moves is
   * a dispatch rather than this table. When it moves, it moves here and in `tools/arm-config-baseline.json`,
   * and the paired gate in `registered-arm.test.ts` fails until both agree.
   */
  maxTurnChars: 400,
  /** The two routes the width stops at. §13.72 is why the other four are left whole. */
  maxTurnCharsRoutes: ['multi-session', 'temporal'] as readonly TurnCapRoute[],
  /** §12.5's rendering. Every reading from `S9` onwards was taken with it. */
  promptContract: 'evidence-blocks-unsourced' as PromptContract,
  /** No query expansion in the registered arm; §13.68 measured the widening and did not adopt it. */
  queryExpansion: 'none',
  /** The width the product's own index scores per question (§13.27). */
  relevanceTopK: 256,
  /** Turns rather than characters, because the ranking scores turns. */
  relevanceUnits: 'turn',
  /** The bare retry's repair pass is off: a re-ask is not a repair (§13.73). */
  replyRepair: 'off',
  /** No cross-encoder. The product's own index is the only ranker, which is what `self-index` names. */
  rerank: 'none',
  /** The identity retrieval gate, on `assemble.ts`'s measurement note. */
  retrievalThreshold: 0,
  /** §13.92's bare decline is part of the registered arm and is what the abstention route reads. */
  reviewBareDecline: true,
  /** `bare` rather than `supersede`: the absorbing pass is a separate experiment (§13.4xx). */
  reviewPass: 'bare',
  /** One answer per question in the registered arm; the three-pass arm is `S13`'s and is not adopted. */
  selfConsistency: 'none',
  /** §13.6xx's carry is off; the arm that carries is the `semantic-carry.yml` dispatch. */
  semanticCarry: false,
  /**
   * §13.92's admission threshold. `0.5` is the registered value and the artifact's
   * `admission.mean` is the same 0.5 measured, not a coincidence: the constant is a floor and the
   * census is what the floor let through.
   */
  sourceTrust: 0.5,
  /** Off: `KU`'s superseded rendering has a reading of its own to earn first. */
  supersededRendering: 'off',
  /** The identity admission gate, for `retrievalThreshold`'s reason. */
  threshold: 0,
  /** No cut marker: the registered rendering cuts silently, and a marker is a measured departure. */
  turnCutMarker: 'none',
} as const;

/*
 * Nothing is left in the table this file once kept beside the gate. It held the four values the artifact recorded
 * and the product could not apply: `maxTurnChars` / `maxTurnCharsRoutes` until `assemble.ts` began resolving them
 * on the room table's rule, and `evidenceRoles` / `evidenceRolesRoutes` until it could read a role. Both pairs went
 * up the same way -- forwarded, proven reachable at the renderer by prompt bytes, defaulted, and only then moved --
 * and the assertion that survives them is `registered-arm.test.ts`'s: the arm this file names and the arm a bare
 * call assembles have to be the same arm, and a re-recorded artifact fails the build until both agree.
 *
 * The one thing the product still cannot do without help is *see* a role: a role is a property of the caller's
 * corpus format, so `roleOf` is an input rather than a default. A call that supplies none gets the census's `null`
 * instead of a filter, which is the honest record of "this run could not read a role" rather than a silent zero.
 */

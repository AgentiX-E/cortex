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
  /** `S16`'s table: `multi-session` 48,460 characters, the other five 24,000. */
  maxPromptCharsByRoute: REGISTERED_ROOMS,
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
 * The registered values this file does not hold, recorded in `__tests__/registered-arm.test.ts` with what each
 * one is missing and the assertion that fails when one of them ships: `maxTurnChars` and
 * `maxTurnCharsRoutes` are nameable at `assembleMemory` and **not defaulted** — a bare call renders every turn
 * whole over every route — while `evidenceRoles` and `evidenceRolesRoutes` still have no option at all. They
 * are next to the gate rather than here for the export census's reason: a constant nothing in the product
 * calls is API surface nobody asked for, and the only thing that reads this claim is the test that enforces
 * it.
 */

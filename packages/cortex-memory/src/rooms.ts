/**
 * The room table the registered arm was measured at, as the product's own constant.
 *
 * ## What these six numbers are
 *
 * `multi-session` keeps 48,460 characters and the other five get 24,000. That is the table `S16`
 * (run `44017278305`, 500 questions × 4 repetitions) priced: **91.25%** at **7,448** prompt tokens per
 * question, paired against the wider table it replaced at **−1 question** (exact McNemar p = 1.0).
 *
 * The shape is what the two neighbours established rather than an average of them. Cutting all six to
 * 24,000 (`S15`) cost **13 questions** — 9 of them on `multi-session`, where an aggregation question is a
 * count over turns and halving the packet truncates the count. Putting `temporal`'s 48,000 back (`S16`)
 * bought **nothing measurable**: that route delivered 23,877 characters instead of 47,852 and lost one
 * question. A temporal question needs its anchor and its neighbours; its width was 24,000 characters that
 * 127 questions did not read.
 *
 * `48,460` rather than `48,000` is not a typo and not rounding: it is the reference window's size, the
 * number the multi-session builder was calibrated on, and `assemble.ts` carried it as a literal in its
 * examples for three rounds before the table existed. Making it 48,000 here would move the bytes of every
 * `multi-session` prompt by 460 characters and re-open a question the two dispatches closed.
 *
 * ## Why a constant in the product and not a file the benchmark reads
 *
 * The benchmark's arm lives in `tools/`, which does not ship (`files: ["dist"]`). A product that could only
 * learn its own calibration from a file outside the package would make "what ships is what was measured" a
 * property of the checkout rather than of the release. The constant is duplicated by necessity and kept
 * equal by a gate: `assemble-rooms.test.ts` reads `tools/arm-config-baseline.json` and fails on any
 * disagreement, in either direction, so a re-recorded arm that forgot this file is red in CI rather than
 * silently shipping a table nobody priced.
 *
 * ## The discipline this constant inherits
 *
 * Changing a value here is an **adoption**, not an edit: it needs a dispatch that priced the change and a
 * row in `docs/ACCEPTANCE-MATRIX.md`, exactly like the baseline file it is pinned to. The history is worth
 * keeping because it happened twice — §13.345 gave one route a wider reach and §13.347 reverted it after a
 * 500-question confirmation run read 90.15% against 91.20%, which is why the pair is read against a control
 * and not against a level.
 */
import { type TurnCapRoute } from './types.js';

/**
 * The registered room, in characters, for each of the six routes.
 *
 * Total rather than `Partial`, so a route added to `TURN_CAP_ROUTES` without a room here is a type error
 * rather than a silent fallback to {@link DEFAULT_MAX_PROMPT_CHARS}. That fallback is 48,000 on all six,
 * which is the configuration this table replaced.
 */
export const REGISTERED_ROOMS: Readonly<Record<TurnCapRoute, number>> = {
  abstention: 24_000,
  assistant: 24_000,
  flat: 24_000,
  'knowledge-update': 24_000,
  'multi-session': 48_460,
  temporal: 24_000,
} as const satisfies Record<TurnCapRoute, number>;

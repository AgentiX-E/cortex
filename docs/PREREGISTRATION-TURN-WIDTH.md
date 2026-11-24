# Pre-registration: the per-turn cap at 600 characters

**Status:** pending — not dispatched, or dispatched and not yet read: no Result section exists for it.

Written before dispatch. The measurement that motivates it is `MEASURE-TURN-WIDTH.md`; the defect it
addresses is `FAILURE-ANATOMY.md` §1 and §3.

## 1. Treatment, byte for byte

One workflow input changes and no other:

| input | shipped | this run | why |
| --- | --- | --- | --- |
| `cortex_memory_max_turn_chars` | `400` | **`600`** | the coverage maximum of the sweep, on both capped routes |
| `cortex_memory_max_turn_chars_routes` | `multi-session,temporal` | *unchanged* | the reach is not the variable |
| marker segment | `none` | *unchanged* | `none` is the shipped state and `<width>` spells it |
| window segment | `head` | *unchanged* | see §6: the `match` window cannot be dispatched alone |
| `cortex_memory_max_prompt_chars` | registered table | *unchanged* | 48,460 / 24,000 is what every number here is conditioned on |
| everything else | shipped | *unchanged* | 22 of the 24 inputs are named explicitly by the dispatcher from the baseline |

The arm is the full 500 questions with both sides in one job -- the pairing invariant of
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §2.2 -- so the comparison is the BASELINE side of this same
dispatch rather than an archived run from another day (time-of-day drift is 1.7–2.1 points, larger
than any effect this arm could find).

## 2. Population, and why it is the whole set

The mechanism is nameable in one sentence: **a turn longer than the cap is delivered as its first
`cap` characters, and the reader is not told**. On run `44017278305` that is 487 of 7,516 annotated
gold turns (6.5%), 245 of them on `MR` and 242 on `TR`; the other four routes carry no cap and cannot
be touched.

| | `MR` | `TR` | `IE` | `KU` | `ABS` |
| --- | ---: | ---: | ---: | ---: | ---: |
| gold turns | 1,832 | 1,615 | 1,709 | 1,688 | 672 |
| cut at 400 | 245 | 242 | 0 | 0 | 0 |
| cut at 600 | 28 | 32 | 0 | 0 | 0 |
| coverage at 400 | 84.99% | 70.22% | 58.34% | 49.94% | 35.57% |
| coverage at 600 | **94.16%** | **80.19%** | 58.34% | 49.94% | 35.57% |

The whole set is dispatched rather than `MR` alone because the four uncapped routes are the internal
control: their prompts must reproduce **to the character**, which is the only way to show the
dispatch changed one thing.

## 3. The prediction, and the model it comes from

`MR` **≥ +4 questions** (102 → ≥106), point estimate **+5.9** (107.92).

That number is not a hope; it is a saturated fit over the cells the shipped run measured, and it is
fragile in a specific way that the prediction is written to survive. The fit carries one quantity:
a complete-and-uncut `MR` question reads 96.43% (27/28) and a complete-and-cut one reads 81.82%
(63/77), a **14.6-point gap**. At 600, 77 questions leave the cut cell and 79 gold turns leave the
delivery, and the net of those two is +5.9. The curve is flat to within 0.9 questions across
550–1,200, so the *direction* is what the model supports while the *magnitude* is what the dispatch
measures. That is why the success bar is +4 and not +5.9.

`TR` is registered as a **guard, not a target**: **no more than 3 questions lost** (120 → ≥117),
against a projection of −0.5. The reason is measured, not assumed -- all 38 `TR` questions whose gold
arrived complete were answered correctly whether the turn was cut (28/28) or not (10/10), so `TR`'s
truncation band carries **zero** accuracy information and a null result there would be a confirmation
rather than a refutation.

## 4. Controls and gates

| gate | condition | what a breach means |
| --- | --- | --- |
| **internal control** | on `IE`, `KU`, `ABS`, `assistant`, `promptChars` is identical between the two sides on every question | the cap reached a route it does not reach: the dispatch is not single-variable, and the reading is void |
| **cost** | total bill ≤ **1.02×** the baseline side; median `promptChars` moves within **±2%** | the room is not fixed the way the sweep assumes, so the sweep's eviction model is wrong and the width must be re-derived before anything is adopted |
| **population** | the treatment side's own `MR` gold bands read coverage 94.16% ± 0.5 pt | the run did not administer what the sweep simulated |
| **guard** | no other capability drops 3 or more questions | `MR` gains are being paid for elsewhere, the §13.72 pattern (+13 `MR`, −30 `IE`) |

The cost gate is the one that can fail in an informative way. The sweep says a wider turn takes room
from the tail rather than lengthening the prompt, so the bill should be unchanged -- fixed room,
identical instruction block, one constant. A bill that moves 10% would mean the arm backfills from
the pool instead of stopping, which is the one thing the replayer cannot see.

## 5. Falsification

Any one of these closes the axis rather than inviting a second width:

1. **`MR` ≤ +1** (≤103). The truncation band would then be a *marker* of hard questions rather than a
   cause of wrong ones, and no width can be justified from it. The axis closes; the next candidate
   becomes the allocator (per-question widths, `MEASURE-GOLD-BAND.md` §5) rather than the constant.
2. **Any capability ≤ −3.** Rejected even if `MR` gains, on the §13.72 precedent.
3. **An uncapped route's prompt moving at all.** Void, not a reading; the dispatch would be
   re-issued rather than reinterpreted.
4. **Bill above 1.02×.** The eviction model is falsified; the width stays at 400 until the model is
   rebuilt against the artifact that broke it.

## 6. What is deliberately not in this dispatch

- **The marker.** `turnCutMarker: 'none'` stays. Turning it on converts wrong answers into `ABS`-style
  declines on the four capabilities that do not grade abstention, so it cannot show a positive effect
  on the scored set by construction; it is an honesty lever measured on `ABS` precision (see
  `MEASURE-ABSTENTION-RECOVERY.md`), and it would confound this arm's cost gate with 3 characters per
  cut turn.
- **The `match` window.** §14.143's window spends the same characters around the question's densest
  lexical match instead of at the head, which is the sharper answer to `a4996e51` (cut at
  `…I increase my work hours`). It is not in this dispatch because the grammar refuses `none` beside
  `match` -- a window that always marks cannot be dispatched as a silent arm -- so the window and the
  marker are one indivisible change, and this campaign runs one variable at a time. It is the next
  arm after this one, and this reading is its control.
- **The room.** Any change to `max_prompt_chars` would move the quantity the sweep holds fixed.

## 7. Adoption path (decided now, so it cannot become a later argument)

If the reading passes §4 and survives §5:

1. the product default moves from 400 to 600 in `packages/cortex-memory/src/types.ts`, with the
   sweep's derivation cited at the field rather than a bare number;
2. `tools/arm-config-baseline.json` is re-pinned and `pnpm guard:arm-config` re-run, so the shipped
   configuration and the baseline file cannot drift apart;
3. the acceptance matrix is re-read -- **`S1` must not fall below 91.0%** -- and the capability
   ledger's `cortex-memory` row is updated with the reading's id;
4. `SOTA-BASELINE.md` §0 takes the new number only from a full 500-question run, never from this
   reading's `MR`-only delta.

Nothing about the width is adopted from this document. It is adopted from the artifact, and only if
the artifact says what §3 predicts.

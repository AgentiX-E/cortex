# Eight points on one route, two on the set, and a p-value for the first time

**Status:** decided. Measured on `45781692092` — `MR` only, two windows per corpus, two repetitions,
**both sides rendering `layered`**, the adopted `ask: verbatim-acts` on the feature side and each
route's reference block (`'route'`) on the control side. ¥**12.83** at the published 2026-11-09
DeepSeek prices. The reading is reproducible with `node tools/paired-flip.mjs --artifact
merged-evidence.json`; nothing in it needs the model again.

## 0. In one paragraph

`PREREG-CLOCK-AXIS.md` §7 left one item open and it was the largest unexploded one in the register: the
ask axis's adoption (`§13.291`, `§13.318.3`) was priced on `raw` while the arm that ships renders
`layered`, so **no reading in this repository had ever priced the shipped instruction block on the
shipped rendering**. `pairing=ask` was built for it in `§197` and dispatched here. On the one route the
block touches — `ASK_CHANGES['verbatim-acts'] === ['multi-session']`, so *every* `MR` question is affected,
not a subset — it reads **+8.27 points at the first window** (99/97 against 108/108 of 121, exact McNemar
`p = 0.0117` and `0.0074`) and **+8.88 points pooled over both windows** (`p = 1.5e-6` and `5.4e-4`). `MR`
is 24.2% of the 500, so the set-level value is **+2.00 points**, which is within one question of the +1.80
the register has been quoting from an unpaired comparison of two artifacts. **No adoption follows** — the
block already ships and is already inside the published 93.40. What follows is that the instruction block
is the largest single mechanism this campaign has measured (rendering is +1.8, the carry is 0), that its
effect is now the only one in the register with a test on the arm that ships, and that the four sibling
blocks in the same axis have acquired an instrument.

## 1. What was dispatched, and the one number in it that was not in the estimate

| input | value |
| --- | --- |
| `pairing` | `ask` — two sides of one job, one instruction block between them |
| `ask` | `verbatim-acts` (the registered block; the control side is `'route'`) |
| `resolution` | `layered`, **both sides** — the rendering the product ships |
| `review_pass` | `bare` — the registered pass, and the one the product ships |
| `thinking` | `multi-session+temporal` — the registered reader |
| `capability` | `MR`, the route the block rewrites |
| `windows` × `ablation_runs` | `2` × `2` → 242 answers per side per repetition |
| `shards` | 8, merged into one artifact |
| billed | prompt 13,724,567 (11,517,488 cached) · completion 2,038,687 · 1,142 calls carrying a `usage` block · **0 retries, 0 throttling** |
| paid | **¥12.83** |

§7.1 estimated **¥5.87** for this reading, and that estimate was for `windows: 1` — 121 questions × two
repetitions = 242 question-runs at the measured 0.0243 CNY each. `tools/dispatch-semantic-carry.py`'s
table defaults `windows: 2`, and this dispatch did not override it, so the population doubled and the bill
followed: ¥11.74 at the same rate, **¥12.83** actual. The extra ¥1.09 is the treatment's own price — the
`verbatim-acts` side emits **231,688** characters of answer against the control's **39,131**, which is
6.6 completion tokens of reasoning and prose for every one the reference block writes.

The second window is not waste and it is not what §7.1 asked for. `two-window.ts` grades both windows so
that a mechanism which moved the second ask is readable **beside a first ask that did not**; a single-window
reading cannot tell those apart, and the first window is the only one whose prompt can be the registered
one (the second is asked on a store that has absorbed the first answer). Both windows moved, which is the
stronger reading.

## 2. The reading

Discordant counts, exact two-sided McNemar on each repetition's own pairs:

| population | n | control | feature | gap | `p` per repetition |
| --- | --- | --- | --- | --- | --- |
| both windows, pooled | 242 | 390/484 = 80.58% | 433/484 = 89.46% | **+8.88** | 1.5e-6 · 5.4e-4 |
| window 1 (99/97 → 108/108 of 121) | 121 | 196/242 = 80.99% | 216/242 = 89.26% | **+8.27** | 0.0117 · 0.0074 |
| window 2 (97/97 → 111/106 of 121) | 121 | 194/242 = 80.17% | 217/242 = 89.67% | **+9.50** | 1.2e-4 · 0.0490 |

Three things about that table are load-bearing.

**First, the control is not a strawman.** `'route'` is the arm's own default — `CORTEX_MEMORY_ASK` absent
means each route renders its reference instruction block — so the delta is what the product's choice is
worth against the configuration it replaced, which is the only comparison an adoption can be made on.

**Second, the delta is the block's and not the rendering's.** Both sides render `layered`, so the reading
`RETRACTIONS.md` §28 withdrew (an ask charged with a rendering) cannot be made again with this instrument.

**Third, the first window reproduces the registered arm.** It reads 89.26 on `MR`; the 500-question
artifact `45760081761` reads 105/121 and 109/121 across its two repetitions, a mean of **88.43** — 1.0
question apart. The two are independent dispatches with different shard counts and different populations,
and they agree to inside the arm's own run-to-run spread, which is the check that says the pair's
treatment side is the arm and not a neighbour of it.

The durable structure, pooled: **17** questions the block wins in both repetitions, **1** it loses in both,
**21** both sides get wrong, **21** contested. A mechanism that moves 17 questions in one direction and one
in the other is not a rendering artifact, and §13.294's unpaired reading of the same block (+4.13 on `MR`)
was attenuated by run noise rather than wrong in direction.

## 3. Why +8.27 here and +4.13 in `§13.294`

They are not two readings of one quantity, and the identity is worth writing down because a reader who
finds both numbers will otherwise average them.

| reading | control | what moved |
| --- | --- | --- |
| `§13.294` | `verbatim` — the block `§13.248` had adopted | the two-step _acts_ form added on top of it |
| `§13.294` again, `§13.318.3`'s adoption | `verbatim` | +1.10 points overall, two sub-significant steps in one direction |
| this document | `'route'` — each route's reference block | everything `verbatim-acts` contains, including `verbatim`'s own |

So the axis has been climbed in three steps — `route` → `verbatim` → `verbatim-acts` → the scope and clock
variants — and the register has only ever priced the top two rungs against each other. The first rung,
`verbatim` against `route`, **has never been measured**; §13.248 adopted it on an unpaired 96-against-93
whose own paired count was two lost against five gained, `p = 0.45`. If the arithmetic closes,
`verbatim` over `route` is about **+4.1**, and that is a prediction rather than a reading: one `pairing=ask`
dispatch at `--set ask=verbatim`, `windows=1`, one repetition is **≈¥3.0** and would settle it.

## 4. The instrument this needed, and did not have

The reading above could not have been taken two rounds ago, for a reason that is not about the ask.

`runAblation` computes `ablation.pValue`, `mcnemarPValue`, `delta`, `effectSize`, both sides' `metrics` and
`perCapability` from **the whole population**. A sharded dispatch has no whole population inside any one
job, so `--merge-evidence` drops all thirty-three of those fields and says so in `notRecomputed` — which is
correct, because a merge cannot compute a statistic over data it has not seen. What was not correct is what
that left behind: `tools/paired-flip.mjs` read the masks, printed the gaps and the durable populations, and
**never tested anything**. On the campaign's only sharded instrument, `20` against `9` (`p = 0.043`) and
`9` against `2` (`p = 0.065`) were the same evidence, and every reading taken from a merged artifact was
decided by a count.

Two changes, both in one place:

1. `exactMcNemar` moved from `a3.ts` to `stats.ts` — it is the arithmetic a reading is made of, and a
   general instrument should not import one experiment's module. `a3.ts` re-exports it, so its public
   surface and its tests are unchanged.
2. `summarisePaired` now carries `pValuePerRun` and `significantEveryRun` per capability, and
   `paired-flip.mjs` prints them beside the counts and **splits a multiplied population by window**
   (`--window N` narrows the reading). Every, not any: the repetitions are the same questions asked again,
   so `significantEveryRun` is the claim a treatment can make, and "significant in one of two" is a
   statement about the draw.

Both are asserted: five cases in `paired-flip.test.ts` (including two rows with the **same** six-question
gap on opposite sides of the bar, which is the reason both numbers are printed) and eight in
`tools/__tests__/test_paired_flip_window.py`.

## 5. What this does not establish

- **Prompt bytes were not compared** between this artifact's first window and the 500-question run's. The
  two levels agree to one question, and the merge does not carry `featurePromptTexts` (another of the
  thirty-three), so the agreement is a fact about two readings rather than a proof that the prompts were
  identical.
- **The second window is a different population.** Its 89.67 is asked on a store that absorbed the first
  answer, so it is a reading about asking twice, not about a better arm.
- **One route.** `verbatim-acts` changes `multi-session` and nothing else, so this says nothing about the
  four other routes and nothing about `ABS`, `IE`, `KU` or `TR`.
- **The control is the arm's default, not silence.** `'route'` renders a reference block; the delta is the
  difference between two instruction blocks, not the value of instruction.
- **Nothing is adopted here.** The block ships, and the 93.40 already contains it.

# The third `resolution` replication, and the rule that decides it before the run exists

**Status:** decided

`C7`/`C8` measured `resolution: 'raw'` against `resolution: 'layered'` twice, on two dispatches, and both
readings point the same way on the same capability:

| dispatch | population | `MR` delta | gained / lost | exact McNemar (two-sided) |
| --- | ---: | ---: | ---: | ---: |
| `44905275457` | 121 `MR` questions, 2 repetitions | **+6.20 points** | 14 / 6 | 0.1153 |
| `44915923906` | 500 questions, 2 repetitions | **+7.85 points** | 15 / 6 | 0.0784 |

The overall reading on the second dispatch is `+2.40 points`, `b=15 c=27`, `p = 0.0884`. `G3` passed
(`+2.40 >= +1.5` and `up-down +12 >= +5`); the cost clauses failed; and the default stayed `raw` because
`p = 0.0884` is not a publishable effect.

That is the right decision on one reading and the wrong one on the pair. Two independent dispatches,
different shard layouts, different sample draws over the same 121 questions, same sign, same magnitude,
`29` conversions against `12` reversions in total. What neither reading can do alone is clear `0.05`, and
what the pair can do is specified **here, before a third one is paid for**, so that the third reading
cannot be read as a licence to keep going.

## 1. What is dispatched

| item | value |
| --- | --- |
| workflow | `semantic-carry.yml` |
| `pairing` | `resolution` (`raw` on the baseline side, `layered` on the feature side) |
| `capability` | `all` (the registered 500) |
| `windows` | `1` |
| `review_pass` | `bare` |
| `turn_rendering` | `head` (`maxTurnChars = 400` on `multi-session,temporal`) |
| `ablation_runs` | `2` |
| `shards` | `8` |
| `thinking` | the workflow default, `multi-session+temporal` |
| `workers` | the workflow default |
| budget ceiling | **¥12** (the second dispatch cost ¥9.10 against a ¥7.13 projection) |

Every field above is stated because the two earlier dispatches **were not identical**: `44905275457` ran
`capability=MR` with `thinking: disabled`, and `44915923906` ran `capability=all` with the workflow's
default thinking reach. The pair is therefore a replication of a *capability reading*, not of a
configuration, and this dispatch reproduces **`44915923906`'s** configuration field for field so that the
Fisher combination below has two readings that differ in nothing but the draw.

## 2. The four criteria, fixed now

| # | criterion | reading it will be judged on | what a miss means |
| --- | --- | --- | --- |
| `R1` | the sign replicates | `MR` up-down `> 0` on this dispatch | three-and-out: the axis retires, see `R4` |
| `R2` | the pair is significant | Fisher's combined `p` over this dispatch and `44915923906` `< 0.05` | the effect is real and smaller than this instrument can resolve at 500 questions; no adoption |
| `R3` | the bill did not rise | `prompt_per_answer.delta_pct <= +1.0` | the mechanism is refused on its own terms, whatever `R2` says |
| `R4` | adoption, if and only if | `R2` and `R3` both hold | otherwise `resolution: 'layered'` is recorded as measured-and-not-adopted and is not cited as a candidate again |

`R3` is written as a ceiling rather than as the `<= 7,416 tokens per question` of `G5` because that number
describes the reference pair. `+1.0%` is the band the two archived readings already sit inside
(`+0.18%` and `+0.75%`), so this criterion cannot be passed by a mechanism that quietly became dearer.

## 3. Why Fisher, and what Fisher does not license

`p = -2 (ln p₁ + ln p₂)` against a χ² with four degrees of freedom combines two independent tests of the
same null. The two dispatches are independent **as dispatches** — separate runs, separate shard
assignments, separate samples — and they are not independent as **questions**: the same 121 `MR`
questions appear in both.

That matters, and it is why the result is reported two ways:

- **Fisher over the two published `p` values.** This is the pre-registered decision rule.
- **The pooled discordant counts** (`29` against `12`) as an **upper bound** on the evidence, printed
  beside it and never used to decide. Pooling counts across two draws of one question set treats each
  question's two outcomes as two observations, which is the pseudoreplication this campaign's statistics
  already refuse (`SOTA-BASELINE.md` §6: exact permutation tests, not pooled z-tests).

If the two disagree about `0.05`, `R2` fails. The rule is deliberately the conservative one: a decision to
change a product default on a borderline statistic is exactly the decision that should be hard to make.

## 4. What adopting would change, if `R4` fires

Three places, and they move together or the gate is red:

| place | change |
| --- | --- |
| `packages/cortex-memory/src/registered-arm.ts` | a `resolution: 'layered'` row, with the dispatch id and the `R2`/`R3` readings |
| `tools/arm-config-baseline.json` | the re-recorded arm |
| `docs/ACCEPTANCE-MATRIX.md` | `S3` (`multi-session`, currently `83.7%` against an `85%` threshold, status `aim`) becomes a `gate` at the level the new arm reads |

The third row is the reason this is worth ¥12 rather than a footnote. `S3` is the **only** `aim` row in the
acceptance matrix: every other criterion either passes or is `accepted`/`unrun`. `MR +7.85` takes `83.7%` to
`91.5%`, which is above its threshold with room, and a project whose last unmet aim closes is a different
project from one that has been carrying it.

## 5. What this registration does not claim

It does not claim the third dispatch will reach `+2.40 points` overall. The two earlier readings differ by
1.65 points on `MR` (`+6.20` against `+7.85`), so the third is expected somewhere in that band and a
noticeably smaller one is a finding rather than a failure of the rule.

It does not re-open the cost question. `G2` closed the **saving** this mechanism claims, and `R3` here is a
ceiling on the bill rather than a re-argument that the mechanism saves characters. `C8` is closed.

It does not license citing `+2.40` as a product number before `R4` fires. A mechanism that is measured and
not adopted is measured and not adopted.

## 6. Result

Run `45543010618` (500 questions, 8 shards, 2 repetitions; the merge that adds the eight parts up
is `70c07b43`). The four criteria, read by
`tools/read-merged-population.py` and archived in `cortex-docs` §190.4:

| # | criterion | reading | verdict |
| --- | --- | --- | --- |
| `R1` | `MR` up-down `> 0` | **+8** (b=5, c=13) | pass |
| `R2` | Fisher `< 0.05` | 0.0872 x 0.0884 → **0.0452** | pass |
| `R3` | paired prompt bill `<= +1.0%` | **+0.07%** (`usageBySide`) | pass |
| `R4` | adoption iff `R2` and `R3` | both hold | **fired** |

Overall **91.70% → 93.50%** (+1.80 points, +9 questions, b=19 c=9). Per capability: `MR` 83.06 → 89.26,
`TR` +0.39, `IE` +1.33, **`KU` −1.39**, `ABS` 0.00. The `KU` row is in the same table as the `MR` row and
is not small enough to leave out: −1.39 is two questions on 72, inside the noise, and it is the one route
the mechanism was not aimed at.

### 6.1 The rule fired, and the default was not flipped

`R4` is written as "adoption, if and only if" — it decides, and the three places in §4 were the work it
owed. That work did not happen, and the reason is a number the registration does not contain:
the pair's cache-weighted price (`cortex-docs` evidence `resolution-pair-500-45543010618.json`),
**1.55x** the control's, raised after the reading was in.

That number is a division over the provider's `prompt_cache_hit_tokens`, and
`docs/AUDIT-CACHE-CREDIT.md` finds that the same artifact credits **96.4%** of prompts whose own bytes
permit **1.4%** of reuse and share **22 characters** of prefix at the longest — a credit 1.93x the bound
that two repetitions of one prompt impose on any cache. So the objection is not yet evidence, and it is
not dismissed either: `probe-cache-credit.yml` names the quantity with five prompts whose shared content
is known by construction, and the verdict selects between `R5` on the price ratio and `R5` on prompt
tokens per answer.

**What this registration therefore says about itself:** the rule passed and the adoption is owed. The
registration is not re-opened, and no fourth dispatch is planned — a mechanism whose sign
replicated on three dispatches does not become unclear because one number is missing.

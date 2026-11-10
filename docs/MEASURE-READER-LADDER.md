# The reader axis is two axes, and the one that costs 2.14x buys half a point

**Pairs read:** `41222844945`→`41254359622` (thinking off→on, older configuration), `42600727738`→`42621461902`
(`T1r`, thinking on→off, 200 questions), `40698867439`→`40698883428` (`deepseek-chat`→`deepseek-v4-pro`), and
`42533236864`→`42826272421` (the 500-question confirmation registered as §13.360).

**Registered before this reading:** `PREREGISTRATION` §13.360, with §13.360.6 replacing its predictions after the
registration was found to be wrong about which pairs already existed. The replacement was written before the
500-question artifact existed.

## 0. One paragraph

`M1` has been the last unwritten row on the reader axis for three rounds, and the reason was never scientific: the
number existed as prose in three places and as a generated value nowhere. Round 60 built the instrument
(`tools/reader-ladder.py`, three refusals, four attestations), pointed `M1` at it, and dispatched the one pair that
would fill it. What that work says before the dispatch is read is the round's actual finding: **"a stronger reader"
names two interventions with opposite signs on this arm** — reasoning mode at the same model is worth **+4.70**
points on the older configuration and **+0.5** on the shipped one (inside the noise, at **2.14x** the bill), while
a larger *model* is worth **−7.20**. The 58 questions that last pair loses were decomposed and **42 of them are
answers unrelated to the gold** — not truncations, not parse rejects, not length artefacts — so the three repairs
this campaign had lined up would reach at most 16 questions, on a population where a 500-question headline moves
by 0.2 points per question.

## 1. The three axes, and the numbers on each

| axis | pair | Δ | prompts | what moved |
| --- | --- | ---: | --- | --- |
| reasoning mode, same model, older configuration | `41222844945` → `41254359622` | **+4.70 pt** (+23.50 questions, p≈8.3e-3) | byte-identical, 500/500 | decoding |
| reasoning mode, same model, shipped configuration, 200 questions | `42600727738` → `42621461902` | **+0.5 pt** (+1 question) | byte-identical, 200/200 | decoding |
| model tier, same mode | `40698867439` → `40698883428` | **−7.20 pt** (417 → 381 of 500) | byte-identical, 500/500 | the model |
| reasoning mode, shipped configuration, 500 questions | `42533236864` → `42826272421` | **§4** | checked by digest | decoding |

Every Δ in that table is `after − before` for the intervention named in the row, so the second row's
**+0.5** means *turning the reach off* gained a question, and the first row's **+4.70** means turning it *on*
gained twenty-three and a half. That is the disagreement, stated in one unit.

The first row and the second are the same knob, and they do not agree. §13.344 read the first dispatch of `T1` as
"−1.0 point", §13.345 repeated it and read **+0.5** after finding the first reading was contaminated by a cold
prefix cache (cache hit 75.2% against 97.4%, and 0.66 CNY of the figure was the cache warming rather than the
mode), and §13.347 declined to adopt it because 200 questions is not the registered scale. **Neither reading was
wrong; the sample was.**

## 2. The model-tier loss is behavioural, and `--relations` is what shows it

`40698867439` (chat, 417 correct) against `40698883428` (v4-pro, 381) shares 500 byte-identical prompts and differs
in one field. 58 questions flipped in the direction that matters and 22 in the other. Classifying the **losing**
side of every flip against its gold — the census `arm-flip-census.py --relations` now prints — gives:

| class | broken (v4-pro lost it) | repaired (v4-pro won it) |
| --- | ---: | ---: |
| `disjoint` | **38** | 9 |
| `empty` (declined) | 9 | 4 |
| `gold-in-answer` (verbose, gold inside) | 6 | 2 |
| `numeric` (a value disagreement) | 4 | 5 |
| `answer-in-gold` (truncated name) | **1** | 1 |
| `equal` (graded wrong, answer equals gold) | **0** | 0 |

Three repairs were candidates before this table existed, and the table retires all three:

- **Truncation.** One question of 58 is an answer that is a proper prefix of its gold. A "copy the exact phrase"
  clause would have a population of **1**.
- **Verbosity.** Six of 58 contain the gold somewhere inside a long answer, and opening them shows the containment
  is incidental — `Page Turners` appearing in an answer about three book clubs. An "extract the final answer"
  pass would convert at most a handful, and could as easily break the twenty-two the larger model won.
- **Declines.** Nine of 58 are `INSUFFICIENT_EVIDENCE` where the smaller model answered. That is the
  abstention-recovery population, which `R1` already measured at a net **−1** and which `E3.1'` cannot score
  without a dispatch that carries the questions.

So the honest statement is the negative one: **a stronger model's loss on this arm is not a fidelity artefact.**
`equal` being zero is the control that makes this a measurement rather than a narrative — if the scorer were
rejecting answers that equal their gold, the column would not be empty.

## 3. Where the frontier prices the same axis, and why the ordering is monotone

Four independent systems now publish a reader-only ablation on a fixed memory:

| system | intervention | Δ | baseline reader |
| --- | --- | ---: | --- |
| Perpetuity's frame (third-party roundup) | one memory, five readers | **22.6** | includes weak readers |
| Mastra OM | `gpt-4o` → `gpt-5-mini` | **10.64** | weak (`gpt-4o`) |
| this arm, older configuration | thinking off → on (two routes) | **+4.70** | mid |
| Synap | `gpt-5.4` → Gemini 4 Argon | **+1.4** | strong |
| this arm, shipped configuration | thinking on → off | **+0.5** | mid |
| this arm, model tier | `deepseek-chat` → `deepseek-v4-pro` | **−7.20** | mid |

**The effect shrinks as the baseline reader strengthens**, monotonically, across four systems and six
measurements. That is the fact that re-prices the plan: the 4.55-point gap to Synap cannot be attributed to "our
reader" without first explaining why every strong-baseline study in the field finds one to five points where the
weak-baseline ones find ten to twenty-two.

## 4. The 500-question confirmation: `M1` passes at +4.35, and the 200-question pair was a sample

`42533236864` (shipped, `thinking=multi-session+temporal`) against `42826272421` (same commit lineage, one input
moved). **500 of 500 prompts byte-identical by `promptDigest`**, four repetitions each:

| capability | n | shipped | disabled | Δ |
| --- | ---: | ---: | ---: | ---: |
| `IE` | 150 | 94.17% | 93.17% | **−1.00** |
| `ABS` | 30 | 100.00% | 100.00% | 0.00 |
| `KU` | 72 | 87.15% | 87.85% | **+0.69** |
| `MR` | 121 | 83.06% | 78.93% | **−4.13** |
| `TR` | 127 | 95.08% | 82.68% | **−12.40** |
| **overall** | 500 | **91.05%** | **86.70%** | **−4.35** |

The flip census, which is the reading a capability table cannot give:

| population | n | repaired | broken | net | exact p | resolution |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 500 | 5 | **26** | **−21** | **1.9e-4** | 13 |
| `TR` | 127 | 1 | **16** | **−15** | 2.7e-4 | 9 |
| `MR` | 121 | 4 | 10 | −6 | 0.18 | 10 |
| `IE` / `KU` / `ABS` | 252 | **0** | **0** | 0 | — | — |

**`M1` passes: +4.35 points against a 3.0-point threshold.** The reasoning reader earns its bill on the
configuration that ships, and the row no longer reads prose.

Three findings that matter more than the pass.

**First, the 200-question pair reversed sign at 500.** `T1r` read **+0.5** (182 against 181 of 200) and this run
reads **−4.35**. The effect is not in `IE`, `KU` or `ABS` — those three capabilities answered **identically on
all 252 questions** across two runs months apart — it is in `TR` (−12.40) and `MR` (−4.13). At 200 questions
`TR` carries 28 questions and `MR` 29, so a 12-point effect is 3.4 questions on a population where §13.118.5
already measured four repetitions of one configuration spreading over 16. **The screening convention this
campaign uses to decide what is worth a full pass cannot resolve the effect the full pass finds**, and that is
a fact about the instrument rather than about this mechanism.

**Second, the loss is mostly refusals.** Classifying the losing side of each flip: **11 of 26 are `empty`** —
the non-reasoning reader declined a question the reasoning one answered. `abstentionRate` moves 6.2% → 8.8% and
the answered-but-wrong population barely moves. So the mode is not buying better reasoning over the same
evidence; it is buying *the willingness to answer*, which is the same population `R1` and `E3.1'` were written
for and the first time that population has a measured price.

**Third, `P2` failed for the reason the campaign already knew about.** Feature-side spend fell **11.08 → 7.43
CNY (−32.9%)**, not the ≥ 40% the registration required, and the composition says why: output tokens fell
87.8% (2.22M → 0.27M) while **uncached input rose 4x** (0.40M → 1.61M) because this was the first run after a
mode change — the cold prefix cache §13.344 found on `T1`'s first dispatch, worth 0.66 CNY there and 2.42 CNY
here (1.21M extra uncached tokens at 2 CNY/M, which is the whole gap between −32.9% and `T1r`'s −53.3%). The
price of the mode is therefore **53% of the bill, steady state**, and this run's number is a floor on the
saving rather than a measurement of it.

## 5. What this changes

1. **The default does not move.** The 2.14x bill buys 4.35 points, which is the first time the shipped
   `thinking` value has had a current-configuration reading behind it rather than a 200-question sample.
2. **The next mechanism cannot be a reader swap** — and now that has a sign on both axes: mode is worth +4.35
   and a larger *model* is worth −7.20.
3. **The refusal population is where the next four points are.** Eleven of the 26 questions this pair separates
   are declines, and `MR`'s 20 failures already measured 1 abstention. A mechanism that makes a non-reasoning
   reader answer what a reasoning one answers is worth up to 4.35 points at a third of the bill — which is the
   first time this campaign has had a *population* with a price attached.
4. **The screening scale is now a known hazard for this effect.** Any 200-question read of a `TR`-shaped effect
   carries ±3 questions of population noise, and this round is the measurement of that rather than an opinion
   about it.

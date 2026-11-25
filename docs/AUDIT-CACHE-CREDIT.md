# The price that refused the mechanism is a counter the prompts cannot produce

**Status:** closed, and the mechanism is **adopted**. Run `45574814660` answered the model question — the
counter is a **prefix cache**, mean residual 0.035 — and left the magnitude question open in a sharper form:
a byte-identical repeat is credited **82.7%**, not 100%, and the benchmark's 96.4% still exceeds the bound
its own two repetitions impose by 1.93x. §8 then measured the lever §7.3 named before building it, and it
**cannot work**: over 105 pairs of `MR` questions in the same artifact, **zero** share their first delivered
turn, so a question-independent rendering has no prefix to share. What decides is therefore `R3` — prompt
tokens per answer, +0.07% of a +1.0% ceiling — which passed, and `resolution: 'layered'` is the shipped
default (`REGISTERED_ARM.resolution`, `tools/arm-adoptions.json`).


## 0. One paragraph

Run `45543010618` measured `resolution: 'layered'` at **93.50%** against **91.70%** and refused to adopt
it because the treated side's cache-weighted price was **1.55x** the control's. That ratio is
`(hit/10 + miss)/...` over the provider's `prompt_cache_hit_tokens`, and the provider credited the
control side with **885,375 of 918,259 prompt tokens (96.4%)**. The prompts those tokens belong to are in
the same artifact. They share **22 characters** of prefix at the longest, and **1.4%** of their text is
content that any other prompt had already sent. A cache is a lookup on something; nothing in these
prompts is there to be found — and §7 then measured what the counter is: a **prefix cache**, verdict
`position` at a residual of 0.035. Both statements are true at once, and together they are the finding:
the counter measures reuse, these prompts contain almost none, and the 96.4% is therefore not about
these prompts. A price built on it cannot veto a mechanism whose prompt-token count moved **+0.07%**.

## 1. The five numbers, all from one shard of one run

Shard 0 of `45543010618`, baseline side, 63 questions, 2 repetitions:

| reading | value | where it comes from |
| --- | ---: | --- |
| reader calls | 129 | `usageBySide.baseline.calls` |
| prompt tokens billed | 918,259 | `usageBySide.baseline.promptTokens` |
| prompt tokens credited as cache hits | 885,375 (**96.4%**) | `usageBySide.baseline.cacheHitPromptTokens` |
| longest byte prefix shared by any two of the 63 prompts | **22 characters** | the 63 `questions[].turns[].text` |
| mean share of a prompt whose *sentences* any earlier prompt already sent | **1.4%** | same |

The two text rows are computed from the artifact's own delivered evidence, concatenated in delivery
order — the same bytes the reader was handed. They are not estimates.

## 2. What the ceiling is, before any model of the cache

Two runs over the same 500 questions send each prompt twice. The most a cache of *any* shape can serve
is therefore one copy of each prompt: **50%**, not 96%.

The measured 96.4% is 1.93x that ceiling. This is the part that does not need the probe: whatever the
provider is counting, the two runs cannot have reused more than one copy of a prompt that was sent
twice, and the arithmetic of the artifact says the credit is twice that.

## 3. Two shapes a reuse counter can have, and what these prompts allow each

- **Position** — the cache serves a run of bytes from the start of the prompt, which is what
  `deepseek`'s documentation describes and what every prefix cache does. Computed over the 63 prompts:
  **mean 0.05%, max 0.13%**.
- **Content** — the cache serves any sentence it has seen before, wherever that sentence now sits.
  Computed over the same 63 prompts: **mean 1.43%, max 23.0%**, the maximum being one prompt that
  restates a numbered list a previous prompt had already sent.

Both are two orders of magnitude below the credit. A third shape — one that credits tokens it has never
seen — is not a cache, which is why the probe exists rather than a paragraph.

## 4. The probe, and the rule written before it runs

`packages/cortex-eval/bench/probe-cache-credit.ts` sends five prompts whose shared content is known by
construction, one call at a time so the per-call delta is exact:

| variant | what changed | position model | content model |
| --- | --- | ---: | ---: |
| `reference` | nothing, it is first | 0% | 0% |
| `repeat` | nothing, it is second | 100% | 100% |
| `head-changed` | the first 200 characters | 0% | ~97% |
| `paragraphs-swapped` | paragraph order, same sentences | 0% | 100% |
| `unrelated` | everything but the instruction | 0% | ~2% |

`packages/cortex-eval/src/cache-credit.ts` scores both models against the five credits and names the
winner when its mean absolute residual is within **0.15**. The rule, fixed here before the dispatch:

| verdict | what it means | what changes |
| --- | --- | --- |
| `position` or `content` | the credit is a reuse measure, and the 63 archived prompts were simply not what it was measuring | `R5` is registered on the price ratio, `resolution` stays `raw`, and the lever is to make a turn's rendering independent of the question |
| `neither` | the credit is not a reuse measure | the 1.55x is withdrawn as a bill, `R5` is registered on **prompt tokens per answer** (+0.07%), and `resolution: 'layered'` is adopted on `R1`/`R2`/`R3` as registered |

**Amendment, written after the dispatch rather than before it.** The `position` row says `R5` is
registered on the price ratio, and §7.2 retired that half: the probe's own control row credits a
byte-identical repeat with **82.7%**, so the credit is a function of arrival order and no ratio over it
is a bill. The branch's *decision* stands — `resolution` stays `raw` and the lever is the rendering —
and the criterion that decides in the meantime is `R3`, prompt tokens per answer. A registration may be
amended by a measurement it did not anticipate; it may not be amended by a preference.

The rule is written this way because the alternative is a ratio that can veto an arm while being
unfalsifiable: `R3` was registered as a **token** ceiling (`+1.0%`) precisely because the campaign had
already learned that a bill moves with the cache and not with the mechanism, and 1.55x was raised
afterwards as an unregistered objection. Either the objection becomes measurable, or it is not a
criterion.

## 5. What this does not claim

It does not claim the provider's counter is broken. A counter can be right about a quantity nobody
described correctly — the credit may be a property of the *account's* cache rather than of this prompt,
it may count blocks by a boundary this repository does not model, or it may be a discount the provider
applies for reasons of its own. Every one of those is compatible with the five numbers in §1.

It does not claim the +1.80 points are affordable. It claims the current **evidence for the 1.55x is
inadmissible**, which is a different statement: the arm still has to be paid for at a price somebody can
compute, and §4 names the price it will be paid at.

It does not re-open `R2`. The Fisher combination (0.0452) is still optimistic for the reason the
preregistration states — two tests of one question set — and the caveat travels with the adoption
either way.

## 6. Where the arithmetic lives

`tools/read-merged-population.py` prints the bill block; the two text measures are one pass over
`questions[].turns[].text` and are reproduced in `cortex-docs` §191 next to the artifact. The probe's
models and the verdict rule are `packages/cortex-eval/src/cache-credit.ts`, tested to
**100 / 100 / 100 / 100** over 35 cases, including the two refusals a wrong dispatch would otherwise
produce a verdict from: a sample for a prompt that was never sent, and a credit larger than the prompt
it describes.

## 7. The probe's reading (run `45574814660`)

Five prompts, sent in order, one call at a time. `promptTokens` and the credit are the provider's own
fields, read through the product's adapter:

| variant | prompt tokens | credited | position model says | content model says |
| --- | ---: | ---: | ---: | ---: |
| `reference` | 1,393 | 0 (0.0%) | 0% | 0% |
| `repeat` | 1,393 | 1,152 (**82.7%**) | 100% | 100% |
| `head-changed` | 1,392 | 0 (0.0%) | 0% | 94.2% |
| `paragraphs-swapped` | 1,393 | 0 (0.0%) | 0% | 100% |
| `unrelated` | 1,483 | 0 (0.0%) | 0% | 0.8% |

**Verdict `position`**, mean absolute residual **0.035**, worst 0.173 — the worst row being `repeat`,
which is the row that matters.

### 7.1 What the probe settled

The counter is a prefix cache. Reordering the paragraphs of a prompt, which keeps every sentence and
destroys every run from the start, is credited **nothing**; the content model predicted 100% there and
was wrong by a whole prompt. So the credit is not a content measure and the repository's intuition about
what a `resolution` change does to a bill has a real object: a turn whose rendering depends on the
question breaks the prefix for every question after it.

### 7.2 What the probe did **not** settle, and made worse

A byte-identical second send was credited **82.7%**, not 100%. Two readings are compatible with that
number and they are not the same finding:

- the provider writes its cache asynchronously, so the tail of the first prompt was not yet available
  241 tokens later;
- the credit excludes a fixed tail by construction.

Either way the consequence is the same and it is the one that matters for a bill: **the credit depends on
when the second call arrived**, which is a property of the dispatch rather than of the mechanism. A
counter whose control reading is 82.7% cannot price a 96.4%-against-70.6% difference at 1.55x.

And the 96.4% is still 1.93x the ceiling §2 proves. The probe says the *model* is `position`; nothing in
it explains how a prompt that was sent twice was served from cache more than once.

### 7.3 The rule's branch, and the step it names

§4 branches on the model, and the model came back `position`: the credit is a reuse measure, a fallen
credit is a real cost, and the lever is to make the rendering of a turn **independent of the question**.
That is the next dispatch's mechanism, not this round's conclusion:

| step | what it changes | cost | why it can be measured |
| --- | --- | --- | --- |
| `layered` v2 | `resolveTurn` reads `(content, cap)` only; the form is chosen by the turn's own operand content instead of by whether it shares a term with the question | one engineering change, ¥0 to build and test | the invariant is a unit test: two questions over the same turns must produce byte-identical evidence |
| the replication | `raw` against `layered` v2 over the registered 500 | ≈¥8 | the same pairing, the same four criteria, re-registered before it runs |

`R5` cannot be registered on the price ratio until §7.2 has an answer, and that answer is not something a
probe of five prompts can give: it needs the dispatch's own call ledger to account for every prompt it
billed. Until then the criterion that decides is `R3` -- prompt tokens per answer, +0.07% -- which is the
one quantity in the artifact that does not depend on when a call arrived.

## 8. The lever §7.3 named, measured before it was built

§7.3's row says the `position` verdict makes the lever "a turn's rendering that does not read the question",
and prices it at one engineering change plus one ¥8 replication. Before spending either, the same artifact can
say whether the lever has an object — because a prefix cache shares a **prefix**, and a prefix that differs at
its first turn shares nothing after it.

The measurement is over the `MR` questions of shard 0 and their delivered turns, in delivery order:

| reading | value |
| --- | --- |
| `MR` questions in the shard | 15 |
| pairs of them | 105 |
| pairs whose **first** delivered turn is identical | **0** |
| mean longest common prefix in turns | **0.00** (max 0) |
| pairs with the same delivered *set* | **0** |
| distinct turn texts across the shard | 3,078 |
| of those, appearing in more than one question | **3** |

The evidence a retrieval reader is given is essentially **disjoint** between questions: three turn texts out of
three thousand are reused, and no two questions begin with the same turn. So making `resolveTurn` ignore the
question would change what each turn *looks like* and not one byte of what any two prompts have in common —
the first turn still differs, and the prefix still ends there.

### 8.1 What that leaves, and what it cost to learn

The only reuse this experiment can have is **within a question**, because the register is answered twice and
the two passes send the same prompt. That is also §2's 50% ceiling, reached from the other side: one prompt
sent twice can be served from cache once. And it is why the observed 96.4% cannot be a bill no matter which
model the counter is: the ceiling is a property of the dispatch, not of the rendering.

So the adoption rule is the registration's own. `R4` was written as "adopt, if and only if `R2` and `R3`";
`R2` returned 0.0452 against a 0.05 bar, `R3` returned +0.07% against +1.0%, and the objection that stopped
the adoption was a ratio the probe then showed to be a function of *when a call arrived*. A branch of this
document cannot outlive its instrument.

Two things are recorded rather than smoothed over:

- **§7.3's table is not deleted.** It names a lever that would have cost a round and ¥8, and the reason it was
  not built is a number in the artifact that nobody had computed. That is the useful part of the record.
- **The adoption is not on the price axis at all.** It is on `R3`, the only quantity in the artifact that does
  not depend on arrival order, and the ledger row that carries it says so (`tools/arm-adoptions.json`).

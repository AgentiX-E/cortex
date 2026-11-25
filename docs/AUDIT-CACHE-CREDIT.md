# The price that refused the mechanism is a counter the prompts cannot produce

**Status:** the arithmetic is closed; the probe that decides what the counter measures is dispatched on
demand (`probe-cache-credit.yml`). Until it reports, `resolution: 'layered'` stays at `raw` **and** the
1.55x price ratio of run `45543010618` is recorded as an unexplained field rather than as a bill.

## 0. One paragraph

Run `45543010618` measured `resolution: 'layered'` at **93.50%** against **91.70%** and refused to adopt
it because the treated side's cache-weighted price was **1.55x** the control's. That ratio is
`(hit/10 + miss)/...` over the provider's `prompt_cache_hit_tokens`, and the provider credited the
control side with **885,375 of 918,259 prompt tokens (96.4%)**. The prompts those tokens belong to are in
the same artifact. They share **22 characters** of prefix at the longest, and **1.4%** of their text is
content that any other prompt had already sent. A cache is a lookup on something; nothing in these
prompts is there to be found, so the credit is not a reuse measure and a price built out of it cannot
veto a mechanism whose prompt-token count moved **+0.07%**.

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

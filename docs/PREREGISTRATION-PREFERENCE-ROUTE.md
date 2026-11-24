# PREREGISTRATION-PREFERENCE-ROUTE

A pre-registration, written before the code, for giving the preference question its own answer
contract in the product.

> **STATUS: DISPATCHED ONCE, C1–C4 MET, artifact FAILS ITS OWN AUDIT (§8.2), confirmation draw
> blocked by the embedding balance (§8.4).** The population below is counted on an archived artifact,
> not estimated; §5 fixes the dispatch and §6 the decision rules, so the readout cannot choose its own
> bar. §8 is the outcome and was written after the numbers were read, which is the only order that
> makes §6 mean anything.

## 1. The population, counted

The archive is the registered arm `S16` (run `44017278305`, 500 questions × 4 repetitions, 91.20% by
per-question count: `feature.metrics.correct = 456`). The preference population is not labelled in
that artifact — `questions[]` carries no `questionType` — so it is identified by the one field that is:
the gold. Every LongMemEval-S preference question's gold states what the user *would prefer*:

```
30 questions, gold contains "would prefer"
route:    all 30 render `flat` (nothing else can receive them)
correct:  20 of 30
wrong:    10 of 30
```

**The first count of this population was 29, and it was wrong in the way this campaign keeps finding.**
The filter was the prefix `The user would prefer`, and one gold leads with a clause instead: `1a1907b4`
reads *"Considering their mixology class background, the user would prefer cocktail suggestions that
build upon their existing …"*. It is a preference question, it renders `flat`, and it is **wrong** — so
a filter that looked mechanical under-counted the population by one, and the ceiling by one. The filter
is a substring match now and the extra question is the last row below. The union with the short-answer
population (§4) is unchanged at 24 questions, because that question was already in the other set.

The ten, with the answer the arm gave:

| question | gold begins | what the arm answered | form |
| --- | --- | --- | --- |
| `75832dbd` | …suggestions related to recent research papers | "The evidence contains requests for recommendations of research papers…" | decline + evidence echo |
| `0edc2aef` | …suggestions of hotels in Miami that offer great views | "The evidence above contains no information about hotels in Miami" | decline |
| `09d032c9` | …responses that build upon their previous mention of purchasing | "The evidence does not contain any tips for improving phone battery life." | decline |
| `57f827a0` | …responses that take into account their existing plans to rearrange | "No direct tips on rearranging bedroom furniture are in the evidence" | decline |
| `d6233ab6` | …responses that draw upon their personal experiences and memories | "The evidence only mentions positive high school memories…" | decline |
| `1da05512` | …responses that take into account their current home network | "The evidence does not address whether to buy a NAS now or wait" | decline |
| `1d4e3b97` | …responses that reference specific details from their previous | "The evidence does not explain why the bike would perform better" | decline |
| `d24813b1` | …baking suggestions that take into account their previous | "Based on the evidence, here are baking ideas…" | composed, judge refused |
| `0a34ad58` | …responses that utilize their existing resources, such as | "Based on the evidence, here are helpful tips for getting around Tokyo…" | composed, judge refused |
| `1a1907b4` | **Considering their mixology class background,** the user would prefer… | "The evidence mentions a Pimm's Cup with a Twist made with Hendrick's gin…" | decline + evidence echo |

Eight of the ten tell the reader the evidence does not answer the question. Two already compose a
recommendation and were not accepted. **The ceiling is therefore 10 questions = 2.00 points on the 500
roster**, and it is a ceiling over the *treated* population, which is the whole of it: all 30 render
`flat`, so no question in this set is outside the treatment's reach.

## 2. Why the flat route cannot serve these, in the block's own words

The registered arm routes every one of the 30 to `answer()`, which builds with the `extractive`
contract. Through `ask: verbatim-acts` that block closes on:

> `Reply with the answer alone. If the evidence does not contain the answer, reply exactly <token>.`

A preference question's gold is a *suggestion composed from* what the user said, so "the answer" is
not a sentence anywhere in the window and "reply with the answer alone" asks for a short fact. The
reader does the only thing the block licenses: it reports the absence. The reference pipeline states
the same diagnosis in its own source, for the same dataset and the same model:

> `the extractive contract is wrong for preference questions … it reads as having nothing to say and
> abstains.` — `RECOMMENDATION_CONTRACT`'s docblock, `natural-language-memory.ts`

This repository has already paid for one attempt at the fix on a different axis. §13.129's
`ask: 'recommend'` put a licence to compose onto the flat route and moved the roster 83.40% → 85.20%
(run `40824682542`), but 7 of the 9 questions it "bought" came from questions whose prompts did not
move a byte, its treated bucket bought 2 and sold 0 over 34 questions, and claim 1 was falsified at
27 against a threshold of 28 — impossible when written, because only 9 of the 33 paragraph-gold
questions render `flat`. It was correctly not adopted. Two things are different here:

1. **The reach is computed, not asserted.** The population is 30 questions, all on `flat`, all
   wrongly-or-rightly treated; the ceiling arithmetic is 9, above the bar.
2. **The treatment is a contract, not a licence on another contract.** §13.129 inserted a permission
   *above* `extractive`'s closing line, and §13.55/`39035438120` measured that a rule placed above a
   block's close loses to it: 21 of 28 declines declined again, 12 with the list in hand. The
   preference contract **replaces** the close, which is the position `withReplacedClose` exists for.

## 3. The treatment

`PromptContract` gains `'preference'`, and `CortexMemory.answerPreference()` renders it. The block:

```
Step 1 — read the evidence and note what the user has said they like, want, own, or are dealing with.
         Keep those notes to yourself: do not write them out.
Step 2 — recommend something concrete that builds on those preferences, and reply with the
         recommendation itself.
Do not quote, copy, or list the evidence turns. Reply in your own words, in at most three sentences,
naming the specific options the evidence supports.
If the evidence contains nothing about the user's situation, reply exactly <token>.
```

Four decisions, each with the failure it answers:

| line | what it answers | which of the ten |
| --- | --- | --- |
| Step 1 silent | the two-step shape, with the notes *not* written out: §13.123's `silent` ask lost 26 `MR` questions by asking for a written list, so the step exists and its output does not | all 7 declines |
| Step 2 recommends | "reply with the answer alone" replaced by "reply with the recommendation itself" | all 7 declines |
| no echo | six of the ten replies are the evidence block restated; the ban is the half a shape guard can never reach (§13.129.3) | `75832dbd`, `0edc2aef`, `57f827a0`, `d6233ab6`, `1da05512`, `1a1907b4` |
| narrowed close | the decline condition becomes *nothing about the user's situation* rather than *not the answer*, which is a predicate over a different thing | all 7 declines |

What it deliberately does **not** do: it states no reply shape and no prefix. `answer-line` proved a
shape is a tax on every question whose gold is not that shape — 117 short-gold questions 116 → 116,
33 paragraph-gold questions 24 → 12 (run `40807829150`) — and two of the ten here already compose
without a shape, so a shape would be a second variable aimed at a failure that is not theirs.

## 4. Claims, thresholds, falsifiers

The control is the archived arm, at the same load (§5). Nothing in this table may be moved after the
artifact exists.

| # | claim | threshold | falsifier |
| --- | --- | --- | --- |
| C1 | **reach** — the instruction block moves on exactly 30 of 500 questions; the other 470 render byte-identical prompts | `promptDigest` equal to the archive on 470 of 470; on the 30 it differs | any digest mismatch outside the 30 |
| C2 | **conversion** — the treated ten convert | ≥ **5 of 10** (at least 25/30 stay correct), McNemar one-sided p < 0.10 over the 30 | ≤ 2 of 10 |
| C3 | **cost** — one call per preference question as before, and prompt tokens per question rise by the block's own delta and no more | `calls` per question unchanged; roster tokens/query +≤ 0.5% | any extra call, or > +1.0% |
| C4 | **guard** — no capability outside `IE` can move (not dispatched in this run), and inside `IE` the 120 non-preference questions are an internal control | flips on the 120 ≤ 7 (the 5.0% reader floor measured on 19 of 379 byte-identical prompts, §13.135.2, rounded to 120) | ≥ 10 flips on the 120 |

C3 is arithmetic rather than a hope, and it is measured on the constant rather than guessed: the
shipped flat block is `extractive` plus the merging sentence — **393 characters** — and the preference
block is **518**, so the delta is **+125 characters per treated question** (≈ 31 tokens). Over 30
questions and a 7,448-token mean across 500, that is **+0.03%**. The retry path is unchanged because
it is the flat route's own (`#answerWithBareRetry`), so the call count is the archive's.

## 5. The dispatch, and the load it is compared at

`benchmark-cortex-memory.yml` dispatched at the commit that carries this file, with the registered
values stated explicitly rather than left to defaults — the class of defect `arm-config-record.py`
exists for is a run that describes a configuration the defaults silently supplied:

| input | value | why |
| --- | --- | --- |
| `limit` | `0` | full file; a sample would change which 30 exist |
| `capability` | `IE` | the treated population is inside `IE`; the other four capabilities cannot move under this change and re-running them prices nothing |
| `ablation_runs` | `4` | the archived control's scale; a 1-run treatment against a 4-run control is two denominators |
| `cortex_memory_ask` | `verbatim-acts` | the archive's |
| `cortex_memory_prompt_contract` | `evidence-blocks-unsourced` | the archive's |
| `cortex_memory_max_prompt_chars` | the archive's six-entry table | stated explicitly, because the workflow default is empty and arrives at the same table through a fallback |
| `cortex_memory_evidence_roles`, `…_routes`, `…_max_turn_chars`, `…_routes`, `relevance*`, `rerank`, `review_pass`, `query_expansion`, `self_consistency`, `source_trust`, `retrieval_threshold`, `thinking`, `model` | the archive's | unchanged, and stated for the same reason |

Cost: `150 questions × 4 repetitions = 600` reader calls plus 600 judge calls, at the archive's
7,448 prompt tokens per question — **≈ 4.5 M prompt tokens**, the same order as the main benchmark's
`IE` share and bounded by it. Wall clock ≈ `1,200 calls × 6 s` under the shared request gate.

## 6. Decision rules

| readout | action |
| --- | --- |
| C1 holds **and** C2 ≥ 5 of 10 **and** C3 ≥ 0 at +≤ 1.0% **and** C4 holds | **adopt**: this is already the product's behaviour (no flag, no arm field), so adoption is keeping the commit, recording the reading in `COMMITTED-READINGS.md` and the row in `ACCEPTANCE-MATRIX.md` — done, as `S19` |
| C2 in 3..4 | one confirmation dispatch at the same load before any statement beyond "inconclusive" |
| C2 ≤ 2, or C4 fails | **revert** the route, keep this file and the contract as the ablation reference, and record in `RETRACTIONS.md` why a mechanism the reference pipeline reports as a win here did not produce one |

No peeking, no re-running for a better draw. A C1 failure voids the run's interpretation before any
accuracy is read, which is the rule §13.129.1 and §13.130 arrived at from four separate defects.

## 7. What this leaves out, on purpose

- **The two composed-but-refused answers** (`d24813b1`, `0a34ad58`) may not move, because their
  failure is the judge's acceptance of a composed recommendation and not the block. If they do move,
  that is a fact about the judge and belongs to the judge axis (`judge-audit.yml`), not here.
- **The retrieval half** of `0edc2aef` (the question names Miami hotels; the window carries Seattle
  hotels) is a ranking question and stays where §13's ranking work left it. A prompt cannot retrieve.
- **A shape** (`Answer: …`), for the reason §3 states.

## 8. Outcome, draw 1

Run `45297492685`, `limit=0 capability=IE ablation_runs=4`, at commit `42ce2376`. The artifact's own
`--registration` readout compares **30 of 30** fields against the dispatch table and finds no
difference, so the numbers below are the arm's; `capability` is the population selector the
registration declares and not an arm field.

Two accuracies come out of one report — one repetition's in `feature.metrics`, the mean over four in
`ablation` — and §13.41.5 is the round this campaign confused them. Both are stated, labelled:

| scale | control (S16, same 150) | treatment | delta |
| --- | --- | --- | --- |
| repetition 1 (`feature.metrics.correct`) | 137 / 150 = 91.33% | **145 / 150 = 96.67%** | **+8 questions, +5.33 points** |
| mean of four (`ablation.featureByCapability.IE`) | 137 / 138.25 / 139 | 139 / **142.5** / 145 | **+4.25 questions, +2.83 points** |

The paired ledger below is a per-question pairing, so it is a repetition-1 comparison; the mean is the
scale the arm's own `costEfficiency` quotes (`accuracy: 0.95`, `accuracySource: all-runs`). The
treatment's own four passes span 6 questions (139–145) against the control's 2 (137–139), so +8 is
**inside the treatment's own spread** and +4.25 is the number to carry into a projection. The
attribution is what makes either number a mechanism rather than a draw.

| claim | threshold | measured | verdict |
| --- | --- | --- | --- |
| C1 reach | 470 of 470 non-treated prompts byte-identical | **118 of 120** identical; the 2 exceptions are on the `assistant` route, which the treatment cannot reach, and are explained by §8.2 | holds on the population the treatment can touch |
| C2 conversion | ≥ 5 of 10 | **7 of 10 rescued, 0 lost**; exact one-sided **p = 0.0078** (two-sided 0.0156) | **met** |
| C3 cost | calls unchanged, tokens +≤ 0.5% | **2.613 calls per question-pass** against the archive's 2.83, and **5,142.8** prompt tokens per question-pass on the arm's own `costEfficiency` (§8.3) | **met** |
| C4 guard | ≤ 7 flips on the 120 non-treated | **1 up, 0 down** (`a82c026e`) | **met** |

### 8.1 The decisive line is the attribution split, not the aggregate

`readout-arm-run.py --attribution` splits the pair by whether the prompt changed, which is the test
`recommend`'s failure in §13.129 produced. `p` is the exact sign test the tool prints, two-sided:

| bucket | n | up | down | tie | flip | p | gold carried |
| --- | --- | --- | --- | --- | --- | --- | --- |
| identical prompt | 118 | 1 | 0 | 117 | 0.85% | 1.0000 | **0** |
| changed prompt | 32 | **7** | **0** | 25 | 21.88% | **0.0156** | +1 |

**Attributable delta: +7 questions of 150 = +4.67 points on `IE`, +1.40 points on the 500 roster**
(repetition-1 scale; on the four-pass mean it is +0.85). The identical-prompt bucket is **+1, not +0**:
`a82c026e` flipped on a prompt whose digest did not change, which is reader variance and is the same
single flip C4's guard counts — not a second one. The `gold carried` column is the split's own
self-check: a delivered turn cannot enter or leave without the prompt changing, and the identical
bucket reads **0**, so `promptDigest` and the pairing key agree.

This is the opposite shape to §13.129, where seven of nine came from prompts that never changed.

### 8.1.1 The variable was actually single on 26 of the 30

An attribution split says the prompt moved; it does not say *only the block* moved. That was checked
directly on the 30 treated questions, and it does not hold for all of them:

* **26 of 30** carry the same `promptChars`, the same `evidenceChars`, the same turn count and the same
  `turnWindowCensus` on both sides, and their `deliveredPromptChars` differ by **exactly +125** — the
  block's own length. For these, the contract is the only variable.
* **4 of the 30** also lost a turn to retrieval (`1c0ddc50` 18→17, `32260d93` 49→48, `38146c39` 16→15,
  `caf03d32` 20→19). **None of the four flipped.** Their prompts moved for two reasons, so they cannot
  carry attribution either way, and they are named rather than averaged in.
* **all seven conversions are among the 26.** No conversion sits on a question whose evidence also
  moved, which is the sentence this section exists to be able to write.

The three that did not convert are `75832dbd`, `1da05512` and `1d4e3b97`; the first names research-paper
recommendations whose retrieval half §7 already excluded, and the other two are the retrieval questions
§7 left to the ranking axis.

### 8.1.2 From the failures' side

`classify-raw-outputs.py --failures` grades the answer each arm actually sent. Non-correct falls from
**13 to 5**, and the taxonomy says where they went:

| state | control | treatment |
| --- | --- | --- |
| `long_prose` (≥ 200 characters) | 9 | 3 |
| `other` | 4 | 2 |
| non-correct total | **13** | **5** |

Six of the eight conversions leave `long_prose`, which is precisely the state the contract was written
for — a reader that answers a composition question in prose because "the answer alone" is not in the
window — and no question moves out of `correct` in either direction.

### 8.2 The audit failed, and the cause is outside the population

`--audit` refuses the artifact on `embedDegraded = 8 of 600`: eight retrievals lost their vector
channel and were scored lexically, so the artifact is a mixture of the registered arm and the lexical
fallback. The cause is in its own transport census — `rateLimited: 1`, `refusedCalls: 1` — one refused
embedding request, and nine questions consequently rendered **two different prompts across their four
passes** (`promptVariants = 2`).

What that does and does not touch:

* all **nine** variant questions are on the `assistant` route; **none** is in the 30-question treated
  population, all of which carry `promptVariants = 1`, i.e. their four passes sent identical prompts;
* the 8 degraded index records are ≤ 1.4% of 600, and the same rate applied to the 120 treated passes
  predicts ≤ 2, so the effect of +7 with 0 losses is not explained by degraded retrievals;
* the two prompts in C1's exception list (`ac031881`, `778164c6`) are both in the nine, and both were
  and remain **correct**.

So the artifact fails its own gate, and the failure is a finding about the embedding provider rather
than a caveat about the treatment. It is recorded rather than waived: the campaign's rule is that an
artifact whose arm is a mixture "belongs to no configuration", and the honest response is to say which
part of it is being read and why.

### 8.3 Cost

| reading | value |
| --- | --- |
| LLM calls | `llmUsage.calls = 1,568` for the run; `usageBySide` attributes **616** to the feature arm and **765** to the reference baseline, and does not attribute the remaining 187 |
| HTTP attempts | `transportRetry.calls = 5,353`, of which `refusedCalls: 1`, `rateLimited: 1` — the two entries §8.2 is about |
| prompt tokens | 3,761,893 total (**feature 3,085,653**, baseline 632,068), of which **3,425,864 (91.1%) were cache hits** |
| completion tokens | 27,502 |
| prompt tokens per question-pass | **5,142.8** — the arm's own `costEfficiency`, denominator 600 passes; the roster's 7,448 carries `multi-session`'s 48,460-character room |
| block delta | +125 characters on each of the 26 single-variable questions, measured as `deliveredPromptChars` — **0.02%** of an `IE` prompt |
| calls per question-pass | **2.613** (1,568 over 600 passes) against the archive's **2.83** (5,661 over 2,000) — the treatment is *cheaper* per pass, not dearer |

C3 said the call count is the archive's because the retry path is the flat route's own. The measurement
says something slightly different and better: **2.613 < 2.83**, because the contract asks for a
recommendation in at most three sentences and fewer answers therefore run long enough to trigger the
truncation retry. The criterion was written as "unchanged"; the reading is "down 0.22 per pass", and
the direction is the same one C3 was protecting — the treatment does not buy its points with extra
calls.

### 8.4 The confirmation draw is blocked, by the same fact as §8.2

A second dispatch at the same load (`45301338541`) failed its embedding preflight in the first minute:

```
429 Too Many Requests — {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
```

The embedding provider's balance is exhausted. That is the same cause as the single refusal in draw 1,
which means draw 1 was taken while the quota was running out rather than on a healthy provider.
Consequences, stated rather than worked around:

* the treatment's claim does not need a second draw — it is a paired comparison on 150 questions with
  the attribution split at p = 0.0156 — but a **replication** does, and it cannot be had until the
  balance is topped up;
* switching to the offline embedder (`@agentix-e/embed-code-node`) would not be a confirmation of this
  arm: `embedding.model` is a registered field, the 91.20% was taken with `embedding-3`, and a lexical
  or ONNX index is the configuration `S14` priced at 85.75%. That is a different experiment.

### 8.5 What adoption left behind, and the one number that was wrong twice

Three artefacts make this a reading rather than a paragraph, and a fourth finding came out of building
them:

* **`packages/cortex-memory/test/preference-route/result.json`** — the numbers, once, in one object, with
  the two commands that produced them. `tools/committed-readings.json` carries it as a `one-shot` reading
  with a hash, because re-deriving it needs a dispatch plus two 60 MB artifacts.
* **`packages/cortex-memory/src/__tests__/preference-route-reading.test.ts`** — nine assertions about the
  *arithmetic between* those numbers: the movement equals its own bucket sum, the buckets partition the
  population, the conversions are the preference questions, the first-repetition count sits inside its
  arm's four-pass range, the failure taxonomy accounts for the conversions, and the quoted p follows from
  the up/down counts it was computed from.
* **`S19`** in `packages/cortex-eval/src/acceptance.ts`, reading
  `paired.buckets.changedPrompt.up` from that file with the arm's `prompt_contract` and `ask` attested, so
  a later edit to the contract renders `STALE` rather than a number. `node tools/acceptance-check.mjs`
  prints `S19  7  ≥ 5  pass`.

The finding: **the first draft of §8.1 said the treatment converted 7 questions and the arm moved from
137 to 145.** Both sentences were true and together they were false — 137 + 7 is 144. The eighth question
is `a82c026e`, which flipped on a prompt whose `promptDigest` did not change, so it belongs to the reach
guard (C4's `1 up, 0 down`) and not to the attribution. Nothing in the tree could have caught it, because
the two numbers lived in two paragraphs of the same section; the rule that came out of it is that a
movement and its decomposition are stored in one object and asserted against each other, which is what the
test above does.

The same recount caught four stale `29`s in code comments — `memory.ts` twice, `preference-route.test.ts`
and `product-provider-route.test.ts` once each — left behind by §1's 29 → 30 correction, which had only
been applied to the document. A corrected count that survives in a comment is a count that gets quoted
again.

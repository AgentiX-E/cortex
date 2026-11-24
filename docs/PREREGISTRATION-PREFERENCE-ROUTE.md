# PREREGISTRATION-PREFERENCE-ROUTE

A pre-registration, written before the code, for giving the preference question its own answer
contract in the product.

> **STATUS: REGISTERED, code in this commit, dispatch pending.** The population below is counted on
> an archived artifact, not estimated; §5 fixes the dispatch and §6 the decision rules, so the readout
> cannot choose its own bar.

## 1. The population, counted

The archive is the registered arm `S16` (run `44017278305`, 500 questions × 4 repetitions, 91.20% by
per-question count: `feature.metrics.correct = 456`). The preference population is not labelled in
that artifact — `questions[]` carries no `questionType` — so it is identified by the one field that is:
the gold. Every LongMemEval-S preference question's gold begins `The user would prefer`, which is the
dataset's own template rather than a heuristic:

```
29 questions, gold prefix "The user would prefer …"
route:    all 29 render `flat` (nothing else can receive them)
correct:  20 of 29
wrong:     9 of 29
```

The nine, with the answer the arm gave:

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

Seven of the nine tell the reader the evidence does not answer the question. Two already compose a
recommendation and were not accepted. **The ceiling is therefore 9 questions = 1.80 points on the 500
roster**, and it is a ceiling over the *treated* population, which is the whole of it: all 29 render
`flat`, so no question in this set is outside the treatment's reach.

## 2. Why the flat route cannot serve these, in the block's own words

The registered arm routes every one of the 29 to `answer()`, which builds with the `extractive`
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

1. **The reach is computed, not asserted.** The population is 29 questions, all on `flat`, all
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

| line | what it answers | which of the nine |
| --- | --- | --- |
| Step 1 silent | the two-step shape, with the notes *not* written out: §13.123's `silent` ask lost 26 `MR` questions by asking for a written list, so the step exists and its output does not | all 7 declines |
| Step 2 recommends | "reply with the answer alone" replaced by "reply with the recommendation itself" | all 7 declines |
| no echo | five of the nine replies are the evidence block restated; the ban is the half a shape guard can never reach (§13.129.3) | `75832dbd`, `0edc2aef`, `57f827a0`, `d6233ab6`, `1da05512` |
| narrowed close | the decline condition becomes *nothing about the user's situation* rather than *not the answer*, which is a predicate over a different thing | all 7 declines |

What it deliberately does **not** do: it states no reply shape and no prefix. `answer-line` proved a
shape is a tax on every question whose gold is not that shape — 117 short-gold questions 116 → 116,
33 paragraph-gold questions 24 → 12 (run `40807829150`) — and two of the nine here already compose
without a shape, so a shape would be a second variable aimed at a failure that is not theirs.

## 4. Claims, thresholds, falsifiers

The control is the archived arm, at the same load (§5). Nothing in this table may be moved after the
artifact exists.

| # | claim | threshold | falsifier |
| --- | --- | --- | --- |
| C1 | **reach** — the instruction block moves on exactly 29 of 500 questions; the other 471 render byte-identical prompts | `promptDigest` equal to the archive on 471 of 471; on the 29 it differs | any digest mismatch outside the 29 |
| C2 | **conversion** — the treated nine convert | ≥ **5 of 9** (≤ 25/29 stay correct → at least 25/29), McNemar one-sided p < 0.10 over the 29 | ≤ 2 of 9 |
| C3 | **cost** — one call per preference question as before, and prompt tokens per question rise by the block's own delta and no more | `calls` per question unchanged; roster tokens/query +≤ 0.5% | any extra call, or > +1.0% |
| C4 | **guard** — no capability outside `IE` can move (not dispatched in this run), and inside `IE` the 121 non-preference questions are an internal control | flips on the 121 ≤ 7 (the 5.0% reader floor measured on 19 of 379 byte-identical prompts, §13.135.2, rounded to 121) | ≥ 10 flips on the 121 |

C3 is arithmetic rather than a hope, and it is measured on the constant rather than guessed: the
shipped flat block is `extractive` plus the merging sentence — **393 characters** — and the preference
block is **518**, so the delta is **+125 characters per treated question** (≈ 31 tokens). Over 29
questions and a 7,448-token mean across 500, that is **+0.02%**. The retry path is unchanged because
it is the flat route's own (`#answerWithBareRetry`), so the call count is the archive's.

## 5. The dispatch, and the load it is compared at

`benchmark-cortex-memory.yml` dispatched at the commit that carries this file, with the registered
values stated explicitly rather than left to defaults — the class of defect `arm-config-record.py`
exists for is a run that describes a configuration the defaults silently supplied:

| input | value | why |
| --- | --- | --- |
| `limit` | `0` | full file; a sample would change which 29 exist |
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
| C1 holds **and** C2 ≥ 5/9 **and** C3 ≥ 0 at +≤ 1.0% **and** C4 holds | **adopt**: this is already the product's behaviour (no flag, no arm field), so adoption is keeping the commit, recording the reading in `COMMITTED-READINGS.md` and the row in `ACCEPTANCE-MATRIX.md` |
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

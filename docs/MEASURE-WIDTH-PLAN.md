# The evidence budget is per question

`C6`. The arm gives a route one room -- 48,460 characters for `multi-session`, 24,000 for the other four
-- and every question on that route is answered at that width. This file records what that costs, the
mechanism that replaces it, the two defects the wiring produced before any reading existed, and the
criteria the reading will be judged against.

**No reading exists yet.** The dispatch that will produce the first one is `43259830582` (200 questions x
2 repetitions). Everything below is the mechanism and its registration.

## 1. What the fixed width costs

From `evidence/longmemeval/cost.json`, the registered arm reads **9,201** billed prompt tokens per question
(`perQuestionPerRun` 9,200.5 over four repetitions), and the room that produced it is:

| route | room | share of the bill |
| --- | ---: | --- |
| `multi-session` | 48,460 | **67.3% together** |
| `temporal` | 48,000 | |
| `flat`, `knowledge-update`, `abstention`, `assistant` | 24,000 | 32.7% |

Two facts make that width indefensible as a single number:

1. **A character room is not a depth.** On `41546569106`, one 48,000-character room delivered 61 turns on
   `flat` (723 characters each) and 179 on `temporal` (205 each). The same number bought 2.9x more ranking
   on one route than on the other.
2. **The delivered turns are small.** The median delivered turn is **272 characters**, p90 2,305. Twenty-six
   of them are 7,072 characters in a 24,000-character room -- so most of the room is a tail.

§14.126 put an upper bound on the alternative: at **2x the gold evidence**, capped at what the run actually
delivers, the same five hundred questions would bill **3,703** tokens. That row is not a configuration
(production does not have the gold), but it locates the money: **59.6% of the bill is not evidence, it is
the assumption that every question needs the same width.**

## 2. The mechanism

`planEvidenceRoom(question, turns, options, rendered?)` in `packages/cortex-memory/src/width.ts`:

1. Score every candidate with `lexicalRelevance` -- the signal the pipeline already has and already ranks
   with.
2. Rank descending, ties by arrival (the signal has no opinion on a tie, and arrival is the only other rule
   the pipeline has).
3. Fund the shortest **prefix** that explains `coverage` of the total relevance mass.
4. Return that prefix's rendered length, raised to `floorChars`, inflated by `renderMargin`.

It is a prefix and not a subset because the budget it feeds is a prefix: `chooseEvidence` spends the room on
the highest-scoring turns it can fit, so the cut removes the **tail** rather than reordering the head. A
subset would be a second selector, and then no reading could say whether the width or the new ordering
earned the delta.

### 2.1 Four reasons, not one number

`WidthDecision.reason` is one of `empty`, `unsignalled`, `identity`, `capped`, because a character count
cannot distinguish "the plan looked and declined" from "the plan cut and delivered" -- and `C6`'s negative
form is a **closure decision**, so a mechanism that reads the same when it never fired cannot be scored.

| reason | when | why it is not the same as `capped` |
| --- | --- | --- |
| `empty` | no candidates | the prompt is the empty-evidence prompt it already was |
| `unsignalled` | the question shares no content term with any candidate | **29 of the 500 abstention questions are this**, and their gold is a decline; cutting there would spend the mechanism on the population it knows least about |
| `identity` | `coverage = 1`, or the prefix already covers every candidate | the plan looked and there was nothing for a cap to remove |
| `capped` | the plan acted | the only reason that means the mechanism reached the prompt |

## 3. The wiring, and the two defects it produced before any reading

### 3.1 The cap was not in the measurement (`43259468403`, cancelled)

The registered arm caps one turn at **400 characters** on `multi-session` and `temporal`
(`CORTEX_MEMORY_MAX_TURN_CHARS`, reach recorded since §13.68). A 5,000-character turn therefore enters the
prompt as 400.

The first version of `planEvidenceRoom` measured **raw** turn lengths. On a 5,000-character turn that funds
a budget **twelve times** the prompt it is budgeting: the prefix is mostly text the renderer was never going
to print, `fitToBudget` reads `min(room, plan)` as non-binding, and the mechanism does nothing -- on exactly
the two routes whose bill the experiment exists to reduce.

The dispatch would have reported that as a **negative result**: a full control copy under the treatment's
name, which is the same shape §14.131 found in the sampler (an input that never reached the request). It was
cancelled at 2.85 CNY of authorisation before it produced a reading.

The repair passes the rendered length per turn, resolved through `#capReaches` rather than by reading the
cap directly: a plan that assumed the cap reached every route would **under**-fund the four it does not.
Three assertions pin it, and the end-to-end one was verified red by passing `undefined` in place of the
lengths.

### 3.2 The plan would have replaced the rooms instead of sitting under them

`C6`'s criterion 3 is a single variable: the two load-bearing routes keep their 48,460 / 24,000 ceilings and
the plan decides the budget under them. The first grammar put the plan on a **separate** input, which does
not exist -- the workflow sits at **24 of GitHub's 25 dispatch inputs** and `test_dispatch_inputs.py` forbids
sitting at the ceiling. The second put it on the budget input as a replacement, which would have moved the
room and the budget in one dispatch.

The grammar now carries both, comma-separated, with one discriminator character per shape:

```
<digits>                                      a scalar room
abstention:24000,...,multi-session:48460      a per-route room
coverage=0.9[,floor=4000][,margin=1.15]       a plan
multi-session:48460,coverage=0.9              both
```

An item with `=` is a plan parameter; an item with `:` is a route. `floor=4000` therefore cannot reach the
route parser, and a neighbouring route name cannot be read as an unknown plan key. Nine refusals, each with
the sentence a reader needs -- `coverege` is refused rather than ignored, because the alternative is a run at
full width whose config line claims a cut.

## 4. The registered criteria

From `03` §14.126.2, unchanged except where noted:

| # | criterion | value |
| ---: | --- | --- |
| 1 | accuracy non-inferior | **>= 90.40%** (the running arm's 91.40% minus 1.0), four repetitions |
| 2 | bill | **<= 6,500** billed tokens per question, with `C1`'s 6,000 recorded as the next target |
| 3 | single variable | only the allocator moves; `ask`, retrieval, contract, pool, evidence source, retry shape and both route ceilings untouched |
| 4 | attribution | per question `promptChars` (already in the artifact) and the run's reason census; without both the score is not read |
| 5 | negative form | accuracy < 90.40% closes this family |
| 6 | price | 200 questions x 2 repetitions (**2.85 CNY**) reads the negative form; the full run (14.26 CNY) only after it passes |

**Criterion 4 is weaker than it was written**, and the reason is a debt rather than a choice: per-question
`reason` would have to travel through `runBenchmark`'s capture and `scoreEvaluation`'s **ninth** positional
parameter, and that signature is already the worst one in this repository. `promptChars` is per question and
is the width itself -- not an estimate -- so the width half of the criterion is met; the reason half is met
at run level. What that loses, stated plainly: a run can say **how many** questions each reason covered but
not **which**, so "the cut fired on the questions with the smallest gold" is not checkable from one
artifact.

## 5. What this does not promise

- **No accuracy claim.** The mechanism can cut evidence that mattered -- `a4996e51` is the recorded case of a
  decisive operand sitting in a turn a `lexicalRelevance` rank would have put last, and §13.187 read it as a
  reader declining on an operand its prompt had lost.
- **No claim that 3,703 is reachable.** It is the bound at 2x gold; the plan approximates gold by relevance
  mass and those are different quantities.
- **No claim about `MR` or `TR` specifically.** Both are on the two capped routes, so the mechanism reaches
  them most -- but the population it cuts hardest is per question, not per route.

## 6. Reproduction

```sh
# the negative-form read (200 questions x 2 repetitions, 2.85 CNY)
python3 tools/dispatch-cortex-memory-ab.py \
  --set limit=200 --set ablation_runs=2 \
  --set cortex_memory_max_prompt_chars='abstention:24000,assistant:24000,flat:24000,knowledge-update:24000,multi-session:48460,temporal:48000,coverage=0.9'

# the full read, only if the above clears 90.40%
python3 tools/dispatch-cortex-memory-ab.py \
  --set cortex_memory_max_prompt_chars='...same...,coverage=0.9'
```

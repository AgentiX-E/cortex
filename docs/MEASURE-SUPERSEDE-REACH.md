# The `'drop'` rule cannot be aimed, and that closes the read-side axis

`docs/MEASURE-KU-STALE.md` ends by withdrawing `supersede: 'mark'` and registering `'drop'` — remove the
superseded turn from the rendering instead of pointing at it — at 72 `KU` questions and roughly 2 元. This file
is the measurement that had to precede the dispatch, and it does not support one. **No function of surface
tokens separates "the corpus changed its value" from "two sentences both mention a number"**: at the tightest
setting available the rule touches **77** windows, of which **66** are already correct, deletes the gold from
**36** of them, and removes the stale value from **none of the four** questions the arm was registered for. The
axis closes here, for the third and last time, and what replaces it is a slot at ingest rather than a sentence
in a prompt.

## 0. One paragraph

`'drop'` needs a decision function: given two turns, "the later one replaces the earlier one's value". Run over
the control artifact (`42533236864`, 500 questions, four repetitions), the loosest rule that reaches the four
known substitutions touches **309 of 500 windows**, drops **858** turns and deletes the gold from **174**
windows. Adding the subject test changes nothing, which is itself the finding: the subject test is implied by
the anchor test. The containment test buys real precision — 77 windows, 128 turns — and the two columns that
decide the arm then read: **6 of 11** failures have their stale value removed, and **36 of 77** windows lose
their gold. Inside `KU`, the capability the arm was registered for, the numbers are **1 of 5** removed and
**7 of 33** gold lost — and the single removal is `c7dc5443`, one of the five **undelivered** questions the
arm's third clause forbids counting. The three stale twins the rule reaches keep their stale value. So the
dispatch is not made, the 2 元 is not spent, and the next step on `KU` is the one the external record names:
extraction with a slot, at ingest.

## 1. What the arm's decision function has to do

The registered arm says the drop set comes from "`conflict.ts`'s existing `conflictStatements`, tightened to
whole token runs". The tightening was specified because `conflict.ts` matches **question terms**, and §7.1 of
`MEASURE-KU-STALE.md` had already measured what that costs: a question about a 5K time shares `45` with a yoga
class, and a question about shoe storage shares `shoe` and `closet` with two unrelated sentences.

Tightening it is not a matter of editing a number. Three properties have to hold at once for a drop to be a
substitution and not a coincidence:

| property | why it is needed | what happens without it |
| --- | --- | --- |
| both sentences carry a **value** | a substitution replaces a value | every pair of turns about the same subject pairs |
| the value **kinds** match | `6:00 pm` replaces `7:00 pm`; `6` does not replace `seven` | a duration pairs with a price |
| the **remainders** agree | the two sentences are about the same detail | "gym day pass \$20" pairs with "gym membership \$45" |

`tools/supersede-census.mjs` measures three rules that add those constraints one at a time, so the curve is
visible rather than one tuned point. It reads only `questions[].turns`, `question`, `capability`, `answer`,
`groundTruth` and `correct`, so it runs on any archived artifact with no model call.

Two new columns are what the decision turns on. `removed` counts the failures where the value the reply gave is
**no longer carried** by any surviving turn — a necessary condition for the arm to have done its job, tested by
whole-token run rather than by substring, because `52` appears inside 22 turns of `c7dc5443`'s transcript and
`5-2` does not. `goldLost` counts the windows, right or wrong, where the drop removes the gold entirely: the
collateral the arm would pay before the reader has read anything.

## 2. The curve

| rule | touched | wrong | right | turns dropped | removed | gold lost | wrong / right |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `anchor` — shared value kind, different value, both sentences share a **question** term | 309 | 29 | 280 | 858 | 22 | **174** | 0.104 |
| `anchor+subject` — and the two sentences share a term with **each other** | 309 | 29 | 280 | 858 | 22 | 174 | 0.104 |
| `anchor+subject+containment` — and one remainder is ≥ half contained in the other | **77** | **11** | **66** | **128** | **6** | **36** | **0.167** |

`anchor` and `anchor+subject` are **identical**, and that is a fact about the corpus rather than a coding
error: a sentence that shares a term with the question and a value kind with another sentence almost always
shares that term with it too, because the question's terms are what selected both. The subject test is implied
by the anchor test, so the only decision in the whole family is containment — and the last row is the best
point on the curve.

By capability, at the tightest rule:

| capability | n | touched | wrong | right | turns dropped | removed | gold lost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ABS` | 30 | 6 | 0 | 6 | 10 | 0 | 6 |
| `IE` | 150 | 9 | 0 | 9 | 11 | 0 | 5 |
| `KU` | 72 | **33** | **5** | **28** | **66** | **1** | **7** |
| `MR` | 121 | 21 | 5 | 16 | 31 | 4 | 13 |
| `TR` | 127 | 8 | 1 | 7 | 10 | 1 | 5 |

Two readings from that table, and the second is the one that ends the argument:

- **The capability this arm was registered for costs the most and returns the least.** 66 turns removed from 33
  `KU` windows to reach 5 failures, one of which is the only one whose stale value actually leaves the window.
- **The rule deletes the gold from 47% of the windows it touches** (36 of 77) — including **6 of 6** `ABS`
  windows, where the corpus answer is "no such information". A drop rule has no way to know which turn a
  question's answer rests on; that is not a tuning defect, it is the absence of a slot.

## 3. What the tightest rule reaches, and what each reach actually does

`MEASURE-KU-STALE.md` §1 splits the nine `KU` failures into four stale twins and five undelivered, and the
registered clause 3 says the five **must not** be counted as improvements — they are not in the arm's reach, so
a movement on them means the rule is doing something other than supersession.

| question | class | touched? | turns dropped | stale value gone? | gold kept? |
| --- | --- | :---: | ---: | :---: | :---: |
| `852ce960` mortgage pre-approval | stale twin | **yes** | 1 | **no** | yes |
| `a1eacc2a` short stories written | stale twin | **yes** | 2 | **no** | yes |
| `59524333` usual gym time | stale twin | no | — | — | — |
| `a2f3aa27` Instagram followers now | stale twin | **yes** | 1 | **no** | yes |
| `f9e8c073` bereavement group sessions | undelivered | no | — | — | — |
| `e66b632c` previous 5K best | undelivered | no | — | — | — |
| `69fee5aa` pre-1920 coins | undelivered | **yes — leak** | 1 | **no** | **no** |
| `c7dc5443` volleyball record | undelivered | **yes — leak** | 1 | **yes** | **no** |
| `07741c45` where the shoes are kept | undelivered | no | — | — | — |

Three readings, and all three change the criterion that was registered:

- **The conversion ceiling is not 3, it is 0.** The registered arm says "≥ 2 of 4, and the ceiling is 2
  because the other two are unreachable by the pair test". That was an inference from `conflict.ts`'s term
  matching, and the reach column seems to correct it upward: `852ce960`, `a1eacc2a` and `a2f3aa27` are all
  touched. The `removed` column corrects it back down, and further: **on none of the three does the stale value
  leave the window.** On `852ce960` the rule drops turn 2 while turns 3 and 11 restate `$350,000`; on
  `a2f3aa27` it drops the turn that states `1250` and a surviving turn still carries it; on `a1eacc2a` it drops
  an assistant turn that restates the count and **not** turn 5, which is the sentence the reply copied.
- **A reach that leaves the value in place is not a reach.** This is the difference between the previous two
  mechanisms on this axis and this one: the block at least *showed* the reader both values. A drop that removes
  one of three copies changes the window by 400 characters and changes nothing the reader can act on.
- **The leak is structural, not incidental.** `69fee5aa` and `c7dc5443` are touched because their windows
  contain the **older** value and the rule cannot observe that the newer one is missing. The single stale value
  that does disappear is `c7dc5443`'s — the volleyball record — which is to say the only window the rule
  actually cleans is one the arm was forbidden to count.

## 4. Why there is no threshold in between

The tempting move is to loosen containment until `59524333` is touched, or to sweep the 0.5 line. This file
does not, and the reason is a single question that makes the continuum argument concrete.

`a1eacc2a` asks "how many short stories have I written since I started writing regularly". The two statements
that disagree are:

```
[5]  I've written four so far since I started writing regularly, and I'm hoping to keep the momentum going.
[11] Completing seven short stories in three months is a remarkable achievement.
```

Their content terms are `{written, far, since, started, writing, regularly, hoping, keep, momentum, going}` and
`{completing, short, stories, months, remarkable, achievement}`. The intersection is **empty**. Both anchor on
the question — on *different halves of it* — and nothing else connects them. The rule touches this question
only through an assistant turn (`[6]`, "since you've written four short stories so far") that restates the
count in the question's own vocabulary, and then through `[16]`, which shares the single word `writing` and a
number and is pure collateral. `--detail a1eacc2a` prints all nineteen candidate pairs and the four the rule
accepts, which is why the tool has that flag: **a reach count cannot distinguish "the pair was found" from "the
turn that carries the answer was found".**

So the reach on the four is not a property of the rule. It is a property of whether some turn happens to
restate the value in the question's vocabulary. A rule tuned until the four convert would be tuned to one
artifact's phrasing, which is the failure `MEASURE-CONFLICT-SURFACING.md` §2 already records once for this
capability.

## 5. Why the axis closes rather than dispatches

Four reasons, and the last two are the ones that decide:

1. **The exposure is 6 correct windows per failure touched, corpus-wide; 5.6 within `KU`.** A drop rule's
   conversions and its collateral share one trigger, so a positive net would not be attributable to
   supersession and a negative one would not be diagnostic. The two prior dispatches on this axis were refused
   for buying conversions with regressions; this rule buys them with a coin flip.
2. **The gold loss is not a tail risk, it is the modal outcome.** 36 of 77 windows lose the answer's evidence
   outright, and the loss is exactly where the capability is hardest to spare: 6 of 6 `ABS` windows, 7 of 33
   `KU`.
3. **Removing turns is not free, and this project has priced it.** `ACCEPTANCE-MATRIX.md` §3.2: halving the
   character room — which is what removing turns does, at scale — cost `MR` **−6.61** and `TR` **−4.72**
   points while `IE`, `KU` and `ABS` barely moved. The two capabilities that aggregate lost accuracy and the
   three that read one fact did not, so a rule that removes turns from `MR` windows (21 of them, 31 turns) is
   spending from the most expensive account to fund the cheapest.
4. **The external record says the repair is not in the rendering.** `MemoryAgentBench`'s FactConsolidation
   split puts the best dedicated memory system at **54%** single-hop and every one of 22 systems at ≤ 28%
   multi-hop, while **deterministic aggregation over extracted candidates — take the highest serial number, in
   code — reaches 78.0%** (`gpt-4o-mini`) and **94.8%** (`gpt-4o`). The same substitution with timestamps
   holds on this benchmark's knowledge-update split. The finding is not "use code": it is that **the current
   value is a property of the store, not a judgement for the reader** — and a store can only hold that
   property if it has a slot to attach it to.

## 6. What would open the axis, stated as a design rather than a hope

The reason `'drop'` was tried at all is that `conflict.ts` derives `supersedes` edges from **subject and
predicate slots** (`packages/cortex-core/src/knowledge/edge.ts`), which is exactly the property surface tokens
cannot recover. It cannot be used here for a reason that is one `grep`:

```
packages/cortex-memory/src/  →  imports from cortex-core: createMemory, decideWrite, decideRetrieval,
                                LLM, MemoryValue, ValueFunction
                             →  imports from knowledge/:  nothing.  No FactFrame, no Edge, no deriveSupersedes.
```

The memory arm reads a value function and a write gate out of `cortex-core` and no part of its knowledge
model. It stores turns, and turns have no slots. So the axis is not reachable **from the rendering layer at
all** — not because the rendering is wrong, but because the layer above it never produced the structure the
rendering would need.

That makes the next increment an ingest-time one, and the shape is prescribed by the same paper:

| what | where it goes | what it costs |
| --- | --- | --- |
| extract `(subject, predicate, value, serial)` per turn at ingest | `cortex-memory`'s write path, beside `decideWrite` | one model call per turn — the 275k-call bill `PROTOCOL.md` already refuses for Mem0 |
| resolve "current" deterministically, in code, from the highest serial | `cortex-core`'s `deriveSupersedes`, already written and already refused traversal by `typed.ts` | zero model calls at read time |
| render the resolved value, not the two candidate turns | `prompt.ts` | replaces this file's rule with a lookup |

The third row is what makes the cost land where it does: the read path stays at one call per question, and the
extraction is paid once per corpus rather than once per question. It is also the one increment on this axis
whose mechanism would be **visible in the artifact** — a resolved value has a serial number and a source turn,
where a dropped turn has only an absence.

This file therefore does **not** register an arm. It records that the third attempt on the read side of this
axis is refused before it is paid for, and that the layer which can reach it is the write path.

## 7. What this does not claim

- It does not claim `'drop'` would fail on accuracy. Nothing was dispatched, so nothing was measured on
  accuracy. The claim is about **reach and attribution**: at the tightest setting the rule does not remove the
  stale value from any registered target, and it removes the gold from half the windows it touches.
- It does not claim the 0.5 containment line is optimal. It is the only setting that produced a curve, and the
  measured points are three; a fourth would be a tuned number, not a mechanism.
- It does not claim `removed` is a repair. An absent stale value is a necessary condition for a supersession
  repair and not a sufficient one — the reader may still answer wrongly from another turn. It is used here
  only in the negative direction, where it is decisive: a rule that leaves all three copies in place cannot
  have changed what the reader had to choose between.
- It does not claim the rule is useless as an **instrument**. `tools/supersede-census.mjs` runs on any artifact
  at zero cost and its `removed / goldLost` columns are the cheapest available test of whether a future
  supersession rule can be aimed. That is why the tool is shipped and the arm is not.

## 8. Reproducing

```sh
node tools/supersede-census.mjs /path/to/benchmark-cortex-memory-ablation-report.json
node tools/supersede-census.mjs /path/to/report.json --json          # per-rule rows, reached ids
node tools/supersede-census.mjs /path/to/report.json --detail <id>   # every candidate pair, accepted or not
```

```
500 questions

rule                            touched   wrong   right  dropped  removed  goldLost   wrong/right
anchor                             309      29     280      858       22       174         0.104
anchor+subject                     309      29     280      858       22       174         0.104
anchor+subject+containment          77      11      66      128        6        36         0.167
```

`tools/__tests__/test_supersede_census.py` pins the decisions this instrument makes rather than the counts:
the date stamp in front of every turn is not a value, a restatement is not a substitution, a pair whose newer
statement is absent is not a pair, and a drop that leaves a copy of the value behind does not report one as
removed.

# MEASURE-ABSTENTION-RECOVERY

What a decline actually means on MR and TR, and the gate that was missing because a comment
asserted something nobody had counted.

## The claim in the code

`memory.ts`, above the audit pass:

> an abstention is a decision, and this pass audits a list that does not exist

That sentence decides behaviour: the second consultation is skipped when the first declines. It is
a claim about the world — that a decline arrives with an empty Step 1 list — and it was never
measured. It is false.

## The measurement

Three archived runs of the adopted configuration. For every reply that returned
`INSUFFICIENT_EVIDENCE` with no parsed answer, the bullets before the `Step 2` heading were counted.

| run | capability | abstentions | with a non-empty Step 1 list |
| --- | --- | --- | --- |
| `39367801501` | MR | 10 | **8** |
| `39367801501` | TR | 20 | 7 |
| `39367801501` | ABS | 30 | **0** |
| `39509698041` | MR | 9 | **7** |
| `39509698041` | TR | 15 | 5 |
| `39509698041` | KU | 2 | 1 |
| `39699987781` | MR | 9 | **8** |
| `39699987781` | TR | 23 | 4 |
| `39699987781` | ABS | 30 | **0** |

Two things make this a reading rather than a count:

- **MR is near-unanimous.** Eight of ten, seven of nine, eight of nine -- and the two that are not are
  the honest case: their only bullets read "No item in the evidence states ...", which the shipped
  predicate excludes, so the pass correctly does not fire on them. The reader enumerated the evidence
  and then declined with it in hand.
- **ABS is zero.** Thirty abstentions, no list, in both runs that have the capability. ABS questions
  are the ones whose gold answer *is* a decline, so this is the control the reading needs: a rule
  about lists cannot touch a route that does not produce one, and a system that started answering
  them would be trading a correct refusal for a wrong answer.

`abstentionReasons` in the same artifacts says where the declines came from: `threshold: 0`. Not one
was the retrieval threshold. They are all `llm` — the reader's own decision.

## Why these are pure loss

An abstention scores correct only when the gold answer is a refusal. On MR and TR it never is, so
every one of these 13 to 17 questions per run is wrong, and no retrieval change can fix it: the
evidence was in hand. This is the population that survived eleven rounds of prompt and retrieval
work, and the reason is structural — the pass that could have corrected it was switched off by a
comment.

## The gate

`abstention-recovery.ts`:

| decision | state |
| --- | --- |
| `disabled` | the feature was not requested |
| `answered` | the reader answered; nothing to correct |
| `no-list` | the decline was honest — the list is empty, which is the state the contract licenses |
| `retry` | the decline contradicts its own list |

A `retry` asks one more question, and it does **not** re-send the evidence. The list is the reader's
own extraction; for a counting question its length is the answer, so quoting it back is a complete
restatement of what the reader decided was relevant. Re-sending the window would make this a second
sample rather than a correction of the first — and §13.100.2 already measured what a second sample
changes: 24 of 121 MR answers.

The retry may still decline. A list can be non-empty and answer nothing (`d905b33f` lists one item
about a book and reports that no discount is stated anywhere), and forcing a number there would
invent one, which is what the grounding gates exist to prevent. So the "count the list" instruction
is added only for counting questions, and only there, because only there is the count of the list an
answer rather than a guess.

## What this does not do

- **It does not touch a question that answered.** The pass fires on `first === null` only, so no
  correct answer can move. The route test that pins this needed a fixture where the model *answers
  and* writes a list — the obvious fixture (a bare answer) has no bullets to find, and hardcoding
  the guard to `false` left the suite green.
- **It does not rescue a two-hop question whose second hop was never retrieved.** MR failures split
  20 reader / 17 retrieval on full versus partial gold coverage, and this pass only addresses the
  first half.
- **It is off by default.** `reviewPass: 'none'` is the shipped behaviour and every archived artifact
  was produced under it, so the treatment needs a run.

## Pre-registration

Dispatched as one variable against the adopted configuration, `CORTEX_MEMORY_REVIEW_PASS` set to
`recover`.

It is a **value** of the existing pass field rather than a new field, and the reason is not brevity.
`ReviewPass` was written as `'none' | 'audit'` with the note that a second pass with a different
question should be a value rather than a second boolean, and this is that pass. It also keeps the
workflow at 24 of its 25 dispatch inputs -- the suite forbids a workflow from sitting at the ceiling,
and a 25th input would have made the next registration impossible. Adding it as its own field was
tried first and failed that test, which is the test doing its job.

| id | criterion | control |
| --- | --- | --- |
| P1 | `recoveryCensus.attempted` between 10 and 20, and `answered > 0` | pass did not fire; the measured population is 12 to 15 |
| P2 | MR correct count ≥ +4 over the control | 84–88 across archived runs |
| P3 | TR correct count not down by more than 2 | 92–95 |
| P4 | ABS correct count unchanged | 29–30 |

P1 failing means the pass is not reaching the population the reading located, and is a bug rather
than a result. P2 failing means the reader cannot answer from its own list, which would say the
declines were right after all — and that is worth knowing, because it would move the work back to
retrieval.

Revert if P2 and P3 both fail, or if P4 moves at all: an abstention pass that changes ABS is
answering questions whose correct answer is "I cannot".

---

## The census is a script now, and it corrected this document

Three readings in step 23 were done with throwaway scripts, and the first of them was wrong in a way
worth keeping: it read the answer as the first number in the Step 2 block, which is the `2` in
"Step 2". Every count question then looked like a disagreement between its list and its answer.

`packages/cortex-eval/test/mr-census/run.mjs` is the same taxonomy, checked in, with `result-*.json`
beside it for three archived runs. It imports `declinedItems` from the built product rather than
re-implementing it, so the reading and the gate cannot drift apart — the rule `test/echo/run.mjs`
follows for `OutputGuard`.

Running it corrected the table at the top of this document. Through the shipped predicate, MR is
**8 of 10, 7 of 9, 8 of 9**, not 10 of 10: the two abstentions that were counted as carrying a list
list only *absence* ("No item in the evidence states ..."), and the predicate excludes those because
an absence is not an item. The first number would have said the pass should fire on an honest decline.

The recovered population is therefore **12 to 15 questions per run**, not 13 to 17, and the
pre-registration's P1 band was narrowed to `[10, 20]` to match.

The `mrVerdict` line is the one that decides the next experiment: on the adopted configuration the
split is **20 reader (complete gold coverage) / 17 retrieval (partial)**. On the session-unit run it is
**43 / 2** — the same taxonomy, a different configuration, and a reminder that this ratio is a property
of a configuration and not of the capability.

## The treatment run is blocked on billing, not on code

`40087115093` (full adopted payload, `review_pass: recover`) failed at 10:46 with

```
LLM request failed: 402 Payment Required — Insufficient Balance
```

The DeepSeek account is out of credit. Every question in the run that got that far failed the same
way, so the artifact carries no reading. Recorded rather than retried: a run re-dispatched into the
same 402 would produce a second artifact with the same shape and the same absence of information.

This is the second external block in the campaign (the first was the Zhipu embedding quota), and it
is stated in the same terms: **the measurement is ready and the account is not.**

---

## Result: the gate works and the treatment does not (run `40088479628`)

Full adopted payload, `review_pass: recover`, 500 questions. The config line was checked field by field
before any score was read, which is the rule step 24 added after a dispatch that measured the product
default: eight of eight fields match.

| | value |
| --- | --- |
| `recovery` | **`{attempted: 10, answered: 1}`** |
| `abstentionReasons` | `llm 75`, `threshold 0`, `answered 425` |
| IE / TR / MR / KU / ABS | 134 / 94 / 84 / 62 / 30 = **404** |
| control (mean of three adopted runs) | 134 / 94.75 / 84.25 / 62.5 / 29.25 = 405 |

Against the pre-registration: **P1 passes** (10 attempts inside `[10, 20]`, one answered), **P3 and P4
hold** (TR −1, ABS unchanged at 30/30), **P2 fails** — MR needed +4 and moved by −1 to 0. The default
therefore stays `none`, and the mechanism stays in the tree as a switch nobody is required to flip.

### Ten attempts, one answer

That ratio is the finding. The pass reached exactly the population the census located, declined to
touch ABS, and then failed to convert: nine times out of ten the reader, shown its own list and asked
again, declined again.

**And the artifact cannot say why.** It contains zero occurrences of the recovery prompt's own text,
because each record's raw output is the first answer rather than the retry's. So the next step is not a
prompt change: it is recording the retry's text, without which any retry mechanism reports a count and
no cause. This is the second observability gap on this pass — the first was P1 being unreadable at all
— and two on one mechanism is the reason the next round starts there.

### What the numbers argue against

Adding to a mechanism measured at 10% conversion, on the strength of a sentence that reads better.
The date frame (`PREREG-DATE-FRAME.md`) costs nothing, is supported by of an external reading on the
same benchmark, and does not depend on the call-layer machinery that just failed. It goes first.

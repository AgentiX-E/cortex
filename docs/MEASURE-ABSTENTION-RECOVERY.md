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
| `39367801501` | MR | 10 | **10** |
| `39367801501` | TR | 20 | 7 |
| `39367801501` | ABS | 30 | **0** |
| `39509698041` | MR | 9 | **9** |
| `39509698041` | TR | 15 | 5 |
| `39509698041` | KU | 2 | 1 |
| `39699987781` | MR | 9 | **9** |
| `39699987781` | TR | 23 | 4 |
| `39699987781` | ABS | 29 | **0** |

Two things make this a reading rather than a count:

- **MR is unanimous.** Every abstention in all three runs carries a non-empty list. The reader
  enumerated the evidence, then declined with the evidence in hand.
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
- **It is off by default.** `abstentionRecovery: 'off'` is the shipped behaviour and every archived
  artifact was produced under it, so the treatment needs a run.

## Pre-registration

Dispatched as one variable against the adopted configuration, `CORTEX_MEMORY_ABSTENTION_RECOVERY`
set to `once`.

| id | criterion | control |
| --- | --- | --- |
| P1 | `recoveryCensus.attempted` between 10 and 25, and `answered > 0` | pass did not fire |
| P2 | MR correct count ≥ +4 over the control | 84–88 across archived runs |
| P3 | TR correct count not down by more than 2 | 92–95 |
| P4 | ABS correct count unchanged | 29–30 |

P1 failing means the pass is not reaching the population the reading located, and is a bug rather
than a result. P2 failing means the reader cannot answer from its own list, which would say the
declines were right after all — and that is worth knowing, because it would move the work back to
retrieval.

Revert if P2 and P3 both fail, or if P4 moves at all: an abstention pass that changes ABS is
answering questions whose correct answer is "I cannot".

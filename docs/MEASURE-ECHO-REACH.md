# The echo gate reached nothing: `43121298653` read against the census that registered it

## 1. The result, in one table

| | control `42533236864` | echo arm `43121298653` |
| --- | ---: | ---: |
| overall correct | 456 (91.20%) | **457 (91.40%)** |
| replies that are an evidence dump (`classifyReply` -> `evidence-echo`) | 15 | 14 |
| … of those, wrong | 8 | 7 |
| `replyRepair.echo.attempted` | — | **0** |
| `replyRepair.echo.answered` | — | **0** |
| `bareRetry.attempted` / `.answered` | 75 / 75 | 75 / 75 |
| feature-side model calls | — | 2,075 |

The movement is **one question**, which is half the noise floor this campaign uses (±2 per capability). The
registered criterion was a net of at least +4 on the echo population. It did not fail on the population; it never
saw the population.

## 2. Why zero, and why it is not a wiring defect

The obvious explanation is the one this repository has already paid for twice: a flag that parses, records itself
in the artifact's config, and never reaches the product. That is not what happened here, and the arithmetic that
rules it out is three lines long.

**Feature-side model calls are 2,075 = 2,000 + 75 + 0.** Two thousand is 500 questions × 4 repetitions — the arm's
own shape. Seventy-five is `bareRetry.attempted`, which agrees exactly. Zero is the repairs. So the gate was
constructed, carried `replyRepair: 'echo'` (its own config line says so), and had nothing to do.

**Fourteen recorded replies are dumps, and the gate fires on any dump it sees.** The predicate is proven against
the first call by `reply-echo-reach.test.ts`'s first case: one dump in, one extra consultation out. So none of the
14 was a first-call dump. Every one of them was written by the **second** call — and the only second call on those
routes under `reviewPass: bare` is the bare-decline retry, because the session-aware recovery pass is off in that
mode by construction.

**The retry's reply is never classified.** `planReplyRepair` reads `#lastRawOutput` immediately after the first
consultation on each route (`memory.ts`, the `#repairReply` call sites). A question whose first reply is the bare
token takes the retry *after* that point, and nothing re-enters the gate afterwards. The second case of
`reply-echo-reach.test.ts` states that as a test: token first, dump second, `echo.attempted` stays 0.

So the registered population was not a population of first replies. It was **a census of whatever call came last**,
and on 75 questions that call was the retry.

## 3. What the misreading cost, and what it did not

It cost one dispatch (about 14 yuan) and it produced a second control sample: 91.40% against 91.20%, one question
apart. That is a useful null, and it is the fourth independent confirmation that the campaign's noise floor is real
— but it is not evidence about the repair, and it is not filed as one.

It did **not** cost the diagnosis. §4 of `MEASURE-COMPETITOR-PAIRING.md` measured 15 dumps wrong 53.3% of the time
against 7.1% for answers, and that reading stands: dumps are still eight times more likely to be wrong. What the
run adds is the missing half of the mechanism — **the dumps are produced by the retry, not by the first ask.**

## 4. The mechanism that follows, and why it is cheaper than the one that failed

Two ways to reach the population. They differ by 14 model calls per repetition, so the order is not a preference:

| candidate | what changes | calls added | what it risks |
| --- | --- | ---: | --- |
| `C-retry-echo` | one line in the **retry prompt**: `Do not restate, quote or list the evidence.` | **0** | the line reaches the 75 retried questions, of which 14 produce dumps |
| `C-echo-again` | a third consultation when the retry's reply is a dump | ~14 | two repairs on one question, and a second thing to attribute |

`C-retry-echo` first. It is the competitor's own line — `LME_answering_prompt.md` carries
*"Never write a reply that says the memories do not hold something and then supplies that very thing"*
(`MEASURE-COMPETITOR-PAIRING.md` §6, gap 2) — and it costs no model call, which means the whole 75-question
population is treated for free rather than 14 questions being repaired at a price.

Pre-registration:

| item | value |
| --- | --- |
| variable | the bare-retry prompt only (`buildRetryPrompt`); the first ask, the contracts and the window are untouched |
| criterion 1 | dumps in the final replies fall from 14 to **≤ 4** |
| criterion 2 | overall correct ≥ **460** (control 456, +4 net, above the ±2 floor) |
| criterion 3 | the 30 `bare-decline` questions stay **30 correct** — the line must not push an abstention question to answer |
| criterion 4 | `bareRetry.answered` does not fall below **70** of 75 (a line that makes the retry decline again would trade a dump for a decline) |
| cost | one dispatch, no added calls; the prompt grows by 45 characters on 75 of 500 questions |
| termination | criterion 1 misses: the retry prompt is not the lever, and the echo family closes with two nulls rather than one |

## 5. What this file changes in the earlier one

`MEASURE-COMPETITOR-PAIRING.md` §5 licensed "a deterministic echo gate" on the arithmetic of the census. The
licence was right about the population and wrong about **where in the pipeline it appears**: the 15 were read from
an artifact field that records the last call, and the gate sits behind the first. Three things are corrected:

1. The census is a census of final replies. Any future reach claim has to say which call it counts.
2. A treatment's `attempted` is not evidence it was administered; it is evidence it **fired**. The two reads that
   separate them are the call arithmetic in §2 and a unit test that drives the same shape.
3. A flag that reaches nothing and a flag that does nothing produce the same zero. The run is read as
   *unmeasurable*, not as *no effect* — the distinction `MEASURE-SUPERSEDE.md` §14.113.8 records for a claim of
   the opposite kind.

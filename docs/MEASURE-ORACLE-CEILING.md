# The oracle ceiling: splitting the distance to 100% into what retrieval lost and what the reader lost

Status: **pre-registered, dispatch pending**. Registered 2026-11-08, before the first run of either
condition. Written against `05-competitor-analysis.md` §1.38.5 (`O1`) and `§1.38.4` (`E1`).

## 1. The question

Every number this project has published is a **system** number: a reader, a prompt, an admission
gate and a retriever, all moving together. That is the right number to ship and the wrong number to
steer by, because it cannot say which component to spend the next round on. Two components account
for almost all of the remaining 8.4 points and there has never been a measurement that separated
them:

| Component | What it decides | Never measured here as |
| --- | --- | --- |
| **Retrieval** | which turns reach the prompt at all | the gap between the shipped score and the score with the gold sessions supplied |
| **Reading** | whether the reader answers correctly from what it was handed | the gap between that score and 100% |

The closest thing this repository has is the **pool ceiling** (`recall-curve`, 93.02%), which answers
"what if this retrieved pool were perfectly re-ordered". That is a different quantity: a perfect
re-ordering of a pool that does not contain the answer still cannot answer, so 93.02% is a bound on
the ranking stage and not on the system. `MEASURE-READING-STAGE.md` §5.2 says so in its own words —
*"not the oracle ceiling ... it cannot separate 'the reader is weak' from 'this reader is weak on
this context'"*.

A rival publishes both halves of the split. `Caura` reports 92.2% shipped and **94.6% under an
oracle condition** on the same 500 questions, which reads as **2.4 points of retrieval loss and 5.4
of reading loss**. If our split has the same shape, every future round belongs on the reader; if it
is inverted, the `MR` axis (the nine-question ceiling §1.37 registers) is not the main front at all.

## 2. The design

**One variable: the evidence pool.** Each question's `context` and `sessions` are replaced by its
gold sessions — every turn of the sessions named by the dataset's `answer_session_ids`, which is the
same set LongMemEval's official oracle file ships. Nothing else moves: the reader, the judge, the
temperature, the prompt contract, the ask, the admission gate, the per-turn cap, the prompt budget,
the answer cache and the four repetitions are all read from the same environment by the same code.

Both ablation sides are handed the oracle dataset. That is deliberate: it keeps the comparison
*paired* (same evidence, two systems), and it yields a second free reading — the reference pipeline's
own ceiling — which tells us whether our reader or our assembly is the limit.

Implementation: `packages/cortex-eval/src/oracle-evidence.ts`, armed by `CORTEX_MEMORY_ORACLE=1`
(a repository variable rather than a dispatch input; the workflow sits at 24 of GitHub's 25 inputs
and `test_dispatch_inputs.py` refuses a workflow that reaches the limit).

### 2.1 What this condition cannot separate, stated before the number exists

The gold pool is **~12 turns against ~550**. So the oracle run differs from a shipped run in two
ways at once: the evidence is correct, and there is 40× less of it. A high ceiling therefore cannot
be read as "retrieval is the only problem" — it may be reading "the reader does well when the
context is short". Caura's published oracle condition has exactly the same property; it is the
definition of the condition rather than a defect in this implementation. `E1` (§5) is the
measurement that separates the two, which is why both are registered in the same round.

Two further asymmetries, both in the reader's favour and both stated now:

1. **Per-turn truncation stops binding.** `maxTurnChars=400` reaches `multi-session` and `temporal`;
   with a 12-turn pool the room is 40× larger than the material, so no gold turn is cut. The shipped
   prompt does cut some.
2. **The 48,460-character room stops binding.** Every gold pool fits. The shipped run sometimes
   does not.

So the ceiling is an **upper** bound on "perfect retrieval, same everything else", not a central
estimate of it. A *low* ceiling is therefore strong evidence — it cannot be explained by either
asymmetry — while a *high* one is weak evidence. That asymmetry is the reason the judgement below is
written as a one-sided test.

## 3. Population, census, and the checks the artifact must pass

| Item | Value | Check |
| --- | --- | --- |
| Questions | 500 (LongMemEval-S, `limit=0`) | `questionCount == 500` |
| Gold annotation | **500 / 500** (`goldOverlap.total > 0` on every record of run `42373407439`, median 12, mean 15.0, max 48) | `census.unsourced == 0` |
| Roster | `IE 150 / TR 127 / MR 121 / KU 72 / ABS 30` | per-capability table reproduces |
| Dataset name | `longmemeval+oracle` | `assertOracleReached` throws otherwise |
| Pool vs shipped | `turns` and `chars` printed at load time, with the ratio | log line `Oracle evidence: …` |

The `unsourced == 0` check is the load-bearing one. A question without gold evidence keeps its
shipped context, so a ceiling computed over a mixed population would be a shipped score and an
oracle score averaged with unknown weights. If a future dataset annotates fewer questions, the
sourced subset becomes its own denominator and the run reports both — it does not silently average.

## 4. Judgement, registered before the run

Let `S` = the shipped score on the same 500 questions (currently **458/500 = 91.60%**, runs
`42452904894` / `42467392736`) and `C` = the feature accuracy of the oracle run.

| # | Reading | Verdict | Consequence |
| --- | --- | --- | --- |
| 1 | `C ≤ 93.60%` | the reader is the binding constraint: the ceiling is within 2 points of what retrieval already delivers | **`MR` stops being the main front.** All effort moves to the reader — prompt contract, ask, second consultation. Retrieval work is re-scoped to what it costs, not what it might gain |
| 2 | `93.60% < C < 96.00%` | both halves are large and comparable | the next four rounds split evenly, and `E1` decides which half buys more per token |
| 3 | `C ≥ 96.00%` | retrieval is the binding constraint | the retrieval axis is re-opened with a budget, and the 48,460-character room is re-examined against `E1` |

Why those thresholds: the noise floor on this arm is **17 questions / 27 at 95%**
(`§1.37.1`), i.e. 3.4–5.4 points. A threshold closer to `S` than 2 points would be unreadable. 93.60
is 2.0 points above `S`; 96.00 is 4.4.

**Falsifiers, and what each would refute:**

| Observation | Refutes |
| --- | --- |
| `census.unsourced > 0` | the population claim — the run is not an oracle measurement and must not be read as one |
| `dataset` lacking `+oracle` | the wiring — a shipped score would be published as a ceiling |
| feature accuracy identical to `S` to the digit | the transform (a 40× pool change that moves nothing is a defect, not a result) |
| `goldOverlap.carried < goldOverlap.total` on > 5% of sourced questions | the pool claim: the reader's own assembly dropped turns it was handed |
| transport retries > 0 or any refused call | the measurement — a throttled run reads low for a reason unrelated to the ceiling |

## 5. `E1`: the budget curve (registered in the same round)

`48,460 / 24,000 / 12,000` characters on `multi-session`, everything else at the registered
configuration, on the shipped corpus.

| Reading | Verdict |
| --- | --- |
| 12,000 loses **≤ 2 questions** against 48,460 | half of the last thirty rounds' tokens bought nothing; the budget becomes a cost axis with a measured knee, and the product default moves |
| 12,000 loses **3–9** | the knee is between the two, and the curve is refined at 18,000 before any adoption |
| 12,000 loses **≥ 10** | the room is load-bearing and the cost axis is closed for now |

The two conditions share one property that makes them readable together: if `C` is high **and**
12,000 loses nothing, then the shipped prompt is buying neither correctness nor necessity, and the
mechanism is over-provisioned on both axes. Neither number alone says that.

## 6. Cost and stopping rule

| Condition | Dispatches | Reader tokens (estimate) | Wall clock (measured on 4 workers) |
| --- | --- | --- | --- |
| `O1` oracle | 1 × 500 questions × 4 repetitions × 2 sides | ~2–4 M prompt (the pool is 40× smaller) | ~1 h |
| `E1` at 12,000 | 1 × 500 × 4 × 2 | ~14 M prompt (half the room) | ~3 h |

One dispatch each, no peeking, no re-running for a better draw. A run that dies on transport is
cancelled and re-dispatched once; a run that completes is final even if the number is unflattering.

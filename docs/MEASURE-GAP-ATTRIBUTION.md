# MEASURE — The Ranking Gap Is Not 63 pp of Reachable Accuracy

**Status:** measured. The k=1 gap decomposes into a population the reader has
already absorbed and a remainder of 11 questions.
**Found by:** following up the B1 verdict. Reranking measured no effect while the
roadmap still credited it with a 63.08 pp opportunity, and the discrepancy had
never been reconciled against the run's own accuracy.

---

## 1. The number that survived its own refutation

`MEASURE-B2-RECALL-CURVE.md` measured, at k=1, recall 33.18% against a ceiling of
96.26% — a 63.08 pp gap — and the roadmap read it as "ranking is the bottleneck,
so reranking is the highest-value work". B1 then ran the reranker: two arms,
+1.33 and −1.33 pp, p = 0.7539 both times, MR 0 vs 0.

The verdict section recorded the correct lesson — _diagnosis correct, prescription
wrong_ — and the gap stayed on the books at 63.08 pp. That is where the error sat.
A gap that no ranking mechanism can move is not a ranking opportunity, and
nothing had checked whether the 63.08 pp was reachable by ranking at all.

## 2. What a recall gap measures, and what it does not

The curve answers: _did retrieval put the answer turn at rank 1?_ It does not
answer: _did the reader need it at rank 1?_ Those differ whenever the reader
answers from context it received **below** rank 1.

That is not a hypothetical. From the same A2 artifacts:

| quantity                | value         | source                  |
| ----------------------- | ------------- | ----------------------- |
| admitted at k=1         | **142**       | curve, `recall × 428`   |
| covered in the pool     | **412**       | curve, `ceiling × 428`  |
| ranking gap             | **270**       | 412 − 142               |
| run accuracy (baseline) | **401 / 500** | `benchmark-report.json` |

The reader answers **401** questions while only **142** have their evidence at
rank 1. So **259** questions were answered from evidence the rank-1 test scores as
a miss. The gap is 270. Of that 270, 259 are already absorbed by the reader.

> **The gap is a property of the retrieval ranking. It is not a measure of
> accuracy the system failed to reach.**

## 3. The remainder

`gapAlreadyAbsorbedByReader` is computed as `readerCorrect − admittedAtOne`,
clamped, and subtracted from the gap:

```
recoverableFromRanking = rankingGapFailureCount({
  coveredQuestions,        // 412
  admittedAtOne,           // 142
  readerCorrect,           // 401
})
  = max(0, (412 − 142)) − max(0, (401 − 142))
  = 270 − 259
  = 11
```

**Eleven questions.** That is the entire population a perfect reranker could
convert into accuracy, on this system, at this pool width.

This is the reconciliation the roadmap was missing. It does not explain the sign
of B1's point estimates, but it explains their _magnitude_: an 11-question ceiling
is 2.2 pp at N=500, and the arms' ±1.33 pp sits entirely inside it. **p = 0.7539 is
what an 11-question ceiling looks like when you measure it.**

## 4. The second separation: the +29 was abstention, all of it

The same artifact pair settles a second question. Per capability, baseline vs
feature:

| capability | baseline correct | feature correct | feature abstained | Δ       |
| ---------- | ---------------- | --------------- | ----------------- | ------- |
| IE         | 145              | 145             | 4                 | **0**   |
| MR         | 106              | 106             | 3                 | **0**   |
| KU         | 59               | 59              | 1                 | **0**   |
| TR         | 91               | 91              | 9                 | **0**   |
| ABS        | 0                | **29**          | 29                | **+29** |

Four of five capabilities are byte-identical across the arms. The entire +29 is
ABS: the reader finding answers it previously refused. `improvementFromAbstention
= 29`, `improvementFromOtherCapabilities = 0`.

> **Two disjoint populations and two different mechanisms.** The +29 is entirely
> abstention behaviour (no evidence turn exists to rank). The 270-question gap is
> entirely outside it (the curve excluded those 30 questions from its own
> denominator — `considered` is 428, not 500). Subtracting abstentions from the
> gap would be removing them twice, and the resulting 240 would be a number no
> measurement supports.

## 5. The design choice this forced

The first implementation subtracted `abstentionQuestions` from the gap. Three
tests failed, and one of them was the _implementation's_ fault in a way that is
worth recording: the subtraction looks like hygiene — "remove the questions no
ranking change can reach" — and it is double-counting, because the curve already
removed them.

The fix reports the abstention population **beside** the gap, not inside it, and
names the identity that makes the decomposition checkable:

```
admittedAtOne + rankingGapQuestions + retrievalGapQuestions === curveDenominator
142          + 270               + 16                   = 428
```

`admittedAtOne` is exposed as a field purely so that identity is statable. Without
it a reader has to take three numbers on trust. A second test failure caught the
same class of error from the other side: my own test asserted
`retrievalGap + rankingGap === covered`, which is arithmetically false and would
have hidden retrieval's own 16-question gap from the sum.

## 6. Where the number now lives

`benchmark-gap-attribution.json`, written by the benchmark run beside the report
and the curve.

The placement is deliberate. The last three defects in this area were each a
figure that existed only in a console line or in an operator's notebook —
`AUDIT-SILENT-DENOMINATOR.md` (a denominator that shrank unannounced),
`AUDIT-DISCORDANT-IDENTITY.md` (a flip count with no ids), and the B1 verdict's
priority conclusion (a gap credited to a mechanism that measurement had already
refuted). A number that decides which subsystem gets worked on next must live in
the artifact the decision is reviewed against.

## 7. Verification

| Step                                                   | Result                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Tests written first                                    | red (module absent)                                  |
| After implementation                                   | 13/13 green                                          |
| Module coverage                                        | **100 / 100 / 100 / 100**                            |
| Injection: subtract abstentions from the gap           | **1 red**                                            |
| Injection: drop the clamp in `rankingGapFailureCount`  | **1 red**                                            |
| Injection: treat every capability as abstention        | **2 red**                                            |
| Injection: measure the retrieval gap against `covered` | **2 red**                                            |
| All restores                                           | byte-exact (md5 `33f5b75b` verified twice)           |
| Full gate                                              | 1286 tests green, every package ≥95% every dimension |

Two of the injections fail tests by design in different ways: the clamp removal is
caught by the "reader outruns the admitted set" case, and the retrieval-gap
injection is caught by the partition identity rather than by an arithmetic
assertion — which is why that identity is written into the suite as a test rather
than as a comment.

## 8. What this changes, and what it does not

**Changes.** The 63.08 pp figure may no longer be quoted as recoverable accuracy.
The correct statement is: _2.2 pp is the ceiling for ranking work at this pool
width; the remaining 60.9 pp sits in a population where the evidence was never at
rank 1 and the reader answered anyway._

**Does not change.** The recall curve's measurement is untouched and still
correct — it answers its own question properly. The B1 verdict stands. The B2
pool-width conclusion stands.

**Opens.** If 259 of 270 covered-but-unadmitted questions are answered correctly
from context below rank 1, then the questions the system actually fails are
elsewhere. The A2 baseline fails 99 of 500. Locating those 99 — by capability and
by cause, not by aggregate — is the measurement this instrument implies and does
not perform.

## 9. Not claimed

- **Not a claim about other pool widths.** The remainder was computed at the pool
  width the A2 dispatch used. A wider pool has a larger ceiling and would move
  every figure here.
- **Not a claim that reranking cannot help.** The claim is that _this measurement_
  caps its recoverable contribution at 11 questions. A mechanism that changes what
  the reader receives, rather than the order it receives it in, is not bounded by
  this number.
- **`gapAlreadyAbsorbedByReader` uses the baseline arm.** It is `readerCorrect −
admittedAtOne` with `readerCorrect` from `baselineMetrics`. The subtraction
  attributes the reader's success to the reader rather than to the pooled run; a
  reader that succeeds _because_ of rank-1 evidence is counted as absorbed, which
  makes the remainder an upper bound rather than an estimate.
- **The 16-question retrieval gap is not decomposed.** It is the complement of the
  ceiling and nothing here says why those 16 are unreachable.

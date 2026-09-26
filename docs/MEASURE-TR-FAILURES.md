# MEASURE — TR Failure Classification: Grounded or Ungrounded

**Status:** measured. Of the 27 answered-wrong TR failures, 13 are ungrounded
(the evidence was never retrieved) and 14 are grounded — but only **4** of those
14 rest on strong evidence, and 6 rest on a token so ubiquitous in the context
that the verdict carries almost no weight.
**Found by:** roadmap item 9e, opened by `MEASURE-FAILURE-CENSUS.md`, which
located 36 TR failures — 51% of all failures — and split them by decision without
ever saying why any of them failed.

---

## 1. The question the census left open

The census established that TR is the largest failure population and that 27 of
its 36 failures are *answered wrong* rather than refused. It did not say why.

For an answered-wrong question there are two mechanisms and they need opposite
work:

- **Grounded** — a retrieved turn carries the answer, and the reader produced
  something else anyway. The evidence was in hand and was misread. The work is in
  the reader, or in how the context is arranged.
- **Ungrounded** — no retrieved turn carries the answer. The reader could not
  have been right. The work is in retrieval, in query expansion, or in whether
  the question is answerable at all.

These are not two shades of the same problem. A run whose failures are mostly
grounded has a reader problem; a run whose failures are mostly ungrounded has a
retrieval problem, and tuning the reader against ungrounded failures cannot help
because there is nothing to read.

## 2. The instrument

`packages/cortex-eval/src/tr-failure-class.ts`.

Classification is **token containment on word boundaries**: the answer's tokens
are extracted by splitting on non-alphanumerics and lowercasing, and a question
is grounded when every token occurs in the retrieved context on a word boundary.

That is weaker than "was the reasoning correct", and it is the strongest claim
the artifact supports. A classifier that inferred more — by comparing the
reader's answer to the truth and narrating a cause — would be generating
explanations rather than reading a record.

Word boundaries are load-bearing rather than fastidious. TR asks for counts and
the answers are single digits, so a substring test would satisfy an answer of
`"1"` from the date `2023/01/21` inside the question's *own* retrieved timestamp.
That would report the most common TR failure as grounded and point the work at
the reader when the evidence was never there.

## 3. The first revision was wrong, and the artifact said so

The first implementation dropped every token shorter than two characters, on the
argument that a one-character match could land inside a date, a score, or an
unrelated word.

Measured against the A2 artifact, that filter removed **10 of 22 records** in the
MR file — and **8 of those 10 had been answered correctly**. The answers it
discarded were `2`, `3`, `4`, `5`.

| design                       | guards `2023/01/21` | handles `4` in "visited 4 stores" | corpus reach |
| ---------------------------- | ------------------- | --------------------------------- | ------------ |
| substring + min length 2     | yes                 | **no**                            | **12 / 22**  |
| word boundary + no min length | **yes**            | yes                               | **22 / 22**  |

The premise was wrong: the word-boundary rule already defeats the date case, so
the length filter was defending against a threat that no longer existed. Keeping
it would have reported nearly half the corpus as ungrounded — "the evidence was
never retrieved, go fix retrieval" — for questions whose evidence was present and
whose answers the reader had already produced. That is the most expensive error
available to this classifier, and it would have arrived inside a census that
looked complete.

The rule the measurement supports is narrower: a token is dropped only when it
carries no alphanumeric content at all.

> **Discipline:** a guard written for a threat that a *different* guard already
> removes is not conservative. It is a second cost with no first benefit, and it
> hides itself as caution.

## 4. The result

Run over the 27 answered-wrong TR failures of the A2 artifact
(`lm_report/benchmark-single-session-diagnostics.json`, 379 records, TR = 127,
wrong = 36, answered-wrong = 27):

| bucket                            | count | occurrences of the answer token |
| --------------------------------- | ----- | ------------------------------- |
| **ungrounded** — evidence absent  | **13** | 0 (at least one token absent)  |
| grounded, strong evidence         | **4**  | 1–2                             |
| grounded, moderate evidence       | **4**  | 3–9                             |
| grounded, weak evidence           | **6**  | ≥ 10                            |

The ungrounded column is solid: every one of the 13 is ungrounded because at least
one token of a multi-token answer is absent, or because a single token genuinely
never occurs. Absence is absence and `a3838d2b` (answer `"4"`) is the clean case
with **zero** occurrences.

The grounded column is **mixed**, and the occurrence counts are what separate it.
The retrieved contexts run 8k–14k characters and the answers are single digits, so
a token like `1` legitimately occurs dozens of times as a date fragment or a list
counter:

| id             | answer | context | occurrences |
| -------------- | ------ | ------- | ----------- |
| `b46e15ed`     | 2      | 12,465  | **1**       |
| `0bc8ad92`     | 5      | 13,641  | **1**       |
| `gpt4_385a5000`| Tomatoes | 12,258 | **2**      |
| `gpt4_7abb270c`| 19-token | 12,970 | 51          |
| `gpt4_d31cdae3`| 8-token  | 11,200 | 68          |
| `gpt4_59149c78`| 5-token  | 12,981 | **95**      |

So `grounded` here means **"the answer string occurs in the context"**, not "the
evidence was adequate". The 14 is an **upper bound** on reader-attributable
failures. The strictly reader-attributable population is the 4 strong cases; the 6
weak cases are unresolved by this instrument and are reported as unresolved rather
than counted as either.

`maxTokenOccurrences` is emitted per question so the confidence travels with the
verdict instead of being re-derived by whoever reads it.

## 5. What this changes about the plan

**TR does not have a single dominant failure mechanism.** The split is 13 / 14,
close to even, so a fix aimed at only one side addresses at most half the
population — and if the 6 weak cases are genuinely retrieval-side, the split is
closer to 19 / 8 in favour of retrieval.

Two consequences:

1. **The 6 weak cases need a different instrument, not a different verdict.**
   Distinguishing "the digit was in the context but in an unrelated sentence" from
   "the digit was in the sentence that answers the question" needs a proximity or
   relevance term the current artifact does not carry. Until that exists, those 6
   are unclassified and must not be spent.
2. **Reader work is justified by 4 questions, not 14.** That is a much weaker
   warrant than the raw grounded count suggests, and it is the number a
   cost-benefit decision should use.

Refusals are excluded by construction. A refusal produces no assertion to check,
so a refused-wrong question cannot be grounded or ungrounded; putting the 9
refused TR failures in either bucket would invent a finding.

## 6. Verification

| check                                        | result                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| unit tests                                   | 20 passing, 100% on all four coverage dimensions                    |
| defect injection (9 mutations)               | **9 / 9 caught**, implementation restored byte-identical (md5)      |
| same input as string and as JSON number      | identical tokens and identical classification                       |
| numeric answer inside a longer number        | `4` not satisfied by `40`; not by a date                            |
| single-digit answers matchable               | `4`/`3`/`5` yield `['4']`/`['3']`/`['5']`                           |
| null answer                                  | ungrounded, and the fixture contains the literal word `null` so the verdict depends on the guard rather than on the fixture |
| token at position zero / at end of string    | counted once, verified on both                                       |
| real-data run                                | 27 records classified, 0 lost to the token filter                    |

Two defects were caught **by the verification rather than by review**:

- The `tr-failure-class.ts` signature was `string | null`, but the artifact holds
  `int` for 10 of 379 records. Unit tests were all passing — every fixture was a
  string — and the **first real run** threw `toLowerCase is not a function`. A
  string-built test suite cannot find a type the fixtures never use.
- The first injection pass **missed** the null-guard mutation: `String(null)` is
  `"null"`, which is absent from an ordinary context, so the broken implementation
  produced `ungrounded` by accident and the test passed for the wrong reason.
  Putting the literal word `null` into that fixture is what made the assertion
  depend on the guard. The mutation is caught now.

> **Discipline:** a test suite that has only ever passed proves nothing. The
> injection harness is what makes "the suite tests this" a measurement instead of
> a belief — and the mutation it missed is the one that shows why.

## 7. What this does not claim

- **Not a claim about correctness of reasoning.** Token containment is not
  entailment. A context containing the answer next to a contradicting qualifier is
  called grounded here.
- **Not a count of misread questions.** 14 is an upper bound derived from
  string containment; the reader-attributable population is 4 on strong evidence.
- **Not a date-anchoring classifier.** An earlier plan had a third class for
  "the evidence was retrieved but anchored to the wrong date". It is not
  implementable from this record: deciding it requires knowing which event the
  question means, which the retrieval text alone does not establish. The class was
  dropped rather than approximated.
- **Not a statement about the baseline arm.** The diagnostics measure the feature
  arm (430 correct of 500); the baseline is 401. Every count here is a count of
  the feature arm's failures.
- **Not generalised beyond TR.** The classifier is applied to TR only. Applying it
  to IE or KU would need their answer shapes measured first — the length-filter
  error is exactly what happens when that step is skipped.

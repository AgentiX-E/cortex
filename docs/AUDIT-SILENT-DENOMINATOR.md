# AUDIT — The Silently Shrinking Curve Denominator

**Measured at** `a7e846d` (run `35523328949`) · **Fixed at** the commit carrying
this document · **Instrument** `cortex-eval`'s recall curve (roadmap measure B2)

---

## 0. One-line summary

`benchmark-recall-curve.json` reported every percentage against **428** questions
while `benchmark-report.json` reported accuracy against **500**, and neither file
said the two populations differed. The 72 missing were answerable
knowledge-update questions whose answers are *derived* values; the exclusion was
invisible because the code that performs it has exactly one observable outcome
("no answer text") for three different causes.

This is not a retrieval defect. Retrieval is unchanged. It is a **reporting**
defect, and its cost is that a number that looked comparable to another was not.

---

## 1. How it was found

Not by reading the code. While reconciling the artifact set from the full A2 run,
every capability count was checked against the run's own report:

| Capability | Total | Correct | Accuracy |
| --- | --- | --- | --- |
| IE | 150 | 145 | 96.67% |
| MR | 121 | 106 | 87.60% |
| **KU** | **72** | **59** | **81.94%** |
| TR | 127 | 91 | 71.65% |
| ABS | 30 | 29 | 96.67% |
| **Σ** | **500** | **430** | **86.00%** |

Those reconcile exactly. The curve's denominator does not:

```
curve n = recalled / recall = 142 / 0.331776 = 428.00
500 - 428 = 72
```

72 is the KU total, and 428 is the only total-minus-capability figure that
matches. The coincidence is of the right size to be the whole story.

`benchmark-diagnostics.json` settles it without inference, because it reports both
numbers in the same payload:

```json
{ "totalQuestions": 500, "answerableQuestions": 428, ... }
```

So the artifact set **knew** the denominator was 428 and **recorded** that it was
428. What no artifact recorded was *which* 72 questions were dropped or *why*.
The only place the shortfall appeared was an `n=` in a console line, and the
console line printed the *sample* size rather than the measured count:

```
k      recall   ceiling  gain     (n=500 sampled questions)
```

That line is the defect's signature: it states 500 next to a table computed over
428.

---

## 2. The three causes behind one outcome

`computeRecallCurve` excluded a question when its answer set was empty:

```ts
if (answerTexts.size === 0 || context.length === 0) {
  continue;
}
```

`answerTexts` is filled from user turns carrying `has_answer`. An empty set
therefore arises in three unrelated situations:

| Reason | What it means | Is excluding it right? |
| --- | --- | --- |
| `abstention` | The correct answer is to refuse. No evidence turn exists by design. | **Yes** — it carries no retrieval signal. This is the documented rule. |
| `derived` | The question *is* answerable, but its answer is computed from the evidence rather than stated in it. | **No, not silently.** It is a real question removed from the denominator. |
| `no-flag` | The question is answerable and no turn was ever marked. | **No** — a data or loader problem, and a pure measurement loss. |

The documentation described only the first. `docs/MEASURE-B2-RECALL-CURVE.md`
§2.3 said, in full, that abstention questions are excluded — which was true and
was read as complete. It never mentioned that 42 of the 72 exclusions are of a
kind it did not name.

### 2.1 Why the 72 are `derived`, and why that is the interesting case

KU answers in LongMemEval-S are aggregates and updated values:

```
'25 minutes and 50 seconds (or 25:50)'   'four'      'the suburbs'
'$400,000'   'Three times a week.'   'Yes.'   '10-12 hours'
'Friday'   'Paris'   'under my bed'   'seven'   '220'
```

66 of the 72 are under 30 characters. These are answers a reader produces *from*
the evidence, not text that appears *in* it. The graded path scores them fine —
the reader composes "four" from four separate running mentions — but the curve's
membership test is verbatim text matching against retrieved turns, and a composed
value matches nothing.

**So the curve is structurally blind to exactly the capability with the second-worst
accuracy.** `ceiling = 96.26%` is a statement about IE/MR/TR/ABS retrieval. It says
nothing about whether KU evidence was retrievable, and it must not be quoted as
though it does.

> **Note on an intermediate wrong hypothesis.** An earlier pass tested whether KU
> answers appear verbatim in retrieved context and found 73.6% do — which
> superficially contradicts this section. It does not: appearing *somewhere in a
> retrieved blob* is not the same predicate as *being the text of a turn marked
> `has_answer`*. The first is a substring check over a concatenation; the second
> is the membership test the curve actually performs. The substring result is what
> made the wrong explanation look plausible, and it is recorded here so the
> distinction is not re-collapsed by the next reader.

---

## 3. The fix

The exclusion is correct for `abstention` and arguable for `derived`. The defect
is the **silence**, so the fix makes the shortfall self-disclosing rather than
changing what is excluded.

### 3.1 The measurement returns its own denominator

`computeRecallCurve` now returns a record rather than a bare array:

```ts
type RecallCurveResult = {
  points: RecallCurvePoint[];
  considered: number;                       // the denominator, stated
  excluded: RecallCurveExclusion[];         // every drop, with its reason
};

type RecallCurveExclusion = {
  questionId: string;
  reason: 'abstention' | 'derived' | 'no-flag';
};
```

`considered` is `ranks.length` — the count the percentages are actually over.
Reporting it costs nothing and removes the only way the two populations could be
confused.

### 3.2 The classification is ordered, and the order carries meaning

```ts
export function classifyExclusion(inst, hadContext): RecallCurveExclusion | null {
  if (!hadContext) return null;                    // nothing to retrieve: not a shortfall
  const id = inst.question_id ?? '';
  if (id.endsWith('_abs')) return { questionId: id, reason: 'abstention' };
  if (hasFlaggedTurn(inst)) return { questionId: id, reason: 'derived' };
  return { questionId: id, reason: 'no-flag' };
}
```

Three details are load-bearing:

1. **`!hadContext` returns `null`.** An instance with no user turns has nothing to
   retrieve. It is not an answer-set problem, and counting it as one would inflate
   the shortfall with questions that were never measurable.
2. **Abstention is checked first.** It is the one case where an empty answer set is
   *expected*, so it must never be mislabelled as a data defect. Checking `derived`
   first would have reported all 30 abstention questions as defects on every run
   and buried the 42 that are.
3. **`question_id` is optional, so the read is guarded.** The unguarded version
   threw `Cannot read properties of undefined (reading 'endsWith')` the moment the
   first test ran against an instance without an id — found by the test suite, not
   by inspection. An unnameable shortfall is still reported (`questionId: ''`)
   rather than crashing the measurement.

### 3.3 Every consumer states it

| Consumer | Before | After |
| --- | --- | --- |
| `benchmark-recall-curve.json` | bare array of points | `{points, considered, excluded[]}` |
| Console (`bench/run.ts`) | `n=500 sampled questions` | `n=428 of 500 sampled questions`, plus a per-reason breakdown |
| Job summary (`tools/benchmark-summary.py`) | table only | table + "Covered **428** questions" + "Excluded **72** (derived 42, abstention 30)" |

The summary accepts both shapes, because older artifacts are bare arrays and a
summary that stops rendering when the writer changes shape is worse than one that
renders an older table.

---

## 4. Verification

### 4.1 The new tests fail against the defective code

Both halves were reverted one at a time and the suite re-run. This is the check
that separates a test from decoration.

| Injected defect | Result |
| --- | --- |
| Silent `continue` restored in `computeRecallCurve` (no `excluded` reporting) | **5 failed** of 40 |
| `curve_denominator` call removed from the summary renderer | **1 failed** of 15 |

Both files were then restored and confirmed **byte-identical** by `diff` before
the gate was re-run.

### 4.2 Coverage of the changed module

`recall-curve.ts` reached **100 / 100 / 100 / 100** (statements / branches /
functions / lines), up from 96.66 / 91.30 when the fix first landed. The two
intermediate shortfalls were genuine gaps, not noise:

| Gap | Why it existed | Test added |
| --- | --- | --- |
| `derived` branch | No test produced a flagged turn that yields no answer text | An assistant turn carrying `has_answer` — dropped before the answer set is built, so the flag exists and contributes nothing |
| `haystack_sessions ?? []` (×2) | Every test supplied sessions | An instance with the key absent, via `computeRecallCurve` and via the exported `classifyExclusion` |

### 4.3 Gate

`pnpm check` — lint, typecheck, tests, prettier — **green**.

| Package | Tests | Stmts | Branch | Funcs | Lines |
| --- | --- | --- | --- | --- | --- |
| cortex-core | 127 | 98.48 | 98.34 | 100 | 98.48 |
| cortex-node | 16 | 100 | 98.61 | 100 | 100 |
| cortex-llm | 71 | 100 | 98.47 | 100 | 100 |
| cortex-eval | 971 | 99.87 | 98.70 | 100 | 99.87 |
| **Total** | **1185** | | | | |

---

## 5. What this defect is an instance of

The repository now has four recorded defects of the same shape — **a measurement
that silently narrowed its own scope**:

| Document | The narrowing |
| --- | --- |
| `FIX-COHORT-COVERAGE-SIDE-CHANNEL.md` | Coverage returned *beside* the report, so a 1-of-7 cohort read as an ordinary result |
| `AUDIT-PERSISTED-NULLS.md` | `NaN` → `null` on serialization, so a loss was indistinguishable from a value |
| `FIX-COVERAGE-GATE-NOISE.md` §12.2 | A property test with a hardcoded parameter, so a generator looked like it ranged over the parameter it had pinned |
| **this document** | A denominator that shrank without saying so, so a ceiling over 428 sat beside an accuracy over 500 |

The common structure is that **the artifact was internally consistent and
externally misleading**. Nothing threw. No test failed. Every number in every
file was correct. The error was in what the reader was invited to compare.

The recurring remedy is also the same, and it is not "be more careful": make the
instrument report the boundary it applied. `considered` and `excluded[]` are not
diagnostics for the measurement's own sake — they are the difference between a
number that can be checked and a number that has to be trusted.

---

## 6. Open items

| Item | Status |
| --- | --- |
| Should `derived` questions be *included* rather than excluded? | **Open.** Including them needs a membership test for composed answers, which is a reader-level judgement the curve deliberately does not make. The current answer is to report them, not to guess. |
| Is 42 a stable count, or does it move run to run? | **Unknown.** It is a property of the dataset's `has_answer` annotation, so it should be constant — but it has been observed in one full run only. |
| Any other artifact with a denominator that differs from 500? | **Checked for the A2 set.** `benchmark-single-session-diagnostics.json` is 379 = 500 − MR(121), which matches its own documented membership rule (`DIAGNOSED_CAPABILITIES`). The recall curve was the only unexplained one. |

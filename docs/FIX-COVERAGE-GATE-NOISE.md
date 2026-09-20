# FIX — The Coverage Gate Measures Noise (and My First Root Cause Was Wrong)

**Status:** root-caused. The instability is real and reproduced; **the explanation
recorded in the first version of this document was incorrect**, and correcting it
surfaced a genuine test gap plus a genuine algorithm bug.

**Found by:** noticing that `cortex-core`'s reported coverage differed between
consecutive verification runs in the same session (98.98, 98.22→98.98, 98.47)
while no code had changed. Earlier in the session I had twice dismissed a low
figure as "a stale cached report". That dismissal was wrong, and the repetition is
what turned a dismissed anomaly into an investigation.

> **This document was wrong once.** It originally concluded that the six
> `c8 ignore` guards in `math/stats.ts` were *unreachable* and that v8's
> application of the ignore hints was *non-deterministic*. The first half of that
> was false, and the second half was never demonstrated. §5 onward records what
> the corrected investigation found, including the two real defects it uncovered.
> The wrong version is summarised in §4 rather than deleted, because the reason it
> was wrong is more instructive than the conclusion.

---

## 1. Symptom

Identical `vitest run --coverage` invocations in `packages/cortex-core`, no source
or test edit between them. Twelve runs under conditions I controlled directly (one
process, sequential, no concurrent load in this workspace):

| Run | covered / total | Result |
| --- | --- | --- |
| 1 | 779 / 789 | 98.73% |
| 2 | 781 / 789 | 98.99% |
| 3 | 783 / 789 | 99.24% |
| 4 | 779 / 789 | 98.48% |
| 5 | 781 / 789 | 98.99% |
| 6 | 783 / 789 | 99.24% |
| 7 | 779 / 789 | 98.73% |
| 8 | 777 / 789 | 98.48% |
| 9 | 781 / 789 | 98.99% |
| 10 | 779 / 789 | 98.73% |
| 11 | 781 / 789 | 98.99% |
| 12 | 777 / 789 | 98.48% |

**Five distinct values, 98.48% – 99.24%: a 0.76pp spread.** The denominator is
**constant at 789 statements** across every run; only the numerator moves.

The gate threshold is 95, so every one of these **passes** — which is precisely
why this survived: an unstable measurement that never crosses the threshold is
indistinguishable from a stable one, until the day a real regression of ~3pp also
passes.

> A gate that reads a noisy input is not a gate at 95%. It is a gate at
> `95 ± noise`, and the noise is invisible until it costs something.

## 2. Localisation: which statements move

Comparing per-statement covered flags across runs isolates the movement to
`math/stats.ts`. The varying statement ids and their source lines:

| Statement id | Line | Source |
| --- | --- | --- |
| 189, 190 | 190, 191 | `d = 1e-30;` and its closing `}` |
| 194, 195 | 195, 196 | `c = 1e-30;` and its closing `}` |
| 202, 203 | 203, 204 | `d = 1e-30;` and its closing `}` |
| 207, 208 | 208, 209 | `c = 1e-30;` and its closing `}` |

Every one is the **body of an underflow guard carrying `/* c8 ignore next */`**:

```ts
d = 1 + aa * d;
/* c8 ignore next -- defensive guard, unreachable via valid inputs */
if (Math.abs(d) < 1e-30) {
  d = 1e-30;                    // <- flips between covered and not
}
```

Two further statements, lines 78/79 (`return Math.abs(t) > 0 ? 0 : 1;` and its
closing brace, under a `c8 ignore` at line 76), are **uncovered in every run** —
never credited, never flaky.

## 3. How the number is computed, and where the movement enters

Worth stating explicitly, because it explains the shape of the evidence:

1. v8 emits **raw counters** per executed block.
2. The `c8`/istanbul layer **maps** those counters onto source statements using
   the source map, and applies `/* c8 ignore */` hints by dropping the annotated
   ranges.
3. Coverage is then `covered_statements / total_statements`.

The denominator is computed in step 2 from the source map and is therefore stable.
The numerator comes from step 1 attributed through step 2. **A constant
denominator with a moving numerator means the code did not change — the
attribution of counters to statements did.**

---

## 4. What the first version of this document concluded, and why it was wrong

The first version claimed:

- the guard bodies were genuinely unreachable, evidenced by replicating the
  continued fraction over 56 `(x, df)` pairs and observing a minimum `|c|`/`|d|`
  of ≈0.81 against a `1e-30` threshold — a 29.9-order-of-magnitude margin;
- therefore the annotations were correct, and the defect was v8 applying the
  ignore hints non-deterministically.

**The second claim was never demonstrated.** I never produced a case where the
same hint was applied differently for the same reason — I inferred it from the
fact that the annotations were (as I believed) true while the numbers moved. That
is reasoning from a conclusion.

**The first claim was false.** §5 shows all five guards are reachable, and §6
shows the minimum-magnitude argument was applied to the wrong quantity.

The deeper mistake was procedural, and it is the reason this section exists:

> I had a measurement problem in the measurement layer, and I investigated it
> **with an instrument I did not validate**. The probe I used to prove
> "unreachable" was itself perturbing the thing it measured.

## 5. Correction: all five guards are reachable

The first version's probe instrumented the guard bodies with counters and
concluded they never fired. Re-running that probe with a **different method**
removes the ambiguity.

**Method — throwing sentinels.** Replace each guard body with a `throw` and run the
real suite. A truly unreachable guard leaves the suite green. A reachable one
fails loudly and names itself. This involves **no counters and no coverage
machinery**, so nothing about the instrument can be confused with the result.

| Guard | Line | Sentinel result |
| --- | --- | --- |
| pre-loop `\|d\| < 1e-30` | 181 | **REACHED — 6 tests fail** |
| loop `\|d\| < 1e-30` | 191 | **REACHED — 6 tests fail** |
| loop `\|c\| < 1e-30` | 196 | **REACHED — 6 tests fail** |
| loop `\|d\| < 1e-30` | 204 | **REACHED — 6 tests fail** |
| loop `\|c\| < 1e-30` | 209 | **REACHED — 6 tests fail** |

All five fire on the **existing** test suite, on ordinary valid inputs.

### 5.1 Why the counter probe said otherwise

Adding a statement to a guard body changes v8's block structure, and the added
statement is attributed to a **different line** than the one it was written on.

This is directly demonstrable. Instrumenting only line 181:

```ts
181|   } globalThis.__G181 = (globalThis.__G181||0)+1;    // written on 181
```

The counter reported **20000 hits** — but those hits belong to the `if` at line
178 being *evaluated*, not to the body at 181 being *entered*. The arithmetic
confirms it: the sweep calls `studentTCdf` 20,000 times, and the guard body's
condition `|d| < 1e-30` is never satisfied for any of them. **The instrument
credits the wrong line, in exactly the way the phenomenon under investigation
does.**

> **An instrument built to measure a mis-attribution bug, which itself
> mis-attributes, will confirm whatever you already believe.**

## 6. Two real defects the correction uncovered

### 6.1 A genuine test gap in `math/ot.ts` (fixed)

`sinkhorn` had two statements — `converged = true; break;` — that **no test ever
executed**. Every existing call either exhausted `maxIter` or used parameters that
did. Adding a test that asserts the convergent exit is reached (TDD: it was red
against the old behaviour, because the old behaviour was §6.2) closes the gap.
`math/ot.ts` is now **100% covered**.

### 6.2 A genuine algorithm bug in `sinkhorn` (fixed)

While closing §6.1, the convergence detector turned out to be **inert**:

```ts
const uPrev = u;          // reference, not a copy
for (...) {
  u[i] = ...;             // mutates the array uPrev points at
}
let maxDiff = 0;
for (let i = 0; i < m; i++) {
  const d = Math.abs(u[i]! - uPrev[i]!);   // u compared against itself
  ...
}
if (maxDiff < tol) { converged = true; break; }
```

`uPrev` aliases `u`, and `u` is mutated in place, so `maxDiff` is **identically
zero** on every iteration for every input. `maxDiff < tol` is therefore trivially
true and `sinkhorn` returns `converged: true` **after one iteration, always** —
including on inputs that have not converged.

The decisive evidence is `tol = 0`:

| Call | `iterations` | `converged` | Reading |
| --- | --- | --- | --- |
| `tol = 1e-300` | 1 | **true** | impossible for a real residual — `maxDiff` cannot be `< 1e-300` |
| `tol = 0` | 1000 | **false** | `0 < 0` is false, so `maxDiff` is exactly 0 |

`tol = 0` failing while `tol = 1e-300` passes can only happen if `maxDiff` is a
constant zero. Fixed by snapshotting: `const uPrev = Float64Array.from(u)`.

**Severity:** latent, not active. `docs/AUDIT-CODE-VS-DOCS.md` already records
that `sinkhorn` is *exported but never called*, so nothing in the product consumed
the wrong answer. It would have become active the moment the
optimal-transport distillation path in `ARCHITECTURE.md` was wired up — and it
would have presented as a **silent** "converged" that was not convergence.

## 7. Corrected characterisation of the remaining instability

With §6.1 and §6.2 fixed, re-measuring 12 times still shows movement, now confined
to `math/stats.ts`:

- lines 78/79 (the `df <= 0` guard, annotated at line 76) — **uncovered in every
  run**, never credited;
- the five loop guard bodies — flip between covered and not.

So the residual instability is genuinely about how the ignore hints are applied,
which is the part of the first version's conclusion that survives. But it is now
on a **narrower and better-evidenced** basis:

| Claim | Evidence |
| --- | --- |
| Numerator moves, denominator constant | 12 runs: 777/779/781/783 over a constant 789 |
| Movement is confined to annotated guard bodies | per-statement diff; no other statement varies |
| The guards are reachable, so the annotations' stated reason is false | throwing sentinels: all 5 reached by 6 tests each |
| Therefore the movement is **false negatives and false positives** | a reachable body should be credited every run; it is sometimes credited, sometimes not |

The important consequence: **the annotations are suppressing coverage for code
that does execute.** Removing all six and running the real suite gives:

```
true coverage with all tests, no ignore hints:   789 / 795 = 99.25%
```

So the ignore hints are not hiding unreachable code — they are hiding *reachable
and untested* code. The four loop guards' bodies are never entered by the suite,
yet they *can* be, and the annotation prevents that from showing up as a gap.

## 8. Fix

**8.1 (done) `sinkhorn` residual is now real.** `Float64Array.from(u)`, with a
regression test that fails against the old implementation and pins both
directions — `tol = 0` must not converge, an achievable `tol` must.

**8.2 (done) `math/ot.ts` convergence path is exercised.** No longer an
untested branch.

**8.3 (done) `coverage.reporter` writes `json` alongside text**, so every claimed
number is re-derivable from raw counters rather than from a rendered table. The
text table is a rendering; the JSON is the evidence.

**8.4 (done) `coverage-annotations.test.ts` pins the annotation set.** It asserts
the count per file and the reasons, and fails if an annotation appears
undeclared. An ignore annotation is an assertion that code cannot run; an
undeclared one is an assertion nobody reviewed.

**8.5 (done) The measured spread is recorded in `vitest.config.ts`** — corrected
from ±0.5pp to the measured 0.76pp — so the next person does not re-derive §1 and
dismiss it as caching, exactly as I did twice.

### 8.6 What was deliberately NOT done

- **Not raised the threshold to absorb the noise.** That would hide a real
  regression behind a wider band. Raising the gate from 95 to 96 to "make it
  stable" is the `|| true` pattern this repository forbids, applied to a metric
  instead of a command.
- **Not deleted the annotations unilaterally.** They are now known to carry a
  false stated reason (§5), but deleting them changes the reported number and
  would need the guard bodies actually tested first. Recorded as an open item
  (§10) rather than done as a drive-by.
- **Not switched coverage provider.** Larger change than the defect justifies,
  and §7 shows the instability is confined to six statements.

---

## 9. Acceptance

| Criterion | Evidence |
| --- | --- |
| Instability quantified, not described | 12 runs, 5 distinct results, 0.76pp spread, constant denominator |
| Varying statements identified | 4 flaky ids + 2 permanently-uncovered, all in `stats.ts`, all annotated |
| The guards' reachability **measured, not argued** | throwing sentinels: 5/5 reached, 6 failing tests each |
| The instrument itself validated | the counter probe's 20000 hits shown to be a line-attribution artifact (§5.1) |
| Real defects found and fixed | `sinkhorn` inert residual (§6.2) + untested branch (§6.1) |
| Fixes covered by tests that fail without them | `tol = 0` must not converge; achievable `tol` must |
| No threshold weakened | 95 unchanged |
| No regression | four packages pass; every dimension ≥95% |

## 10. Residual risk and open items, stated

- **The root cause in the hint-application layer is not fixed.** It is bounded and
  documented, not eliminated. The retained `coverage-final.json` makes any
  recurrence diagnosable by the method used here rather than by noticing a number
  moved.
- **The six annotations carry a stated reason that is now known to be false**
  ("unreachable via valid inputs"). They are reachable. The correct repair is to
  test the guard bodies and then remove the hints, which changes the reported
  figure and belongs in its own change with its own evidence.
- **Two of the five loop guards are never entered by any test.** They are
  reachable, and untested. The annotation currently conceals that.

**Not claimed:** that the reported figure is now stable. It is claimed that its
instability is measured, bounded, localised to six statements, and that the two
real defects found while establishing that are fixed and covered.

## 11. Method lesson

The first version of this document reached a confident, wrong conclusion and wrote
it into the repository with an acceptance table. What made the difference was not
more care in the writing; it was **changing the method** — from an instrument that
perturbs the measurement to one that observes behaviour from outside it.

> When a measurement is unstable, the first thing to check is whether the tool
> used to explain it is stable. Mine was not: it added statements to the exact
> lines under investigation and then reported their coverage.

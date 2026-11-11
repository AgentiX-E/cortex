# Two nulls, and why the resolution wall closed the wrong queue

**Read from:** `42533236864` (the control), `42355323615` (the four-repetition census), `13824633060` and
`42930900136` (the two paired `MR` dispatches), plus `MEASURE-PLAN-SHAPE.md` §1's measured flip floor.

**Cost:** zero. Nothing here dispatches. It recomputes tests that were already paid for.

## 0. One paragraph

`MEASURE-RESOLUTION-WALL.md` §2 concluded that **every mechanism in the queue is smaller than its population
can see**, and cancelled four of them by arithmetic. The conclusion is correct about a comparison of
**published rates** and wrong about the arms this campaign runs, because those arms are **paired by
construction** — both sides answer the same 500 questions in the same job. A paired test's resolution is not a
function of the denominator; it is a function of the discordant counts, and this campaign has already
published a `p = 1.8e-08` on a 121-question column. The wall is real, but it is a wall around *"is cortex
better than competitor X"*, not around *"did this mechanism work"*. The cost of conflating the two is four
cancelled mechanisms that were never too small to see; the cost of ignoring it is that a two-question
movement gets published as a finding. Both mistakes are avoidable by naming which question is being asked.

## 1. Three yardsticks, three different questions

| yardstick | formula | `MR` (n=121) | `KU` (n=72) | answers |
| --- | --- | ---: | ---: | --- |
| repetition 2 sd | 2 sd of the four repetition accuracies, over `sqrt(4)` | 3.50 | 2.52 | how much would this same configuration move if re-run |
| resolution floor | `2.8016 * sqrt(p(1-p)/n)` (Miller, `arXiv:2411.00640`) | **9.37 pts** | **10.52 pts** | how large a difference between two **independent** samples is visible 80% of the time |
| measured flip floor | 5 of 121 questions under a **byte-identical prompt**, §13.365 | **4.1%** | 4.1% (assumed) | how often this population moves with **nothing changed** |

All three are in the table `MEASURE-RESOLUTION-WALL.md` §1 built, and only the second one is called a floor
there. The document's error is one of scope, not of arithmetic: `2.8016 * sqrt(p(1-p)/n)` is the sample size
formula for **two independent proportions**, and the arm is not two independent proportions. It is one
sample measured twice, which is why the third row exists at all — it is not derivable from the second.

## 2. The campaign's own record says the paired design sees small effects

The two dispatches since `MEASURE-RESOLUTION-WALL.md` was written are the evidence, and they point in
opposite directions from the conclusion:

| run | population | discordant (repair / damage) | exact McNemar | movement in points | above the 9.37 floor? |
| --- | --- | ---: | ---: | ---: | :---: |
| `42930900136` (`spec`) | 121 `MR` | **6 / 45** | **1.8e-08** | −32.2 | yes, in the negative direction |
| `42791109966` (`E3.2` decline repair) | 127 `TR` | 6 / 5 | 0.607 | +0.25 | no |
| `42355323615` vs `42533236864` | 500 | — | — | 0.75 (rep mean) | no |

The first row is the one that settles it: **a 51-question movement on 121 questions reached `p = 1.8e-08`**,
and every candidate shape gate priced on that same artifact could be read to a single question
(`span-wide` blocks 43 of 43 damages, loses 3 of 3 repairs). The resolution floor has nothing to say about any
of it. Neither does a reader of the second row: `6/5` at `p = 0.607` is an arm that **moved and did not
move**, which is a far more useful statement than "below the floor" — the floor would have called it
invisible before it ran.

So the wall's own table is right and its verdict is not. Every mechanism it cancelled had a ceiling **below
the floor it cannot reach**, and the remedy is either a bigger effect or a paired measurement — not
cancellation. The two `MR` mechanisms that were cancelled for cause (`H3` entity grouping at 4.00 against a
repetition null of 4.16, deterministic summation at 2.25) were cancelled by the **first** row of the table,
which is a different and correct argument.

## 3. The third row is the one that bounds a verdict

A paired exact test is generous: `6/0` is `p = 0.031` at any denominator, because it only ever looks at the six
questions that moved. That generosity is exactly why §13.365's measured flip floor matters more than either
floor above it. Five of 121 questions moved under a byte-identical prompt — three up, two down — and that is a
property of the population, not of a mechanism.

Two nulls follow, and they are not the same null:

| null | what it assumes | `p(≥6 same-direction on 72)` | `p(≥5)` | `p(≥4)` | `p(≥3)` |
| --- | --- | ---: | ---: | ---: | ---: |
| **A — exact McNemar**, no mechanism effect | every discordant pair is a fair coin | 0.031 | 0.063 | 0.125 | 0.25 |
| **B — measured flip floor**, 4.1% flips, direction by chance | the population moves with nothing changed | **0.0037** | 0.016 | 0.061 | 0.18 |

Both nulls reject four conversions and accept six. Neither accepts five at the 0.05 level. **The bar that
`MEASURE-FAILURE-STABILITY.md` §4 registered — "≥ 4 of 6 stable conversions" — is satisfied by a result both
nulls call indistinguishable from luck**, and it was registered before either null was computable. That is the
defect this note exists to correct, and it was found by computing the test the registration implied rather
than by running anything.

## 4. What the wall is still right about

Three things, and none of them is a mechanism verdict:

1. **No arm here can establish "cortex beats Hindsight by 5 points".** That is a comparison of two independent
   samples at `n = 500`, and 92.6% against 97.2% is inside `2.8016 * sqrt(p(1-p)/n)` at that denominator. Any
   such claim needs either thousands of questions or a same-harness run of the competitor — which is what the
   controlled board already does, and it is why the board's numbers are quoted with the harness beside them.
2. **A file-level movement under ~9 points cannot be attributed to one mechanism.** The paired test says a
   mechanism *moved something*; it does not say the movement is the mechanism's, because four repetitions of a
  500-question file have a 27-question stable/flaky split. §13.365's floor is the local answer to that.
3. **The `MR` mechanism axis stays closed** — but on reach and on repetition null, not on the resolution wall.
   `MEASURE-PLAN-SHAPE.md` prices every shape gate at or below +1, and that result does not depend on any
   floor.

## 5. The rule this note installs

Every verdict in this campaign names its null and its denominator:

> A mechanism's result is stated as `repairs / damages` on a **named population**, with the exact McNemar
> `p` **and** the measured-flip-floor `p` beside it. A movement smaller than either is a direction. A result
> that beats both is a result. Nothing is compared to a rate floor unless it is a rate over independent
> samples.

## 6. Reproducing the arithmetic

```
python3 - <<'PY'
from math import comb
def mcnemar(b, c):
    n, k = b + c, min(b, c)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) * 0.5 ** n)
def noise(k, n=72, rate=0.041 / 2):
    return sum(comb(n, i) * rate ** i * (1 - rate) ** (n - i) for i in range(k, n + 1))
print([(b, c, round(mcnemar(b, c), 4)) for b in range(3, 8) for c in (0, 1)])
print([(k, f'{noise(k):.4f}') for k in range(3, 7)])
PY
```

The floor's own constant is `2.8016`, which is `z(0.975) + z(0.80)`; the flip floor's `4.1%` is `5/121` from
`MEASURE-PLAN-SHAPE.md` §1, and it is a **measured** quantity on this benchmark rather than a convention.

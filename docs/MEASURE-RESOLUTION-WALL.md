# The resolution wall: every registered mechanism is smaller than its population can see

This note registers a result that costs nothing to obtain and that had been invisible for five rounds: **no
mechanism in the queue could have been detected on this benchmark at this denominator, whatever it did.** The
two dispatches of the conflict block are not two unlucky draws. They are what an effect smaller than the
population's resolution looks like when it is measured anyway.

## 1. Two floors, and the difference between them

The campaign has used one yardstick — **2 sd of a capability's own repetition spread** — and it is the wrong
one for the question the queue asks. Three quantities are in play and they answer three different questions:

| quantity | what it is | `MR` (n=121) | `KU` (n=72) | answers |
| --- | --- | ---: | ---: | --- |
| repetition 2 sd | twice the standard deviation of the four repetition accuracies, divided by `sqrt(4)` for the mean | 3.50 | 2.52 | how much would this same configuration move if re-run |
| resolution floor | `2.8016 * sqrt(p(1-p)/n)` (Miller, `arXiv:2411.00640`) | **9.37** | **10.52** | how large must a true difference be before this population sees it 80% of the time |
| paired floor | `2.8016 * sqrt(pi/n)` with `pi` the discordant share | 9.53 at `pi`=0.14 | 12.3 at `pi`=0.14 | the same, when the two arms answer the same questions |

The first number is smaller than the other two, and that is the whole of the mistake. Repetition spread
measures the **reader's** nondeterminism on one configuration. It does not measure the **question sample**,
which is the dominant variance when the population is 121 items. Four repetitions divide the first and leave
the second untouched, so a bar set at 2 sd is a bar set against a variance component that is not the binding
one.

`pi` = 0.14 is not assumed: the second administration of the conflict block moved 10 of its 72 `KU` questions,
which is 13.9%. At that discordance, pairing buys essentially nothing at these denominators — the paired floor
(9.53) is *larger* than the unpaired one (9.37) because `pi` exceeds `2p(1-p)` at p=0.84. Pairing is not a
discount; it is a discount only when the mechanism is narrow.

## 2. Every ceiling in the queue, against its own floor

Ceilings are the ones `MEASURE-FAILURE-STABILITY.md` §3 already prices, computed as
`sum(1 - passRate)` over the target set. Converted to points against the population they live in:

| population | mechanism | target set | ceiling (questions) | ceiling (points) | floor (points) | detectable |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| `MR` | deterministic summation | 3 | 2.25 | 1.86 | 9.37 | **no** |
| `MR` | entity grouping (`H3`) | 5 | 4.00 | 3.31 | 9.37 | **no** |
| `MR` | decline repair (`E3.2`) | 4 | 3.75 | 3.10 | 9.37 | **no** |
| `MR` | under-count repair | 7 | 6.00 | 4.96 | 9.37 | **no** |
| `KU` | stale-value selection (`H2`) | 6 | 6.00 | 8.33 | 10.52 | **no** |
| `KU` | the same, including the decline | 7 | 7.00 | 9.72 | 10.52 | **no** |

The closest margin in the table is `KU`'s 9.72 against 10.52, and that row is the one that was dispatched
twice and read 5 up and 5 down. **The single largest ceiling in the queue is 92% of the smallest floor it
could be measured against.** No dispatch in this campaign has ever had the resolution to fail, and none had
the resolution to succeed either: `§13.354.2`'s verdict of *rejected* on a +1.74-point mean was arithmetically
correct and evidentially empty, because 1.74 points is 0.19 of the floor.

## 3. The under-count mechanism, cancelled on reach before it was ever priced

`MEASURE-FAILURE-STABILITY.md` §3 lists under-count as the one `MR` class above the null with no mechanism
proposed, and it stayed there for four rounds because nobody asked how much of it a prompt could reach. The
artifact answers it at zero cost: `goldOverlap.carried` against `goldOverlap.total` says whether every turn
that supplies a gold item is inside the delivered evidence.

| question | mask | gold turns carried | wrong in all four | reachable |
| --- | --- | ---: | :---: | :---: |
| `2b8f3739` | `0000` | **18 / 18** | yes | **yes** |
| `bf659f65` | `0000` | **17 / 17** | yes | **yes** |
| `gpt4_2f91af09` | `0000` | **17 / 17** | yes | **yes** |
| `gpt4_731e37d7` | `0000` | 22 / 23 | yes | no |
| `gpt4_372c3eed` | `0000` | 16 / 17 | yes | no |
| `21d02d0d` | `0000` | 10 / 11 | yes | no |
| `3a704032` | `1111` | 18 / 18 | no | ceiling already taken |

Three of six are reachable, so the reachable ceiling is **3.00 questions = 2.48 points** against a floor of
9.37. The full class at 6.00 questions is 4.96 points and is also below it. Both numbers are below, so the
mechanism is cancelled twice over: unreachable on four of seven, undetectable on the rest.

The four that carry a missing gold turn are the interesting half, because they are the reason a "count more
carefully" mechanism is not the repair even in principle: `21d02d0d` answers 1 where the truth is 2 and one of
its eleven gold turns is outside the window, so the reader was short by one *fact*, not by one act of
counting. A prompt that enumerates cannot enumerate what was never delivered.

## 4. What the wall implies, in order of cost

The wall is a property of the denominator, so the three ways past it are ranked by what they cost:

1. **Measure in a currency the population can resolve.** A paired conversion count on a low-discordance
   mechanism has a floor of `2.8016 * sqrt(pi/n)`; at `pi` = 0.03 and n = 121 that is 4.4 points, which is
   under the under-count ceiling. This is what `S8` does and what `V4` computes. Cost: zero, and it is
   already built.
2. **Grow the population.** Detecting the full under-count ceiling needs **431 `MR` questions**; detecting
   only the reachable part needs **1,726**. The benchmark has 121. A second multi-session suite, or a
   held-out set of our own, is the only route that moves this number, and it is a dataset decision rather
   than a mechanism decision.
3. **Attack a ceiling that is large in the population's own units.** No single failure class is: the largest
   is 7 of 121. What is large is the gap between `MR`'s 83.9% and a 95% target, which is 13 points and would
   need a mechanism spanning several classes — and the campaign has no evidence that such a mechanism exists,
   because every cross-class change it has tried (`§13.108`'s session unit, `windowReorder`) moved the total
   by less than the floor.

Option 3 is where the next phase has to live if the score is to move, and it is the option with the least
evidence behind it. That is stated here rather than discovered later.

## 5. The one thing this note does not license

It does not license reading the last four rounds as wasted. `§13.352.2`'s reach decomposition, the value gate's
population counts, and `V4` are all readings that survive the wall, and the wall itself is a result: it says
that the campaign's remaining deficit on this benchmark is **not** a sum of small mechanisms, which is the
single most load-bearing assumption every dispatch since `§13.340` has been built on.

What it does license is a change of bar. Every future mechanism registration carries its ceiling **in the
population's own resolution units** before it is priced, and a registration whose ceiling is under its floor is
recorded as undetectable rather than dispatched:

> A mechanism whose ceiling is under its population's floor cannot be accepted, cannot be rejected, and cannot
> be measured. Registering one is a decision to spend money on a coin flip and to write the outcome down as
> evidence.

## 6. Reproduction

```
python3 tools/capability-ledger.py <artifact> --run <id>          # means, exact intervals, floors
node tools/arm-verdict.mjs --control <a> --arm <b> --capability KU --require-identical-evidence
```

The reach table is two fields per question, `goldOverlap.carried` and `goldOverlap.total`, both in
`benchmark-cortex-memory-ablation-report.json`. The masks are `ablation.featureCorrectByRun`.

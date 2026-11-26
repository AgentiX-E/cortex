# What the queue costs, and the three quotations that could not be reproduced

> Scope: every paid row in `§205.6`. Question: is each of those numbers reproducible from a bill this
> repository already paid? Answer: **no, and the error runs in both directions.**
> Instrument: `tools/queue-price.mjs` (gate `guard:queue-price`).

## 1. The three numbers, and the bill behind each

`§205.6` put three prices on the queue: **40–80** for a wider population, **12** for a MemCog run,
**8** for LoCoMo. None of them cited a bill. `spend-baseline.json` states two:

* `questionCount: 500`, `runs: 4`, billed **14.26** (`42467`) — the file rate is `14.26 / 2000 = 0.00713`.
* `capabilityRates.measured.MR`: `billedCny: 5.87`, `billedQuestions: 121`, `billedRuns: 2` — the `MR`
  rate is `5.87 / 242 = ` **0.024256**.

The second is **3.40× the first**, and that ratio is the reason the baseline stores the bill and not a
rounded rate: `COST-AND-ACCURACY.md` §10.1 already recorded a dispatch projected at 1.73 and billed at
5.87 because the projection scaled by the census instead of by the route. Every row below is priced at
`MR`'s own rate, because every row below is multi-session work.

| row | quoted | reproduced | quoted ÷ cheapest | what the quotation assumed without saying so |
| --- | ---: | ---: | ---: | --- |
| wider population, `MR` | 40–80 | **10.45 / 20.91 / 41.82** | 3.8× – 7.7× | 431 questions × **4 repetitions**; the 80 is that doubled for a longer population |
| MemCog, `MR` | 12 | **5.87 / 11.74** | 2.0× | 121 questions × **2 repetitions × 2 agentic steps** |
| LoCoMo | 8 | **7.28** / **48.17** | 1.1× (at 300) — **0.17× at 1,986** | 300 questions, one repetition; the published corpus size is never stated |

**All three quotations reproduce.** They were not invented; they were a design priced correctly against
a bill. What failed was the **choice of design**, and — for LoCoMo — the unstated question count.

## 2. Where the money actually is: repetitions, not questions

The 40 CNY row is not an expensive population. It is a population measured four times:

| design | CNY | basis | label |
| --- | ---: | --- | --- |
| 431 questions, retrieval side only, no judge | **0.00** | billed (zero calls) | free probe |
| 431 questions, 1 reader pass | **10.45** | extrapolated | the cheapest row that can certify a gap |
| 431 questions, 2 passes | **20.91** | extrapolated | the repetition count `45760081761` used |
| 431 questions, 4 passes | **41.82** | extrapolated | the quotation of 40 |

Four repetitions was never a requirement of the reading. `§13.348`'s two-pass `MR` bill is what the
published number was measured at, and a **paired** mechanism comparison — the only kind this campaign
runs — needs one pass, because pairing holds every other question fixed by construction. The two
passes **above** the published reading's own count bought variance reduction on a metric whose
rejection region is six discordant questions, and those six do not become more or less discordant on
a third and fourth pass.

The same correction applies to MemCog: `12` is 121 questions read twice. The criterion it answers —
`MR` 88.43 against 92.48 — is a comparison inside one population, so it is one pass. **5.87, not 12.**

## 3. The one row that was priced too low

LoCoMo's `8` implies 300 questions. `LoCoMo` as published is **1,986** questions, and at `MR`'s rate
that is **48.17** — 6.0× the quotation. This is the direction that matters more, because a plan that
under-reports survives review and then overruns; a plan that over-reports gets cut in review and costs
nothing.

So the honest statement of the queue's error is not "everything is too expensive". It is §166.5 item
6 in its second appearance: **our own quotations miss by one to two orders of magnitude in both
directions** — 40 → 10.45 here, 8 → 48.17 there. The repair is not a better estimator. It is a gate
that recomputes the number from a bill, which is what `guard:queue-price` now does.

## 4. The cheapest row in the queue costs nothing, and it comes first

`expand-population-retrieval`: run the wider population through **the retrieval side only** — offline
embedding plus the arm's own window allocation — and compute `goldOverlap.goldDelivered` per question.
No reader call, no judge call. **0.00 CNY.**

This is not a discounted version of the measurement; it is a different question, and it is the one
that should be asked first:

* If gold delivery on the new population is within noise of the 500-question reading, the retrieval
  mechanism transfers, and the 10.45 CNY reader pass is worth buying.
* If gold delivery collapses, **the answer is already in hand**: the arm does not transfer to that
  population, and no amount of judge money changes that. The 10.45 is saved by being *falsified*, not
  by being postponed.

`§166.5` states the rule with its receipt: **every dispatch at or above 10 CNY should have a reading
at or below 0.5 first** — a 0.28 reading killed a 14 CNY dispatch. The largest row in this queue has a
probe that costs **zero**, which is the strongest form the rule has ever taken here. The gate refuses
to price a row at or above the threshold unless the row names its probe.

## 5. The ordering was wrong for a second reason

`§205.6` put the wider population at position 2 and MemCog at position 3. Price agreed with that
ordering; **value did not**:

* The wider population buys a **ruler**, not a mechanism. It can certify a gap only after a mechanism
  exists that could cross it — and `§205.6` ① says plainly that no such mechanism is known: certifying
  2.2 points on `MR` is eleven questions moving in one direction, `p = 0.00098`, and "this repository
  has no evidence that such a mechanism exists".
* MemCog is the **only** system in the register whose `MR` is above ours (92.48 against 88.43), and the
  entry point it needs — `memory.search` — landed in §204. It costs **5.87**, not 12.

A ruler bought before the thing it measures is the most expensive item in a queue, because it is the
one that produces a null reading that reads like a verdict.

## 6. What is not cheaper, stated so it is not discovered later

| item | why the price cannot move |
| --- | --- |
| the reader pass itself | 10.45 CNY for 431 questions is `MR`'s billed rate × questions. The rate is a measurement; the only cheaper unit is fewer questions, and fewer questions is the gap this row exists to close. |
| the judge | already apportioned once per question-run by `scoped-spend.mjs` and not multiplied by arms. There is no second copy to remove. |
| a new population's data | fetching `LongMemEval-M` is network and wall clock, not model money. It is not free in engineering, and this document does not price engineering. |
| LoCoMo at full size | 48.17 is the correct price for 1,986 questions. The way to spend less is to register a **subset and say which**, not to quote 8 and run the corpus. |

## 7. The plan, priced

| # | row | CNY | basis |
| ---: | --- | ---: | --- |
| 1 | wider population, retrieval side only (probe) | **0.00** | billed (zero calls) |
| 2 | MemCog mechanism, `MR` 121, one pass, two steps | **5.87** | extrapolated (steps) |
| 3 | LoCoMo subset, 300 questions, one pass | **7.28** | proxy (`MR` rate; `TR` has no bill) |
| 4 | wider population, one reader pass | **10.45** | extrapolated (population) |
| | **total** | **23.60** | |

Plus one row that is **refused rather than priced**: the three `text-absent` questions cost 0.15 CNY
and cannot produce a reading at any price — three members against a rejection region that begins at
six. Its repair is a code read of the window allocation, which is free and was never scheduled.

`23.60` against the `60` the three quotations implied is **2.5× cheaper**, and the first row of it is
zero. The ordering change matters more than the money: the queue now spends its first 6 CNY on the only
mechanism with external evidence that it moves `MR`, and its last 10.45 on the ruler.

## 8. Reproducing this table

```
node tools/queue-price.mjs --list          # the table above
node tools/queue-price.mjs --id memcog-mr  # one row, with its label and basis
node tools/queue-price.mjs --questions 431 --capability MR --reps 1 --population external
node tools/queue-price.mjs --self-test     # the gate
```

Four labels, and the gate refuses the fourth: `billed` (this population, within the billed repetition
count), `extrapolated` (a larger population or more repetitions, scaled linearly and said to be),
`proxy` (another capability's billed rate, named on the command line), and **no label at all** for a
capability with neither a bill nor a named proxy — that row is refused with the two ways forward
printed, because a floor answers "what would this cost" and the queue is asking "should this be bought".

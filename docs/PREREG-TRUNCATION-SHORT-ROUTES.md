# PREREG-TRUNCATION-SHORT-ROUTES

**Status:** pending — registered before its dispatch, amended once before the dispatch (§0.1). There is
deliberately no Result section: `tools/prereg-status.mjs` fails a registration that declares `pending` and also
carries one, because a section with a placeholder in it is read as a result by every later reader and by the
gate.

## 0. What is being tested

The adopted arm gives six routes two different amounts of room, and the room census reads every one of them
spending it:

| route              |   n |   room |  turns |      fill | gold carried |     gold% | accuracy | failures | failures with full gold |
| ------------------ | --: | -----: | -----: | --------: | -----------: | --------: | -------: | -------: | ----------------------: |
| `multi-session`    | 121 | 48,460 |    207 | **99.8%** |    1804/1832 | **98.5%** |   89.26% |       13 |                   **9** |
| `temporal`         | 127 | 24,000 |     98 |     99.5% |    1376/1615 |     85.2% |   96.06% |        5 |                       0 |
| `flat`             |  94 | 24,000 | **19** |     95.9% |     595/1182 | **50.3%** |   92.55% |        7 |                       0 |
| `knowledge-update` |  72 | 24,000 | **18** |     95.8% |     843/1688 | **49.9%** |   90.28% |        7 |                       0 |
| `abstention`       |  30 | 24,000 |     19 |     96.6% |      239/672 |     35.6% |  100.00% |        0 |                       0 |
| `assistant`        |  56 | 24,000 |     18 |     95.5% |      402/527 |     76.3% |   96.43% |        2 |                       0 |

`tools/room-census.mjs` on `45543010618` (the adopted arm, 500 of 500, two repetitions). `fill` is
`deliveredPromptChars` over the route's **own** room.

Three facts come out of it and each one is a reason this registration exists.

**No route has idle room.** Every route is between 95.5% and 99.8% of its ceiling, so the hypothesis that a
route's failures are caused by a budget nobody filled is dead before the dispatch. (It was briefly alive: a
census run against the scalar `maxPromptChars` instead of the per-route table read _"379 of 500 questions
spend under 60% of the room"_ — false, because the table names all six routes and the scalar is dead code
for every one of them. `room-census.mjs`'s docblock keeps the mistake.)

**Turn count, not characters, is what the room buys.** At 24,000 characters `temporal` delivers **98** turns
and `flat` delivers **19**, because `temporal` is a capped route (`maxTurnChars: 400`) and `flat` is not. The
room is identical; the depth per turn is not.

**The capped routes carry nearly twice the gold.** Same room, same corpus, same arm: `temporal` delivers
**85.2%** of its gold turns, `flat` delivers **50.3%**, `knowledge-update` **49.9%**. `multi-session`, also
capped but at twice the room, delivers **98.5%**.

## 0.1 The amendment, and the measurement that forced it

This registration was written naming **six** routes and predicting a win. Two facts in the repository say that
shape is not a single-variable experiment, and both were read before the dispatch rather than after it.

**First, the same width has reached every route before, and it lost.** `PREREGISTRATION-CORTEX-MEMORY-ARM.md`
§13.72 measured `maxTurnChars: 400` reaching **every** route: `MR` **+13**, `TR` **+7**, `KU` **−4**,
`IE` **−30**, roster 371 → 357, union 87.40% → 80.20%. Its verdict was _"rejected as a global default, not
rejected as a mechanism"_. The −30 is not diffuse: **all thirty were `correct → abstention`**, their median
gold coverage was **100%**, and §13.72.3 localises the cause in the **flat route's block**, which ends with the
unconditional _\"If the evidence does not contain the answer, reply exactly INSUFFICIENT_EVIDENCE\"_ — a licence
that a window of 73 turns gives the reader seventy-three more opportunities to take.

**Second, the mechanism that caused it is still in the prompt.** `prompt.ts`'s route blocks still close the
`assistant` and `knowledge-update` blocks with that unconditional line, and `flat` is on the same contract. So a
dispatch that widens these three routes is a dispatch that re-admits a measured harm whose cause it does not
touch.

**What has changed since §13.72, and what has not.** Changed: the rendering. `resolution: layered` is now
adopted (1.80 points, `45543010618`), and under it the cap **no longer bounds a turn** — three forms do, with
ceilings that are ratios of the width (`resolution.ts`): `raw` ≤ 400, `excerpt` ≤ 1.5 × 400 = 600,
`record` ≤ 0.6 × 400 = 240. A long turn on these routes is therefore never a 400-character head fragment; it is
either a question-anchored window or a first sentence plus its numeric sentences. Not changed: the closing
line, and therefore the decline licence. Changed as well, and this is the reading that makes the dispatch worth
its price: **on `45543010618` the arm records zero declines on `flat`, `knowledge-update`, `multi-session` and
`temporal`**, so the licence §13.72's reader took is not being taken today — the cascade is a *risk*, not a
current state.

**The amendment, therefore, is three things and no fourth:**

1. **`abstention` is dropped from the field.** It has **0 failures**, its gold is a different object (the turn
   that must *not* be there, which is why its gold coverage is 35.6% at 100% accuracy), and truncation is the
   one change that could plausibly hurt it. Including it would buy a risk and no reading. The field names five.
2. **The §13.72 cascade becomes a registered criterion (`T6`) rather than a surprise.** A treatment that
   converts `correct → abstention` at full coverage on `flat` is the same failure this campaign has already paid
   for once, and a reading that finds it is a **finding about `layered`**, not a null.
3. **`T4` is restated as a deterministic bound**, because the point estimate it carried ("roughly 60 turns") was
   arithmetic for the *cut*, not for the *forms*: the room holds between `24,000 / 600 = 40` and
   `24,000 / 240 = 100` turns under `layered`, and the control that came free (`temporal`, same room, 98 turns,
   85.2% gold) sits near the top of that bound.

## 1. The design

One field, and it is a route list rather than a number:

```
CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES   multi-session,temporal   ->   multi-session,temporal,flat,knowledge-update,assistant
```

`CORTEX_MEMORY_MAX_TURN_CHARS` stays at `400`, `CORTEX_MEMORY_RESOLUTION` stays at the adopted `layered`, and
`CORTEX_MEMORY_MAX_PROMPT_CHARS` is **not sent at all**, so `maxPromptCharsByRoute` keeps the product's
registered table untouched (`REGISTERED_ROOMS`: 48,460 on `multi-session`, 24,000 on the other five). The
dispatch moves **one** field, and the three routes it adds are three instances of one mechanism rather than
three mechanisms.

This is the reason the registration is worth more than its accuracy delta: **the room does not change, so the
prompt's character budget does not change.** The only thing that moves is how the same 24,000 characters are
divided — fewer, longer turns against more, shorter ones. A dispatch that widened the room instead would
confound "more text" with "more turns", and `S16` already read that confound as a null on `temporal` (48,000
back, 23,877 delivered instead of 47,852, one question lost).

`600` is not a candidate here. It was §13's own lever once and it moves the cost; this one does not.

## 2. Predictions, stated so that a failure is a failure

- **`T4` (mechanism, read first, deterministic).** `flat` **50.3% → ≥70%**, `knowledge-update` **49.9% → ≥70%**,
  `assistant` **76.3% → ≥85%** of their gold turns delivered. This quantity is computed from `goldOverlap` and
  `turnWindowCensus`, not from the reader, so it carries **no sampling noise**: it either moved or it did not,
  and the bound it must land in is 40–100 delivered turns per 24,000-character room.
- **`T6` (the cascade, read second, and the criterion this amendment exists for).** On `flat` and
  `knowledge-update` the count of `correct → abstention` transitions stays **≤ 2**, and no decline carries
  **100%** gold coverage. §13.72 measured **30** such transitions at 100% median coverage when the same width
  reached the same route under `raw`; a layered rendering that reproduces them says the forms do not repair the
  licence, and one that does not is the first evidence that the 240/600 ceilings change what the reader is
  willing to conclude from a long list.
- **`T1`.** `IE` + `KU` together gain **≥ 4 net questions** out of 222, **and** the conversion count reads
  `b ≥ 6, c ≤ 1`. The second half is the one that certifies: `MEASURE-RESOLUTION-WALL.md` puts the paired floor
  at these denominators at 7.0 points (15.6 questions), so a true 4-question effect cannot be *reliably*
  detected — what can be certified is a **near-pure conversion**, and `b=6, c=0` reads `p = 0.031` exactly. A
  mid-discordance outcome (`b=3, c=1`) is recorded as **inconclusive**, not as a negative, which is the
  distinction that note exists to force.
- **`T2`.** Exact McNemar on the paired 222 questions reads **p ≤ 0.05**, two-sided.
- **`T3`.** Prompt tokens per answer move **≤ +1.0%**. The room is unchanged, so the only growth is the
  decoration: 60 turns carry ~660 more characters of index and role prefix than 18 do, on 24,000.
- **`T5`.** `abstention` is **not in the field**, so its 30 prompts are byte-identical to the adopted arm's.
  That is a unit test on the route table plus a digest comparison across the two artifacts, not a reading — the
  point of dropping it from the dispatch is that the claim needs no money to check.

## 3. The falsifier, and what a negative reading would mean

`T4` passing and `T1`/`T2` failing **with `T6` clean** is the informative negative, and it is registered as the
outcome that would close an entire direction rather than one lever:

> If the gold a route delivers rises from ~50% to ≥70% and its accuracy does not move, then **"the remaining
> `IE`/`KU` failures are a delivery institution"** — the reading `§196` recorded and every round since `§193`
> has been built on — is false. The failures would have to be a decision institution after all, on routes
> whose windows were never the constraint, and the next dispatch would be a prompt axis on `flat` and
> `knowledge-update` rather than any further retrieval work.

`T6` firing is a different verdict and it is not a null either:

> If the gold rises **and** thirty questions convert to declines at full coverage, then `layered` does not
> repair §13.72 and the cap cannot reach these routes until the closing line does. The next dispatch is then
> the **conditional closing line on `flat`** — one sentence, zero model cost, and a mechanism §13.72's own
> reading named four rounds ago and nothing has implemented.

The remaining branch (`T6` clean, `T1` mid-discordance) is **inconclusive** and buys a re-run at four
repetitions, which is a price this registration names rather than a conclusion it takes.

## 4. What this registration does not claim

- **Nothing about `MR`.** Its route key is in the field, but it is already capped at 400 at its own room, so its
  prompts are byte-identical and the artifact will differ from `45543010618` on `multi-session` by **zero
  bytes**. That is asserted by a unit test on the route table rather than read from a number, because a run
  cannot show a non-change it was never given the chance to make.
- **Nothing about `temporal`.** Also already capped, so its prompts are byte-identical too. Its row in the
  census is the **control that came free**: 98 turns and 85.2% gold at the same room is where `flat` and
  `knowledge-update` are being asked to arrive.
- **Nothing about `abstention`.** Dropped from the field, on the reason in §0.1.
- **Nothing about cost being free.** `T3` permits +1.0% and the measured figure may be zero; either way the
  dispatch is not claiming truncation is cheaper, only that it is not more expensive.

## 5. Price

**¥10.80** as the ceiling, from two numbers that disagree and are both stated:

- `node tools/spend-projection.mjs --report <merged 45543010618> --limit 0 --runs 2 --capability IE,KU` reads
  **¥6.21** and prints `LOWER BOUND` itself, because per-question cost is route-scoped and the census scales by
  count.
- The same tool on `--capability KU` reads **¥2.01**, and `--capability MR` reads **¥3.38** for the dispatch that
  was actually billed **¥5.87** (`45636994046`), a ratio of **1.74**. Applying it: `6.21 × 1.74 = ¥10.80`.

The ceiling is what the spend gate is set to. 222 questions × 2 repetitions = 444 question-runs, and the
projection's own per-1,000 figure (13.98 CNY at list price) puts the same population at ¥6.24 before the
ratio — the two agree on the lower bound and the ratio is what makes the ceiling honest.

## 6. Why this and not the three levers already in the queue

| candidate                                 |                 population |   CNY | why it waits                                                                                                                 |
| ----------------------------------------- | -------------------------: | ----: | ---------------------------------------------------------------------------------------------------------------------------- |
| this one                                  | 222 questions, 16 failures | 10.80 | the only one whose **mechanism** is deterministic (`T4` has no sampling noise) and whose control came free (`temporal`)      |
| `⑬` re-price `verbatim-acts` on `layered` |                        121 |  5.87 | needs `vars.CORTEX_MEMORY_RESOLUTION=layered` or a `pairing=ask` the arm does not have yet — a settings change, not a commit |
| `⑤` `KU` conflict block                   |                         72 |  1.03 | a different mechanism on the same 7 failures; would confound this one if dispatched together                                  |
| `④` 60-question judge pinning             |                         60 |  0.86 | measures the instrument, not the arm                                                                                         |

The order is deliberate. This dispatch is the only one in the queue that can **falsify a diagnosis** rather
than add a lever, and if `T4` passes while `T1` fails then `⑤` and `⑬` both become the wrong next move and
the queue is rewritten.

# PREREG-TRUNCATION-SHORT-ROUTES

**Status:** pending — registered before its dispatch. There is deliberately no Result section: `tools/prereg-status.mjs` fails a registration that declares `pending` and also carries one, because a section with a placeholder in it is read as a result by every later reader and by the gate.

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

## 1. The design

One field, and it is a route list rather than a number:

```
CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES   multi-session,temporal   ->   multi-session,temporal,flat,knowledge-update,abstention,assistant
```

`CORTEX_MEMORY_MAX_TURN_CHARS` stays at `400` and `CORTEX_MEMORY_MAX_PROMPT_CHARS` is **not sent at all**, so
`maxPromptCharsByRoute` keeps the product's registered table untouched (`REGISTERED_ROOMS`: 48,460 on
`multi-session`, 24,000 on the other five). The dispatch moves **one** field, and the four routes it adds are
four instances of one mechanism rather than four mechanisms.

This is the reason the registration is worth more than its accuracy delta: **the room does not change, so the
prompt's character budget does not change.** The only thing that moves is how the same 24,000 characters are
divided — fewer, longer turns against more, shorter ones. A dispatch that widened the room instead would
confound "more text" with "more turns", and `S16` already read that confound as a null on `temporal` (48,000
back, 23,877 delivered instead of 47,852, one question lost).

`600` is not a candidate here. It was §13's own lever once and it moves the cost; this one does not.

## 2. Predictions, stated so that a failure is a failure

- **`T4` (mechanism, read first).** The three routes this dispatch touches deliver **≥70%** of their gold
  turns, up from 50.3% / 49.9% / 76.3%. At 400 characters the same room holds roughly 60 turns instead of 18,
  and the gold a route misses is gold that lost the ranking's top-18; tripling the window is the only change
  in this dispatch, so `T4` is the criterion that says **whether the mechanism executed at all**. It is read
  before the accuracy, on `S17`'s precedent: a delta published for a mechanism that did not run is a delta
  about nothing.
- **`T1`.** `IE` + `KU` together gain **≥ 4 net questions** out of 222. Four is the noise floor's upper edge
  (1.6–2.2 points on this corpus, and 4/222 is 1.8).
- **`T2`.** Exact McNemar on the paired 222 questions reads **p ≤ 0.05**. This is reachable here and it is
  worth saying why: the population carries **16 failures**, so `b=6, c=0` reads `p = 0.031`. On `KU` alone
  (7 failures) the best case `b=4, c=0` reads `p = 0.125` — which is why this dispatch moves three routes
  and not one. A single-route truncation registration would be a registration that cannot certify.
- **`T3`.** Prompt tokens per answer move **≤ +1.0%**. The room is unchanged, so the only growth is the
  decoration: 60 turns carry ~660 more characters of index and role prefix than 18 do, on 24,000.
- **`T5`.** `abstention` stays at **30/30**. It is in the population because the field is a route list and
  sending four of five would be a different experiment; it is also the route where truncation could plausibly
  hurt, because a question that must be declined is decided on the _absence_ of an item and a window that
  holds 60 turns can make an absence look like a presence. This criterion exists to catch that.

## 3. The falsifier, and what a negative reading would mean

`T4` passing and `T1`/`T2` failing is the informative negative, and it is registered as the outcome that
would close an entire direction rather than one lever:

> If the gold a route delivers rises from ~50% to ≥70% and its accuracy does not move, then **"the remaining
> `IE`/`KU` failures are a delivery institution"** — the reading `§196` recorded and every round since `§193`
> has been built on — is false. The failures would have to be a decision institution after all, on routes
> whose windows were never the constraint, and the next dispatch would be a prompt axis on `flat` and
> `knowledge-update` rather than any further retrieval work.

That is the branch this registration is designed to be able to reach. The opposite outcome (`T4` passing and
`T1` passing) is the ordinary one and it costs one more dispatch to confirm at 4 repetitions.

`T4` failing is a different finding and it is not a null: gold coverage that does **not** rise when the
window triples says the ranking had already offered those gold turns nowhere near the top 18 — i.e. the
retrieval signal, not the window, is the constraint, and the next lever is `CORTEX_MEMORY_RELEVANCE` rather
than width.

## 4. What this registration does not claim

- **Nothing about `MR`.** Its route key is not in the field this dispatch sends, its room is not touched, and
  the artifact will differ from `45543010618` on `multi-session` prompts by **zero bytes**. That is asserted by
  a unit test on the route table rather than read from a number, because a run cannot show a non-change it was
  never given the chance to make.
- **Nothing about `temporal`.** It is already capped at 400 and already in the list, so its prompts are
  byte-identical too. Its row in the census is the **control that came free**: 98 turns and 85.2% gold at the
  same room is where `flat` and `knowledge-update` are being asked to arrive.
- **Nothing about cost being free.** `T3` permits +1.0% and the measured figure may be zero; either way the
  dispatch is not claiming truncation is cheaper, only that it is not more expensive.
- **Nothing about the 4 unfilled gold bands.** `assistant` at 76.3% and `abstention` at 35.6% are in the
  population and are not predicted separately: `abstention`'s gold is a different object (the turn that must
  _not_ be there), and `assistant`'s 2 failures are too few to read.

## 5. Price

**¥10.80** as the ceiling, from two numbers that disagree and are both stated:

- `node tools/spend-projection.mjs --report <merged 45543010618> --limit 0 --runs 2 --capability IE,KU`
  reads **¥6.21** and prints `LOWER BOUND` itself, because per-question cost is route-scoped and the census
  scales by count.
- The same tool on `--capability MR` reads **¥3.38** for the dispatch that was actually billed at **¥5.87**
  (`45636994046`), a ratio of **1.74**. Applying it: `6.21 × 1.74 = ¥10.80`.

The ceiling is what the spend gate is set to. 222 questions × 2 repetitions = 444 question-runs, and the
projection's own per-1,000 figure (14.04 CNY at list price) puts the same population at ¥6.24 before the
ratio — the two agree on the lower bound and the ratio is what makes the ceiling honest.

## 6. Why this and not the three levers already in the queue

| candidate                                 |                 population |   CNY | why it waits                                                                                                                 |
| ----------------------------------------- | -------------------------: | ----: | ---------------------------------------------------------------------------------------------------------------------------- |
| this one                                  | 222 questions, 16 failures | 10.80 | the only one whose **mechanism** is already visible in a control that came free (`temporal`)                                 |
| `⑬` re-price `verbatim-acts` on `layered` |                        121 |  5.87 | needs `vars.CORTEX_MEMORY_RESOLUTION=layered` or a `pairing=ask` the arm does not have yet — a settings change, not a commit |
| `⑤` `KU` conflict block                   |                         72 |  1.03 | a different mechanism on the same 7 failures; would confound this one if dispatched together                                 |
| `④` 60-question judge pinning             |                         60 |  0.86 | measures the instrument, not the arm                                                                                         |

The order is deliberate. This dispatch is the only one in the queue that can **falsify a diagnosis** rather
than add a lever, and if `T4` passes while `T1` fails then `⑤` and `⑬` both become the wrong next move and
the queue is rewritten.

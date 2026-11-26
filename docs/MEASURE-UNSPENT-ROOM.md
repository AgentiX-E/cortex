# The room that was paid for and not spent

`selectByRelevance` takes the **largest fitting prefix** of the relevance order. A turn that does not
fit therefore ends the pass: every turn ranked below it is dropped, however small, and the room it
could not fill is returned to nobody. This document measures that hole on the published artifact,
prices the repair, and bounds what the repair can earn.

The repair is `relevanceUnits: 'turn-fill'`. It is not new behaviour invented here — it is the rule
`selectBySessionFill` already is, applied to the unit that kept the one `38753835652` refuted.

## 1. The hole

`maxPromptCharsByRoute` less `deliveredPromptChars`, per question, on `45760081761`:

| route | room | slack mean | slack p50 | slack p90 | slack max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `multi-session` | 48,460 | **132** | 115 | 262 | 358 |
| `temporal` | 24,000 | **127** | 113 | 262 | 443 |
| `abstention` | 24,000 | 954 | 795 | 1,635 | 6,258 |
| `knowledge-update` | 24,000 | 1,333 | 998 | 2,620 | 9,577 |
| `assistant` | 24,000 | 1,356 | 1,046 | 2,344 | 10,012 |
| `flat` | 24,000 | 1,398 | 987 | 2,388 | **13,817** |

**The hole is a function of how long a single turn can be, and of nothing else.** `maxTurnChars` is
`400` on exactly `multi-session` and `temporal`, which is why those two sit at 132 and 127 — a prefix
over 400-character turns lands within one turn of the room by construction, and its maximum over both
routes (443) is barely above one turn. The four routes with no cap run to 13,817 characters on a
single question.

That is the whole explanation of why this was never noticed: the campaign's own reading of the room
axis is `multi-session`-shaped, and `multi-session` is the one route where the prefix rule is nearly
exact.

## 2. The rule was already refuted, once, for sessions

`38753835652` dispatched the session unit on this same prefix rule against `§13.26`'s turn unit with
nothing else moved:

| | control | treatment |
| --- | ---: | ---: |
| the delta it was chasing | +25.75 pp | **+17.80 pp** |
| `MR` accuracy | 42.15% | **12.40%** |
| questions the control had right and the treatment wrong | — | **92** |
| questions gained | — | **0** |
| median turns carried | — | **12**, in a room holding about **23** |

The mechanism was not the unit. A session is far larger than a turn, so the first session over the
line ended the pass and **the rest of the room was never spent**. `selectBySessionFill` was written
to skip and continue, and `session` was frozen beside it so the refutation stays reproducible.

**The turn unit kept the rule.** No artifact has measured the difference there since, and §1 is what
it costs.

## 3. The safety property, which is why this can be stated before it is dispatched

**Every turn the prefix carries, the fill carries.** The prefix carried `0..k-1` because their
rendering fits; the fill walks the same order from zero and accepts each of them for the same reason
before it reaches `k`. The carried set is a **superset** on every question:

- gold delivered can go up and cannot go down;
- the cost is **zero tokens**, because the room was already bought.

`evidence-turn-fill.test.ts` asserts the containment at every room from 900 to 2,400 characters in
steps of 20, on four corpora, rather than at the one budget the suite configures.

## 4. The two costs, stated rather than hidden

**`O(n)` renders instead of `O(log n)`.** A skipped turn changes which indices the ones after it
carry, so the marginal cost of a candidate is not a constant. A pre-filter rejects, without calling
the renderer, any turn longer than the remaining room — a rendered block is never shorter than its
own content plus a separator — and that filter is what a prefix rule never needed and a filling rule
cannot do without.

**The number of turns carried is not monotone in the room.** A room large enough for a big turn buys
it and can then have nothing left for the two small ones a smaller room bought instead. On the test
corpus, `1,700` characters carries three turns and `1,720` carries two. The prefix rule cannot do
this — `k` only grows — and **that**, rather than the count, is what the prefix was buying. The
characters delivered do not fall, and the superset property above is what makes the rule safe. Both
are asserted, because a maintainer who meets the non-monotonicity without the superset will read it
as a regression and revert the rule.

## 5. What the repair can reach, bounded from the artifact

`tools/turn-fill-ceiling.mjs` (`guard:turn-fill-ceiling`) walks each question's missing gold in rank
order and spends the unspent room on it, **as if no other turn competed for it** — so every number
below is an upper bound, and the true recovery lies between zero and it.

On `45760081761`, over the 330 questions that have a gold segment missing:

| route | questions | wrong | slack mean | gain gold | of them wrong | all of it | of them wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `abstention` | 29 | 0 | 975 | 23 | 0 | 0 | 0 |
| `assistant` | 32 | 1 | 1,494 | 28 | **1** | 17 | **1** |
| `flat` | 90 | 6 | 1,404 | 79 | **5** | 9 | 0 |
| `knowledge-update` | 71 | 5 | 1,346 | 66 | **4** | 0 | 0 |
| `multi-session` | 14 | 3 | 107 | **0** | **0** | 0 | 0 |
| `temporal` | 88 | 6 | 119 | 16 | **0** | 4 | 0 |
| **all** | **330** | **21** | **950** | **215** | **10** | **31** | **1** |

**313,372 characters stand unspent across the arm**, and the fill could deliver at least one more
gold segment on **215 questions**. But of the **21 wrong questions** that have a gold segment missing,
only **10** are reachable and only **one** gets all of its gold.

And the split has a shape: **`multi-session` gains nothing at all.** Its 14 questions in this
population have a mean slack of 107 characters, so the fill cannot buy a single segment there — which
is where **13 of the arm's 14 decision faults live** and where `MR`'s 88.43% is decided.

## 6. Why this is not the same measurement as §207

`§207` established that the arm has **35** wrong questions rather than 617, split **21 delivery faults
and 14 decision faults**, and that the delivery axis is therefore worth at most **4.20 points**. It
did *not* ask which repair can reach which of the 21. This document does, and two of its rows change
the picture:

- `§207.3` read the delivery axis as a **room** question, priced at 5.81 CNY for a re-dispatch on the
  registered configuration. That price is right and the axis is not: the per-question gap — the best
  missing gold's rank minus the turns the window held — has a median of **14** and a maximum of **50**
  over the 21, and room has to close that gap turn by turn.
- The two numbers a reader will confuse are kept apart in every table: **215 questions gain gold**
  and **10 wrong ones** do. On this artifact a question with an absent gold reads **93.64%** against
  **91.76%** for one whose gold arrived whole, so "more gold delivered" is not "more answers right",
  and only a dispatch can separate the two.

## 7. What is measured, what is bounded, and what is unknown

| claim | status |
| --- | --- |
| the prefix leaves room unspent | **measured** — `maxPromptChars - deliveredPromptChars`, per question, on the published artifact |
| the hole is a function of the turn cap | **measured** — 132/127 on the two capped routes against 954–1,398 on the four uncapped ones |
| the fill's carried set is a superset of the prefix's | **proved and tested** — every turn the prefix took fits, so the walk takes it first |
| the fill costs no tokens | **by construction** — the room is already in the prompt budget |
| the fill could deliver more gold on 215 questions | **bounded** — upper bound, no competing turn assumed |
| 10 of the 21 wrong questions are reachable | **bounded** — same assumption, same direction |
| the fill raises accuracy | **unknown** — needs a dispatch at one pass, and `turn` stays the registered unit until one exists |

## 8. The one-line summary

> The arm pays for 24,000 or 48,460 characters of evidence and returns up to 13,817 of them unread.
> Filling costs nothing, cannot lose a turn the prefix carried, and — read off the artifact rather
> than promised — reaches 10 of the 21 wrong questions that are missing gold, and none of the 13 in
> `multi-session` that are not.

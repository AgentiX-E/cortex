# The queue was ordered by a floor the registration does not use

**Status:** decided. Two dispatches were refused by arithmetic this round, not by opinion, and the
instrument that refused them is `tools/queue-floor.mjs`, admitted to `pnpm check` as
`guard:queue-floor`. Nothing was dispatched and nothing was spent.

## 0. In one paragraph

`AUDIT-FAILURE-CLASSES.md` §4 ranks every remaining mechanism by "ceiling against floor" and concludes
that **not one class can be certified**, calling that "the arithmetic reason five rounds of
single-lever dispatches produced no certifiable reading". The table's floor is
`2.8016·sqrt(2·p(1−p)/n)` — the **unpaired** two-proportion minimum detectable effect — while every
dispatch in this campaign is read by a **paired** test whose criteria are written in the registrations
themselves: `T1` requires `b ≥ 6, c ≤ 1` and `T2` requires McNemar `p ≤ 0.05`. On `MR` the unpaired
floor is **13.5 questions**; McNemar certifies **6**. The queue has therefore been ordered by an
instrument that demands 2.2× (on the route) to 3.7× (on the suite) what the test it is read by
demands, and five classes of six to nine questions were written off as untestable when six is exactly
what certifies. (This paragraph read 9.5, 1.6× and 2.6× until §211 corrected the floor's formula; see
§1.1.) The second half of the round applies the same scrutiny to the one dispatch that *was*
queued — `reviewPass: spec` — whose frozen ceiling of 12 has decayed to **4** on the arm it would be
read against, which is below the floor of 6: it could not have produced a certifiable reading even if
it repaired every question it could reach.

## 1. The two floors, and which one a dispatch is

They are not rival estimates of one quantity. They answer different questions.

| | unpaired | paired |
| --- | --- | --- |
| the question | *how many questions would two independent samples need, to show this difference?* | *how many questions must move, given that every other question is held fixed?* |
| formula | `2.8016·sqrt(2·p(1−p)/n)` points | smallest `b` with exact McNemar `p ≤ 0.05` at `c` losses |
| `MR`, n = 121 | 11.13 points = **13.5 questions** | **6 questions** = 4.96 points |
| suite, n = 500 | 4.47 points = **22.3 questions** | **6 questions** = 1.20 points |
| where it is the right instrument | a competitor comparison, where two systems cannot share a run | a one-field dispatch, where they do |

### 1.1 The unpaired floor was computed in its one-sample form, and the correction widens the gap

The two rows above read **7.87 points / 9.5 questions** and **3.16 / 15.8** for four months. They were
computed as `2.8016·sqrt(p(1−p)/n)`, which is the standard error of **one** proportion — the quantity
that bounds a single arm's resolution — while the column is headed *"how many questions would two
independent samples need"*. Two samples at the same denominator have two variances, and the MDE of a
difference uses their **sum**, so the printed figure was low by exactly `sqrt(2)`.
`MEASURE-TWO-WITNESSES.md` §5 found it and left it standing on the explicit ground that no verdict
read it; the queue did, and this table is the queue's instrument.

| quantity | one-sample (what was printed) | two-proportion (what the column asks) |
| --- | ---: | ---: |
| `MR`, p = 0.893, n = 121 | 7.87 points = 9.5 questions | **11.13 points = 13.5 questions** |
| suite, n = 500 (the printed value, scaled) | 3.16 points = 15.8 questions | **4.47 points = 22.3 questions** |

**What the correction changes, and what it does not.** The section's conclusion is unchanged and
stronger: the queue should be read by the paired floor, and the unpaired one now disagrees with it by
2.2× on `MR` and 3.7× on the suite rather than 1.6× and 2.6×. The two dispositions this document
issued — `reviewPass: spec` refused at a decayed ceiling of 4, and the delivery institution refused on
its ceiling — were taken on the **paired** floor of 6 and do not move. What moves is any later argument
that used the unpaired number as a *population size*: a class of ten on `MR` clears the old floor of
9.5 and does not clear the corrected 13.5, and the second reading is the one the definition supports.

The fix is `tools/queue-floor.mjs`'s `unpairedFloor`, which now writes the variance as the **sum of two
sample variances** so the factor of two is the derivation rather than a constant. The self-test's pin
was the defect's strongest ally — it asserted `~7.87` and would have gone red on the fix — so it now
asserts the identity `unpairedFloor(p, n) = sqrt(2) · [one-sample form]` against an independently
written expression, which is a statement about the derivation and not about a number somebody once
computed.

A one-field dispatch is the second thing by construction: the same 500 questions, the same corpus,
the same reader, one configuration field moved, `b` and `c` counted on the discordant pairs. The
campaign has never run the first thing — no dispatch has ever compared two *independent* samples —
so the unpaired floor has never been the operative constraint, and yet it has been the only floor in
the table.

The floor table, at the values the registrations quote (`tools/queue-floor.mjs --self-test` pins
them):

| losses `c` | 0 | 1 | 2 | 3 |
| --- | --: | --: | --: | --: |
| gains `b` needed | **6** | 8 | 10 | 12 |
| exact `p` at that `b` | 0.03125 | 0.0391 | 0.0386 | 0.0352 |

`p(6, 0) = 0.03125` and `p(5, 0) = 0.0625` are the two numbers the argument turns on: six conversions
with no losses certify, five do not. Both are exact binomial values, asserted at exact equality rather
than to a tolerance, because a gamma-function p-value returns `0.03125000000000001` and a pinned
assertion on it would be a tolerance pretending to be a proof.

## 2. What the correction does to the table §198.4 printed

Re-read with the paired floor, the same census of the adopted arm's 34 failures orders differently.
Every number below is computed from the artifact, not quoted from §198.4 — including each route's own
accuracy, because the unpaired floor needs it and a floor computed at the wrong `p` is the kind of
error that survives review:

| class | route | n | pop. | acc. | ceiling | unpaired | paired floor | verdict |
| --- | --- | --: | --: | --: | --: | --: | --: | --- |
| `preference` | `flat` | 6 | 94 | 92.55% | **6.38** | 7.59 | 6.38 | **certifiable, at 6 of 6** |
| `derived-number` | `multi-session` | 6 | 121 | 89.34% | **4.96** | 7.89 | 4.96 | **certifiable, at 6 of 6** |
| `text-misselected` | `knowledge-update` | 3 | 72 | 90.28% | 4.17 | 9.78 | 8.33 | refused |
| `derived-number` | `knowledge-update` | 2 | 72 | 90.28% | 2.78 | 9.78 | 8.33 | refused |
| `number-absent` | `multi-session` | 3 | 121 | 89.34% | 2.48 | 7.89 | 4.96 | refused |
| `number-misselected` | `multi-session` | 3 | 121 | 89.34% | 2.48 | 7.89 | 4.96 | refused |
| `text-misselected` | `temporal` | 3 | 127 | 96.06% | 2.36 | 4.83 | 4.72 | refused |
| `number-misselected` | `assistant` | 1 | 56 | 96.43% | 1.79 | 6.95 | 10.71 | refused |
| `empty` | `knowledge-update` | 1 | 72 | 90.28% | 1.39 | 9.78 | 8.33 | refused |
| `number-misselected` | `flat` | 1 | 94 | 92.55% | 1.06 | 7.59 | 6.38 | refused |
| `empty` | `multi-session` | 1 | 121 | 89.34% | 0.83 | 7.89 | 4.96 | refused |
| `derived-number` / `number-misselected` | `temporal` | 1 + 1 | 127 | 96.06% | 0.79 | 4.83 | 4.72 | refused |

**The verdict changes from "not one class clears the floor" to "exactly two do, and each of them only
if every one of its questions converts."** That is a real correction and a weak permission: a class of
six whose floor is six needs 100% conversion, which no mechanism in this campaign has ever achieved
(the best single-lever dispatch converted 6 of 9 and lost 15 elsewhere). So the practical conclusion
of §198.4 — that a single class is not the right target — survives the correction, but for a
different reason and with a number instead of an assertion:

> **The bundle is what the floor rewards, because the floor is a count and the ceiling is a share.**
> The numeric institution is 12 of `MR`'s 121 = **9.92 points** against a floor of **4.96** — so a
> mechanism needs **6 of 12, not 12 of 12**. Every single class needs 6 of 6. Splitting a bundle into
> its classes therefore does not just lose power, it multiplies the required conversion rate by the
> number of classes it is split into.

That identity — *required conversion = floor ÷ class size* — is the ordering rule the queue should
have been built on, and it is monotone in exactly the direction that favours bundles.

The honest caveat, which belongs here rather than in a footnote: with a deterministic reader, `b` and
`c` are not a sample. A question either moves or it does not, and McNemar treats the sign of the
discordant pairs as a coin. What the test really says is *"if the mechanism had no direction, how
surprised should we be by this split?"* — a statement about the mechanism's plausibility, not about a
population of runs. That is the reading the campaign has always used and it is defensible; what was
not defensible was using a **different** statistic to decide which mechanisms were worth testing.

## 3. The second check: a frozen ceiling decays

`tools/spec-reachability-groups.json` froze, on control `42533236864`, which of the 17 numeric `MR`
failures a plan in `reviewPass: spec`'s grammar could reach: 8 from the question's own vocabulary, 4
only from the history's, 5 not at all. Its own header records that it was frozen "before the round-62
`reviewPass: spec` dispatch". That dispatch never happened. The arm it would be read against has moved
twice since — `layered` and `verbatim-acts` — so the frozen groups are populations measured against a
system that is no longer the one running.

Re-counting them against the adopted arm's own artifact, which needs no corpus because the artifact
carries every question's outcome:

```
MR: 121 questions in the artifact; paired floor 6 gains = 4.96 points (McNemar, c = 0)

group                  frozen  remaining  repaired  ceiling  floor  verdict
question-vocabulary         8          4         4     3.31  4.96  refused
history-only                4          0         4     0.00  4.96    empty
unreachable                 5          3         2     2.48  4.96  refused
no-numeric-gold             3          2         1     1.65  4.96  refused
```

Two of the four groups no longer describe this system. `history-only` is **empty**: all four questions
that only a history-vocabulary plan could reach are answered correctly today, so the "gap between 8
and 12 is the act of naming a word" — the exact thing the dispatch was built to measure — has already
been closed by a different mechanism and would have been measured as zero. `question-vocabulary` is
down to 4 of 8, which is a ceiling of 3.31 points against a floor of 4.96.

**A ceiling is a population, and a population counted against an older arm is not a ceiling.** The
registered number was 12; the number the dispatch would have been read against is 4; the floor is 6.
The dispatch was not expensive-and-unpromising, it was **unreadable**: even a perfect plan author
could not have produced a certifying split.

## 4. The refusal, and why refusing is the act

Both checks live in one instrument because they answer one question — *can this dispatch certify?* —
and a reader who has to hold two commands in their head will run the cheap one and skip the other.

```
node tools/queue-floor.mjs --class 6 --population 121 --accuracy 0.893
node tools/queue-floor.mjs --artifact <report.json> --groups tools/spec-reachability-groups.json
```

The first exits 1 when a class cannot certify; the second exits 1 when a frozen group's remaining
ceiling is below the floor. Three states are refused outright, each of which would otherwise print a
number about nothing: a group id the artifact does not contain (a ceiling over a population it cannot
see), a class larger than its population or `c ≥ b` (a floor beside a mechanism that lost), and
`n ≤ 0` (a share of nothing).

`⑭` closed last round by losing 9 questions; `spec` closes this round by arithmetic. What is left is
in §5 of `AUDIT-NUMERIC-MEMBERSHIP.md`, and the number that matters there — 10 membership failures
against a floor of 6 — is measured on the arm that will run it.

## 5. What this does not claim

1. **Not that the earlier rounds' mechanisms were good.** Five dispatches still failed. What changes is
   the *explanation*: they were not underpowered by construction, they did not convert.
2. **Not that `preference` is now worth buying.** It clears the floor only if all six convert with no
   losses, which is the strongest possible requirement expressed as a floor of six.
3. **Not that the suite floor should replace the route floor.** A route is a population and a class is
   read inside it; both floors are computed at whichever denominator the class lives in.
4. **Not a re-derivation of the frozen groups.** The instrument reports the remainder and cannot
   re-measure the ceiling; that needs `measure-spec-ceiling.ts`, the corpus, and the runner.

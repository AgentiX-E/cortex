# The ceiling of `reviewPass: 'spec'` on the arm that ships, registered before it is measured

**Status:** pending. Registered and unmeasured: the ceiling run costs zero model calls and zero
CNY, and the dispatch it prices is `reviewPass: 'spec'`, one field, read against the shipped arm at
the same load. The result is written into section 7 once the run exists, and the four criteria in
section 3 are what it will be judged by.

## 0. In one paragraph

`docs/MEASURE-SPEC-CEILING.md` measured the specification grammar's ceiling once, over the failing
questions of `42533236864`, and found 8 reachable from the question's own vocabulary and 12 from the
history's. Eight mechanisms have landed since. Most of those ids now pass, so a ceiling re-read over
that same population prints **4** and reads as a statement about the grammar when it is a statement
about the report: the questions the grammar could not express have been replaced by questions nobody
has asked it. This document registers the measurement that replaces it — the ceiling over the twelve
numeric `MR` failures of the **adopted arm** `45543010618`, named one by one in
`docs/AUDIT-NUMERIC-MEMBERSHIP.md` and frozen in `tools/spec-ceiling-population.json` before this
file existed. It costs nothing but runner time, and it decides a dispatch that costs about ¥5.9.

## 1. Why the old reading cannot be reused, in numbers

| reading | control `42533236864` | adopted arm `45543010618` |
| --- | --- | --- |
| numeric `MR` failures | 17 | **12**, and only 8 of the ids are shared |
| reachable from the question's vocabulary | 8 | **untested** |
| reachable from the history's vocabulary | 12 | **untested** |
| reachable, after intersecting the old groups with the new failing set | — | 4 (question group) + 0 (history-only group) |

The last row is the trap. Intersecting a frozen group with a newer failing set is arithmetic that
*looks* like a re-measurement and is not one: it can only ever shrink, because a question that was
fixed leaves the group, and a question that broke for the first time was never in it. `spec`'s
ceiling would then be "4 of 6", which is below the paired floor and would close the mechanism for the
wrong reason. The eight ids that survived are exactly the ones an older mechanism already reached, so
the intersection measures *how much the grammar was already used*, not *what it can express*.

## 2. The population, and its arithmetic

Twelve ids, frozen in `tools/spec-ceiling-population.json`, in three groups the audit states:

| group | n | what it is |
| --- | --- | --- |
| membership-dropped | 6 | a member the gold keeps was dropped: an invented evidentiary bar (3), an over-merge (1), an over-strict period (2) |
| membership-kept | 4 | a member the gold drops was kept: one object stated twice (2), a boundary the question states in words (1), an amount the event raised rather than the user (1) |
| not-membership | 2 | a stated value picked wrongly, and a derived value needing a fact the history never states |

| quantity | value |
| --- | --- |
| numeric `MR` failures on the adopted arm | 12 of 121 |
| ceiling if all twelve converted | 12 / 121 = **9.92 points** |
| paired floor (`c = 0`, `b = 6` certified) | 6 questions = **4.96 points** |
| conversion required at the full population | **6 of 12 = 50%** |

The floor is the paired one, because this is a single-variable dispatch read against the shipped arm
by exact McNemar (`docs/AUDIT-QUEUE-FLOOR.md` 1). The unpaired band — 9.5 questions on this
capability at `p = 0.8926` — is the number competitor tables are compared on, not the number a
dispatch is judged by.

## 3. The three criteria, registered before the run

### C1 — arithmetic: `grammarOfEligible ≥ 10`

The search is an upper bound and returns the count of questions where **some** plan reaches the gold.
A dispatch converts a question only when the reader *chooses* that plan. No measurement in this
campaign has ever observed a conversion rate above 60% on a single-variable pass, and the instrument
this one replaces observed **0 of 10** (`reviewPass: 'tally'`, run `42855433242`). Ten reachable is
therefore the smallest count that clears six converted questions at the optimistic end of the
observed range (10 × 0.6 = 6). Nine reachable would require 67% conversion, which nothing on this arm
has achieved; eight would require 75%.

The gate is `grammarOfEligible` and not `grammar`, because `reviewPass: 'spec'` is gated on
`isTallyQuestion` — an enumeration question asking for a count or a total. A question outside that
gate is never reached by the pass, so counting it in the numerator would be a ceiling over a
population the mechanism does not have.

### C2 — semantic: every one of the hits is read, and a fake hit is subtracted from C1

The search tries every keyword the question supplies and every unit the ledger carries, including
combinations a reader would never consider. A count that lands on the gold by coincidence — gold `4`,
and some keyword the question happens to use selects exactly four rows — is a hit the arithmetic
cannot tell from a real one. So the reading is not accepted on C1 alone: **each of the hits is read
beside its question**, and `g_semantic` is the count whose plan a reader could plausibly have
intended. C1 is judged on `g_semantic`.

This is the criterion `docs/MEASURE-SPEC-CEILING.md` named as its own limit — *"a ceiling of 12 was
measured by asking 'can any plan produce the gold', not 'will the reader's plan name the gold's
set'"* — and it is why the dispatch decision is not a number a script can print. The script prints the
candidate plan; the reading is a judgement, recorded per question in the result section.

### C3 — denominator: the gate is recomputed on `eligible`, not on `numeric`

If fewer than twelve questions pass `isTallyQuestion`, the denominator moves with them and so does
the bar: `ceil(0.6 × eligible)`, and never fewer than six, because six is what the floor certifies.
A reading that reported "10 of 12" while only eight were eligible would be reporting a ratio against
a population the pass cannot address.

### What passes, and what a failure means

| outcome | reading | consequence |
| --- | --- | --- |
| `g_semantic ≥ 10` and `eligible = 12` | the grammar can express what the pass is for | dispatch `reviewPass: 'spec'`, ≈¥5.9 |
| `6 ≤ g_semantic < 10` | expressible, but not at the conversion rate the arm has ever achieved | **do not dispatch**; record the direction as priced-out rather than refuted |
| `g_semantic < 6` | the grammar cannot reach the floor even at 100% conversion | **close** the direction, and the residual is the ledger's grain or the membership institution, not the plan language |

The third row is the one this measurement is most likely to produce, and it is a real finding:
`AUDIT-NUMERIC-MEMBERSHIP.md` 1 shows ten of the twelve are decided before any arithmetic happens, so
a grammar whose only predicate is `text contains` cannot name the set the gold counts. If that is what
the reading says, the next increment is the membership adjudicator and not a fourth arithmetic pass.

## 4. What this does not claim

1. **Not a prediction of accuracy.** A yes is permission to spend, not a promise of six conversions.
   The gap between "a plan exists" and "the reader writes it" is the whole of C2 and cannot be
   measured offline.
2. **Not measured on the arm's window.** The ledger is compiled from **every** haystack session, while
   the arm reads a `layered` window under a 48,460-character room. Both ceilings are therefore upper
   bounds on what a windowed pass could reach, which is the direction an upper bound must err in — but
   it also means a high reading is necessary rather than sufficient.
3. **Not a re-reading of the twelve by hand.** C2 reads the *plan*, not the reply. Whether the plan
   points at the gold's set is a semantic judgement; whether the reader would have written that plan
   is not measured here and is not claimed.
4. **Not an exhaustive search of the history vocabulary.** The question vocabulary is searched
   exhaustively -- it is a handful of words -- and the history vocabulary is capped at 200 keywords,
   because the search is (keywords x units) plans executed over every row of the whole corpus and six
   hundred keywords against a few hundred units is a quarter of a million executions per question,
   which is a timeout rather than a measurement. The cap is printed with the reading, so a bounded
   search is never read as an exhaustive one. The criterion is on the question vocabulary, so the cap
   cannot move the decision.
5. **Not a seventh attempt at the period bound.** `PREREG-CLOCK-AXIS.md` and §197 spent that axis
   (`verbatim-scope` −4, `verbatim-clock` zero). Two of the twelve are window errors and this
   measurement does not re-open them; it prices a mechanism that would have to reach them by a route
   the axis never tried, which is why the reading is per question rather than aggregate.

## 5. Cost, and what is spent if the answer is no

| item | cost |
| --- | --- |
| corpus download, install, build, search over two vocabularies, 12 questions | runner minutes, **¥0** |
| the dispatch, if C1 and C2 pass | 500 questions × 2 repetitions, one field, ≈**¥5.9** |
| the dispatch, if they do not | **¥0**, and the direction is closed in writing |

## 6. Where the numbers live

- Population and its arithmetic: `tools/spec-ceiling-population.json`, cross-checked against
  `docs/AUDIT-NUMERIC-MEMBERSHIP.md` by
  `packages/cortex-memory/src/__tests__/measure-spec-ceiling.test.ts`, so a later edit to either has
  to move a test rather than pass beside it.
- Instrument: `packages/cortex-memory/src/aggregation/ceiling.ts` (the search) and
  `packages/cortex-memory/bench/measure-spec-ceiling.ts` (the command line), script
  `measure:spec-ceiling`, dispatched by `.github/workflows/measure-spec-ceiling.yml`. The split is
  not cosmetic: `bench/` is outside the coverage boundary and outside the caller census, so
  arithmetic living there is measured by nothing and reported as a new orphan (`AUDIT-WORKFLOW-WIRING.md` 4).
- Floor: `docs/AUDIT-QUEUE-FLOOR.md` 1, computed by `tools/queue-floor.mjs`.
- Result: written into this file as §7 once the run exists, with the per-question plan beside the
  per-question gold.

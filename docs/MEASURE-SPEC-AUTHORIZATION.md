# The arithmetic of a veto, recorded before the veto exists

**Read from:** `42930900136` and `42533236864` (the `spec` and control arms the relation is stated over),
`MEASURE-PLAN-SHAPE.md` §1 (why the plan's shape does not separate the two populations), and
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.365, which registers the veto and its four bars.

**Cost:** zero. This increment adds no model call; it records four integers the pass already computes and was
dropping.

## 0. One paragraph

§13.365 registers the next `MR` mechanism: **do not trust the plan, authorize the substitution.** Keep the plan's
value only if the first answer's own numeral appears among the rows the plan selected; otherwise keep the first
answer and count the refusal. That registrations' premises had one hole — the relation had never been persisted,
so nobody could say whether it had a population — and the campaign has already paid for exactly this hole once, in
this pass, when `support` was computed on every call and dropped at `memory.ts`. So the arithmetic lands first,
with **no behaviour change**: `selected`, `ledgerRows`, `supportHits`, `authorized` are recorded per question and
per run, and nothing acts on them. What that buys is the reading the arm's own gate `V3` needs — *would the veto
have authorized the three known repairs* — off a run that was going to happen anyway, and the answer to whether
the predicate separates the two populations **before** the dispatch that depends on it is paid for.

## 1. What is recorded, and where

| field | unit | why it is not the verdict |
| --- | --- | --- |
| `evaluated` | substitutions the pass offered | a refused plan is outside this population, so `evaluated + refused = attempted` stays true |
| `authorized` | verdicts that would keep the plan's value | a rate over `evaluated`; `0` with `evaluated > 0` is a predicate with no population |
| `selected` | rows the plan selected, summed | the denominator of a hit rate — two rows and two hundred are different readings |
| `supportHits` | selected rows carrying one of the answer's numerals | the numerator, and `supportHits <= selected` is checkable |
| `ledgerRows` | rows the plan ran over, summed | bounds `selected`; a plan that kept the whole ledger is a different claim |
| `tokens` | distinct numerals the answer offered | `tokens: 0` is the case where the veto **cannot run** |

Per question the artifact carries the first four as counts — `specEvaluations`, `specAuthorizations`,
`specSelected`, `specSupportHits` — and the run-level block carries all six. Four columns and not a boolean for
the reason §13.262 records about the audit's own pair: a question is answered `runs` times, and a boolean column
disagrees with its own tally by exactly the repetition count.

Per question, `ledgerRows` and `tokens` are omitted on purpose. They are denominators for a rate over the run, and
a per-question copy would be two more columns whose sum nobody reads.

## 2. The two asymmetries, which are decisions rather than consequences

- **A first answer with no numeral is never authorized.** `Friday`, `seven`, `in a shoe rack in my closet` are
  real answers in this set, and a numeric aggregate substituted for one of them cannot be authorized by comparing
  numbers. Authorizing by default when the check cannot run would make the veto silent exactly where it is least
  understood. The recorded shape of that state is `tokens: 0, supportHits: 0, authorized: 0`.
- **A hit counts rows, not occurrences.** A row that says `1998` twice is one supporting row: the question is
  whether the answer's quantity is among the rows the plan kept, not how often it appears.

## 3. The bound that makes `V2` predictable before the run

> **The veto cannot damage a substitution that did not change the answer.**

If the plan's value equals the first answer, refusing the substitution leaves the same answer, so the veto's
damage is bounded by the substitutions that actually differ. That is not an argument — it is an identity, and it
is pinned by a test (`records nothing where the value it would refuse is the answer it was given`): the question
where the plan counted two rows and the reader had already said `2` records `changed: 0` beside
`authorized: 0`.

The consequence for `V2` (`damage ≤ 3`) is that a damage needs **both** a changed substitution and a wrong
authorization. The first is a fact the artifact already records; only the second is what the arm measures.

## 4. What the fold refuses

Three ways a recorded arithmetic lies, each closed by a refusal rather than a comment:

- **A partial sum.** One instance reports the block and another does not, and the run-level total would state a
  veto measured over part of the run. The block is dropped, because a number that is a fraction of the run reads
  exactly like a measurement — `41773546221` published worker 0's quarter of a census and nothing about it looked
  wrong.
- **A violated identity.** `supportHits ≤ selected ≤ ledgerRows` holds inside one instance by construction, so a
  total that breaks it can only be a defect in the fold. The block is dropped rather than published.
- **A violated census.** `evaluated + refused = attempted` is the same identity `specified = attempted - refused`
  already gives the pass, checked on the sum. The block is dropped.

Each of those is a test, and each test fails on the version that publishes the number anyway.

## 5. What this does not do

- **It does not change any answer.** No branch reads `authorized`. The `spec` arm's accuracy is unchanged by this
  increment, which is why it can land without a dispatch.
- **It is not a correctness check.** A `sum` that selected the wrong two rows out of three and happens to include
  one carrying the answer's numeral is authorized, and the arithmetic can still be wrong. This is the cheapest
  relation that is genuinely a relation between the two answers; it is not a check on the plan.
- **It does not price the veto.** `V1`–`V4` need an arm with the veto switched on, and that arm needs an option in
  the dispatch table, which is the next increment. What is available now is the pre-arm reading: a `spec` run of
  any size will report the authorization table, and the block will say whether the predicate has a population at
  all before anything is spent on it.

## 6. Where it shows up

| surface | field |
| --- | --- |
| artifact, per question | `questions[].specEvaluations`, `specAuthorizations`, `specSelected`, `specSupportHits` |
| artifact, run level | `audit.authorization.{evaluated, authorized, selected, supportHits, ledgerRows, tokens}` |
| report markdown | `## Authorization (reviewPass: spec, §13.365)`, with the identity printed beside the numbers |

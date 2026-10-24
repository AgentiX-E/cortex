# PREREG-DATE-FRAME

A pre-registration, written before the code, for telling the reader what day it is.

## What the reader is told today

Nothing. `prompt.ts` carries no statement of the conversation's date, and a turn's `[2023/05/27]`
prefix is the only temporal information in the prompt. So a question asking what happened "last month"
requires the reader to pick a reference date out of a two-hundred-turn window and do the arithmetic
itself.

That is a deterministic computation delegated to a language model, which is the same defect
`timeWindow` annotation fixed in step 9 for a different question ("how far is this turn from the
window"), and the same defect the routing layer exists to avoid elsewhere.

## Why this is the next experiment and not the next hypothesis

Two independent reasons.

**Ours.** On the adopted configuration, temporal-reasoning questions that contain a relative time
expression answer **66%** (33/50) against **81%** (62/77) for those that do not, and the split is
identical or near-identical across three archived runs (−15, −15, −17 points) on the same fifty
questions. One test gives z≈1.84, p≈0.066 -- **not significant**, and three same-direction runs are
weak evidence (sign test p=0.125). So it is a target, not a finding.

The same split on multi-session did *not* replicate (61%, 70%, 48% against 73%, 73%, 68%), and the
19.7-point gap published in step 23 came from the worst of three runs. That retraction is recorded in
`cortex-docs` 04 §9.28 and it is the reason this document demands a repeat before a conclusion.

**Theirs.** A published memory system reports the same mechanism measured on the same benchmark: a
date frame -- the current date in the message, and each content block's own date -- moved
LongMemEval-S from **80.7% to 90.0%** (+9.3 points, 95% CI [+4.0, +15.3]) and LoCoMo from 76.7% to
89.1%, with retrieval unchanged and p95 latency unchanged. Their reading is on a development sample,
so the interval is wide, but it is a direction measured by someone else on the benchmark this project
is scored on, and it is the largest published effect available at zero inference cost.

Two independent signals pointing at one mechanism, one of them external, is the bar this project has
used for every adopted change.

## The design

1. **Anchor.** The maximum parseable date among the turns the prompt carries. Deterministic, no model
   call, computed in the same renderer that already walks every turn.
2. **One line.** `The conversation runs to <YYYY-MM-DD>; resolve any relative time in the question
   against that date.` Placed beside the existing session note, not inside the question.
3. **Nothing when there is nothing.** If no turn carries a parseable date, the line is absent and the
   prompt is **byte-identical** to the control's. A test pins that, because an injected line that
   silently appears on a dateless window would make every comparison unreadable.
4. **Reach: temporal and multi-session.** These are the two routes whose questions ask about time.
   The other four are untouched by construction, so their prompts and answers must be identical -- an
   internal control this project already uses (`maxTurnCharsRoutes`, `evidenceRolesRoutes`).
5. **No arithmetic.** The line states the anchor. It does not pre-compute "last month = April 2023",
   because a wrong derivation would be worse than none and the reader can do one subtraction from a
   date it now has.

## Pre-registration

| id | criterion | control |
| --- | --- | --- |
| P1 | temporal questions containing a relative expression: **≥ +8 points** | 33/50 (66%) |
| P2 | temporal overall: **not down by more than 2** | 95/127 (75%) |
| P3 | multi-session: **not down by more than 2** | 84–87/121 |
| P4 | `IE`, `KU`, `ABS`: **identical** | 134/150, 63/64/72, 30/30 |
| P5 | dateless windows: prompt byte-identical | test, not a run |

**P1 at +8 rather than +9.3**: the published interval is [+4.0, +15.3] on a development sample, so the
lower bound of what would be worth adopting is around 4 and the midpoint is around 9. Setting the bar
at 8 says the change must land near the published point estimate, not merely inside its interval.

**Revert if P1 fails, or if P2/P3 fall by more than 2, or if P4 moves at all.** P4 moving would mean
the line reached a route it was not aimed at, which would make the run a two-variable change.

**One repeat before any conclusion.** Step 23 published a 19.7-point gap that did not survive a second
run. A single run of this experiment will be reported as a direction; adoption requires the same
result twice, as the distillation reading did (33.5% ± 1.4pp over four runs).

## What this does not address

- **The seventeen retrieval-type multi-session failures.** Their gold turn is not in the pool at all,
  so no prompt change reaches them. The published direction there is a sufficiency check with up to
  three follow-up queries (arXiv 2610.22668), which costs model calls and is the experiment after
  this one.
- **The reader-side count errors.** Twenty multi-session failures carry every gold turn and still
  answer wrong; `numeric -1` is the largest single shape. A date frame does nothing for arithmetic.

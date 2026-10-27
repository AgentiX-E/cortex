# The session-unit experiment already ran, and it lost by 28 questions

## 0. One paragraph

`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.105 registered six predictions for `relevanceUnits: session`
and named run `39509698041` as the control. **That experiment ran on 2026-10-22 as `39699987781`, and
its result has never been written down.** MR read **62.81%**, against a registered floor of **≥ 91** —
a refutation of 28 questions. The document still describes the dispatch as pending, which is how this
round came to plan a re-run of an experiment whose answer was already on disk. This file records the
result, checks the other five predictions, and corrects a cross-arm figure in §13.105.1 that this
repository has now made twice.

## 1. Three runs of the same configuration, one variable apart

| run | units | reviewPass | ask | overall | IE | **MR** | KU | TR | ABS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `39509698041` (control) | `turn` | `none` | `enumerated` | **81.80%** | 89.33 | **71.90** | 87.50 | 74.80 | 100 |
| `39699987781` (treatment) | **`session`** | `none` | `enumerated` | **78.40%** | 89.33 | **62.81** | 84.72 | 72.44 | 96.67 |
| `40088479628` (latest) | `turn` | `recover` | `enumerated` | 80.80% | 89.33 | 69.42 | 86.11 | 74.02 | 100 |

Everything except `relevanceUnits` is byte-identical between the first two: same `relevanceTopK=256`,
same `maxPromptChars=48000`, same `maxTurnChars=400` on two routes, same `retrieval-hybrid`, same
`evidenceRoles=user` on two routes, same ask, same contract, same reader, same judge.

## 2. The six predictions, judged

| # | registered prediction | measured | verdict |
| --- | --- | --- | --- |
| 1 | the config reads `relevanceUnits=session` | it does | **met** |
| 2 | the four untouched capabilities reproduce `39509698041` **to the character** | IE identical; **KU −2, TR −3, ABS −1 questions** (84.72 / 72.44 / 96.67) | **not met** |
| 3 | MR mean **≥ 91** | **62.81** | **falsified, by 28 questions** |
| 4 | MR abstentions **≤ 10** | not separable from this artifact: `abstentionReasons` is `{"empty":0,"threshold":0,"llm":294,"answered":1706}`, aggregated over four repetitions and **not broken down by capability** | **unmeasurable as recorded** |
| 5 | under-counts fall from 15 to ≤ 10 (`--arithmetic`) | the readout was never run on this artifact | **untested** |
| 6 | MR `promptChars` within 46,186 ± 1,000 | the artifact does not carry per-route `promptChars` | **unmeasurable as recorded** |

**Prediction 2 is the one worth reading twice.** Its whole purpose was to make the treatment
single-variable: a route-scoped switch cannot move three capabilities it does not reach. Two of the
three moved in the direction of *loss*, and their total is 6 questions — inside the noise floor this
repository measured for those columns (`MEASURE-READING-STAGE.md` §1.1: a 127-question column can
swing 10 questions with the prompt held identical).

So the honest reading is not "the switch leaked". It is that **"reproduces to the character" is not a
prediction this instrument can satisfy at `runs=1`**, and registering it as a pass/fail gate creates a
failure that carries no information. A prediction has to be sized to the instrument's noise, which is
exactly what prediction 3 did not do either — but there, the effect was 28 questions, an order of
magnitude past anything sampling can produce.

## 3. A cross-arm figure in §13.105.1, and it is the third instance

§13.105.1's "what has changed since the unit lost" table lists:

| | when the unit lost | now |
| --- | --- | --- |
| MR | 51% | **86–87%** |

**No `cortex-memory` run has ever measured MR at 86–87%.** The five runs with this configuration read
71.90, 67.77, 62.81, 69.42 and (with `ask=route`) 0.00. The figure is the **`reference-pipeline`**'s
MR in the same runs — 88.43 in `39509698041`, 84.30 in the two October runs — and in `benchmark.yml`
the `nl-abstain-feature` arm reads 86.78.

So the "now" column describes the **baseline**, in a table whose purpose was to argue the treatment had
become viable because *the arm* had improved. It had not. The consequence is concrete: this round's
plan said "MR is the one capability where a known-better answer exists inside this repository", which is
true, and then cited 14.9 points of gap against a baseline that is genuinely at 84–88 — also true — but
§13.105 had been read as evidence that the arm itself was near that level, which was never measured.

Three times now the same shape: `MEASURE-BASELINE-DRIFT.md` §8 (a number from another system),
`MEASURE-READING-STAGE.md` §4 (a score attributed to the wrong composition), and this. The countermeasure
from §8.5 applies unchanged — **the arm name has to be inside the number** — and this table is a place
where it is not.

## 4. What the result actually says about MR

The gap is real and it is large:

| | `cortex-memory` | `reference-pipeline`, same run |
| --- | --- | --- |
| `39509698041` | 71.90% (87/121) | **88.43%** (107/121) |
| `39699987781` | 62.81% (76/121) | **84.30%** (102/121) |
| `40088479628` | 69.42% (84/121) | **84.30%** (102/121) |

15 to 25 questions, on paired data, in every run. And the treatment that was registered to close it
**widened** it — completing whole sessions cost 11 questions relative to the turn unit at the same ask.

That is a substantive negative result about the mechanism §13.105 bet on: *"a turn unit scatters a
session across the window; a session unit completes it."* At 48,000 characters, a 256-wide pool and
`enumerated`, completing the session was cheaper than the turns it displaced. §13.105.4 pre-committed to
exactly this reading — *"if a completed session at 48,000 characters and a 256-wide pool does not move
MR, then the unit of retrieval is not the lever at any configuration this arm can express"* — so the
unit of retrieval is closed as a lever, by its own registered criterion.

## 5. What that leaves, and why the next candidate is structural rather than a flag

`reference-pipeline` reaches 84–88% on MR **with a smaller window**. It does so by retrieving
**sessions** — `retrieveTopKSessions` — where a session is scored as a unit, not assembled from
individually-ranked turns. `cortex-memory`'s `relevanceUnits: session` is not that: it ranks **turns**,
then takes the largest prefix of whole sessions that fits. Two different operations share a name:

| | what is scored | what the budget buys |
| --- | --- | --- |
| `reference-pipeline` | a **session** (its concatenated text, one embedding) | the top-k sessions, each truncated |
| `cortex-memory` `relevanceUnits=session` | a **turn** (the session's best-scoring turn decides its rank) | whole sessions in that induced order |

The first is what the negative result leaves standing, and it is the one thing `cortex-memory` cannot
express today: the arm has no session-level embedding channel, because `memory.ts` receives `context`
as a flat string list and builds its index over turns.

**That is a design change, not a dispatch**, so it is registered here rather than run: a session-grained
relevance channel on the multi-session route, scoring a session's concatenated user turns as one unit,
with the per-session truncation the reference pipeline already applies. `PREREGISTRATION` §13.105.4's
closing sentence anticipated this — *"the remaining difference from the reference pipeline is either its
per-session truncation or the reader itself"* — and the experiment above has now removed the third
possibility (the unit of the budget) from that list.

**Prerequisite before it is worth building**: the honest MR baseline is 69.42 at `turn` + `recover` and
71.90 at `turn` + `none`. Any new channel has to be measured against the same ask, contract and
`reviewPass` as its control, and the noise floor for a 121-question column is ~2 questions
(`§13.100.2`), so the bar is MR ≥ 80/121 to be worth a second run.

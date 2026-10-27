# Pre-registration: scoring a session as one unit, on the route that needs it

**Registered 2026-10-27, before the implementation it describes.**
Reads with `MEASURE-MR-UNITS.md` (the negative result this is built on) and
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.105 (the registration it supersedes).

## 1. The gap this is for

| run | `cortex-memory` MR | `reference-pipeline` MR, same run |
| --- | --- | --- |
| `39509698041` | 71.90% (87/121) | **88.43%** (107/121) |
| `39699987781` | 62.81% (76/121) | **84.30%** (102/121) |
| `40088479628` | 69.42% (84/121) | **84.30%** (102/121) |

15 to 25 questions, paired, in every run. It is the only capability where a better answer exists
**inside this repository under the same reader, judge and corpus**.

Two things are already excluded by measurement: the **unit of the budget** (completing whole sessions
in turn-induced order lost 11 questions, `MEASURE-MR-UNITS.md` §2) and the **corpus, the cache and
throttling** (`MEASURE-BASELINE-DRIFT.md` §8.8, run `40408635007`).

## 2. What the reference pipeline does that this arm cannot

| | what is scored | what the budget buys |
| --- | --- | --- |
| `reference-pipeline` | a **session** — its concatenated text, **one embedding** | the top-k sessions, each truncated |
| `cortex-memory`, `relevanceUnits=session` | a **turn** — the session's best-scoring turn decides its rank | whole sessions in that induced order |

The negative result in `MEASURE-MR-UNITS.md` closed the **second** row. It says nothing about the first,
which this arm cannot express: `relevanceFor(question, turn)` is scored per turn, and `memory.ts` builds
its index over `context`, a flat turn list with the boundaries already flattened away.

## 3. The mechanism, and why it needs no new interface for the *budget*

**Score a session once, then project that score onto every turn it contains.**

`relevanceFor(q, turn)` already returns a number per turn, and `relevanceUnits: session` already ranks
sessions by their best-scoring turn. If every turn of a session carries the **session's** score, then
"best-scoring turn" **is** the session score, and the existing budget code becomes session ranking
without being touched.

So the change is confined to the index:

1. **`RelevanceCase` gains `sessions?: readonly (readonly string[])[]`** — the boundaries, index-aligned
   with `context` (whose values are exactly `sessions.flat()`; asserted, not assumed). The loader already
   produces both (`Question.sessions` and `Question.context`), so no data is invented.
2. **A new `relevanceSignal` value, `retrieval-session`**, built by a new module
   `session-relevance.ts`: embed each session's joined user turns **once**, embed the question (plus any
   expanded queries) once, and score by cosine.
3. `relevanceFor(question, turn)` looks the turn's text up in a `Map<turnText, sessionScore>` built at
   construction and returns the session score.

**One variable, or two?** The signal changes and `relevanceUnits` changes with it, because a
session-constant score on `turn` units degenerates to arrival order — the two are a mechanism and its
required setting, not two treatments. The width is therefore carried at the **control's** value
(`relevanceTopK=256`) rather than at this module's default of 32: in session units 256 exceeds the
pool (~50 sessions per question), so the width is inert on both arms instead of narrowing one of them.
That is stated here rather than left to the dispatch, because "256" in two artifacts that count
different things is exactly the kind of coincidence this repository keeps finding afterwards.

**Why not a new option on the memory arm**: the arm does not embed. Every signal in this repository is
built outside it and injected as a callback, and `relevance-index.ts` states why — the index must be a
function of what it was handed, so two runs holding the same cases score identically. A signal that
embedded inside `memory.ts` would put a network call behind a synchronous callback.

**Why the projection is safe here and not a coincidence**: MR is the only capability whose questions
need evidence assembled **across** turns of one session (`MEASURE-FAILURE-CENSUS.md` §3: 15 of 70
failures, and the third-largest population). A score that is constant within a session is exactly wrong
for IE/KU — which is why the signal is route-scoped to `multi-session` and every other route keeps the
existing turn-scored index, byte-identical.

## 4. Cost, which goes down

| | sessions embedded | turns embedded |
| --- | --- | --- |
| `retrieval-hybrid` (current) | 0 | ~19,000 live per run after de-duplication (`40408635007`: `liveTexts 19,251`) |
| `retrieval-session` (this) | one per session, so roughly one per ten turns at LongMemEval-S's session length — **an order of magnitude fewer** | 0 for the index |

The session channel **replaces** the turn index rather than adding to it, and each session's text is
longer than a turn's, so the token bill does not fall by the same factor. The claim here is only
directional: the run stays cheap enough to repeat, which is what a second dispatch would need.

## 5. Predictions, registered before the implementation

Control: **`40088479628`** (`turn`, `recover`, `enumerated`, 48,000, k=256, `user`-only on two routes,
cap 400). MR 69.42% (84/121).

| # | prediction | falsified if |
| --- | --- | --- |
| **P1** | mechanism: the artifact reads `relevanceSignal=retrieval-session`, and the scored-unit count is **well below** the turn index's | any other value, or a count at or above the turn index's |
| **P2** | **MR ≥ 96/121 = 79.34%**, from the control's **84/121 = 69.42%** — a gain of 12 questions, six times the 2-question noise floor measured for a 121-question column | MR ≤ 90 |
| **P3** | MR abstentions do not rise: the decline count stays ≤ the control's | any increase |
| **P4** | IE, KU, TR, ABS each move ≤ 3 questions. The signal is route-scoped to `multi-session`, so a larger move means the reach is not what this registration says | any moves further |
| **P5** | `promptChars` on the multi-session route stays within ±20% of the control's. The budget's *ceiling* is unchanged (48,000) but its *fill* can move, because a different ordering admits different turns before the room runs out | outside that band |

**P2 is the claim, and it is a floor rather than a target.** The reference pipeline reaches 102/121 on
this operation, so a session-scored index has 18 questions of room before it has to explain the rest by
the reader, the truncation and the prompt — which is where §13.105.4 said the remainder would be if the
unit was not the lever. Predicting 96 rather than 102 is deliberate: the transplant is of one mechanism,
not of the whole pipeline, and `reviewPass=recover` is on in the control but not in the reference arm.

An earlier draft of this line said `≥ 80/121`, which is **below the control's 84** — a floor under the
baseline. Caught before the implementation, and left here as the record of it, because a target that a
no-op would satisfy is the kind of error that reads as a result.

## 6. TDD order, and what must be red first

1. `session-relevance.test.ts`, written against a module that does not exist:
   - a session's turns all receive the **identical** score (the projection property);
   - two sessions with different texts receive different scores;
   - `sessions` absent → the builder **refuses** rather than falling back to the turn index
     (a silent fallback would make the arm look like `retrieval-hybrid` in an artifact that says otherwise);
   - `sessions.flat()` disagreeing with `context` → refuses. The two come from one loader and can only
     disagree if a caller hand-built a case, and a misaligned case would attribute a score to the wrong
     session;
   - duplicate turn **text** across two sessions: the first occurrence wins, and the test states that as
     the chosen behaviour rather than leaving it to `Map` insertion order by accident;
   - an empty session contributes no scored turn and does not throw.
2. `relevance-signal` parsing: `retrieval-session` accepted, an unknown value still **rejected**
   (`bench-arm-options.ts` already has that rule and the test for it).
3. Then the implementation, then the arm wiring, then the dispatch.

**Coverage**: every new line in `session-relevance.ts` is inside the coverage boundary (it is `src/`, not
`bench/`), and the four dimensions must stay at their current levels — core 99.22/98.03/100/99.22,
eval 99.62/99.40/99.78/99.62, memory 100/100/100/100.

## 7. Stop rule

One dispatch against `40088479628`. If P2 fails, the **session-as-a-unit** hypothesis is closed the same
way §13.105 closed the unit of the budget, and MR's remaining candidate is the per-session truncation the
reference pipeline applies (`maxSessionChars`), which is a presentation change rather than a retrieval
one. A second dispatch happens only if P2 is met.

## 8. What this does not claim

It does not claim the reference pipeline is better run by run — it is, on MR, by 15 to 25 questions,
but its IE and KU are 0.67% and 0.00% because a 15-turn retrieval cannot serve a short-phrase question
(`MEASURE-BASELINE-DRIFT.md` §8.8). **This is a transplant of one mechanism, not a switch of system**,
and the four untouched capabilities are the internal control that says so.

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

| | **items** embedded | **characters** embedded |
| --- | --- | --- |
| `retrieval-hybrid` (current) | ~19,000 live texts after de-duplication (`40408635007`: `liveTexts 19,251`) | ~5.2 M — a delivered turn has a median of 272 characters |
| `retrieval-session` (this) | ~25,000 — one per session, and each question carries its own haystack of roughly fifty | **~136 M — about 26× more** |

**The first draft of this table said "an order of magnitude fewer", and it was wrong in the direction
that matters.** It counted *items*: `retrieval-hybrid` embeds 19,000 turns while the session channel
embeds one document per session. But a session's joined user turns are ~20 turns × 272 characters
≈ 5,400 characters, so trading one embedding per turn for one per session trades 19,000 short inputs
for 25,000 long ones. **Fewer units, far more tokens.**

That is not a reason to reject the experiment — the mechanism is what is being tested, and the run is
one dispatch either way — but it is a reason to say the cost honestly, and to expect the workflow to
take **substantially longer** than a turn-scored A/B. Recorded because a cost table that is wrong by
26× in the optimistic direction is the kind of line a later round would quote as fact.

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

## 6. Result: the mechanism ran, the prediction failed, and it failed cleanly

Run **`40498191604`**, 500 questions. The log's own config line confirms the treatment was administered exactly
as registered:

```
cortex-memory gate: … relevanceSignal=retrieval-session, relevanceTopK=256, relevanceUnits=session,
maxTurnChars=400, maxPromptChars=48000, reviewPass=recover, evidenceRoles=user
```

| | registered | measured | verdict |
| --- | --- | --- | --- |
| **P1** mechanism | artifact reads `relevanceSignal=retrieval-session` and scores fewer units than the turn index | confirmed by the gate line above | **met** |
| **P2** the claim | **MR ≥ 96/121 = 79.34%** | **83/121 = 68.60%** | **refuted, by 13 questions** |
| **P3** MR abstention does not rise | — | run-wide abstention **13.00% (65)** against the control's 75 | **met** |
| **P4** IE/KU/TR/ABS each move ≤ 3 | — | IE −2, KU **+3**, TR **+7**, ABS **−2** | **refuted by TR** |
| **P5** `promptChars` within ±20% | — | not reported per question in this artifact | **unmeasured** |

### 6.1 What the run produced, per capability

| capability | baseline in the same run | feature | discordant (b/f) |
| --- | --- | --- | --- |
| IE | 0.67% | **88.00%** (132/150) | 0 / 131 |
| MR | **85.12%** (103/121) | **68.60% (83/121)** | 29 / 9 |
| KU | 1.39% | **90.28%** (65/72) | 0 / 64 |
| TR | 67.72% | **79.53%** (101/127) | 11 / 26 |
| ABS | 100.00% | **93.33%** (28/30) | 2 / 0 |
| **overall** | 44.20% | **81.80% (409/500)** | 42 / 230 |

Against the turn-scored control `40088479628`: IE −2, KU **+3**, MR **−1**, TR **+7**, ABS **−2**, overall
**+5**.

### 6.2 The claim is refuted, and that is the useful part

**MR moved one question in the wrong direction.** The registered floor was 96/121; it read 83. The reference
pipeline, in the same invocation, read **103/121** — so the 20-question gap this treatment was built to close
is untouched.

Read together with `MEASURE-SOTA-FAILURES.md` §1.1, this closes the retrieval side of the MR question with two
independent lines of evidence:

1. **The gold turn reaches the rendered prompt for 500 of 500 questions.** There is nothing for a better ranking
   to find.
2. **The one operation the reference pipeline performs and this arm could not — scoring a session as one unit —
   moved MR by −1.** The mechanism was administered, the code path existed, and it made no difference.

So MR is not a retrieval-unit problem, not a recall problem, and not a budget-allocation problem of this kind.
It is the reader: 27 of its 37 misses answered and were wrong (12 of them exactly one low, with cross-session
merging in 41.7% of that group against 4.8% of correct answers, Fisher p = 0.0012).

**That is worth more than a null result usually is**, because it retires an entire family of candidates. Every
retrieval-side change that could be proposed for MR is now competing against two measurements that say there is
nothing there to win.

### 6.3 The rest of the table is a signal, not a finding

`TR +7` and `overall +5` are the largest movements this arm has produced. They are also **inside noise**: a
127-question column swings about 10 questions when the prompt is unchanged (`MEASURE-READING-STAGE.md` §1.1),
and the arm's four genuine repeats span 15 questions on the total.

Three reasons not to adopt it, stated so a later round does not read the +5 as one:

1. **The treatment's own prediction failed**, so the movement is somewhere the registration did not look. An
   effect in an unregistered place is a hypothesis, not a result.
2. **`ABS` fell from 30/30 to 28/30** — the first time this arm has ever lost a false-premise question. Any
   change that costs the one capability which was perfect needs its own explanation before it is kept.
3. **n = 1.** The registration said a repeat is required before adoption, and the previous round published a
   19.7-point gap that did not survive one.

What it *does* earn is a registered repeat with a paired criterion: if `TR` is genuinely +7 and `MR` genuinely
−1, a second run should reproduce the same discordant set — 26 wins and 11 losses on TR. That is the next
dispatch, not a conclusion.

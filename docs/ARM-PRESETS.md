# ARM-PRESETS

The exact dispatch inputs for each arm this project compares against, because **the workflow's defaults are
not the archived arm**.

## 0. Why this file exists

Run `40614779756` was dispatched with one input — `cortex_memory_review_pass=bare` — on the reasonable
assumption that everything else would default to what the control run used. It did not. The workflow's
defaults produced a different arm:

| field                    | control `39509698041`             | what the defaults gave                                             |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------ |
| questions                | 500                               | **60** (`limit` defaults to 60, and `limit` is the question count) |
| `promptContract`         | `abstention-evidence-blocks`      | `abstention`                                                       |
| `ask`                    | `enumerated`                      | `route`                                                            |
| `relevanceSignal`        | `retrieval-hybrid`                | `none`                                                             |
| `relevanceTopK`          | 256                               | default                                                            |
| `maxTurnChars` / routes  | 400 / `multi-session+temporal`    | `none` / `all`                                                     |
| `maxPromptChars`         | 48000                             | default                                                            |
| `evidenceRoles` / routes | `user` / `multi-session+temporal` | `all` / `all`                                                      |

The run completed and reported 75.00% on 60 questions with `bareRetry 41/41`. Every one of those numbers is
about a system nobody has measured before, and none of them can be compared with the control. The census did
its job — it is the reason the mechanism question is now answered rather than open — but the accuracy column
is not a result.

The lesson is narrow and mechanical: **an arm is a set of fifteen inputs, not a name.** A dispatch that names
one is a dispatch that changed fourteen by accident.

## 1. The control arm (`39509698041`, `reviewPass: none`, 500 questions, 80.80%)

This is the arm every S1–S5 number is measured against.

```json
{
  "limit": "0",
  "cortex_memory_prompt_contract": "abstention-evidence-blocks",
  "cortex_memory_ask": "enumerated",
  "cortex_memory_relevance": "retrieval-hybrid",
  "cortex_memory_relevance_top_k": "256",
  "cortex_memory_relevance_units": "turn",
  "cortex_memory_max_turn_chars": "400",
  "cortex_memory_max_turn_chars_routes": "multi-session,temporal",
  "cortex_memory_max_prompt_chars": "48000",
  "cortex_memory_evidence_roles": "user",
  "cortex_memory_evidence_roles_routes": "multi-session,temporal",
  "cortex_memory_budget_minutes": "90",
  "cortex_memory_review_pass": "none"
}
```

`cortex_memory_review_pass` is listed here **only in §2's aftermath**: the field's default is now `bare`, so this
block without that line reproduces the *treatment* and not `39509698041`. A preset file that documents an arm but
omits a field whose default moved is a preset file that has silently become a different arm — the same defect as
§0, arriving through a default rather than through an omission.

Fields **not** listed keep their defaults and those defaults are the control's: `threshold=0`,
`retrievalThreshold=0`, `sessionBudget` empty, `sourceTrust=0.5`, `confidenceSignal=none`,
`reviewPass` empty, `queryExpansion` empty, `selfConsistency` empty.

## 2. The bare-retry arm — now the recommended shipped configuration

The control's inputs, plus one line. **Nothing else changes** — that is what makes it single-variable.

```json
{
  "cortex_memory_review_pass": "bare"
}
```

Merged with §1. Four runs against two controls: **417 / 415 / 416 / 421 against 404 / 399**, no category
lower, `ABS` 29/30 in all six, and the two ranges do not overlap. That is +3.15 points at the means, so this
is the configuration the project recommends and the one the `S1` evidence now records.

**It is now the dispatch default.** `benchmark-cortex-memory.yml` declares `default: 'bare'` for this input,
so a dispatch that omits the field ships the treatment, and a run that wants the control must say `none`.
`test_review_pass_wiring.py` asserts both halves and says why: a default equal to the treatment turns every
later "control" run into a second treatment unless the run names its own value, and that failure is silent —
the artifact would carry a config line nobody re-read.

**The library default is still `none`, and that asymmetry is deliberate.** `readReviewPass` returns `none`
for an unset variable, which is the smallest assumption a library can make; the dispatch layer is where a
project decides what it ships. Moving the library default would also move eighteen assertions in the arm's
tests, which is a change that deserves its own review rather than a line edited during an analysis round.

The check after dispatch is not "did it run" but "does the config line differ from the control in exactly one
field":

```
cortex-memory gate: threshold=0, retrievalThreshold=0, sessionBudget=unbounded, sourceTrust=0.5,
confidenceSignal=none, ask=enumerated, relevanceSignal=retrieval-hybrid, relevanceTopK=256,
relevanceUnits=turn, maxTurnChars=400, maxPromptChars=48000
```

and the arm-config line carrying `reviewPass=bare` where the control carries `reviewPass=none`.

## 3. The retrieval-signal arms (S-1 … S-5, registered)

S-1 through S-5 change **one** field each when they exist: `cortex_memory_relevance` gains a value, or a new
weight input is added at a non-zero value while everything else holds. Until then they are registered and
unbuilt, and this section says so rather than describing a dispatch that has no field to set.

| arm            | input                                                   | state                                                                   |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| S-1 temporal   | `cortex_memory_relevance=retrieval-temporal` (proposed) | module built, arm wiring **not** done — see `ACCEPTANCE-MATRIX.md` §4.1 |
| S-2 activation | weight input, not yet named                             | registered, unbuilt                                                     |
| S-3 graph      | as above                                                | registered, unbuilt                                                     |
| S-4 importance | as above                                                | registered, unbuilt                                                     |
| S-5 rerank     | `cortex_memory_rerank=cross-encoder` (proposed)         | registered, unbuilt                                                     |

## 3.5 The ask arms (`silent`, `answer-line`, `recommend`, `derive`) — the one input §1 already names

The two ask experiments are single-variable against §1, but the field they change is **already in the preset**,
which makes merging the two blocks a replace rather than an addition. Written down because "merge with §1" is
exactly the instruction that produced the 60-question run.

`silent` (§13.123.4, MR) — **refuted, kept as the ablation reference**: §1 with its `ask` line replaced.
Run `40792853362` measured MR 87 → 61 against the enumerated control, with the loss localised to the 66 questions
whose carried turns are byte-identical (48 → 31). Do not dispatch it as a candidate; it exists so the sentence
"the written list is the state Step 2 counts from" has a measurement behind it.

```json
{
  "limit": "0",
  "cortex_memory_prompt_contract": "abstention-evidence-blocks",
  "cortex_memory_ask": "silent",
  "cortex_memory_relevance": "retrieval-hybrid",
  "cortex_memory_relevance_top_k": "256",
  "cortex_memory_relevance_units": "turn",
  "cortex_memory_max_turn_chars": "400",
  "cortex_memory_max_turn_chars_routes": "multi-session,temporal",
  "cortex_memory_max_prompt_chars": "48000",
  "cortex_memory_evidence_roles": "user",
  "cortex_memory_evidence_roles_routes": "multi-session,temporal",
  "cortex_memory_budget_minutes": "90"
}
```

`answer-line` (§13.124.4, IE) — **refuted twice over, and its reach was corrected after the fact**:
run `40807829150` moved the roster 84.20% → 71.55%, and the IE subset split by the shape of the gold says why:
117 short-gold questions moved 116 → 116 while 33 paragraph-gold questions moved 24 → 12. A reply shape is a
tax on every question whose gold is not that shape. Its reach also declared one route and fell through to the
**shipped** block on the other two, which is why MR fell 87 → 39 and TR 100 → 88; the reach is now
`enumerated`'s with `flat` the only route whose bytes change (§13.130). Do not dispatch it as a candidate.

```json
{
  "cortex_memory_ask": "answer-line"
}
```

`recommend` (§13.129.8, IE): the same block again, and the value to dispatch next.

```json
{
  "cortex_memory_ask": "recommend"
}
```

It adds a licence to compose and a ban on quoting the evidence, and **no reply shape** — the lesson the ask above
paid for. Reach `enumerated`'s, change set `{flat}`, control `40751394094`.

`derive` (§13.132.5, MR): the value to dispatch next, and the smallest change any ask in this file makes.

```json
{
  "cortex_memory_ask": "derive"
}
```

It **reorders** `enumerated`'s multi-session block and adds, drops and rewords nothing: the merging sentence —
*"the answer may require combining evidence from more than one turn or session … do not reply
`INSUFFICIENT_EVIDENCE` merely because no single piece states the answer outright"* — is moved from six lines
above the closing rule to immediately above it. That sentence is already an answer to seven of the control's
twelve MR declines; the reason it was not read is that the enumeration contract's *"do not merge two items into
one"* sat closer to the rule that decides, and one reply quotes it back as *"a separate session and cannot be
merged"*. Reach `enumerated`'s, change set `{multi-session}`, control `40751394094`.

Two checks make it a one-variable run, and both are tests:

- the two blocks must be **permutations** of one another (`derive-licence.test.ts` compares line multisets), so a
  reworded or duplicated sentence fails as a change of variable rather than passing as an edit;
- a permutation preserves length, so MR's `promptChars` must equal the control's **to the character** on all 121
  records. A treated run whose MR prompt got longer is not this ask.

**And the check is the same one.** `ask` must be the only differing field, and one line of the arm-config output
says so:

```
cortex-memory gate: threshold=0, retrievalThreshold=0, sessionBudget=unbounded, sourceTrust=0.5,
confidenceSignal=none, ask=answer-line, relevanceSignal=retrieval-hybrid, relevanceTopK=256,
relevanceUnits=turn, maxTurnChars=400, maxPromptChars=48000
```

Three things that are easy to get wrong here, each of which the reach tests already guard but a dispatcher does
not read:

- all four asks now declare `enumerated`'s reach (three routes) and differ from the control on **one**: `silent`
  and `derive` on `multi-session`, `recommend` and `answer-line` on `flat`. The untreated routes must
  reproduce the enumeration arm **question for question** — that is the assembly check, and it is read before any
  accuracy number. This bullet used to claim `answer-line` reached one route, which is the reading that produced
  `40807829150`: a reach of one route with a fallthrough of `own` is not a narrower treatment, it is a different
  experiment (§13.130).
- the two asks **cannot be dispatched together**; both are `ask` values and a run that moved both would price
  neither (§13.124.4).
- `cortex_memory_review_pass` defaults to `bare`, which is the shipped treatment, so both blocks above inherit
  it and their comparison arm is **bare** rather than the `reviewPass: none` arm §1 documents. The arm to diff
  against is therefore the most recent `enumerated` run at the same `reviewPass` and the same temperature —
  `40751394094` (`ask=enumerated, reviewPass=bare, temperature=0`, four repetitions, first repetition is the one
  its `discordantQuestions` describes). A dispatch that inherits one and compares against the other has two
  variables, and the artifact's own config line is the only place that says which happened.

## 4. The competitor run

```json
{
  "questions": "100",
  "read_questions": "0",
  "limit": "10",
  "sut": "mem0",
  "sut_infer": "0"
}
```

`limit` here is the **top-k a reader would see**, not the question count — the two workflows use the same
name for different things, which is the second trap this file exists to record. `questions` is the count in
`competitor-retrieval.yml`; `limit` is the count in `benchmark-cortex-memory.yml`.

## 5. The rule this leaves

Before reading any number from a dispatched run, compare its **config line** against the control's, field by
field, and name the fields that differ. If the answer is not "exactly the one the experiment changes", the run
is a measurement of something — just not of the thing that was registered. That comparison costs one `grep`
and it is the only defence against a run that is healthy, complete, and about the wrong system.

**And the second rule, learned after the first**: one run on each side is not a comparison. The four-run bare
arm and the two-run control give a within-arm spread of 6 and 5; a single pair gives neither, which is how a
+13 was first read as "inside a nine-question floor" and then, once repeats existed, as +3.15 points. **A floor
estimated from one run is not a floor, it is another point.**

**And the third, from §13.125.7**: a floor is not one number. The control's *count* moved 2 questions across four
repetitions at `temperature=0`, its *per-question identity* disagreed with itself on at least 7 of 500 between two
runs, and the treatment's count moved 7. Quoting "seven" without saying which of the three it is describes a
quantity that was never measured.

**And the fourth, from §13.130**: the reach and the change set are two different statements, and an artifact only
prints the first. `askRoutes` says which routes the block was composed onto; the *change set* says which routes
actually read different bytes. Three dispatches were registered as single-variable and were not, because the
fallthrough reverted the untouched routes to the shipped block instead of keeping the control's. Read
`askRoutes` **against the control's**, and if they differ, the run is not one variable apart no matter what the
registration says.

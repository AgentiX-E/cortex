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
  "cortex_memory_budget_minutes": "90"
}
```

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

## 6. The rule this leaves

Before reading any number from a dispatched run, compare its **config line** against the control's, field by
field, and name the fields that differ. If the answer is not "exactly the one the experiment changes", the run
is a measurement of something — just not of the thing that was registered. That comparison costs one `grep`
and it is the only defence against a run that is healthy, complete, and about the wrong system.

**And the second rule, learned after the first**: one run on each side is not a comparison. The four-run bare
arm and the two-run control give a within-arm spread of 6 and 5; a single pair gives neither, which is how a
+13 was first read as "inside a nine-question floor" and then, once repeats existed, as +3.15 points. **A floor
estimated from one run is not a floor, it is another point.**

# AUDIT-SCORING-RULE-AS-CONDITION

**Scope:** the comparability key of `tools/competitor-ledger.mjs`, the spread block built from
it, and the one published row that showed the key was incomplete.
**Verdict:** the key was a **five-tuple** — dataset, variant, answer model, judge, harness — and
it was missing the field that turns predictions into a number. A competitor reports 98.6 on
LongMemEval-S by running eight prompt variants per question and counting the question correct if
**any one** of the eight is. Every other row in this ledger is one answer per question. Under five
fields those two rows are one field apart, which the tool would have reported as _near_; under six
they are two questions. `scoring` is now a required field with **no default**, and the group,
print, JSON and spread paths are all keyed on it.

Measured at revision `b0a49fe`, changed in the commit that adds this document.

---

## 1. What the key claimed, and the row that broke it

The tool's own docstring states the rule it enforces:

> Two numbers are ordered only when they agree on **dataset, variant, answer model, judge,
> harness**. The first two say what was asked, the middle two say who answered and who marked it,
> and the last says whose pipeline decided what reached the answer model at all.

That sentence is false by one field, and the counter-example is not hypothetical. Take one
published system reporting two numbers on the same 500 questions:

|                                | configuration A                                                | configuration B                             |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| score                          | **98.6**                                                       | **97.2**                                    |
| dataset                        | LongMemEval                                                    | LongMemEval                                 |
| variant                        | S                                                              | S                                           |
| answer model                   | same readers, same answerers                                   | same readers, same answerers                |
| judge                          | same                                                           | same                                        |
| harness                        | same team, same blog post                                      | same team, same blog post                   |
| **how the score was produced** | **8 variants each answer; any one correct ⇒ question correct** | **12 variants; majority vote ⇒ one answer** |

Every field the key knew about is identical. The two numbers differ by 1.4 points and by nothing
the key can see — except the rule. A reader who sorted them would be ordering _"what can be
reached by eight tries"_ against _"what can be reached by twelve tries reduced to one"_, and would
read the difference as a property of the system.

The mechanism, from the vendor's own account: three reader agents extract six categories of
structured knowledge, three search agents answer from them, and then **eight specialised prompt
variants** — a precise counter, a time specialist, a context deep-dive and five others — each
produce an answer independently. The headline number counts the question correct if any of the
eight is. The authors then ran a second configuration where twelve specialists feed an aggregator
that produces one consensus answer by majority vote, and reported 97.2 for it.

### 1.1 Why this is the most dangerous kind of row

The five-tuple's purpose is to stop a reader from ordering numbers produced under different
conditions. It does that by being **coarser than necessary**: it can split a table that was in
fact comparable, and it cannot merge two that were not. Every previous field was chosen that way.

`scoring` violates the pattern in the opposite direction, and that is why it went unnoticed. Two
rows can agree on all five fields and still be incomparable, so the key was not merely coarse — it
was **unsound**, and the unsoundness is invisible exactly when the numbers look most comparable.
The rows that are furthest apart (a 7B reader at 38.2 against a frontier reader at 95.8) were
never in danger: the answer model field already split them. The row that was in danger is the one
that matched on everything.

### 1.2 The number that circulated, and what it was

Chinese-language coverage in March 2026 reported "99% on LongMemEval, SOTA broken". The 99 is the
98.6 above, rounded, and three things are true of it at once:

1. It is an **any-of-eight** reading, not an accuracy.
2. The vendor states in the same post that this is **not** their production engine; the production
   engine is the 84.6 already recorded in this ledger under `supermemory-published/gpt5`.
3. At least one reproduction of the post describes the release as a **parody** aimed at what a
   memory benchmark can be made to say.

None of the three is a reason to delete the row. All three are reasons the row has to carry its
scoring rule, its `kind` and its `note` — which is what a ledger is for. The ledger's job is not
to decide whether the vendor was joking; it is to make sure that whatever they published cannot be
sorted against our number by accident.

### 1.3 The caveat already existed, in prose, where nothing could enforce it

`docs/SOTA-LANDSCAPE.md` §2 has carried this note against the Supermemory row for as long as the row has
been there:

> advertised ~99% is an 8-variant ensemble

So the fact was known, written down, and correct. What it could not do was **anything**: it could not be
checked, it could not be printed beside a group, it could not stop `--gap` from calling the row near, and a
future row arriving without it would not have been noticed. That is the difference between a caveat and a
condition, and it is the reason this audit ends with a schema change rather than a paragraph.

The general form: **a qualification that lives in one document and not in the artifact that consumes the
number will be lost by the second consumer.** This repository has met the same shape four times — coverage
annotations the gate could not see, `wired` flags the ablation runner never read, a population nobody named
before the run, and now a scoring rule. Each time the fix was to move the qualification into the thing that
decides.

---

## 2. What a five-field key would have done with that row

Concretely, and not as a thought experiment. `--gap` reports, for a score of ours that matches no
group, the nearest group and **the fields that differ**. With five fields, a ledger containing the
any-of-eight row would have produced:

```
83 has no comparable group.
  1 group(s) are equally near, and none of them shares all five fields:
    LongMemEval|S|DeepSeek|cortex-judge|supermemory-asmr-or8
      harness      theirs supermemory-asmr-or8  ours cortex-ablation-40989420944
```

One differing field. A reader — and a document generator, which is the caller that matters — would
have read "one field away" as _nearly comparable_, and the whole point of `--gap` is that it never
says that. The tool's guard against ranking was intact and the sentence it printed was still
misleading, because the guard was checking a key that did not describe the numbers.

With six:

```
83 has no comparable group.
  26 group(s) are equally near, none shares all six fields, and every one differs in the same 3
  field(s): answerModel, harness, judge.
```

The any-of-eight row is no longer near at all: it differs in four fields, so it is not in the tie
set. The 26 groups that remain are the single-answer rows, and the sentence names the three things
that would have to change for a comparison to exist. All three are things only a re-run can
change, which is the finding `PLAN-COMPETITOR-HARNESS.md` exists to act on.

---

## 3. The change

Six edits, each with a test that fails without it.

| File                                                    | Change                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/competitor-ledger.mjs`                           | `SCORINGS = {single, pass@k, majority}`; `scoring` joins `REQUIRED` with no default; `groupKey` returns six fields; `spreads()` keys on the rule; the `--gap` field list is six long; `render` and `--json` group on the full tuple rather than on `dataset\|variant\|harness` |
| `tools/competitor-ledger.json`                          | all 46 pre-existing rows declare `"scoring": "single"`; five new rows added (§4)                                                                                                                                                                                               |
| `tools/__tests__/test_competitor_ledger.py`             | eight tests in `TestTheScoringRule`, plus two rewritten tie-reporting tests                                                                                                                                                                                                    |
| `packages/cortex-eval/src/__tests__/acceptance.test.ts` | `currentOf` dispatch tested for every source kind, and the absent-value note                                                                                                                                                                                                   |
| `docs/SOTA-LANDSCAPE.md`                                | §2 gains the rule column; §10 records the new rows                                                                                                                                                                                                                             |
| `cortex-docs` `05-competitor-analysis.md`               | §1 becomes a six-tuple, with §1.3 on the rule                                                                                                                                                                                                                                  |

### 3.1 Why it is required and not defaulted

A default of `single` would have been the smaller change and the worse one. An author who copies a
row, forgets the field, and is silently recorded as a single-answer reading has produced exactly
the error this field exists to prevent — and in the direction that inflates **somebody else's**
number, which is the direction nobody in this repository is motivated to catch. Required means the
check refuses, and the refusal names the permitted set:

```
entries[0] someone their-harness: missing scoring
entries[0] someone their-harness: scoring "best-of-lots" is not one of single/pass@k/majority
  -- a rule this tool cannot reason about is a number it cannot place
```

### 3.2 Why a harness may still report two rules

The first draft of this change also refused a ledger in which one harness name covered two scoring
rules, by analogy with the existing rule about answer models. That was wrong and it was caught by
a test.

A harness that prints a single-answer column **and** an any-of-k column for every system it ran is
the most honest table in this literature; refusing it refuses the evidence. The harm is never the
coexistence. The harm is the **merge** — one score-sorted block whose first row came from one rule
and whose second came from the other — and that was a real defect in `render()`, which grouped on
`dataset|variant|harness` and would have printed both rules in one table sorted by score.

So the fix is in the rendering, not in the validation: `render` and `--json` group on the full
tuple, and the group header prints the rule beside the harness. A harness reporting both rules now
prints two tables, each labelled, and `--check` accepts the input.

---

## 4. The four other rows this audit added

Adding a field is worth doing only if the field has work to do, so the same pass added the rows
that make it work — each one a mechanism this project could act on, not a score for a leaderboard.

| System                            | Score | Rule       | Kind | What it is here for                                                                                                                                    |
| --------------------------------- | ----- | ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supermemory ASMR (any of 8)       | 98.6  | `pass@k`   | self | The row that names the field                                                                                                                           |
| Supermemory ASMR (majority of 12) | 97.2  | `majority` | self | The defensible half of the same experiment, and a 1.4-point measurement of what any-of-k is worth                                                      |
| MemCog                            | 95.80 | `single`   | self | Highest single-answer figure held; its multi-session 92.48 is reached by 2–3 ReAct steps per query, and multi-session is this arm's weakest route      |
| PlugMem                           | 90.2  | `single`   | self | The highest score held whose **code is obtainable** (Apache-2.0, arXiv:2603.03296), so the one competitor number that can be replaced by a measurement |
| MEMTIER                           | 38.2  | `single`   | self | The only 7B-reader row held; keeps the 57-point reader effect visible in the same table                                                                |

### 4.1 The two rows that changed how this project reads its own position

**MemCog's table is a composite, and its own row is the only one that was measured.** The paper
states that its baseline rows are _sourced from_ Latimer et al. (2025) and Sen et al. (2026) rather
than re-run. So the 95.80-against-85.71 it prints for Mastra is not a paired difference: Mastra
self-reports 94.87, which is already in this ledger. **The 9.2-point distance between the two
readings of Mastra is the size of the effect that a composite table presents as a system gap.**
This is the third independent confirmation of the pattern §3 of the analysis records, and the first
one where the compositing is stated in the paper rather than inferred.

**PlugMem reproduces a write-path claim, which is where this repository has spent its last sixty
steps.** Its mechanism is a split decided **at ingestion** — propositions (facts about the world)
against prescriptions (instructions about behaviour) — plus retrieval routed on high-level concept
and intent, plus a compression step that reduces retrieved units to a short task instruction. The
first half is the null hypothesis this arm keeps failing to reject: that what a memory system writes
matters more than how it ranks. PlugMem is the entry that says it, at 90.2, with code.

---

## 5. What this audit does not establish

1. **No new measurement of this arm.** Every number here is somebody else's, re-typed with its
   conditions. The arm still reads 83.0 on its own harness and nothing in this document moves it.
2. **The rule set is closed at three.** `single`, `pass@k`, `majority` are the three rules this
   ledger has met. A fourth — a judge that samples, a grader that averages over trials — would be
   `single` with a trial count this key cannot express. When one arrives it will need a seventh
   field, and the argument for it will be the same argument as §1: two numbers that agree on
   everything the key knows and are still not the same number.
3. **`judge` already carries a loophole of the same shape.** `apex-mem-published/sonnet` declares
   its judge as _"LLM judge, mean of 3 trials"_, which is a scoring rule written into the judge
   field. It is recorded as it was published rather than normalised, because normalising it would
   hide that the publisher conflated the two.
4. **The 26-way tie is not a defect.** It is the correct output of a key with six fields when one
   system in the world uses `DeepSeek` as its answer model and `cortex-judge` as its judge. The
   tie collapses only when a competitor is run in this harness, which is what
   `PLAN-COMPETITOR-HARNESS.md` proposes and what no amount of reading can substitute for.

---

## 6. The tests, and what each would catch

| Test                                                                            | Catches                                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `test_a_missing_scoring_rule_is_refused`                                        | an undeclared rule entering as `single`                                                                                            |
| `test_an_unrecognised_scoring_rule_is_refused`                                  | a fourth rule silently added to the data without a decision                                                                        |
| `test_the_rule_is_part_of_the_group_key`                                        | a regression that drops the field from `groupKey` while leaving it in `REQUIRED` — the check would pass and the merge would return |
| `test_a_harness_reporting_two_rules_prints_two_tables_not_one`                  | the actual historical defect: one block sorted across two rules (asserted on the printed blocks, not on the refusal)               |
| `test_a_scoring_difference_is_named_when_our_score_is_placed`                   | `--gap` reporting "one field away" instead of naming the rule, on a row where the rule is the _only_ difference                    |
| `test_readings_under_two_rules_are_not_given_one_spread`                        | 98.6 and 97.2 presented as a system that "travelled 1.4 points"                                                                    |
| `test_the_committed_ledger_declares_a_rule_on_every_row_and_uses_more_than_one` | the field becoming a constant that is present and does nothing                                                                     |
| `test_our_own_row_is_a_single_answer`                                           | a silent change to the rule our numbers are produced under, which would re-point every gap in the file                             |
| `test_ties_with_different_causes_are_listed_by_name`                            | the new condensed report claiming one shared cause when there are two                                                              |

The last one exists because the condensation (§2's 26-way output) is itself a compression, and a
compression that is allowed to be wrong is a new way to mislead. It is printed only when every tied
group differs in the same field set; otherwise the tool falls back to the full list.

---

## 7. The general lesson, stated so it can be checked against the next field

A comparability key is a claim that **two numbers agreeing on it are the same number**. Every field
added to it is a guess that the remaining differences do not matter, and the guess is only ever
falsified by a row that agrees on everything and still should not be sorted. The five-field key
survived six months and 46 rows because every earlier counter-example differed in a field the key
already had.

The check that would have found this one sooner is not "add more fields". It is: **for each field,
name the row that would expose its absence.** No such row could be named for `scoring`, because the
question had not been asked — and the question is cheap. It cost one search.

# Measure: the assumption ledger, and what each part of it is worth

**Run with:** `node tools/assumption-ablation.mjs` (add `--verbose` for per-case detail, `--json` for the
record). No model, no key, no embedding: the set is deterministic, so two runs disagreeing is a bug.

The criteria this reads against were fixed before the code existed, in
[`PREREG-ASSUMPTION-LEDGER.md`](PREREG-ASSUMPTION-LEDGER.md).

---

## 1. The reading

Sixteen cases after the temporal axis landed: the twelve from step 31 plus a `plan` family (a commitment
that lapsed, one still pending, one fulfilled) and an `immutable` case (two settled events on one slot).

```
arm         correct   accuracy
flat        5/16      31.3%
annotated   5/16      31.3%
gated       16/16     100.0%

family        flat      annotated gated
type-i        0/3       0/3       3/3
historical    1/2       1/2       2/2
false-stale   2/2       2/2       2/2
conflict      0/2       0/2       2/2
type-ii       0/2       0/2       2/2
cascade       0/1       0/1       1/1
plan          1/3       1/3       3/3
immutable     1/1       1/1       1/1

ablation (gated arm, one mechanism removed)
removed         accuracy  delta    targeted families
none            100.0%    0.0pp    —
persistence     75.0%     -25.0pp  type-i, type-ii
uniqueness      87.5%     -12.5pp  conflict
time-anchor     100.0%     0.0pp   historical, false-stale
cascade         93.8%      -6.3pp  cascade
temporality     87.5%     -12.5pp  plan, immutable
lapse           100.0%     0.0pp   plan
fulfil          100.0%     0.0pp   plan
immutability    93.8%      -6.3pp  immutable
```

## 2. What each row establishes, and what it does not

**`annotated` equals `flat`, exactly.** This is the arm that tests the cheapest hypothesis — that a reader
who is _told_ which facts are retired will do the right thing. It moves nothing, and it moves nothing on
every family. Labelling that does not change a decision is decoration; the ledger has to participate in the
decision or it is a comment.

**`flat` served seven retired facts** across sixteen cases. That is the failure mode the whole design is aimed
at, in the form the published record describes it: the older value is still `at`-less in the reader's mind,
it is equally relevant lexically, and nothing in the pipeline says it has been replaced.

**The ablations attribute cleanly.** Removing `persistence` costs exactly the three `type-i` cases and
nothing else. Removing `uniqueness` costs exactly the two `conflict` cases. Removing `cascade` costs exactly
the one `cascade` case. A mechanism that moved three families when removed would be entangled with them;
none of these do.

**Two mechanisms were expected to be inert, and one is.** `time-anchor` costs nothing on accuracy, which
§7.3 of the pre-registration predicted before the code existed: an ingestion timestamp is never wrong in a
fixture where every timestamp is known exactly, so its value is in _being recorded_, not in being read. The
prediction is written down so that a null result cannot later be sold as a discovery.

**`cascade` was expected to be inert and is not — on one case.** PACMI's own ablation of its cascade did not
reach significance (3 errors → 11, p = 0.0574), which is why the switch ships off by default. Here it is
worth one answer out of twelve. That is not a contradiction of PACMI; it is the same effect seen in a set
built to make the effect visible, which is exactly the bias §7.1 names.

## 3. Why 100% is not a result

The number that matters is the **shape** of the table, not its top row. Three reasons the 100% cannot be
quoted as anything else:

1. **The baseline is weaker than reality, deliberately.** `flat` breaks a tie by fact id. In a real
   corpus, relevance is not a tie — the older fact is often _more_ similar to the question, because it was
   discussed at length. A stronger baseline would make `flat` look better and `gated` look worse on
   `type-i`, and neither number would be more true.
2. **The conflicts are constructed, not found.** The generator writes both the premise and the update. A
   real conversation buries both in filler, and the hard part — _noticing_ that the update invalidates the
   premise — is not tested here at all (see §4).
3. **Twelve cases cannot support a percentage.** Written as 12/12, not as 100%, whenever it is quoted.

## 4. What this set does **not** measure

- **Whether a system can _find_ an invalidation.** STALE Type II is hard precisely because the changed
  attribute is never mentioned in relation to the fact it breaks. This fixture _declares_ the invalidation
  (`invalidates`) and measures only whether the system propagates it. That is PACMI's boundary as well
  ("conditional on derivation links being represented or supplied"), and it is the honest one: detecting the
  link is a research problem, using it is bookkeeping.
- **Whether the ledger helps on a real benchmark.** LongMemEval-S has low contradiction density — the reason
  arXiv 2606.22030 found belief updating unprofitable on LoCoMo — so the A/B (registered as **A8**) may
  well report a null. That is a legitimate outcome and it would not refute this set: the set says the
  mechanism works, not that the workload is full of the cases where it matters.
- **Whether the extra fields cost anything.** Ledger size, write latency and the token cost of the
  `assumed:` line in a block are all unmeasured. The line is suppressed when the only assumption is an open
  persistence, which is the common case, so the expected cost is near zero — expected, not measured.

## 5. The extraction path, separately

The pre-registration gated four extraction endpoints (E1–E4). Three are asserted in the unit suite rather
than reported here, because they are accounting rules with a 100% bar:

| #   | Endpoint                                                                     | Where it is checked                                                                       | Reading                                                                                            |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| E1  | every undated fact carries a `time-anchor`; every fact carries `persistence` | `assumption.test.ts`                                                                      | passes by construction: `deriveAssumptions` is the only producer and it always emits `persistence` |
| E2  | revision verdicts match gold on the controlled set                           | implicit in §1: `gated` cannot reach 12/12 unless every refutation landed where it should | 12/12                                                                                              |
| E3  | no assumption whose origin cannot be recomputed                              | `assumption.test.ts` (origin is a literal per branch)                                     | passes; the origin is a constant in the code, not a value a model supplies                         |
| E4  | the `strict` unit gate still passes on the 20 reviewed pairs                 | `knowledge-probe` + `unit.test.ts`                                                        | 15/20 unchanged — the ledger did not become a way around the relation gate                         |

E2 is the one worth a sentence: it is **not** an independent reading. If the refutation rule were wrong in
the same direction as the expected answer, both would agree and the number would still be 12/12. The
independent check is the `false-stale` control, where a wrongly applied refutation would take the score
_down_, and it stays at 2/2.

## 6. The third axis: settled fact, commitment, wish

Step 31 recorded what a fact _assumed_. It did not distinguish a fact from a plan, and the reviewer was
right that this is a separate capability: "if the user describes what happened, that is settled; if they
describe what they intend, that is a plan, and a plan that is never fulfilled has to be corrected or
forgotten."

Two axes, not one. `modality` collapsed them: TimeML separates `I-ACTION` ("does not necessarily actually
happen") and `I-STATE` ("alternative possible worlds") from plain `OCCURRENCE`, and FactBank separates
factual / probable / possible with MEANTIME adding `possibility (future)` as its own value. So:

| futurity       | certainty          | reads as                                    | old `modality` |
| -------------- | ------------------ | ------------------------------------------- | -------------- |
| past / present | factual            | **settled** — nothing later can unsettle it | `actual`       |
| future         | factual / probable | **a commitment**                            | `planned`      |
| future         | possible           | **a wish**                                  | `hypothetical` |

The lifecycle is a state machine with three transitions on evidence and **one on absence**:
`pending → fulfilled` needs a declaration, `pending → abandoned` needs a declaration, `pending → lapsed`
needs only that the date passed with no word. `lapsed` discounts to 0.4 rather than deleting, because
nobody saying a plan happened is not the same as it not happening.

### What the ablation says about it

**`-temporality` costs 12.5pp and takes out two families.** With the axis unread, nothing is a plan, so a
question about what happened gets answered with a commitment — and a settled event stops being protected,
because the protection is `type: event` **and** past.

**`-immutability` costs 6.3pp on exactly one case and moves nothing else.** With the protection off,
`deriveSupersedes` builds the edge a system without it would build, and the earlier trip is retired by the
later one. That is the failure the distinction exists to prevent: rewriting history so the current answer
looks tidy.

**`-lapse` and `-fulfil` are inert, and the reason is worth recording.** The intent filter already keeps
every unfulfilled plan out of a question about what happened, so removing the lapse transition changes the
label without changing the answer; and a fulfilled plan is superseded by the event that fulfilled it, so
`persistence` retires it before `fulfil` is consulted. Both are **state correctness** rather than
answer accuracy on this set. They still matter — `describePlan` and `planFactor` read them, and a plan
labelled `pending` for ever is a plan that will be offered again — but the table says plainly that this
fixture cannot price them, and no claim is made that it does.

### The gap this does not close

`fulfils` and `abandons` are **declared**, exactly as `invalidates` is. Noticing that "I ran the marathon
in April" fulfils "I will run a marathon in spring" is a matching problem, and the published machinery for
it (PM-Bench, and the Prospective Intention Store built on it) is the reference for the day this is
attempted. Claiming it here would be claiming a capability the fixture supplied.

### The prior this sits on

PM-Bench (arXiv 2607.12385) reports 65.1% F1 for the best configuration and **under 50% on cross-day
intentions**, and names the failure precisely: plans that were _completed or cancelled_ keep being acted
on. Its companion result is the design argument for this whole module — an explicit typed store with
deterministic transitions moved the same backbone from 65.1% to 82.9%, and a small model from 4.2% to
66.2%. The lesson is not "use a bigger model"; it is that a state machine belongs in code and only the
language part belongs in the model.

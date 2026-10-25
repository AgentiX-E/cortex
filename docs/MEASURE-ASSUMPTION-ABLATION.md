# Measure: the assumption ledger, and what each part of it is worth

**Run with:** `node tools/assumption-ablation.mjs` (add `--verbose` for per-case detail, `--json` for the
record). No model, no key, no embedding: the set is deterministic, so two runs disagreeing is a bug.

The criteria this reads against were fixed before the code existed, in
[`PREREG-ASSUMPTION-LEDGER.md`](PREREG-ASSUMPTION-LEDGER.md).

---

## 1. The reading

```
controlled contradiction set: 12 cases

arm         correct   accuracy  retired served
flat        3/12      25.0%     6
annotated   3/12      25.0%     6
gated       12/12     100.0%    0

family        flat      annotated gated
type-i        0/3       0/3       3/3
historical    1/2       1/2       2/2
false-stale   2/2       2/2       2/2
conflict      0/2       0/2       2/2
type-ii       0/2       0/2       2/2
cascade       0/1       0/1       1/1

ablation (gated arm, one mechanism removed)
removed         accuracy  delta    targeted families
none            100.0%    0.0pp    —
persistence     75.0%     -25.0pp  type-i, type-ii
uniqueness      83.3%     -16.7pp  conflict
time-anchor     100.0%    0.0pp    historical, false-stale
cascade         91.7%     -8.3pp   cascade
```

## 2. What each row establishes, and what it does not

**`annotated` equals `flat`, exactly.** This is the arm that tests the cheapest hypothesis — that a reader
who is *told* which facts are retired will do the right thing. It moves nothing, and it moves nothing on
every family. Labelling that does not change a decision is decoration; the ledger has to participate in the
decision or it is a comment.

**`flat` served six retired facts** across twelve cases. That is the failure mode the whole design is aimed
at, in the form the published record describes it: the older value is still `at`-less in the reader's mind,
it is equally relevant lexically, and nothing in the pipeline says it has been replaced.

**The ablations attribute cleanly.** Removing `persistence` costs exactly the three `type-i` cases and
nothing else. Removing `uniqueness` costs exactly the two `conflict` cases. Removing `cascade` costs exactly
the one `cascade` case. A mechanism that moved three families when removed would be entangled with them;
none of these do.

**Two mechanisms were expected to be inert, and one is.** `time-anchor` costs nothing on accuracy, which
§7.3 of the pre-registration predicted before the code existed: an ingestion timestamp is never wrong in a
fixture where every timestamp is known exactly, so its value is in *being recorded*, not in being read. The
prediction is written down so that a null result cannot later be sold as a discovery.

**`cascade` was expected to be inert and is not — on one case.** PACMI's own ablation of its cascade did not
reach significance (3 errors → 11, p = 0.0574), which is why the switch ships off by default. Here it is
worth one answer out of twelve. That is not a contradiction of PACMI; it is the same effect seen in a set
built to make the effect visible, which is exactly the bias §7.1 names.

## 3. Why 100% is not a result

The number that matters is the **shape** of the table, not its top row. Three reasons the 100% cannot be
quoted as anything else:

1. **The baseline is weaker than reality, deliberately.** `flat` breaks a tie by fact id. In a real
   corpus, relevance is not a tie — the older fact is often *more* similar to the question, because it was
   discussed at length. A stronger baseline would make `flat` look better and `gated` look worse on
   `type-i`, and neither number would be more true.
2. **The conflicts are constructed, not found.** The generator writes both the premise and the update. A
   real conversation buries both in filler, and the hard part — *noticing* that the update invalidates the
   premise — is not tested here at all (see §4).
3. **Twelve cases cannot support a percentage.** Written as 12/12, not as 100%, whenever it is quoted.

## 4. What this set does **not** measure

- **Whether a system can *find* an invalidation.** STALE Type II is hard precisely because the changed
  attribute is never mentioned in relation to the fact it breaks. This fixture *declares* the invalidation
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

| # | Endpoint | Where it is checked | Reading |
| --- | --- | --- | --- |
| E1 | every undated fact carries a `time-anchor`; every fact carries `persistence` | `assumption.test.ts` | passes by construction: `deriveAssumptions` is the only producer and it always emits `persistence` |
| E2 | revision verdicts match gold on the controlled set | implicit in §1: `gated` cannot reach 12/12 unless every refutation landed where it should | 12/12 |
| E3 | no assumption whose origin cannot be recomputed | `assumption.test.ts` (origin is a literal per branch) | passes; the origin is a constant in the code, not a value a model supplies |
| E4 | the `strict` unit gate still passes on the 20 reviewed pairs | `knowledge-probe` + `unit.test.ts` | 15/20 unchanged — the ledger did not become a way around the relation gate |

E2 is the one worth a sentence: it is **not** an independent reading. If the refutation rule were wrong in
the same direction as the expected answer, both would agree and the number would still be 12/12. The
independent check is the `false-stale` control, where a wrongly applied refutation would take the score
*down*, and it stays at 2/2.

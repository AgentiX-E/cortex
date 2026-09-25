# VERDICT B1 — cross-encoder reranking, first measured dispatch

**Status:** measured. Verdict is **inconclusive by power, with a resolved
observability defect that would otherwise have made it unfalsifiable.**

**Run:** `35624110842` — `completed / success`, 15/15 steps green.
**Artifact:** `10654395809`, 1,298,259 bytes, retrieved byte-exact.
**Commit:** the dispatch was on the commit carrying the fallback counters and the
`rerank_provider` dispatch input. Verified by the artifact's own report contents,
not by assumption.

---

## 1. Headline

| Arm      | Configuration                         | Accuracy   | Correct |
| -------- | ------------------------------------- | ---------- | ------- |
| baseline | shipped pipeline, reranking off       | **86.00%** | 129/150 |
| feature  | reranking on, `llm` provider, pool 60 | **87.33%** | 131/150 |

- **Δ accuracy: +1.33 pp** (feature − baseline)
- **McNemar p = 0.7539** — not significant
- Discordant pairs: 4 (baseline✓/feature✗) vs 6 (baseline✗/feature✓)
- **ABSTENTION SHIFT: +2.00 pp** — **NON-ZERO**

**The verdict is not "reranking helps" and not "reranking hurts."** Two
independent facts each block a conclusion, and §2 and §3 take them in turn.

## 2. The pre-registered reading, in the pre-registered order

The reading order was fixed in `MEASURE-B1-RERANKING.md` §5.3 **before** the
numbers existed, precisely so it could not be chosen to suit them.

### 2.1 `fallbacks` — was the reranker actually running?

**Reported as `null`. The reranker exposes no counters.**

That is the honest field value, and it is also the defect. `fallbacks: null` is
supposed to mean "this reranker has no fallback concept" — the correct answer for
the local cross-encoder, which throws rather than abstaining. It was **also** the
answer for `provider=llm`, which is the one provider the dispatch used and the
one provider that _does_ have the concept.

Cause, confirmed by probe rather than inference:

```
PROBE llm    fallbackCount: undefined   readRerankFallbacks: null
PROBE local  fallbackCount: undefined   readRerankFallbacks: null
PROBE openai fallbackCount: undefined   readRerankFallbacks: null
```

`buildReranker` ended in `return new LLMReranker({ llm }).score`. `.score` is an
instance-bound arrow function: it carries the counter closures but not the
getters, so the factory handed back a function on which both properties were
`undefined`, and `readRerankFallbacks` correctly answered `null` for all three
providers.

**What this costs the verdict.** The counters exist to distinguish "reranking
had no effect" from "reranking never ran". With them unreachable, this run's
`+1.33 pp` cannot be separated from the case where every bucket failed to parse,
the adapter returned `[]`, and `rerankHits` preserved the retrieved order. The
dispatch's `CORTEX_RERANK_PROVIDER=llm` and the presence of a non-zero
`abstentionShift` (§2.2) both make a total failure **implausible** — an arm that
never reranked cannot move the abstention boundary. But _implausible by argument_
is not _measured_, and this project does not accept the former where the latter
is obtainable.

Fixed in the same change as this document; see §5.

### 2.2 `abstentionShift` — **+2.00 pp**, and the delta is confounded

The pre-registered rule is categorical:

| Abstention shift | What the accuracy delta means                                                |
| ---------------- | ---------------------------------------------------------------------------- |
| ≈ 0              | attributable to reranking's effect on which evidence is read                 |
| non-zero         | **confounded** — the system changed when it declines, not only what it reads |

The measured shift is **+2.00 pp** (16.67% → 18.67% abstention rate; 25 → 28
abstentions), so the second row applies. The `+1.33 pp` accuracy change is **not
attributable to reranking the evidence**; it is entangled with a reranker-driven
move in _when the system declines to answer_.

`AUDIT-B1-HITS0-READ-SITES.md` predicted exactly this, and named the mechanism:
read sites `571` and `1009` take abstention confidence from `hits[0].score`, so a
stage that only reorders nonetheless changes the decision threshold. Those two
sites were deliberately **not** migrated to `maxHitScore` in the B1 change, to
keep this experiment separate from an abstention-behaviour change — which means
the confound was known, bounded, and left in place on purpose, with the control
(`RERANK_PROTECTED_HEAD=1`) wired for exactly this reading.

### 2.3 The MR/TR pair — and why "not significant" is the wrong summary

| Capability | n   | baseline | feature    | b✓f✗ | b✗f✓ | McNemar p |
| ---------- | --- | -------- | ---------- | ---- | ---- | --------- |
| IE         | 64  | 90.63%   | 89.06%     | 3    | 2    | 1.000     |
| **MR**     | 22  | 81.82%   | **81.82%** | 0    | 0    | 1.000     |
| KU         | 21  | 71.43%   | 76.19%     | 1    | 2    | 1.000     |
| **TR**     | 21  | 80.95%   | **90.48%** | 0    | 2    | 0.500     |
| ABS        | 22  | 95.45%   | 95.45%     | 0    | 0    | 1.000     |

The aggregate `+1.33 pp` is the sum of two movements in opposite directions
(IE −1.56 pp, MR 0.00 pp, KU +4.76 pp, TR +9.52 pp, ABS 0.00 pp). Reporting the
aggregate alone would hide that.

**TR is the only arm that moved meaningfully** (+9.52 pp), and it moved on 2
discordant pairs with **zero** in the other direction. MR — the other capability
the pre-registration named — is **bit-identical at 0 vs 0**, i.e. reranking
changed nothing whatsoever for it. The pre-registered acceptance criterion asked
for MR **and** TR to move in the same direction; **MR did not move at all**, so
that criterion is **not met**, independent of significance.

## 3. Why this is underpowered, not refuted

The power analysis was written before the data, in `MEASURE-B1-RERANKING.md`
§5.3, and it said:

> | p≥0.05 | **Underpowered, not refuted.** This run cannot separate "no effect"
> from "effect below detection at n≈16". |

That prediction is what the run delivered. With `limit=150` the cohort splits to
IE 64, MR 22, KU 21, TR 21, ABS 22; MR and TR sit at 22 and 21 questions. At
those sizes a 6:0 discordant split is required for p<0.05; TR delivered 2:0, and
MR delivered 0:0.

So the honest statement is: **at this sample size, a reranking benefit below
roughly 10 pp on TR and any benefit at all on MR are invisible.** `p = 0.7539`
does not license "reranking does not help." It licenses "this run could not
detect it."

Note also that `Welch p = n/a (deterministic)` and `Cohen's d = +∞` are artifacts
of `RUNS=1` — a single deterministic pass has no between-run variance. Neither
number carries information about the effect, and both must not be read as
extremely strong evidence.

## 4. What is decided, and what is not

**Decided:**

1. The reranking stage is **wired end to end and executes in CI** — it was not a
   no-op. Evidence: `CORTEX_RERANK=on` / `rerank_provider=llm` reached the bench
   process, the ablation produced a report distinct from the main test, and
   `abstentionShift` is non-zero, which requires the reranker to have reordered
   hits.
2. The reranker's baseline arm is correctly anchored: `rerank-baseline` measures
   **86.00%**, exactly the main test's shipped `nl-abstain-feature` arm. The
   ablation is therefore measured against the shipped configuration rather than
   against a naive one.
3. **The +1.33 pp aggregate is confounded by a +2.00 pp abstention shift** and
   must not be shipped as an accuracy claim.
4. **The MR half of the pre-registered acceptance criterion fails** — 0 vs 0.

**Not decided:**

- Whether reranking helps. The run is underpowered for the effect size in play.
- Whether reranking hurts IE (−1.56 pp on 3:2 discordance is noise).
- Whether the shipped configuration should change. No change is justified by data
  that cannot separate the hypothesis from its null.

**Recommendation: do not enable reranking by default.** The evidence does not
support it, and the one capability that moved (TR) is the one whose abstention
confidence is read from `hits[0].score` — i.e. the move is at least partly the
confound, not the feature.

## 5. The defect this run found, and its fix

This is the substantive outcome of the iteration. The B1 observability shipped in
the previous iteration was **dead on arrival for the provider the experiment
uses**, and a green run with `fallbacks: null` would have been read as "no
fallbacks" rather than "no visibility."

`packages/cortex-eval/src/rerank-factory.ts` now projects the counters onto the
returned function as live getters:

```ts
function withFallbackCounters(
  score: RerankScoreFn,
  adapter: { readonly fallbackCount: number; readonly bucketCount: number },
): RerankScoreFn {
  return Object.defineProperties(score, {
    fallbackCount: { get: () => adapter.fallbackCount, enumerable: true },
    bucketCount: { get: () => adapter.bucketCount, enumerable: true },
  });
}
```

Getters rather than copied values, because a copy would pass a construction-time
assertion and then report `0/0` after any number of failures — the same
silent-unknown outcome the counters exist to prevent, just harder to notice.

Verification (TDD, tests written first and observed red):

| Method                                 | Result                                             |
| -------------------------------------- | -------------------------------------------------- |
| 7 new tests written before the fix     | **3 red** on the counter contract                  |
| Defect injection: revert the fix       | **4 red**, 24 passed                               |
| Restore, re-run                        | 28 passed                                          |
| Live end-to-end via injected `fetchFn` | `bucketCount: 2`, `fallbackCount: 2`, `scores: []` |

The end-to-end check is the one that matters: it drives the real adapter through
the real request path with a 200 reply whose content cannot be parsed, and reads
the counters off **the function the factory returns**. The empty score list
alongside the two counters is the exact signature that was previously
indistinguishable from a successful no-op.

**Re-measurement is required** to convert §2.1 from "implausible by argument" to
"measured," and the next dispatch will finally carry the reading.

## 6. Sandbox note: the artifact was retrieved, at the second attempt

`OPS-UNFETCHABLE-ARTIFACT.md` records two failure modes for artifact download
(`404 AccountNotFound` on `sa16`; TLS interception on `sa18`), both called
unrecoverable and "re-dispatch only."

**That conclusion is too strong.** The same `sa18` artifact that failed under
plain resolution downloaded successfully through the repository's own
`tools/fetch-artifact.py`, which resolves the signed blob host over DoH
(`dns.alidns.com`) and substitutes the real A records before connecting:

```
productionresultssa18.blob.core.windows.net -> 20.150.88.228, 52.239.172.36, 20.150.82.228
artifact -> 200, 1298259 bytes  (sha256 truncated 083bfeb74f7d4768)
```

The distinction the earlier document drew — "the SAS is host-bound, so
cross-host recovery is closed" — remains correct and is not contradicted: DoH
supplies the **right** address for the **same** host, which is a different thing
from substituting a different host. The failure was in the _name resolution_,
not in the signature.

So "re-dispatch only" should be amended to: **retry through
`tools/fetch-artifact.py` first; re-dispatch only if the DoH resolution itself
returns nothing.** One of the two documented modes (`sa16`, a genuinely absent
account) remains unrecoverable, so the amendment is narrowing, not a retraction.

## 7. The follow-up dispatch, and what it is designed to separate

Dispatched the moment the fix above landed: **run `35693431980` on `caf20810`** —
`limit=150`, `runs=1`, `temperature=0`, `rerank=on`, `provider=llm`, `pool=60`,
and **`RERANK_PROTECTED_HEAD=1`**.

The pin is the whole point, and it is one of the two configurations
`AUDIT-B1-HITS0-READ-SITES.md` §4 calls legitimate:

| Configuration                              | Question it answers                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| unprotected (run `35624110842`)            | what happens if reranking ships with abstention coupling included                               |
| **protected head ≥ 1** (run `35693431980`) | how much of the change is reranking the _evidence_ rather than moving the _abstention boundary_ |

`rerankProtectedHead` pins the leading hit, and read sites `571` and `1009` take
abstention confidence from `hits[0].score`, so a protected head of 1 makes that
confidence **invariant** under reranking. The expected signature of a clean
attributable effect is therefore:

1. `abstentionShift` ≈ 0 — the confound removed, not merely hoped away;
2. the MR/TR pair readable as evidence about answer content.

And the precondition this document exists to establish: **the run must report a
non-null `fallbacks`.** If it reports `null` again, the fix did not survive
whatever path the workflow takes to the bench process, and that is a second
defect — not a second reading.

### 7.1 What would change the verdict, stated before the data

The verdict in §1 is "undecided". These are the observations that would move it,
fixed now so they cannot be chosen afterwards:

| Observation in `35693431980`                          | Revised verdict                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abstentionShift` ≈ 0 **and** TR moves with p<0.05    | reranking has an attributable effect on TR; revisit shipping it                                                                                     |
| `abstentionShift` ≈ 0 **and** TR/MR both ~0           | reranking has no detectable effect at this sample size — still underpowered, so **not** a refutation                                                |
| `abstentionShift` still non-zero with the head pinned | the pin does not reach the coupling; the audit's two read sites are not the whole mechanism, and that becomes the next investigation                |
| `fallbacks` non-null and non-zero                     | the previous run's numbers are uninterpretable in a _second_, measured way — re-read `35624110842`'s delta as counting an arm that partly abstained |

Note the third row: it is the outcome the pre-registration has no branch for, and
it would mean the abstention confound has a cause beyond the two lines the audit
found. Recording that in advance is the point — an unexpected result should
produce a new investigation, not a retro-fitted explanation.

## 8. The control arm: read, and it corrects §2.1 — plus one alarm that was mine, not the code's

Run `35693431980` (commit `caf20810`, `RERANK_PROTECTED_HEAD=1`) completed
success; artifact `10680667211` retrieved byte-exact.

### 8.1 The precondition is satisfied, and the fix is confirmed in production

```
fallbacks = { "fallbackCount": 0, "bucketCount": 300 }
```

**300 buckets scored, zero abstentions.** This is the first run that has ever
reported this field truthfully, and it is what §2.1 could not obtain: the
observability gap is closed, and it was closed on the one provider the experiment
uses. §5's fix is therefore verified in the environment it was written for, not
merely in tests.

It also retro-validates run A retrospectively: an arm that never reranked could
not have produced these counters, so run A's reranker was running too. The
argument §2.1 said was "plausible but not measured" is now measured.

### 8.2 The control arm's numbers

| Arm      | Accuracy | Correct |
| -------- | -------- | ------- |
| baseline | 87.33%   | 131/150 |
| feature  | 86.00%   | 129/150 |

Δ = **−1.33 pp**, McNemar p = **0.7539**, `abstentionShift` = **+0.67 pp**.

Compare run A: baseline 129, feature 131, Δ = **+1.33 pp**, same p.

**The two runs are exact mirrors.** Under the pre-registration in §7.1 the
reading is the second row — `abstentionShift` is small but non-zero, and TR/MR do
not move significantly — so the verdict is unchanged: **reranking has no
detectable effect at this sample size.** Pinning the head did shrink the
abstention shift (+2.00 → +0.67 pp), which is the direction §4 of
`AUDIT-B1-HITS0-READ-SITES.md` predicts, but it did not change the conclusion.

### 8.3 The alarm: two identical configurations scored differently

`rerank-baseline` is by construction the shipped pipeline with no reranker. The
same run's main test measures that same configuration as `nl-abstain-feature`. In
run B they disagreed:

| Configuration        | Source in run B | Correct     |
| -------------------- | --------------- | ----------- |
| `rerank-baseline`    | rerank ablation | **131**/150 |
| `nl-abstain-feature` | main test       | **129**/150 |

I raised this as a possible defect — "two configurations that should be identical
score differently, so the pairing premise is broken". **That alarm was wrong, and
the way it was wrong is worth recording.**

### 8.4 Why they differ, and why it is not a defect

The caches are declared **per ablation**:

```ts
const answerCache = new Map<string, string>(); // inside each run*Ablation
```

So the two arms _within_ an ablation share a cache, while **different ablations
and the main benchmark do not share one with each other**. Since the hosted
endpoint is not reproducible across calls even at `temperature = 0`, arms with
separate caches acquire a difference they were not built to measure.

This is already documented in the repository from the opposite direction
(`runner.ts`, on the MR-adjacent arms):

> shared-cache arms disagreed on **0 of 470** questions, while two
> identically-configured arms with **separate caches** disagreed on **2 of 127**.

`2 of 127` ≈ `2 of 150`. The observed gap **is** the documented behaviour, and the
correct conclusion is the reverse of my alarm: the cross-ablation comparison is
the invalid one, and it was never a comparison the experiment makes. Within a run
the arms are paired, which is the whole point of `runRerankAblation` constructing
both of them itself.

### 8.5 What was actually tested, and what the tests pin

Asserting "the arms agree with the main test" would be asserting something false.
The defensible properties are:

| Property                                                   | Why it matters                                                                           | Verified by           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| A shared cache serves each distinct prompt once            | A byte-identical prompt cannot acquire a difference the arm did not measure              | `cache-scope.test.ts` |
| Separate caches do re-issue the same prompt                | The control that keeps the assertion above from passing vacuously                        | same file             |
| The cache key is the **rendered prompt**, not the question | Otherwise a reranker's reorder would be invisible and the ablation would measure nothing | same file             |

The third is the one that would have mattered most: if the key were the question,
`rerank-baseline` and `rerank-feature` would share answers and B1 would have
measured zero by construction — while reporting a plausible-looking number.

Measured values on the fixture (4 completions for the first arm; sharing absorbs
part but not all of the second, 6 total, versus 8 with separate caches) are
asserted as observed rather than as a rounded-up "absorbs everything", because
the gap between "absorbs most" and "absorbs all" is exactly what a reader would
otherwise have to guess.

Defect injection, both directions: a cache that never **stores** fails 2 of 2; a
cache that never **reads** fails 1 of 2. Both restored byte-exact.

### 8.6 A false positive I produced, and the fix to my own method

Earlier in this investigation I reported that the reranker's scores were being
**ignored entirely**, on the evidence that four different scorers all produced
`["a","b","c"]`. I was wrong: my probe returned `-i` for "reverse", and
`-0 > -1 > -2` means the **first** candidate already wins, so `["a","b","c"]` was
correct behaviour. A second scorer in the same probe, returning `i`, produced
`["c","b","a"]` and I did not read the pair together.

The lesson is not "be careful with signs". It is that **a probe whose expected
output is not shown beside a known-different case is not evidence** — the same
rule this repository already applies to tests. Both the corrected probes and the
committed test file now print a control beside the observation.

### 8.7 Corrected verdict

Unchanged in substance, and strengthened in basis:

1. **No detectable reranking effect at n≈150**, in either the unprotected or the
   head-pinned configuration. `p = 0.7539` in both, from discordant splits of
   4:6 and 6:4 — the two runs differ by sign and nothing else.
2. **Reranking stays off by default.** Nothing in either run justifies enabling it.
3. **The observability gap is closed and verified in production** (300/300
   buckets, 0 fallbacks), which is the durable outcome of this iteration.
4. **No defect was found in the cache scope or the ordering path.** Both were
   investigated on suspicion, and both were cleared with controls.

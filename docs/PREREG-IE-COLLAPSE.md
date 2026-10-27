# Pre-registration: is the entity-identity clause what collapses IE and KU?

**Registered 2026-10-27, before the dispatch it describes.**
Context: `MEASURE-BASELINE-DRIFT.md` §8 (two systems, not a drift) and the three runs tabulated in
§9 below.

## 1. The observation, and what has already been eliminated

`benchmark.yml`'s feature arm reads **44.60%** on run `40408635007`, with **IE 1/150** and
**KU 0/72**. That is the third measurement of the same shape:

| run | overall | IE | KU | MR | TR | ABS | corpus sha256 | embedding source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `40378588466` | 43.80% (219) | **1** | 1 | 104 | 87 | 30 | `d6f21ea9…a442` | v1 cache hit (56,782 texts) |
| `recall` / `per-item` | 44.20% (221) | **1** | 0 | 104 | 86 | 30 | not recorded | v1 cache hit |
| **`40408635007`** | **44.60% (223)** | **1** | **0** | **105** | **87** | **30** | `d6f21ea9…a442` | **v1 refused → 19,251 live texts embedded** |

Three things are now eliminated by measurement rather than by argument:

1. **The corpus.** `40408635007` printed the same `sha256` and the same byte count (277,383,467) as
   `40378588466`. §5 of the drift document ordered this first; it is answered.
2. **A foreign vector space, at least in this run.** `40408635007` is the **first** run after the
   provenance fix (`37ae1df`), so it refused the v1 cache and embedded 19,251 texts live — a
   self-consistent space by construction. IE still read 1/150. The cache hypothesis in
   `MEASURE-CACHE-PROVENANCE.md` §6 predicted that a fresh space might restore IE; it did not.
3. **Throttling.** `transportRetry` on that run: `attempts 782, retried 0, rateLimited 0, retryRate 0`.
   Not a quota problem, not a concurrency problem, on this run.

What remains is the **ask** — the instruction block the flat route reads — or the retrieval beneath it.

## 2. The hypothesis

`entityIdentityClause` (`runner.ts:321`, default **on**) appends this sentence to the prompt:

> Answer `INSUFFICIENT_EVIDENCE` when the question names a specific entity (a person, object, place, or
> qualifier) that does not appear in the context, even if a related or similarly-named one does: a
> different name is not the same as the entity asked about, and a related object is not the same as the
> object asked about.

IE questions are "what degree did I graduate with", "where did I redeem a $5 coupon", "what is my
last name" — each names a specific entity, and the delivered context is a retrieved subset. The
clause **licenses declining on exactly the failure the retrieval already produces**. KU questions
share the shape and the route.

Its own attribution note records a **+3 on ABS** (29/30 → 26/30 without it, run `35097952715`). It has
never been measured on IE or KU — the two capabilities that share its route and not its target.

**The counter-argument, stated now so it is not discovered later.** Run `35097952715` removed this
clause on **2026-09-16**, nine days before the 430/500 reading (`MEASURE-FAILURE-CENSUS.md` §2–3). If
that September run carried the clause, it cannot be what changed. But that run **predates
`featureConfig` being written into the artifact**, so its switches are unrecorded — which is why this
is a dispatch and not a deduction.

## 3. The treatment

One flag on the shipped configuration; every other value byte-identical to `40408635007`:

```
gh workflow run benchmark.yml -f limit=0 -f runs=1 -f ablation_runs=1 -f temperature=0 \
  -f model=deepseek-chat -f thinking=disabled -f aggregation_critique=0 \
  -f entity_identity_clause=0 -f candidate_discrimination=0 -f retrieval_sides=0 \
  -f embedding_batch_interval_ms=100
```

## 4. Predictions, registered before the run

| # | prediction | falsified if |
| --- | --- | --- |
| **P1** | mechanism: the artifact's `Feature config` reads `entityIdentityClause=off`, and the fixed prompt is shorter than the control's by the clause length on the flat route | the config line reads `on`, or `promptChars` is unchanged |
| **P2** | **IE ≥ 51/150** (from 1) | IE ≤ 5 |
| **P3** | **KU ≥ 30/72** (from 0) | KU ≤ 5 |
| **P4** | MR, TR and ABS each move ≤ 5 questions | any moves further — the clause is not reached by their routes, so a move means the routes are not what this registration claims |
| **P5** | ABS does not fall below 27/30 | ABS ≤ 26 — that would be the clause's own measured benefit disappearing, which is a cost to record, not a bug |

**P2 is the claim.** P3 is the same mechanism on a second capability, and it is what separates "the
clause suppresses IE" from "IE is broken for an unrelated reason".

## 5. Stop rule and revert rule

- One dispatch. A direction from one run, not a finding; a second run is required before anything is
  adopted into the shipped configuration.
- **If P2 holds**, `entityIdentityClause` becomes route-scoped (`abstention` only, where it was
  validated) rather than global, and the change is registered with its own A/B on ABS.
- **If P2 fails**, the clause stays on and this document records the elimination. The next candidate
  is the retrieval beneath the flat route, measured by the recall curve that already exists
  (`recall@1 0.408` against `recall@5 0.776` on this run's sample).
- **Never**: turn the clause off because a run without it "looks better" on one repetition.

## 6. What this does not claim

It does not claim the clause is a defect. It was validated where it was measured and it earns its
keep there. The claim under test is narrower: **that a sentence which licenses declining, installed on
a route whose retrieval is the weakest thing in the system, was never measured on that route.**

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

## 7. Post-dispatch correction, written before the result exists

**Dispatch `40427127569` was already queued when this section was written, and it is written now rather
than after reading the artifact.**

The hypothesis in §2 is **wrong at the code level**, and one `rg` says so:

```
$ rg -n "buildConservativeQaPrompt" packages/cortex-eval/src
natural-language-memory.ts:856:      return buildConservativeQaPrompt(q, c, token ?? DEFAULT_ABSTAIN_TOKEN, {
```

One call site. It is the `conservativePrompt` closure built inside the **abstention** route, and
`entityIdentityClause` is passed to that closure and to nothing else. So the sentence **cannot reach
the flat route that IE and KU travel**. P2 and P3 predict a movement the treatment cannot produce, and
they will be refuted — which is the correct fate for a prediction registered against a mechanism that
was not where I said it was.

**The run is not wasted, and it is not re-specified.** Its three readings are:

1. **P2 and P3 refuting** — an elimination, and eliminations are what this file's §5 promised to
   record. The clause is not the cause of the IE collapse.
2. **The ABS arm of the clause's own attribution** — run `35097952715` measured 26/30 with the clause
   removed. If this run reproduces ~26/30, that +3 is confirmed on a second run and the clause keeps
   its keep; if ABS stays at 30/30, the +3 does not reproduce and that verdict needs its own look.
3. **P4 becoming the strictest test in the file.** If IE, KU, MR and TR move at all, the routes are
   not what §2 and the code both say they are, and the more interesting finding is that a switch
   documented as unreachable from four routes is reachable from them.

**What replaces the hypothesis is not another guess.** The three runs in §1 have eliminated the
corpus, the cache and throttling; §7's remaining candidate is the **ask and the evidence it is given**,
and that is measured from an artifact already on disk rather than by another dispatch. The next
document records that measurement; a second dispatch happens only after it.

## 8. Result: three of five predictions refuted, and the fourth is unmeasurable

Run **`40427127569`**, 500 questions, `entity_identity_clause=0`, everything else byte-identical to
`40408635007`.

| | control (`40408635007`, clause **on**) | treatment (clause **off**) | Δ |
| --- | --- | --- | --- |
| overall | 44.60% (223) | **44.00% (220)** | −3 |
| IE | 1/150 | **1/150** | 0 |
| KU | 0/72 | **0/72** | 0 |
| MR | 105/121 | **104/121** | −1 |
| TR | 87/127 | **85/127** | −2 |
| ABS | 30/30 | **30/30** | 0 |
| `decisionReasons` | `{llm: 249}` | `{llm: 247}` | −2 |

| # | prediction | measured | verdict |
| --- | --- | --- | --- |
| **P1** | config reads `entityIdentityClause=off` | `featureConfig.entityIdentityClause: false` | **met** |
| **P2** | IE ≥ 51/150 | **1** | **refuted** |
| **P3** | KU ≥ 30/72 | **0** | **refuted** |
| **P4** | MR, TR, ABS each move ≤ 5 | −1, −2, 0 | **met** |
| **P5** | ABS does not fall below 27/30 | **30/30** | **met — vacuously** |

**P2 and P3 failed exactly as §7 predicted they would**, for the reason §7 gave: the clause is bound to
the abstention route's prompt builder and cannot reach the flat route IE and KU travel. The prediction
was written against a mechanism that was not where I said it was, and refuting it is the correct
outcome rather than a wasted run.

**P5 is the interesting one, and it is not a pass.** The prediction was a floor, and the floor was not
reached from above because **it cannot be**: ABS reads 30/30 **with the clause and 30/30 without it**.
The +3 that run `35097952715` measured (29/30 → 26/30) has no room to appear in a 500-question run
whose ABS column is already saturated. So this run does not confirm the attribution, does not refute it,
and **cannot**: a treatment measured against a control at the ceiling is unmeasured, not null.

### 8.1 What the run does establish

**On this configuration, the clause is a no-op across all five capabilities.** Every column moved by
0, 1 or 2 questions. The four readings this arm now has are 219, 221, 223 and 220 — a mean of 220.75 and
a range of 4 questions (0.8pp) — so a 3-question overall delta is inside this arm's own measured
repetition spread and is not evidence of anything.

That is worth stating plainly: **a sentence shipped in the abstention prompt, with an attribution note
claiming +3, produces no measurable effect on 500 questions in the configuration that ships.** It is not
therefore wrong — the note's +3 was measured against a control that was not at the ceiling — but the
repository has been carrying a component whose contribution it cannot demonstrate, and that state is
now recorded rather than assumed benign.

### 8.2 What is not concluded

- **Not** "delete the clause." Its own experiment had a sub-ceiling control; this one does not. Removing
  a component because the only test available is saturated would be the same error as adopting one.
- **Not** "IE is broken because of a prompt." IE's collapse is a retrieval fact, quantified in
  `MEASURE-BASELINE-DRIFT.md` §8.8: the gold phrase reaches the delivered context for **4 of 150**
  questions, so the reader's ceiling is 2.7%.

### 8.3 The measurement this configuration cannot make

To test the +3 again, ABS must have headroom. Two ways, and both are dispatches rather than edits:
a configuration whose ABS sits below 30/30 (the pre-`enumerated` ask is one), or the original
`35097952715` protocol reproduced exactly. Until one of those runs, the note in
`natural-language-memory.ts` stands as a measurement made **under conditions this benchmark no longer
produces** — which is a weaker claim than the note's phrasing suggests, and is now stated.

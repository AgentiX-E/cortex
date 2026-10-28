# Pre-registration: an assumption ledger, and what it has to beat

**Status:** written before implementation. The criteria in §5 are fixed now so that the numbers in
§6 cannot be chosen after the fact. Nothing in this file has been run.

---

## 1. The observation this answers

> "For information without a time or other qualifier, do we still extract the fact? I think we must —
> but we should record an **assumption** alongside it: things that are derivable but may be wrong or
> may easily change, such as the time the memory or the conversation was ingested. These
> assumption-carrying facts are exactly what later ingestion and later retrieval should progressively
> **correct or forget**."

The first half is already the system's behaviour: `KnowledgeFact.at` is optional and a fact without a
time is still stored. What does not exist is the second half — the record of _what was assumed in order
to store it that way_, and any mechanism that treats those assumptions as revisable objects.

This is not a confidence score. A score is a number nothing calibrates, and the closest published
evidence says it is also the wrong choice: reliability estimated from the text is manipulable, and
capping trust by **provenance** rather than by self-reported confidence is what survived a poisoning
experiment (arXiv 2606.22030). An assumption is a different kind of object: a **named, derivable,
disprovable** proposition whose only fields are where it came from, how many observations have
supported it, how many have contradicted it, and whether it is still open.

## 2. What the field already has, and the gap this fills

| Work                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                    | What it does **not** do                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ATMS** — de Kleer, _An Assumption-Based TMS_, AI 1986                        | An assumption is a first-class node; every derived datum carries the **minimal set of assumptions** under which it holds; a contradiction produces a **nogood** and invalidates only the environments that contain it                                                                                                                                                                                                           | Its guarantees are explicitly _relative to the supplied assumptions_. It "does not decide whether the assumptions … are true or empirically warranted", and it has no operator for repairing them. No notion of time, ingestion, or forgetting.                          |
| **ISO-TimeML / TimeML** — ISO 24617-1                                          | When a text gives no time, the **document creation time** is the default anchor; `anchorTimeID` points at it, and `functionInDocument` distinguishes `CREATION_TIME` / `PUBLICATION_TIME` / `RECEPTION_TIME`                                                                                                                                                                                                                    | A document standard, not a memory. It says which anchor to use; it says nothing about revisiting the anchor when later text dates the event.                                                                                                                             |
| **NELL** — Carlson et al., AAAI 2010 / 2015                                    | A **two-tier** KB: candidate facts carry provenance and confidence, and the Knowledge Integrator promotes, demotes and discards them over iterations                                                                                                                                                                                                                                                                            | Promotions are about _belief strength_, not about which **premise** was assumed. A demoted belief leaves no record of what was assumed when it was promoted.                                                                                                             |
| **Graphiti / Zep** — arXiv 2501.13956, source reviewed                         | Four timestamps per edge; `valid_at` is derived from the episode's **`reference_time`**, so "Alex moved in June" is anchored to June and not to when the pipeline ran. Contradiction **expires** the older edge instead of deleting it                                                                                                                                                                                          | The anchor is a field, not a proposition: nothing records "this edge's validity window rests on the reference time because the sentence named no time", so nothing can revisit that decision or report it.                                                               |
| **Mem0** — arXiv 2504.19413, prompt reviewed                                   | An ADD-only extractor, then an application-level DELETE when new information contradicts                                                                                                                                                                                                                                                                                                                                        | The published prompt explicitly forbids the extractor from deleting. Stale facts stay until the application notices, and nothing marks _why_ a fact was believed.                                                                                                        |
| **STALE / CUPMEM** — 2026                                                      | Formalises **implicit conflict**: Type I co-referential (same attribute, incompatible value, no explicit negation) and Type II **propagated** (an upstream attribute changes and invalidates a downstream belief that was never mentioned)                                                                                                                                                                                      | Detection is an LLM judgement over the dialogue. The dependency that propagates is common sense, not a recorded assumption.                                                                                                                                              |
| **PACMI** — _Provenance-Aware Cascading Memory Invalidation_, arXiv 2610.05732 | 100 cases / 300 queries. Invalidation **cascades** along declared derivation links; non-destructive, so historical queries still work. 0.99 final accuracy vs 0.90 for an A-MEM-style baseline; **stale-premise queries 0.97 vs 0.71**. Ablations: removing premise checking → 0.83; removing historical preservation → historical accuracy 1.00 → 0.36; removing cascade → 3 errors become 11, **p = 0.0574, not significant** | States its own boundary: it "does not solve open-ended provenance extraction; it evaluates read-path behaviour **conditional on derivation links being represented or supplied**". The links are given; how a system _earns_ them from text is exactly the open problem. |
| **Nous** — arXiv 2606.22030                                                    | Bayesian belief updating per entity–attribute; **negative result**: on LoCoMo, belief updating gives "little benefit over naive last-write-wins" because conversational benchmarks "rarely contain contradictory or differently reliable evidence". On a **controlled contradiction benchmark** it wins substantially                                                                                                           | Establishes the methodological constraint below: a benchmark without contradictions cannot measure this, so one has to be built.                                                                                                                                         |
| **Memora** — ACL 2026 Findings                                                 | Introduces **FAMA**, which penalises reusing invalidated information rather than only failing to retrieve current information                                                                                                                                                                                                                                                                                                   | A benchmark; no mechanism.                                                                                                                                                                                                                                               |

**The gap, stated precisely:** every one of these either (a) records _when_ a fact was learned but not
_what was assumed_ to place it there, or (b) records propagation over dependency links that somebody
else supplied. Nobody makes the assumption itself a **stored, countable, revisable** object whose
retraction is what drives invalidation.

That is the claim this iteration tests, and §5 is how it can fail.

## 3. The model

### 3.1 Six kinds, each derivable from the frame without a model

Every assumption below is computed from `KnowledgeFact` + `KnowledgeFrame` by a pure function, so the
same input always yields the same ledger and a diff between two exports shows only real change.

| Kind             | Asserted when                                                                | Value                                                     | What revises it                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `time-anchor`    | the fact has no `at`, so it is anchored to the frame's `at` (ingestion time) | the anchor timestamp, plus `ingestion-time` as its origin | a later frame that dates the same slot explicitly (`"that was last year"`) **refutes** the anchor and replaces it         |
| `persistence`    | any fact that is not explicitly bounded stays true                           | `open`                                                    | a later fact on the same slot with a different value or polarity **refutes** it; a later fact that agrees **confirms** it |
| `uniqueness`     | a fact asserts a value for a single-valued slot (subject + predicate)        | `open`                                                    | a second, simultaneous value **refutes** it (that is a real contradiction, not an update)                                 |
| `attribution`    | the fact carries a speaker                                                   | that speaker                                              | a frame with a different speaker asserting the same slot does not silently transfer it                                    |
| `entity-binding` | a fact borrowed a word from context (`references`)                           | the borrowed source id                                    | a later frame that binds the same token differently **refutes** it                                                        |
| `completeness`   | a fact enumerates a set ("two cats")                                         | the count                                                 | a later frame that adds a member **refutes** it and the count is corrected                                                |

Three of these (`time-anchor`, `persistence`, `uniqueness`) are the load-bearing ones. The other three
exist because leaving them out would make the ledger a lie by omission: a fact whose pronoun was bound
to a guess is _more_ assumption-carrying than one that was not.

### 3.2 State, and why there is no confidence number

```
open ──confirm──► confirmed ──contradict──► refuted
  │                    │
  └────expire──────────┴──────► expired
```

`support` and `contradict` are integer counts of **observed frames**, not probabilities. The distinction
matters: a count can be recounted by anyone holding the frames, a probability cannot. `expired` is
different from `refuted` on purpose — a `persistence` assumption that has gone untested for a long time
is not disproven, and treating it as though it were is how a memory system starts deleting true facts.

### 3.3 Cascading, and the published reason to be suspicious of it

When a `persistence` assumption is refuted, facts whose own assumptions were derived _from that fact_
are marked `stale`. This is PACMI's cascade, with one difference that is the point of this design: PACMI
cascades over **declared derivation links**, and here the link is the assumption's own provenance, so the
chain exists because the system recorded it rather than because a benchmark supplied it.

PACMI's own ablation is the reason the cascade is a **switch and not a default**: removing it moved 3
errors to 11 and did **not** reach significance (p = 0.0574). A mechanism that does not pay must be
measurable in the off state, so `cascade: false` ships.

## 4. The benchmark, and why it has to be built

arXiv 2606.22030 is unambiguous: belief-updating machinery shows "little benefit over naive
last-write-wins" on LoCoMo because the corpus contains almost no contradictions. LongMemEval is the same
shape — its knowledge-update questions are ~22% of the set, and our own failure census already found the
one that matters (`25:50` vs `27:12` both in context, the older one chosen).

So the ablation runs on a **controlled contradiction set**, deterministic and generated in-repo, in the
shape the published benchmarks use:

| Scenario family         | What it isolates                                                                                    | Source of the shape       |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------- |
| `type-i` co-referential | same slot, incompatible value, no explicit negation                                                 | STALE Type I              |
| `type-ii` propagated    | an upstream slot changes and silently invalidates a downstream fact                                 | STALE Type II             |
| `stale-premise`         | the answer-bearing claim is correct, one of its premises is not                                     | PACMI Q2                  |
| `historical`            | the question is about a past state and must return the superseded value                             | PACMI's historical arm    |
| `false-stale` control   | an update exists but is **outside** the query's valid-time window, so marking it stale is the error | PACMI's specificity cases |

Each case carries a gold answer, the fact that answer depends on, and the exact premise that must be
invalidated. The oracle is structural: no LLM judge, no tolerance.

## 5. Pre-registered criteria

Fixed before implementation. Each is a command, not an opinion.

### 5.1 Extraction path

| #      | Endpoint                                                                                                          | Pass                                                           | Why this number                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **E1** | Ledger coverage: every fact whose `at` is absent carries a `time-anchor`; every fact carries `persistence`        | **100%**                                                       | It is an accounting rule. A ledger that records 97% of what it assumed cannot be audited.                    |
| **E2** | Revision verdicts on the controlled set: `refuted` when gold says superseded, `confirmed` when gold says agreeing | **≥ 95%**, and **0** refutations on the `false-stale` controls | A false refutation deletes a true fact, which is worse than a miss; the control arm is the specificity gate. |
| **E3** | Zero invented fields: no assumption whose `derivedFrom` cannot be recomputed from the frame                       | **0**                                                          | Same rule as `evidenceSpan`: an unlocatable premise is an invention.                                         |
| **E4** | `strict` unit gate still passes on the 20 reviewed pairs                                                          | **15/20 unchanged**                                            | The ledger must not become a way around the relation gate.                                                   |

### 5.2 Retrieval path

Three arms over the same cases, same budget, same ranker:

| Arm            | Behaviour                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `R0 flat`      | today's behaviour: facts retrieved, no assumption participates                                                                                                                                         |
| `R1 annotated` | assumption state rendered into the context block, ranking unchanged                                                                                                                                    |
| `R2 gated`     | refuted `persistence` excluded from the default answer path but kept for historical queries; open-and-aged `persistence` discounted by a fixed half-life; `time-anchor` facts labelled with the anchor |

| #      | Endpoint                                 | Pass                                                                                                                                                                 |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | `stale-premise` accuracy: R2 − R0        | **≥ +10 pp**, one-sided, exact McNemar                                                                                                                               |
| **R2** | `historical` accuracy: R2 vs R0          | **no regression** (≥ −2 pp)                                                                                                                                          |
| **R3** | `false-stale` rate                       | **≤ 2%**                                                                                                                                                             |
| **R4** | `type-ii` (propagated) accuracy: R2 − R0 | reported, **not gated** — the published cascade ablation did not reach significance, so demanding one here would be demanding a result the evidence does not support |

### 5.3 Ablations, on the retrieval path

Each removes one assumption kind from `R2` and re-runs, same cases:

| Ablation       | Question                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| `−persistence` | is the persistence ledger doing the work, or is the labelling?               |
| `−uniqueness`  | does single-value reasoning add anything over plain supersession?            |
| `−time-anchor` | does anchoring an undated fact change any answer, or only the presentation?  |
| `−cascade`     | does propagation pay at this scale? (Prior: probably not — PACMI p = 0.0574) |

### 5.4 Stop and revert rules

- A single run is a direction; two runs with the same sign is a finding. The controlled set is
  deterministic, so "run" means a fresh process, and disagreement between two runs is a bug, not noise.
- If **R1** fails, the ledger stays as an audit field and does **not** ship as a retrieval signal.
- If **R2** regresses beyond −2 pp, `refuted` exclusion is withdrawn even if R1 passed: losing the
  ability to answer "what did it used to be" is the failure PACMI measured at 1.00 → 0.36.
- If E1 or E3 fails, nothing downstream is read at all.

## 6. What the numbers will and will not mean

The controlled set is synthetic and small by design: it isolates one mechanism per family, which is what
makes an ablation readable and also what makes an absolute accuracy meaningless. No number from it may be
quoted as "cortex scores X" — only as a **delta between arms on this set**.

The real test is an A/B on LongMemEval-S, and that has two problems this iteration cannot solve: the raw
contradiction density there is low (§4), and the run needs the runner. It is registered as **A8**, after
A7, and it is the only place a claim about the benchmark may come from.

## 7. Threats to validity, named now

1. **Synthetic conflicts are easier than real ones.** The generator writes the premise and the update;
   a real conversation buries both. A pass here is necessary, not sufficient.
2. **The oracle is structural, so it cannot see a better answer.** If a system answers a historical
   question correctly by a route the oracle did not anticipate, it scores zero. Accepted: the alternative
   is an LLM judge, which the project has already measured as the weaker instrument.
3. **`time-anchor` may be unfalsifiable in this set.** Every ingestion timestamp is known exactly, so the
   anchor is never wrong; its value is only in being _recorded_. E2 therefore does not test it, and the
   ablation `−time-anchor` is expected to be inert on accuracy — that expectation is written here so a
   null result is not later sold as a discovery.
4. **Six assumption kinds is a vocabulary, not a validated taxonomy.** The three load-bearing kinds are
   derived from the three ways a stored fact can be wrong about _when_, _whether_, and _how many_; the
   rest are recorded because omitting them would make the ledger incomplete. A seventh kind will appear
   the first time a real export shows a fact that is wrong for a reason none of the six names.

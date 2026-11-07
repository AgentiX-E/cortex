# Decision: three external reviews, and what the project changes because of them

Three analyses were put in front of this repository on 2026-11-07: a direction card on MEME
(`MEME方向决策卡`), a programme-level review of SOTA progress (`cortex_SOTA深度分析`), and a
five-phase MEME roadmap with a dependency-propagation design (`MEME依赖传播与SOTA路线`). This
document records what each one establishes, what it gets wrong, and the five decisions that follow.
Every claim below carries a path or a run id, because a review read without checking is a second
opinion mistaken for a measurement.

---

## 0. The five decisions

| # | decision | because |
| --- | --- | --- |
| **D1** | The target becomes three decidable lines, not "overall SOTA" | Two of the three are already met; the third is the only reading where we are genuinely behind, and it is free to read |
| **D2** | No MEME campaign. A 10–20 episode slice, gated behind three unfinished settlements | The reference pipeline inside our own artifacts is 3.30 points ahead on `MR`; starting a new arena from zero while that is unread is the most expensive option available |
| **D3** | `derivedFrom` keeps the shape already decided; nothing is built until D2 says the graph is the binding point | `DECISION-PROVENANCE-NODE.md` §3.1 settled the shape and `ARCHITECTURE.md` line 91 says why |
| **D4** | The `⊥` answer contract is its own item, not a MEME dependency | It is a real gap (`assumption.ts` has a boolean gate and no unknown), and it serves `ABS` on the benchmark we already run |
| **D5** | A stop rule, and "who consumes it" as an entry condition | Both reviews propose one; neither proposes a version with a number in it, so this one has numbers |

---

## 1. The direction card: three charges, two upheld and one needing a sharper line

### 1.1 Upheld — the coverage band was used backwards

The card says the roadmap's §0.4 cites `MEME 证据覆盖率 35.69–76.35%` as evidence that MEME is an
unsaturated arena worth entering, and that this inverts what the repository already wrote.

Verified against `cortex-docs/docs/05-competitor-analysis.md` §1.17.4:

> 论文说的那个"覆盖不足"的区间（19%–76%）我们已经走出了，而我们还差 4 分——所以剩下的 4 分不在覆盖率上，在排序质量上

and §1.17.5:

> 同一条机制在两个覆盖率区间上的期望收益不能互相搬运

Our own coverage, measured by `tools/evidence-depth.py` (§13.239), is **69.7%–100%**, with three of
five routes above 84%. The 35.69–76.35 band is the **other systems'** coverage in the MEME paper.
It is not our result, and "somebody else covers 36–76% of MEME" is not a statement that MEME is
unsaturated for us — it is a statement that those systems would gain from reranking and we would
not. The card is right, and the consequence is narrow: **the roadmap cannot borrow that number.**

### 1.2 Upheld — the P0 would rebuild something deleted, and `cascade` is not missing

`ARCHITECTURE.md` line 91:

> A speculative `ProvenanceNode` type once stood in for this and read no code; it was deleted rather
> than kept as a shape without a graph. The remedy is a `derivedFrom?: string[]` field on `Fact`,
> not a parallel table.

`docs/DECISION-PROVENANCE-NODE.md` §3.1 adds the mechanism of the failure:

> `ProvenanceNode`'s error was structural: it made provenance a **sibling** of the domain types
> instead of a property of them, which is why it has no consumer.

And the cascade the roadmap lists as missing is present: `packages/cortex-core/src/knowledge/revision.ts`
declares `cascade?: boolean` (line 65), returns early unless it is exactly `true` (line 243), and
propagates `stale` through `function cascade(...)` (line 292). What is genuinely missing is the
**edge** — a fact derived from three memories cannot be told apart from one asserted directly.

### 1.3 Needs a sharper line — `Derivation` is not automatically a parallel table

The card treats "`Fact.derivedFrom` plus a versioned `Derivation` object" as one shape and rejects
both. The two are different granularities and only one of them is the failure mode:

| record | holds | may it decide whether a fact exists |
| --- | --- | --- |
| `Fact.derivedFrom?: string[]` | the ids of the facts this one was derived from | **yes** — it is the fact's own row |
| `Derivation` | rule id, rule version, premise bindings, evidence spans, computation version | **no** — it is a proof record, not a source |

`ProvenanceNode` died because it was a **sibling** of the domain types: nothing pointed at it, so
nothing read it. A `Derivation` that is reachable only from a `proof_id` on the fact, and that is
forbidden from asserting anything the fact row does not already assert, is a **proof**, not a second
authority. The distinction is worth writing down precisely because it is the only thing separating
the design from the shape that was deleted — §22.42 in the external design doc carries it.

---

## 2. The programme review: the diagnosis holds, two numbers have moved, one prescription is off

### 2.1 What holds, and it is the part that matters

- **There is no capability regression.** The apparent fall is three things compounding: several
  scoring scales coexisting and being quoted interchangeably, a target that keeps moving because it
  is other people's self-reported headline, and measurement discipline tightening. The repository
  says so itself: `SOTA-BASELINE.md` records "citing a frozen number as the current score" as a P0
  defect.
- **"Overall SOTA" is not an operable target.** This document agrees without reservation. The
  comparison rules already refuse to rank systems whose six-tuple differs (`--gap` prints no
  ordering), so a per-round KPI of "are we SOTA" is a KPI the project has proven it cannot compute.
- **No credible ETA under that definition.** Accepted, and the reasoning is the repository's own.

### 2.2 Stale number 1: the `MR` gap has halved

The review reads the memory arm at **76.86–77.69%** against the reference pipeline's
**85.12–86.78%**, a gap of 7.43–12.4 points, and calls it the one genuinely lower reading.

That was true of the artifact the review saw. It is no longer the reading. `42337560027`
(`ask=verbatim-acts`) moves `MR` to **81.82%** (99/121, 8 won / 3 lost, p = 0.2266) against the same
reference arm's 85.12%, so the gap is **−3.30**, not −7.43. §13.294 has the gate table.

The review's *conclusion* survives the correction — we are still behind the pipeline we ship beside —
but the size of the deficit changed by more than half in one dispatch, and a decision taken on −7.43
would have over-allocated to it by a factor of two.

### 2.3 Stale number 2: the per-question cost is 12,105, not 14.1K

The review quotes 14.1K tokens per question. The current reading, from `42310779222` through
`tools/cost-ledger.py`, is **12,105** per question per repetition, with the two other defensible
divisions at 11,690 (per call) and 48,420 (per question across all four repetitions). The spread is
4.14x and the choice of denominator is stated in `acceptance.ts` row `C1`.

This is not a nitpick: the review makes the cost argument ("1.9–3.9x the leaders") *and* observes
that the project has a unit problem. Both are right, and the second is why the first had to be
re-derived — §13.293.1 records that the first draft of `cost-ledger.py` had the denominator wrong
too.

### 2.4 The prescription needs replacing, and here is the mechanism

The review says the product and the evaluation are two implementations, and recommends connecting
them. Verified, this is **half true in a way that changes the next action**:

- `packages/cortex-eval/src/bench-memory-arm.ts` imports `cortex-memory` **type-only** — the reason
  is stated at lines 422 and 450, the acyclicity rule between the packages. The feature arm's
  `CortexMemory` instance is injected by `cortex-memory/bench/run-ablation.ts`.
- The `ask` instruction text lives in `packages/cortex-memory/src/prompt.ts` (`instructionsFor` at
  line 1855, `VERBATIM_MULTI_SESSION_INSTRUCTION` at 1479, `VERBATIM_ACTS_MULTI_SESSION_INSTRUCTION`
  at 1594). When that file changed, the artifact's prompts changed: **94 of 94 reachable `MR`
  prompts carry new bytes** (§13.294.2).

So the **prompt-contract layer is connected**, and it is where this campaign's recent gains came
from. What is *not* settled is the layer below it: whether `cortex-core`'s **value gates** — the
assumption ledger, temporality, uniqueness — help a score on real corpora. That is what `A8` and the
`cortex-memory` A/B are for, and neither has been dispatched.

The correct action is therefore **dispatch the A/B that is already assembled**, not rebuild a
pipeline that is already half-connected. `README.md`'s Status paragraph is the source of the
confusion and is corrected in §22.42: it explains that `cortex-core` is not the engine, which readers
reasonably hear as "the product is not connected".

---

## 3. The roadmap: three real assets, one unusable artefact, one wrong phase order

### 3.1 Refused as P0

`Fact.derivedFrom` + `DerivationStore` + scoped delta is refused as a first action for the reason in
§1.2: the shape is decided, and nothing consumes it yet. A field with no reader is the defect
`AUDIT-UNREFERENCED-*` exists to catch.

### 3.2 Not evidence

The roadmap cites `/data/workspace/meme_dependency_engine.py` and `meme_engine_selftest.txt` as a
prototype with 16 passing assertions. Neither file is in either repository, so nothing here can be
re-run. The direction card reached the same conclusion. It is recorded as an unreproducible claim and
is not used to support anything below.

### 3.3 Three assets worth keeping

1. **The `⊥` answer contract is a real gap.** `packages/cortex-core/src/knowledge/assumption.ts` line
   170 is `isAnswerable(fact): boolean` — `stale` returns false, a refuted `persistence` returns
   false — with `assumptionPenalty` as a numeric discount beside it. That is a **two-valued gate and
   a score**, not an unknown. The system can say "this fact does not count" but has no first-class
   way to say *"under the current premises there is no rule"*, which is exactly what MEME's Absence
   asks for.
2. **Stratified negation is the correctness condition for that contract, not an optimisation.** For
   `R(x) :- A(x), not B(x)`, `not B` is only decidable after `B`'s stratum has reached its fixpoint.
   A `⊥` emitted before that is a lie. Whoever implements D4 has to carry this.
3. **Incremental maintenance (`Δ⁺ = desc(anc(Δ))` with early cutoff) is the right complexity story**
   — but it presupposes a graph. It is sequenced after D2, not before.

### 3.4 The phase order is wrong, and the roadmap says so itself

§五 of the roadmap: *"应先检查覆盖率与 reader 输入形状，而不是先上复杂图算法"*. §六's P0 then does
the opposite. The direction card noticed the same contradiction. This document resolves it in favour
of §五, because our own measurements point the same way: §13.291 moved every gold turn into the `MR`
prompts and bought **+0.00**, and §13.294.3 measured that an instruction edit silently displaces
about twice its length in evidence. In this harness the shape of what the reader sees moves more than
the amount does.

### 3.5 The external hook, at its actual evidence grade

RAW-RAG's phase-visible oracle is quoted as **82.32 / 91.54** for DeepSeek-V4-Flash against **1.83 /
36.15** for GPT-4o-mini on Cas / Abs — which, if true, says MEME's 3%/1% is a reader-and-assembly
problem rather than a graph problem. Both upstream documents label this as second-hand Chinese
coverage of `arXiv:2610.30755` needing the original. It is therefore **a hypothesis with a cheap
test**, not a finding. D2 is designed to be that test: 10–20 episodes, existing raw-turn retrieval,
chronological assembly, no graph.

---

## 4. What "done" means now (D1)

`SOTA-BASELINE.md` keeps one frozen anchor and one registered configuration. The programme needs a
target it can adjudicate, so the target becomes three lines with explicit comparison rules:

| line | reading | status | comparison rule |
| --- | --- | --- | --- |
| **T1** reproducible A-grade first | 90.15% against memoricai's 85.8% | **met** | same-harness, A grade only |
| **T2** parity at the same reader grade | 90.15 / 90.40 against Recallium's 90.2 (GPT-4o) | **met** | judge differs; claim is "not behind", not "ahead" |
| **T3** `MR` inside the reference-pipeline pair | 81.82% against 85.12%, **−3.30** | **open** | one artifact, same reader, same judge, same questions |

T3 is the only line where the project is behind something it controls end to end, and it is the only
line that can be moved without a new arena, a new reader, or a new dataset. D1 therefore moves the
campaign's weight onto it.

What this retires: "are we SOTA" as a per-round required field. The round report keeps the paired
delta, the six-tuple and the grade, which are the three things that can be computed.

---

## 5. What is refused, explicitly

| refused | reason |
| --- | --- |
| The five-phase MEME campaign | §3.4's own order plus a scale mismatch: five phases over six benchmarks is months, against a budget stated in weeks and one currency figure |
| `derivedFrom` / `DerivationStore` as a first action | §1.2 — the shape is decided; the consumer is not |
| Moving to BEAM-10M now | at 1M–10M tokens the binding constraint is the window and the retrieval cost, neither of which this arm has measured; and the 28.17% multi-session figure is one self-reported number on a leaderboard this project has already ruled unrankable |
| Chasing the 96–98.4% self-reported top | the project already graded it C and measured that a stronger reader costs −7.20 points here |
| Editing `tools/gates/13.290.json` after the fact | §13.294.2 — that is the failure the file format prevents. The correction lives in `13.295.json` |

---

## 6. What changed in the code and the documents this round

| artefact | change | why |
| --- | --- | --- |
| `packages/cortex-ai/src/llm/openai-compatible.ts` | `complete` no longer assumes the response body is an object | run `42347151147` died at question 88 of 500 on `TypeError: Cannot read properties of null (reading 'usage')`; the provider had answered `200` with the body `null` |
| `packages/cortex-ai/src/__tests__/openai-compatible-empty-body.test.ts` | 8 tests | four traps: `null` is not absent, an empty body throws instead of returning `null`, a non-string `content` is not an answer, and the retry ladder has already finished by the time the body is read |
| `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.296 | the failed dispatch and the repair | a 135-second dispatch was discarded by one empty answer; the repair makes it one question |
| `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.297 | this decision, as a queue change | the queue is where a decision becomes work |
| `docs/SOTA-LANDSCAPE.md` §15 | MEME at its evidence grade, and the three target lines | the external board is one of two documents that answer "where do we stand" |
| `cortex-docs` 01 §6.17 | what the product's target is now | a whitepaper that promises "SOTA" promises something unadjudicable |
| `cortex-docs` 02 §22.42 | the `derivedFrom` / `Derivation` boundary, the `⊥` gap, and the README correction | the boundary is the only thing separating the design from the deleted shape |
| `cortex-docs` 03 §14.69 | queue, entry conditions, stop rule | plans are the only document that can hold a gate on *starting* |
| `cortex-docs` 05 §1.43 | the coverage band read correctly, and MEME's board | the band was misquoted once; the correction has to live where the band lives |

---

## 7. The next three dispatches, in order

1. **Re-run §13.295** (`multi-session:48460`, `ask=verbatim-acts`). The registration is unchanged; the
   run only needs a transport that does not die on an empty body. It is the last unsettled variable
   on `T3`, and it decides whether the +4.13 belongs to the rule or to the evidence it displaced.
2. **Dispatch `A8`** (`gated` context against the current context). `MEASURE-ASSUMPTION-ABLATION.md`
   §4 predicts a null. A null is a result: it would say the value gates earn nothing on real corpora.
3. **Dispatch the `cortex-memory` product A/B.** The one decision this campaign has been avoiding —
   whether the cognitive layer helps a score — and the only one that changes what the product *is*.

MEME's slice does not start until all three have readings, and the order is not negotiable: each of
the three is cheaper than the slice and each one changes what the slice would mean.

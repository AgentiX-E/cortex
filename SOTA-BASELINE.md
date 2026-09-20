# Cortex — LongMemEval-S SOTA Baseline

This document freezes the current LongMemEval-S position of Cortex as a reproducible
baseline: where we stand, which capability each gap lives in, what has been validated,
and what the hard constraint on further gains is.

**Measured on:** `master` @ `a52628f` (revert of the DCG experiment), DeepSeek LLM +
Zhipu GLM embedding-3, temperature 0, full N=500, 4 interleaved runs.

> **This is a historical measurement, not a description of current `master`.**
> `a52628f` is **55 commits behind** `master` @ `31a3371`, and the evaluation harness
> changed substantially in between: `packages/cortex-eval/src` gained **8,326 lines
> and lost 227** across 30 files. Every capability number below is therefore an
> *anchor from the DCG-revert point*, useful for measuring deltas against that exact
> revision — it is **not** the current score, and should not be quoted as the current
> state without re-running. See
> [`docs/AUDIT-CODE-VS-DOCS.md`](docs/AUDIT-CODE-VS-DOCS.md) §2 for the drift detail
> and the reproduction command.

---

## 1. Position

| System | Overall | Reader |
| --- | --- | --- |
| Claude Opus 4.6 | 95.6% | Claude Opus |
| GPT-4o (raw reader) | 92.6% | GPT-4o |
| Hindsight | 91.4% | Gemini 3 Pro |
| HydraDB | 90.79% | Gemini 3.0 Pro |
| Emergence | 86.0% | GPT-4o |
| AgentOS | 85.6% | GPT-4o |
| Supermemory | 85.2% | Gemini 3 Pro |
| Mastra OM | 84.23% | GPT-4o |
| **cortex** | **83.55%** | **DeepSeek** |
| Original paper GPT-4o Oracle | 82.4% | GPT-4o (gold sessions only) |
| Original paper full-context | 63.8% | GPT-4o |

Cortex sits **above the original paper's Oracle baseline** (82.4%, which is handed the
gold answer sessions) and within ~0.7–1.7pp of the Mastra/Supermemory commercial tier —
**while using a strictly weaker reader (DeepSeek) than every system above it.**

## 2. Per-capability decomposition (current baseline, 4 runs pooled)

| Capability | Correct | Accuracy | Abstention | Wrong |
| --- | --- | --- | --- | --- |
| IE (single-session) | 567/600 | **94.50%** | 2.3% | 3.2% |
| MR (multi-session) | 373/484 | **77.07%** | 8.1% | 14.9% |
| KU (knowledge update) | 226/288 | **78.47%** | 3.8% | 17.7% |
| TR (temporal) | 385/508 | **75.79%** | 7.3% | 16.9% |
| ABS (abstention) | 120/120 | **100.00%** | 100% | — |
| **Overall** | **1671/2000** | **83.55%** | — | — |

The dominant error mode has shifted from **abstention** (largely fixed) to **wrong
answers**, which now outnumber abstentions 2–7× on MR/KU/TR.

## 3. Validated fixes (all ACCEPTED, in `master`)

Each fix was gated by a same-instant 4-vs-4 A/B with an exact permutation test on a
mechanism endpoint; overall accuracy was treated as a noise-floored descriptive estimate
only (per-run within-arm spread is 6–7 questions, exceeding small effects).

| Commit | Fix | Mechanism endpoint result |
| --- | --- | --- |
| `eb1bc3c` | KU questions with no time qualifier get a selection rule instead of abstaining | KU `other` abstention 14.36% → 4.26% (−10.11pp, p = 0.0143); KU accuracy 75.35% → 79.51% (+4.17pp, p = 0.0143) |
| `4640c86` | Bound every fetch attempt with its own abort deadline | Inert guard (no LLM-pattern change); shipped alongside `eb1bc3c` |
| `a104ea0` | Route duration/age-difference questions to the derivation prompt | "current role" (3y9m − 2y4m = 1y5m) and "grandma older" (75 − 32 = 43) both 4/4 abstain → 4/4 correct |
| `a45b32a` | Expand derivation questions into operands, not activities | "Alex born" operand "32" recall 0/2 → 2/2 (p = 0.0143); 4/4 abstain → 4/4 correct |
| `bc687b9` | Annotate per-question diagnostics with the scored verdict | Observability fix (no model behavior); unlocks wrong-answer root-cause analysis |

## 4. Negative results (scientifically valuable, reverted)

| Commit | Experiment | Result |
| --- | --- | --- |
| `51b573f` → `a52628f` | DCG session scoring (rank-discounted turn gain, mirroring EmergenceMem/AgentOS) | **REJECT**: MR 77.07% → 73.14% (−3.9pp, p ≈ 0.029). LongMemEval-S MR questions are mostly single-fact; `max` turn reduction is locally optimal and DCG lets noisy mid-relevance turns outrank the single strong evidence turn. |

The DCG result is recorded as evidence that frontier heuristics do **not** transfer
blindly: each change must pass the benchmark, which is exactly why the A/B gate exists.

## 5. Why the remaining gap is a reader ceiling

The wrong-answer pool was root-caused exhaustively:

- **TR duration errors** reproduce identically across runs (deterministic), but the
  arithmetic (`daysBetween`) is correct — the error is *event-date extraction* (e.g.
  "yesterday" inside a turn) and entity disambiguation, not math.
- **MR counting errors** enumerate the items correctly but misjudge *which items count*
  (e.g. "dry cleaning ≠ store pickup"), an LLM semantic judgment, not arithmetic or
  enumeration completeness. Deterministic summation was already implemented and
  reverted (`900dcf6`/`377c34d`) because the bottleneck is extraction/judgment, not
  summing.
- **The LLM judge is sound**: semantically-equivalent surface differences
  (`"The Nightingale"` vs `"'The Nightingale' by Kristin Hannah"`) are correctly scored
  as correct — there is no evaluation bug to reclaim.

The remaining errors are heterogeneous semantic-judgment failures of the DeepSeek
reader. **83.55% is a strong result at the DeepSeek ceiling**; the residual gap to
85–95% is gated by the reader model, which is a fixed constraint in this configuration.
A stronger reader (GPT-4o/Claude/Gemini) would be the single largest lever, at the cost
of leaving the DeepSeek-only constraint.

> **Correction (2026-09-20).** The two sentences above do not survive contact with the
> published evidence and are retained only so the error is on the record.
>
> 1. **DeepSeek is not the weaker reader here.** On LongBench v2 — raw long-context
>    reading with no memory layer — DeepSeek-R1 scores **58.3** against GPT-4o's
>    **51.4**. Systems running the *same or a smaller* reader tier already reach
>    **94.87%** (GPT-5-mini) and **96.4%** (Gemini 3 Flash).
> 2. **Architecture explains far more than the reader.** Holding the reader fixed at
>    GPT-4o, the spread across systems is **37.0pp** (EmergenceMem 86.00 vs Mem0 49.00).
>    Holding the architecture fixed, swapping 20B → Gemini 3 Pro is worth **7.8pp**
>    (Hindsight). Architecture variance is **4.7x** reader variance.
> 3. Therefore 82–86% is a **pipeline** ceiling, not a reader ceiling. The binding
>    constraint is the structure of the context we hand the reader — we run no
>    reranker, our query expansion takes only top-3 per query, and we have no
>    specialised extraction channels.
>
> See `cortex-docs/docs/08-reader-parity-analysis.md` for the full attribution and the
> reproduction script. "The reader is the remaining lever" is **withdrawn**.

> **Correction (2026-09-20, second pass).** §5's second bullet — "MR counting errors
> enumerate the items correctly but misjudge *which items count*, an LLM semantic
> judgment, not arithmetic or enumeration completeness" — is **confirmed** by a
> per-question read of `benchmark-mr-diagnostics.json`, and the reason it was right
> is worth recording because the first pass got the *mechanism* wrong. For
> `0a995998` ("How many items … to pick up or return"), the model's own trace
> enumerates all three items correctly, then reasons itself down to 2 by ruling out
> dry cleaning and collapsing an exchange into one item. The failure is semantic
> attribution, not counting. A deterministic numeric gate is therefore not the fix,
> and a re-score of all 29 MR questions under `numericAnswerVerdict`'s rules
> reproduces the stored verdict exactly (22/29 = 75.9%) — it moves nothing.
>
> **Retrieval is not MR's constraint either.** In `6a1eabeb` ("personal best in the
> charity 5K run") the gold string `25:50` is present in the retrieved context at
> offset 7839, alongside the superseded `27:12`. The reader had both and chose the
> older one. This is a *knowledge-update* failure surfaced through a KU question,
> not a recall failure.
>
> **And the breadth question is now closed by measurement.** The recall curve
> (run `35498421148`, `docs/MEASURE-B2-RECALL-CURVE.md`) reports a pool `ceiling` of
> **93.02%** for answerable questions with `gain` decaying 65.12% → 2.33% from
> `k=1` to `k=20`. Only 6.98% of answerable questions are unreachable by any
> reordering, so "add recall channels" is a proposal for a ≥6.98% prize, not for
> the third that `recall@5` alone appeared to imply.

## 6. Methodology (standing)

- Same-instant 4-vs-4 A/B only; never staggered (time-of-day drift is ~1.7–2.1pp).
- Mechanism endpoints (abstention rate, operand recall, per-question correct) are
  decisive; overall accuracy is descriptive.
- Exact permutation tests, not pooled z-tests (pooling the same questions across runs
  is pseudoreplication).
- `pnpm check` green, ≥95% coverage on all four dimensions, no skipped tests.

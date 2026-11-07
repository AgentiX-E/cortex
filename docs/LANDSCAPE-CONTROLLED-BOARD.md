# The controlled board, and the five boards that are not one

Every number in `SOTA-LANDSCAPE.md` is a **citation**. This document is the layer above it: an inventory of
the boards the citations come from, the one property that decides whether two rows may be subtracted, and
an instrument reading taken on 2026-11-07 that changes what this project can and cannot say.

The conclusion up front, because it is short and it is unwelcome:

> **There is no neutral agent-memory leaderboard.** Every board is owned by a company that sells a memory
> system, and each one configures its competitors. So no external number, however high, may be used to
> claim a gap in either direction. The only grade-A gap this project owns is the one it computes against
> itself — `T3`, one artifact, one reader, one judge, one question set, **−3.30**.

Everything below is the evidence for that sentence, and the three findings that survive even though no
score claim does.

---

## 1. The five boards, and who owns each

| board | run by | how its rows are made | covers |
| --- | --- | --- | --- |
| `agentmemorybenchmark.ai` (AMB) | Vectorize — **the maker of Hindsight** | its own runs with an open harness, plus an "external results" section copied from papers | BEAM, LoCoMo, LongMemEval, PersonaMem, LifeBench, PrecisionMemBench, one coding-agent test |
| OmniMemEval | MemTensor — **the maker of MemOS** | its own runs of 14 backends on **one** setup: `gpt-4.1-mini` answers, `gpt-4o-mini` judges | LoCoMo, LongMemEval-S, BEAM 100K and 10M, PersonaMem v2, HaluMem |
| Mem0 research + compare pages | Mem0 | its own managed-platform runs, plus competitors on its compare pages | LoCoMo, LongMemEval, BEAM, tokens per retrieval |
| Zep research | Zep | its own runs, GPT-5.4 as reader **and** judge | LoCoMo, LongMemEval |
| past.dev BEAM leaderboard | past.dev | collected vendor results **plus** its own run with one model answering and judging | BEAM, all four tiers |

Two of them are same-harness (OmniMemEval, AMB's own rows). Three are collected. **All five are run by a
participant**, and in four of the five the owner’s own system leads its board
(AMB’s collected section carries higher external rows; its own runs cover one system). That is not an accusation — it is a
description of the only available evidence, and it is why the grade column in `ACCEPTANCE-MATRIX.md` is a
field of the criterion rather than a footnote.

The two same-harness boards are also the two whose owners lead them:

- OmniMemEval: MemOS leads LoCoMo at 88.83 and LongMemEval-S at 89.20. MemTensor makes MemOS.
- AMB: Hindsight is first on every BEAM tier it reports. Vectorize makes Hindsight.

And OmniMemEval's own results page carries the sentence that keeps it honest: competitor adapters *"are
not a claim that every adapter has reached a globally optimal product-specific configuration."* A
same-harness board removes the reader and judge as variables and introduces **integration effort** as a new
one. It is a better instrument than a collected board. It is not a neutral one.

---

## 2. The collected board, as of 2026-10-12

Vendor figures, checked on the source pages, none reproduced by a third party. `C` grade throughout, which
means every one of them may motivate work and none may appear in a gap claim.

| system | LongMemEval-S | LoCoMo | BEAM 1M | BEAM 10M | ran by |
| --- | ---: | ---: | ---: | ---: | --- |
| Agent Zero Memory (Zero Labs) | **95.60** | — | — | — | Zero Labs, arXiv, Aug 2026 — **setting not stated** |
| Mastra Observational Memory | **94.87** | — | — | — | Mastra, `gpt-5-mini` reader; **84.23 with `gpt-4o`** |
| Hindsight | 94.6 | 92 | 73.9 | 64.1 | Vectorize |
| Mem0 Platform | 94.4 | 92.5 | 64.1 | 48.6 | Mem0 |
| Honcho | 90.4 | 89.9 | 61.8 | 40.9 | Plastic Labs |
| Zep | 90.2 | 94.7 | — | — | Zep, GPT-5.4 reader **and** judge |
| MemOS | 89.2 | 88.8 | — | 56.8 | MemTensor |
| Supermemory | 85.2 | — | — | — | Supermemory |
| past.dev | — | — | 90.65 | 85.03 | past.dev, one model answers and judges |

**The number this project must name when it says it is not SOTA.** On LongMemEval, the highest published
figure is **95.60% — Zero Labs, Agent Zero Memory** (August 2026), and the paper does not name the setting,
so it is not even known to be LongMemEval-S. The tightest figure that *does* state the setting is
**94.87% — Mastra Observational Memory with a `gpt-5-mini` reader**, vendor-run. Against those, Cortex's
90.15 is **−5.45 and −4.72**, and neither difference may be claimed as a gap in the technical sense,
because both rows were produced by a different reader, a different judge, or both. The honest form is:

> Cortex is **not** SOTA on LongMemEval-S. The published leader is **Agent Zero Memory (Zero Labs) at
> 95.60%**, a figure whose setting is undisclosed; the best disclosed-setting figure is **Mastra
> Observational Memory at 94.87%**. Cortex reads 90.15 at its own configuration. The distance is real and
> its decomposition is unknown, which is exactly why `T3` exists and a leaderboard comparison does not.

---

## 3. The −22.4 delta, which is the strongest single argument for the grade system

OmniMemEval runs 14 backends with `gpt-4.1-mini` answering and `gpt-4o-mini` judging, one setup for
everyone. Two rows may be placed beside their self-reported counterparts:

| system | self-reported LongMemEval-S | same-harness (OmniMemEval) | delta |
| --- | ---: | ---: | ---: |
| Hindsight | 94.6 | **72.20** | **−22.40** |
| MemOS | 89.20 | **89.20** | **0.00** |

The first row is the ordinary case: a vendor's own harness, its own reader, its own judge, its own prompt
— and a controlled run takes 22 points off it. The second row is the unusual case, and worth naming: MemOS's
headline **is** its controlled number, so that vendor publishes the same figure its competitor's harness
produces. Both facts are compatible with the same rule:

> A self-reported figure is a **configuration**, not a capability. The only thing a configuration tells you
> is what that configuration scored.

That rule is already `ACCEPTANCE-MATRIX.md` §2. This is the first external measurement that prices breaking
it: 22.4 points, on 500 questions, from a system with a $x00M-scale product behind it.

It also disposes of a temptation this project has faced in every round report: quoting a competitor's high
number as the thing to beat. `Hindsight 94.6` is not the thing to beat. `Hindsight 72.20` under a
stranger's harness is closer to the thing to beat, and **neither is grade A against us**, because our reader
is not `gpt-4.1-mini`.

---

## 4. Per-type: the frontier's weakest axis is the one this product is aimed at

`past.dev` publishes BEAM per category at all four history sizes — the only public per-type breakdown at
production scale. Its worst category, at every size, is **contradiction resolution**:

| category | 100K | 500K | 1M | 10M |
| --- | ---: | ---: | ---: | ---: |
| Abstention | 98.75 | 92.14 | 97.14 | 100.00 |
| Event ordering | 100.00 | 100.00 | 99.81 | 100.00 |
| Preference following | 100.00 | 99.05 | 98.87 | 100.00 |
| Summarization | 99.38 | 97.25 | 99.60 | 99.00 |
| Instruction following | 96.25 | 92.02 | 96.43 | 95.00 |
| Temporal reasoning | 95.00 | 93.45 | 96.79 | 93.75 |
| Information extraction | 95.00 | 86.32 | 83.98 | 68.75 |
| Knowledge update | 89.38 | 86.07 | 85.71 | 92.50 |
| **Contradiction resolution** | **78.13** | **78.57** | **75.36** | **73.13** |
| **Multi-session reasoning** | **68.95** | **71.39** | **72.82** | **28.17** |

Three readings, and the first two are the reason this section exists:

1. **Contradiction resolution never exceeds 78.13** — on the first-place system, on a board it owns, with
   one model answering and judging. A fact that was replaced is still being served, at every history size,
   about one time in four.
2. **Multi-session reasoning is stable at 69–73 and then falls to 28.17 at 10M.** The frontier does not
   degrade gracefully; it has a cliff, and the cliff is where the evidence has to be *assembled* from many
   old sessions rather than *matched* in one.
3. Abstention, preference, ordering and summarization are **saturated** (92–100). Work aimed there is work
   aimed at the part of the problem that is already solved.

This project's thesis — a settled fact versus a superseded one, a ledger that can say "no rule applies",
revision that cascades — is aimed at axis 1, which is the axis the leader scores worst on. That is a
**positioning** observation and nothing more; it is not evidence that our mechanism works, and `T1`–`T4` and
`S2` are the instruments that would say so. But it does settle one question the plan has carried for
several rounds: *if the campaign buys one capability, which one?* Contradiction resolution, because it is
where the leader is 73 and where our gates are already written.

---

## 5. The reader swap moves the level, not the order

Two published results pull in opposite directions and both are true:

| source | finding |
| --- | --- |
| Mastra, own ablation | same memory system, `gpt-4o` → `gpt-5-mini`: **84.23 → 94.87, +10.64** |
| SJTU/Tsinghua + MemTensor, 12 systems × 4 backbones | swapping the backbone "raised absolute scores but barely reordered the systems"; MemOS stayed the best memory configuration under all four |

The reconciliation is the sentence the second source writes for it: *grounding is decided before
generation — a stronger model polishes answers whose evidence was already found, but it cannot rescue
evidence that was never retrieved.*

Three consequences, and they are the round's operative ones:

- **Requirement 12 is satisfiable and expected.** A stronger reader should score higher, by roughly the
  margin Mastra measured. A memory layer that scores **lower** on a stronger reader has a prompt-contract
  bug, not a reader problem. That is now a criterion (`M1`), not a hope.
- **A stronger reader will not close `T3`.** Both sources agree the ordering is roughly reader-invariant,
  so buying a stronger reader buys level for us and for whoever we are behind. `T3` stays the work.
- **It also disposes of `LoCoMo`.** The same paper that reports per-type numbers says LoCoMo's histories are
  short enough that its system passes the reader the *full dated history* — 90.0% for full history against
  89.5% for the memory system, on GPT-5.6. A benchmark whose baseline ties its best system is measuring the
  reader and the prompt. It is struck from any future claim in this repository, alongside the grade rule.

---

## 6. The eval-set inventory, with a decision per set

Eleven sets are now known well enough to rule on. "Adopt" means it enters this arm's measurement; "watch"
means it is specified and refused for a reason that can expire; "struck" means it may not appear in a claim.

| set | size and shape | what it measures | decision |
| --- | --- | --- | --- |
| **LongMemEval-S** (ICLR 2025) | 500 questions, 5 types | extraction, multi-session, temporal, knowledge update, abstention | **adopt** — `S1`–`S8`, `T1`–`T3` |
| **LongMemEval-V2** (May 2026) | agentic contexts | the same axes with tool traces | **watch** — adopting it changes the arena, which would reset `T3`'s baseline for no reason |
| **BEAM** (`arXiv:2510.27246`, ICLR 2026) | 100 conversations, 2,000 questions at 100K / 500K / 1M / 10M tokens | 10 categories, the only set that separates the field | **watch, priced** — the 10M tier is ~200 questions over ~10M tokens of ingest; that is a dispatch cost this arm's budget does not carry, and it is the *next* arena rather than this one |
| **LoCoMo** | 1,540 questions | single-hop, multi-hop, temporal, open-domain over short histories | **struck** — §5: full history ties the best memory system |
| **PersonaMem v2** | preference axis | preference drift over sessions | **watch** — the frontier's second-worst axis (Reglos 60.0 vs EverOS 76.7 on the 30 preference questions), and the one axis this product has **no** gate for |
| **HaluMem** | hallucination in memory | whether a memory system invents what it stored | **watch** — closest external set to the `⊥` question; would need the three-valued gate from `DECISION-MEME-AND-TARGETS.md` §D4 to be readable at all |
| **DB-Bench** | state-change dependency chains | whether an agent's *operations* survive abstraction | **watch** — SJTU measured full context at 48.2 exact match, beating every summarizer: "summarization destroys the operation order that correctness depends on". That is a direct warning for any `Derivation`/summary layer, and the reason `Fact.derivedFrom` must not become a summary |
| **ConvoMem** + **MemoryBench** (`supermemoryai/memorybench`, MIT) | harness, not a set | runs Supermemory, Mem0 and Zep through one pipeline on LoCoMo / LongMemEval / ConvoMem | **adopt as a harness** — the cheapest route to grade-A rows against named competitors, and the answer to requirement 7 that does not cost a re-implementation |
| **LifeBench**, **PrecisionMemBench** | not yet read | personal-life and precision axes | **watch** — named, unread, not ruled on |
| this repository's controlled sets | 16-case assumption base, contradiction set, A3 extraction | `K*`, `T*`, `G*`, `D1` | **adopt** — the only grade-A evidence the project owns |
| this repository's A/B arms | 500 questions, two configurations | `T3`, `S1`, `S3`, `S4` | **adopt** — the only gap claim the project may make |

The asymmetry is the point. **Ten of eleven external sets are watched or struck; one is adopted as a
harness; the grade-A evidence all comes from sets this project built.** That is not a weakness — an external
set nobody can reproduce under our reader adds a row to a table and no knowledge. It is why
`PLAN-COMPETITOR-HARNESS.md` exists, and `MemoryBench` is now the concrete way to execute it.

---

## 7. What this changes in the queue — and what it does not

**Does not change.** `T3` is still first, `A8` second, the `cortex-memory` product A/B third, the MEME slice
fourth. No reading above moves any of them, and the reason is §1: nothing here is grade A against us.

**Changes, in four places, all of them criteria rather than prose.**

1. **`M1` — reader strength.** Same 500 questions, same arm configuration, reader swapped from the
   non-reasoning model to the reasoning one: overall accuracy **≥ +3.0 points**. Three is above the noise
   floor this arm has measured (1.6–2.2) and far below the +10.6 the outside world reports, so a miss is a
   defect rather than variance. Registered as an aim with no reading.
2. **`P1` — provider portability.** A third provider at the same reader class, same 500 questions, within
   **±2.0 points** of the reference. `AUDIT-MODEL-PORTABILITY.md` §7 has the ratio this needs and has never
   measured it; the criterion makes the omission visible.
3. **`C2` — the adaptive budget.** `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.297.7 states that `C2` "is
   registered as an aim". **It was not registered**: `acceptance.ts` had no such row, so a document claimed
   a criterion that no checker evaluated. That is the exact failure the matrix was built to prevent, and it
   is fixed this round — the row now exists, `unrun`, with the reason.
4. **`B1`/`B2` — the browser axis.** Two gates over the committed readings:
   `summary.failed = 0` for chromium and for Firefox. "Product maturity" has been a word in the plan and a
   number nowhere; these two rows are the number, and they cost nothing because the artifacts are already
   committed and already regenerated in CI.

**One thing is deliberately not added.** No criterion is registered for BEAM, because a criterion whose
measurement costs more than the quarter it is registered in is a criterion that will be `unrun` forever, and
this document has just spent six sections arguing that an `unrun` row is only honest when its recipe is
affordable.

---

## 8. The claim this document licenses, in the form it may be repeated

> On the **only same-harness board that exists** (OmniMemEval, 14 backends, one reader, one judge), the
> leader reads **89.20** and the vendor that reported **94.6** reads **72.20** on the same set. Cortex reads
> **90.15 / 90.40** on its own harness — a **B**-grade comparison to both rows, which means it may be placed
> beside them and may not be subtracted from them. Cortex is therefore **not SOTA** on LongMemEval-S: the
> published leader is **Agent Zero Memory at 95.60%** with an undisclosed setting, the best disclosed-setting
> figure is **Mastra Observational Memory at 94.87%**, and the only gap this project can defend is the
> **−3.30** it computes against itself.

# Two mechanisms from the 2026 leaders, read against ours

`LANDSCAPE-CONTROLLED-BOARD.md` is about **boards**. This document is about **code**: what the two systems
that lead the disclosed-setting board actually do, read at the level of mechanism rather than score, and
what the comparison says about our own implementation — including one thing we do not have.

The rule this document follows is the same one `PLAN-COMPETITOR-HARNESS.md` states: a leaderboard row is a
configuration, so it can only motivate. A mechanism can be **read**, and reading it is how a row becomes
either a confirmation of something we already do or a named gap. Both outcomes are below.

---

## 1. Graphiti (Zep): retire, never delete — and the two-pass that makes a late arrival safe

Source: `getzep/graphiti`, Apache-2.0; `graphiti_core/edges.py`, `utils/maintenance/edge_operations.py`,
`search/search_filters.py`; paper arXiv January 2025. Self-reported LongMemEval 71.2 with a `gpt-4o`
reader against 60.2 for full history, 63.8 against 55.4 with `gpt-4o-mini`.

### 1.1 The model

Five timestamps, on two timelines:

| field | lives on | means |
| --- | --- | --- |
| `valid_at` | episodic node, entity edge | when the fact became true **in the world** |
| `invalid_at` | entity edge | when it stopped being true **in the world** |
| `created_at` | every node and edge | when **the system** learned it |
| `expired_at` | entity edge | when **the system** recorded that it stopped |
| `reference_time` | the episode | the reference point the edge's times were resolved against |

`valid_at` is **inferred, not supplied**: `add_episode()` takes a `reference_time`, and a dedicated model
call (`extract_edges.extract_timestamps`) reads the fact text against it and returns `valid_at`/`invalid_at`.
So "I left Acme last March" produces a `valid_at` **earlier** than the message that carried it.

### 1.2 The two passes, and why there are two

Invalidation is mechanical and runs in a fixed order:

1. **The incoming edge may be the stale one.** When deduplication marks a new edge as contradicting
   existing ones, Graphiti first checks the incoming edge against its candidates: if **any** candidate
   became valid **later** than the incoming edge, the incoming edge loses — its `invalid_at` is set to that
   candidate's `valid_at` and its `expired_at` to now.
2. **Only then** does `resolve_edge_contradictions` expire an existing edge, and only when that edge became
   valid **earlier** than the incoming one — `invalid_at` = the new edge's `valid_at`, `expired_at` = now.
3. **A pair whose validity windows do not overlap is never touched.**

Pass 1 is the one that is easy to omit and expensive to omit. Without it, a message that arrives late but
describes an earlier world state **overwrites current truth**, and the failure is silent: the answer is
well-formed, cites a real source, and is wrong.

### 1.3 Read against ours

| property | Graphiti | `packages/cortex-core/src/knowledge/revision.ts` |
| --- | --- | --- |
| retire rather than delete | `invalid_at`/`expired_at`, edge kept | `refuted` on `persistence`: stops answering the default question, keeps answering the historical one |
| only a later fact invalidates an earlier one | pass 2's ordering condition | **yes** — line 172: "only a fact that is *later* can invalidate an earlier one. A declaration pointing backwards is a caller error" |
| late arrival cannot overwrite current truth | pass 1 | **yes, by construction**: the input is sorted by `(slot, at, id)` before anything happens, so arrival order cannot enter the decision |
| non-overlapping windows do not contradict | explicit guard | **yes, by representation**: "stops answering the default question, keeps answering a historical one" *is* the window |
| order-independence of the result | not stated | **yes, and tested**: the deterministic sort is the mechanism |
| when the system learned the fact | `created_at` / `expired_at` | **no** |

Six of seven match, one of them by a different route (we get late-arrival safety from a sort; they get it
from a comparison). That is a **convergence**, and it is worth more than a leaderboard row: two independent
designs, one of them behind a commercial product with a paper, arrived at retire-not-delete and at
"backwards declarations are errors".

### 1.4 The one gap, named and not built

`Fact` carries `at` (when the fact was true) and no system-time field. So the ledger can answer **"what was
true on 3 March"** and cannot answer **"what did we believe on 3 March"**. Graphiti can answer both, which
is the whole point of its second timeline, and Zep's own marketing is written around the second question.

This is a real capability gap against a real competitor, and it is **not** being closed this round:

- **No consumer.** Nothing in the pipeline or the benchmark asks a belief-history question. LongMemEval's
  temporal category asks about world time. A field with no reader is what `AUDIT-UNREFERENCED-*` exists to
  catch, and `ProvenanceNode` is the precedent.
- **It is not free.** `created_at` is trivial; `expired_at` requires every write path to record system time
  and every retirement to write one, which changes the ledger's on-disk shape.
- **The criterion comes first if it is ever built.** The form would be: for a controlled set with known
  belief transitions, "what did the ledger believe at T" answered correctly for all T, plus a leak count of
  zero for facts the ledger had not yet learned at T. That is a `T*`-shaped row, and it is unwritten
  because the set is unwritten.

Recorded here so that the gap is a decision with a reason rather than an omission.

---

## 2. Mastra Observational Memory: the leader is not retrieval

Source: Mastra's implementation notes and research page, February 2026. LongMemEval **94.87 with a
`gpt-5-mini` reader**, **84.23 with `gpt-4o`** — the latter being **1.8 points above the official oracle
configuration** (82.4), i.e. above a run that is handed the answer evidence.

### 2.1 The mechanism

- Two background agents. **Observer** fires when unobserved messages reach ~30,000 tokens and rewrites them
  as dense, **dated** observations. **Reflector** fires when observations reach ~40,000 tokens and merges,
  dedupes and condenses them.
- The observations are a **plain text log** in ordinary storage (PostgreSQL, LibSQL, MongoDB). **No vector
  index, no graph.** They are loaded into the context directly.
- Priority is encoded as **emoji** — 🔴 important, 🟡 possibly relevant, 🟢 background — chosen because a
  language model parses them cheaply and a human can read them.
- A **three-date model** (observation date, reference date, relative date) for temporal questions.
- The context window is split into a **stable observation prefix** and an append-only recent-message suffix.
  Stability is the point: the prefix is cacheable, and the reported saving is 4–10x on cached input tokens.

Reported compression is 3–6x on text-heavy conversations and 5–40x on tool-heavy ones (the vendor calls the
second range anecdotal).

### 2.2 Read against ours

Three comparisons, and the third is the uncomfortable one.

1. **Architecture: they are the anti-retrieval position, and they are winning.** The highest disclosed-setting
   score in this field is produced by a system with no vector store and no graph, whose entire memory is a
   compressed text log placed in the context. Our arm is a retrieval pipeline, and `S1`/`S3`/`S4` are its
   readings. This does not say retrieval is wrong — it says the 2026 ceiling is being set on the
   *compression* axis, not the *selection* axis, and that is a different axis from the one we have been
   buying.
2. **Their `gpt-4o` number is above the oracle.** 84.23 against 82.4. Our S1 row already carries the oracle
   figure and the note that it is "not a ceiling" — this is the second independent confirmation, and the
   mechanism is the reason: a compressed observation log can *omit* the distractor turns that a full-history
   oracle still contains.
3. **Our cost row prices the wrong quantity.** `C1` reads 12,105 prompt tokens per question, and §13.293.2
   established that the delivery **fills** its 48,000-character cap, so the number is a configuration
   constant. Mastra's saving does not come from a smaller log; it comes from a **stable** prefix. We already
   record the evidence for that and do not read it as a criterion: 18,933,570 of 24,209,976 prompt tokens in
   `42310779222` were cache hits — **78%**. That is the number that says whether our prefix is stable, and it
   is currently a footnote inside `C1`'s `onMiss`.

   The consequence is a candidate mechanism, not a decision: **the budget's unit is characters (wrong, 4.11
   characters per token) and its mechanism is stability (unmeasured as a criterion)**. `C2` is the row that
   would hold "median evidence tokens down 30% at flat accuracy"; the cache-hit share is the row that would
   hold "the prefix did not move". Neither is dispatched, and `T3` is why.

### 2.3 What is refused, and the source that says why

Building an Observer/Reflector is refused this round, and not only for queue reasons. **DB-Bench** measured
that on state-change dependency chains, full context reads 48.2 exact match and **beats every summarizer** —
"summarization destroys the operation order that correctness depends on". A consolidation layer is the one
mechanism this project has external evidence *against*, on the axis where our own `T4` (`−lapse` = 100%)
already reads perfectly. If it is ever built, it is built for cost and it is gated by `C2`, never for
accuracy.

---

## 3. Mem0 v3: the graph was removed, and it is priced on our axis

Mem0's v3 pipeline (commit `a488e190`, merged April 2026) **removed the graph backend**: Neo4j and Neptune
graph traversal are gone, replaced by entity extraction plus cross-memory links used as a ranking signal, with
no multi-hop traversal. Neptune Analytics survives only as a vector store.

The published consequence, on the temporal subtask with `gpt-4o`: **Zep 63.8, Mem0 49.0** — a 15-point
architectural gap on the one axis where a store that models time beats a store that overwrites. Mem0's own
headline (94.4) is measured on the aggregate with a GPT-5 reader and judge, which is why it can lead the
aggregate and trail by 15 on the category this product is aimed at.

Two readings:

- **The market's revealed preference is time-to-first-value, and it costs the temporal axis.** Mem0 chose
  flat because two calls and a string paste is the fastest integration in the field. That is a real product
  advantage and it is not the one we are building.
- **Our thesis is on the correct side of that trade.** `T1`–`T4`, `K*` and `S2` all sit on the axis Mem0 gave
  up. It does not mean we are better; it means that if we are better *anywhere*, the aggregate will hide it
  and the per-category table will not.

---

## 3.1 TEPA: append-only memory scores below no memory at all

`arXiv:2608.07429` makes validity an explicit state of memory -- observations become keyed precedents, and a
fresh statement conflicting with an active precedent **under the same key** revokes the old one, which is kept
for audit and excluded from retrieval. The measurement that matters is the reversal table:

| design | full reversal, 50 seeds | real file-backed drift |
| --- | ---: | ---: |
| append-only | 0.210 | 0.203 |
| last-write-wins | 0.210 | -- |
| **no memory at all** | **0.309** | 0.298 |
| keyed revocation | **0.950** | 0.950 |

The third row is the finding. Append-only and last-write-wins do not merely fail to help; they land **below
storing nothing**, because a stale value that is still retrievable is worse than an absence the reader can see.
That is the strongest external support this project's thesis has, and it is support for the *question* rather
than for our implementation: `K3` (retired facts served: 0) and `T4` (`-lapse` arm: 100% on 16 cases) measure
that a retired fact is not delivered, which is necessary and not the same quantity. TEPA's 0.950 is the success
rate **after the world reversed**.

The controlled set has no reversal case. Building one is cheap in the way that matters: a key, two values, one
reversal, no generation, no reader -- so it is a set `S2` could read directly. Recorded and not built, because
the only dispatch capacity this round is `P1`.

## 3.2 A frozen resolver answers 80.25% of MemoryAgentBench's conflict split

`arXiv:2610.09193` (NeurIPS 2026 IAB workshop) executes the benchmark's own rule -- the newest statement about a
fact wins -- as a **zero-learning resolver**, and reads the result per item:

| | |
| --- | ---: |
| answered by the rule under the official metric | **80.25%** (74.5% on the three held-out lists) |
| items whose released gold the last-write graph cannot reach | **67** (a third of the 262K multi-hop questions) |
| two long-context models on the items the rule solves | 84.7% / 82.6% |
| the same models on those 67 | **10.4% / 11.9%** |

The conclusion is the sentence this repository should adopt verbatim: *the per-item split, not the aggregate, is
the unit at which a score here can be read*. Two prohibitions follow. Do not adopt that split's aggregate as a
criterion, because most of it is a rule that needs no memory. And do not compare against it without a
reachability split -- reachable-by-rule, unreachable-gold, remainder.

It also explains why TEPA ties last-write-wins at 0.890 on clean single-hop data: with a clean stream, taking
the newest value *is* the correct mechanism, so revocation adds nothing. The increment only appears under
reversal.

## 3.3 The cache number, calibrated

`13.298.4` read 96.0% of prompt tokens as a prefix-cache hit and treated it as a stability signal against 78.2%
two dispatches earlier. DeepSeek's own published figure is that **96% of all input tokens are cache hits**, and
the retention behind it is 3 days for agent traffic against the ~5 minutes a typical provider offers. So 96.0%
is the mean, not an advantage: the honest claim is that this arm does not break its prefix, and there is nothing
yet to say about doing better.

Two consequences worth carrying. A broken prefix costs **10x** on the input side (cache hit $0.006 against
$0.30 per million on V4.1-Flash), which makes prefix stability the most valuable and least measured property in
this pipeline. And the hit rate is a **harness** property, measured across eight harnesses on one model at
roughly a 7x spread in cost per task -- which is the outside evidence for requirement 8 being about prompt
structure rather than prompt wording.

## 3.4 MemStrata: the packet is a *selection* under a token ceiling, and attribution is paid for

`arXiv:2610.05343` keeps a retrieval backbone and adds **non-duplicated, dated, speaker-attributed source spans**,
with the whole rendered packet — provenance headers included — required to fit **24,000 tokens under the pinned
reader tokenizer**. The arms are the useful part, because each one is a single variable:

| arm | score (reference-only) | what it isolates |
| --- | ---: | --- |
| CL1, the bounded packet | 463/500 = 92.6% | the system |
| keyword-only selection, same budget | 425/500 = 85.0% | **ranking is worth 7.6 points** |
| matched-reader Letta | 438/500 = 87.6% | a competing memory design on the same reader |
| full-history control, ~4.7x evidence | 464/500 = 92.8% | **volume is worth +0.2, i.e. nothing** |

Two mechanisms are directly comparable to decisions this repository has already taken, and they point in
opposite directions, which is why they are recorded together rather than as one lesson.

1. **Attribution is part of their packet, and we removed ours.** §13.283 withheld the per-turn source id and read
   the freed characters as capacity, on a census showing the reader reproduces an id in 4 of 500 answers and 0 of
   121 on `MR`. MemStrata *adds* date and speaker attribution and reaches 92.6% at 24k tokens; this arm reaches
   91.95% at 12.1k tokens. Both are true, and the difference is the price: they spend about 2x the budget on
   attribution, we spend nothing. A future arm that adds attribution back at a *fixed* budget would be a
   single-variable test of whether the attribution is what the extra tokens buy — and nobody has run it.
2. **The ceiling is stated in tokens under the reader's tokenizer, and ours is stated in characters.** Their
   24,000 is a token budget; our 48,000 is a character budget, which is 11,680 tokens at the measured 4.11
   characters per token. A reader comparing the two numbers directly concludes we run at 2x their budget when we
   run at 0.51x. §13.287.2 registered the unit change; this is the second independent reason for it.

## 3.5 Agent Zero Memory: three parallel stores, a citation lock, and an intent gate

`arXiv:2608.29606` runs an **episodic timeline**, an **entity-event knowledge graph** and a **citation-locked
documentary memory** in parallel, with a retrieval turn that runs an intent gate (self-contained turns add no
latency), a source router, and three concurrent agentic searches over hybrid embedding + lexical retrieval. Its
retrieval-channel ablation is the cleanest published reading of what each channel is worth:

| channel exposed | accuracy | delta |
| --- | ---: | ---: |
| embedding + lexical | 95.20% | — |
| embedding only | 94.00% | −1.20 |
| grep only | 93.60% | −1.60 |
| lexical only | 93.40% | −1.80 |

Three mechanisms are worth naming against our design, and only one of them is a candidate.

- **The citation lock** — "every answer may cite only evidence its reader actually opened" — is a *structural*
  anti-fabrication guarantee, not a score. This project has the same information (`sources`, `evidenceRoles`,
  the B7 annotation channel) and no equivalent rule, and the reason is honest: our reader is not asked to cite,
  so there is nothing to lock. It becomes a mechanism the moment an answer carries references, and it should be
  built then rather than now.
- **The intent gate** — self-contained turns skip retrieval entirely — is a **cost** mechanism with no accuracy
  cost, and it is the one candidate here. This arm routes by question shape already (§13.34 and the `ask`
  family), but it routes the *prompt*, not the *retrieval*: every question pays a 256-wide pool. A gate that
  recognised a self-contained question would cut `C1` on the subset it catches and is measurable inside the
  existing artifact (`relevanceTopK` per question).
- **Three parallel stores** is the one thing here this project should **not** copy. Our ledger is one store with
  an explicit validity state, and `V1` reads 0.0pp for the append-only version against +64.7pp for the ledger —
  the specialisation Agent Zero buys with three stores is bought here with one state field, on a fixture that
  can tell the difference.

## 4. What changes, what does not

| finding | consequence |
| --- | --- |
| Graphiti matches our retirement semantics 6/7, by a different route | **confirmation.** No change. `T4` stays the instrument |
| No system-time field, so "what did we believe at T" is unanswerable | **named gap, not built.** Consumer first (`D5`), criterion second |
| The leader's mechanism is compression with a cacheable prefix, not retrieval | **candidate mechanism.** Cache-hit share becomes a criterion candidate; the budget's unit stays characters until `C2` has a measurement |
| Consolidation is externally evidenced to hurt operation order | **refusal with a source.** Any Observer/Reflector work is cost-motivated and `C2`-gated |
| Mem0 removed the graph and trails by 15 on the temporal subtask | **positioning.** Per-category tables are where our claims have to live |
| Ranking is worth 7.6 points at a fixed budget; volume is worth 0.2 | **confirmation with a number.** `C2`'s cut is priced by a published ablation for the first time (§13.301.2), and the *cut* side is still unmeasured by anyone |
| The intent gate is a cost mechanism with no accuracy cost | **candidate mechanism**, gated behind `C2` — it changes retrieval, not the prompt, so it needs its own dispatch |
| The citation lock is structural anti-fabrication | **deferred with a trigger.** It becomes buildable when an answer carries references; today it does not |

**Nothing here is a score.** Every number in this document comes from a vendor or from a paper reporting its
own run. `T3` is still the only gap this project can defend, and this document does not move it.
